'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function runCursor(cursor, cli, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cursor, [cli, ...args], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(
      new Error(`Cursor extension test exited with code ${code} and signal ${signal || 'none'}`),
    ));
  });
}

async function waitForResult(filename, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { return JSON.parse(await fs.readFile(filename, 'utf8')); } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Cursor did not record a stability result.');
}

async function main() {
  const cursor = process.env.CURSOR_EXECUTABLE_PATH
    || 'C:\\Users\\beyon\\AppData\\Local\\Programs\\cursor\\Cursor.exe';
  const cli = path.join(path.dirname(cursor), 'resources', 'app', 'out', 'cli.js');
  const vsix = path.resolve(process.argv[2] || path.join(__dirname, '../dist/aio-ide.vsix'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-cursor-stability-'));
  const profile = path.join(root, 'profile');
  const extensions = path.join(root, 'extensions');
  const project = path.join(root, 'project');
  const resultFile = path.join(root, 'result.json');
  const developmentExtension = path.join(root, 'empty-development-extension');
  await Promise.all([
    fs.mkdir(path.join(profile, 'User'), { recursive: true }),
    fs.mkdir(project),
    fs.mkdir(developmentExtension),
  ]);
  await fs.writeFile(path.join(project, 'first.txt'), 'Cursor preview fixture');
  await fs.writeFile(path.join(developmentExtension, 'package.json'), JSON.stringify({
    name: 'aio-cursor-stability-host', publisher: 'local', version: '0.0.1', engines: { vscode: '^1.97.0' },
  }));
  await fs.writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
    'window.restoreWindows': 'none',
    'workbench.startupEditor': 'none',
    'security.workspace.trust.enabled': false,
  }));
  const profileArgs = [`--user-data-dir=${profile}`, `--extensions-dir=${extensions}`];
  try {
    await runCursor(cursor, cli, [...profileArgs, '--install-extension', vsix], process.env);
    await runCursor(cursor, cli, [
      '--new-window', '--disable-workspace-trust', '--disable-updates', '--skip-welcome', '--skip-release-notes',
      ...profileArgs,
      `--extensionDevelopmentPath=${developmentExtension}`,
      `--extensionTestsPath=${path.join(__dirname, 'cursor-stability-tests.cjs')}`,
      project,
    ], { ...process.env, AIO_CURSOR_STABILITY_RESULT: resultFile });
    const result = await waitForResult(resultFile);
    assert.equal(result.status, 'passed', result.message || 'Cursor stability test failed.');
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
