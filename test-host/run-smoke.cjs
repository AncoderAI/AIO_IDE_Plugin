'use strict';

const fs = require('node:fs');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { spawn, spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const repositoryPath = path.resolve(__dirname, '..');
const codeExecutable = process.env.VSCODE_EXECUTABLE_PATH ||
  (process.platform === 'win32'
    ? String(spawnSync('where.exe', ['code.cmd'], { encoding: 'utf8', windowsHide: true }).stdout || '').trim().split(/\r?\n/)[0]
    : 'code');
const installedMode = process.argv.includes('--installed');

function findInstalledCli(name) {
  const result = spawnSync('where.exe', [`${name}.exe`], { encoding: 'utf8', windowsHide: true });
  const executable = String(result.stdout || '').split(/\r?\n/).find(Boolean);
  return executable && path.isAbsolute(executable) ? executable : undefined;
}

function resolveCodeLaunch(argumentsList, environment) {
  if (!codeExecutable) throw new Error('Set VSCODE_EXECUTABLE_PATH to your VS Code executable.');
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(codeExecutable) || !path.isAbsolute(codeExecutable)) {
    return { executable: codeExecutable, argumentsList, environment };
  }

  const codeRoot = path.resolve(path.dirname(codeExecutable), '..');
  const executable = path.join(codeRoot, 'Code.exe');
  const builds = ['', ...fs.readdirSync(codeRoot).filter((name) => /^[0-9a-f]{8,}$/i.test(name))];
  const cliScript = builds.map((build) => path.join(codeRoot, build, 'resources/app/out/cli.js')).find((script) => fs.existsSync(script));
  if (!fs.existsSync(executable) || !cliScript) {
    throw new Error(`The VS Code launcher at '${codeExecutable}' does not have its expected Code.exe and cli.js files.`);
  }
  return {
    executable,
    argumentsList: [cliScript, ...argumentsList],
    environment: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
  };
}

async function makeTemporaryWorkspace() {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'aio-vscode-smoke-workspace-'));
  await writeFile(path.join(workspacePath, 'README.md'), '# AIO smoke workspace\n', 'utf8');
  return workspacePath;
}

function runCode(argumentsList, environment = process.env) {
  return new Promise((resolve, reject) => {
    const launch = resolveCodeLaunch(argumentsList, environment);
    const processHandle = spawn(launch.executable, launch.argumentsList, {
      cwd: repositoryPath,
      stdio: 'inherit',
      env: launch.environment,
      windowsHide: true,
    });
    processHandle.once('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(new Error(`Cannot find VS Code launcher '${codeExecutable}'. Set VSCODE_EXECUTABLE_PATH to code.cmd or Code.exe.`, { cause: error }));
        return;
      }
      reject(error);
    });
    processHandle.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`VS Code smoke host exited with code ${code} and signal ${signal || 'none'}.`));
    });
  });
}

async function waitForResult(resultPath) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(resultPath, 'utf8'));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error('The Extension Host exited without recording its smoke-test result.');
}

async function main() {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'aio-vscode-smoke-'));
  const userDataPath = path.join(rootPath, 'user-data');
  const extensionsPath = path.join(rootPath, 'extensions');
  const resultPath = path.join(rootPath, 'result.json');
  const workspacePath = await makeTemporaryWorkspace();
  const installedClis = installedMode && Object.fromEntries(['omp', 'claude', 'codex'].map((name) => [name, findInstalledCli(name)]));

  try {
    if (installedMode) {
      const missing = Object.entries(installedClis).filter(([, executable]) => !executable).map(([name]) => name);
      if (missing.length) throw new Error(`Installed CLI smoke mode requires: ${missing.join(', ')}. Run the default fixture smoke test instead.`);
    }
    await runCode([
      '--new-window',
      '--disable-extensions',
      '--disable-workspace-trust',
      `--user-data-dir=${userDataPath}`,
      `--extensions-dir=${extensionsPath}`,
      `--extensionDevelopmentPath=${repositoryPath}`,
      `--extensionTestsPath=${path.join(repositoryPath, 'test-host', 'extension-tests.cjs')}`,
      workspacePath,
    ], {
      ...process.env,
      AIO_SMOKE_RESULT_PATH: resultPath,
      AIO_SMOKE_MODE: installedMode ? 'installed' : 'fixture',
      ...(installedMode ? {
        AIO_SMOKE_OMP_PATH: installedClis.omp,
        AIO_SMOKE_CLAUDE_PATH: installedClis.claude,
        AIO_SMOKE_CODEX_PATH: installedClis.codex,
      } : {}),
    });
    const result = await waitForResult(resultPath);
    if (result.status !== 'passed') throw new Error(`Extension Host smoke test failed: ${result.message || 'unknown error'}`);
  } finally {
    await Promise.all([
      rm(rootPath, { recursive: true, force: true, maxRetries: 3 }),
      rm(workspacePath, { recursive: true, force: true, maxRetries: 3 }),
    ]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
