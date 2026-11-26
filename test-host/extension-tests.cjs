'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

const COMMANDS = [
  'aio.openTerminal',
  'aio.openOmp',
  'aio.openClaude',
  'aio.openCodex',
  'aio.detectClis',
  'aio.openWorkbench',
];

const fixtureNames = {
  omp: 'aio-smoke-omp.cmd',
  claude: 'aio-smoke-claude.cmd',
  codex: 'aio-smoke-codex.cmd',
};

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(description, condition, timeoutMilliseconds = 15_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function prepareFixtures(workspacePath) {
  const fixturePath = path.join(workspacePath, '.aio-smoke-fixtures');
  const markerPath = path.join(workspacePath, '.aio-smoke-markers');
  await fs.mkdir(fixturePath, { recursive: true });
  await fs.mkdir(markerPath, { recursive: true });

  for (const [cli, filename] of Object.entries(fixtureNames)) {
    const markerFile = path.join(markerPath, `${cli}.started`);
    const command = [
      '@echo off',
      `> "${markerFile}" echo started`,
      'timeout /t 1 /nobreak >nul',
      'exit /b 0',
      '',
    ].join('\r\n');
    await fs.writeFile(path.join(fixturePath, filename), command, 'utf8');
  }

  return { fixturePath, markerPath };
}

async function configureFixtures(fixturePath) {
  const configuration = vscode.workspace.getConfiguration('aio');
  await Promise.all(Object.entries(fixtureNames).map(([cli, filename]) => configuration.update(
    `${cli}Path`,
    path.join(fixturePath, filename),
    vscode.ConfigurationTarget.Global,
  )));
}

function terminalProcessCount(executable) {
  const imageName = path.basename(executable);
  const result = spawnSync('tasklist.exe', [
    '/FO', 'CSV',
    '/NH',
    '/FI', `IMAGENAME eq ${imageName}`,
  ], { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  return String(result.stdout).split(/\r?\n/).filter((line) =>
    line.toLowerCase().startsWith(`"${imageName.toLowerCase()}",`),
  ).length;
}

async function configureInstalledClis() {
  const configuration = vscode.workspace.getConfiguration('aio');
  const executables = Object.fromEntries(Object.keys(fixtureNames).map((cli) => [
    cli,
    process.env[`AIO_SMOKE_${cli.toUpperCase()}_PATH`],
  ]));
  for (const [cli, executable] of Object.entries(executables)) {
    assert.ok(executable && path.isAbsolute(executable), `Missing installed executable for ${cli}.`);
    await fs.access(executable);
  }
  await Promise.all(Object.entries(executables).map(([cli, executable]) => configuration.update(
    `${cli}Path`,
    executable,
    vscode.ConfigurationTarget.Global,
  )));
  return executables;
}

async function closeTerminals(terminals) {
  const expected = new Set(terminals);
  const closed = new Set();
  const listener = vscode.window.onDidCloseTerminal((terminal) => {
    if (expected.has(terminal)) closed.add(terminal);
  });

  try {
    for (const terminal of terminals) terminal.hide();
    for (const terminal of terminals) terminal.dispose();
    await waitFor('all AIO test terminals to close', () => closed.size === expected.size);
  } finally {
    listener.dispose();
  }
}

async function smoke() {
  const extension = vscode.extensions.getExtension('ancoder.aio-ide');
  assert.ok(extension, 'The AIO extension must be available in Extension Development Host.');
  await extension.activate();

  const registeredCommands = await vscode.commands.getCommands(true);
  for (const command of COMMANDS) {
    assert.ok(registeredCommands.includes(command), `Expected registered command: ${command}`);
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'The smoke test needs its temporary workspace folder.');
  const workspacePath = workspaceFolder.uri.fsPath;
  const installedMode = process.env.AIO_SMOKE_MODE === 'installed';
  let markerPath;
  let processCounts;
  if (installedMode) {
    const executables = await configureInstalledClis();
    processCounts = Object.fromEntries(Object.entries(executables).map(([cli, executable]) => [
      cli,
      terminalProcessCount(executable),
    ]));
  } else {
    const fixtures = await prepareFixtures(workspacePath);
    markerPath = fixtures.markerPath;
    await configureFixtures(fixtures.fixturePath);
  }

  const terminals = await Promise.all([
    vscode.commands.executeCommand('aio.openOmp', workspaceFolder.uri),
    vscode.commands.executeCommand('aio.openClaude', workspaceFolder.uri),
    vscode.commands.executeCommand('aio.openCodex', workspaceFolder.uri),
  ]);

  assert.ok(terminals.every((terminal) => terminal && typeof terminal.dispose === 'function'),
    'Each direct CLI command must create and return a terminal.');
  assert.equal(new Set(terminals).size, 3, 'Each direct CLI command must create a distinct terminal.');
  assert.equal(new Set(terminals.map((terminal) => terminal.name)).size, 3,
    'Each direct CLI terminal must have a distinct label.');

  for (const cli of Object.keys(fixtureNames)) {
    if (installedMode) {
      await waitFor(`${cli} process to start`, () => terminalProcessCount(process.env[`AIO_SMOKE_${cli.toUpperCase()}_PATH`]) > processCounts[cli]);
    } else {
      await waitFor(`${cli} fixture to run`, async () => {
        try {
          await fs.access(path.join(markerPath, `${cli}.started`));
          return true;
        } catch {
          return false;
        }
      });
    }
  }

  await closeTerminals(terminals);

  const workbenchIndex = path.join(extension.extensionPath, 'workbench', 'ui', 'index.html');
  try {
    await fs.access(workbenchIndex);
  } catch {
    return;
  }

  const workbench = await vscode.commands.executeCommand('aio.openWorkbench');
  assert.ok(workbench?.webview, 'The workbench command must return a WebviewPanel when its resources are built.');
  assert.equal(workbench.visible, true, 'The workbench WebviewPanel must be visible after opening.');
  workbench.dispose();
}

async function writeResult(result) {
  const resultPath = process.env.AIO_SMOKE_RESULT_PATH;
  if (resultPath) await fs.writeFile(resultPath, JSON.stringify(result), 'utf8');
}

async function run() {
  try {
    await smoke();
    await writeResult({ status: 'passed', mode: process.env.AIO_SMOKE_MODE || 'fixture' });
  } catch (error) {
    await writeResult({ status: 'failed', message: error instanceof Error ? error.stack || error.message : String(error) });
    throw error;
  }
}

module.exports = { run };
