'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

async function installVsix(code, vsix, profileArguments) {
  const directory = path.dirname(code);
  const candidates = [directory, ...(await fs.readdir(directory)).filter(name => /^[0-9a-f]{8,}$/i.test(name)).map(name => path.join(directory, name))];
  for (const candidate of candidates) {
    const cli = path.join(candidate, 'resources/app/out/cli.js');
    if (!(await fs.stat(cli).catch(() => null))?.isFile()) continue;
    execFileSync(code, [cli, ...profileArguments, '--install-extension', vsix], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'inherit', timeout: 60000,
    });
    return;
  }
  throw new Error('VS Code CLI entry point missing beside ' + code);
}

async function writeObserver(extensionPath) {
  await fs.mkdir(extensionPath, { recursive: true });
  await fs.writeFile(path.join(extensionPath, 'package.json'), JSON.stringify({
    name: 'aio-reverse-sync-observer', publisher: 'local', version: '0.0.1',
    engines: { vscode: '^1.97.0' }, activationEvents: ['onStartupFinished'], main: './index.js',
  }));
  await fs.writeFile(path.join(extensionPath, 'index.js'), String.raw`
'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
async function read(filename) { try { return JSON.parse(await fs.readFile(filename, 'utf8')); } catch { return { startups: [] }; } }
async function activate() {
  const filename = process.env.AIO_REVERSE_STATE;
  const folders = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
  const state = await read(filename);
  state.startups.push(folders);
  await fs.writeFile(filename, JSON.stringify(state));
  const extension = vscode.extensions.getExtension('ancoder.aio-ide');
  if (!extension) throw new Error('AIO extension was not installed.');
  await extension.activate();
  await vscode.commands.executeCommand('aio.openWorkbench');
  await vscode.commands.executeCommand('aio.openWorkbench');
  state.openCalls = (state.openCalls || 0) + 2;
  state.aioVersion = extension.packageJSON.version;
  state.lastWorkspace = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
  await fs.writeFile(filename, JSON.stringify(state));
}
module.exports = { activate };
`);
}

async function readState(filename) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); } catch { return undefined; }
}

async function waitFor(predicate, description, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for ' + description);
}

async function workbenchFrame(app) {
  return waitFor(async () => {
    for (const page of app.windows().filter(candidate => !candidate.isClosed()).reverse()) {
      for (const frame of page.frames()) {
        if (await frame.evaluate(() => Boolean(window.__TAURI__ && document.querySelector('#root'))).catch(() => false)) return frame;
      }
    }
  }, 'AIO workbench frame');
}

async function projectPaths(frame) {
  return frame.evaluate(async () => {
    const projects = await window.__TAURI__.core.invoke('desktop_request', { channel: 'projects:list-initial', args: [] });
    return projects.map(project => project.primaryFolder);
  });
}

function samePath(left, right) { return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase(); }

async function waitForProjects(frame, expected) {
  return waitFor(async () => {
    const actual = await projectPaths(frame);
    return expected.every(value => actual.some(candidate => samePath(candidate, value))) ? actual : undefined;
  }, 'AIO reverse-synchronized projects');
}

async function launch(_electron, code, profile, extensions, observer, workspace, stateFile) {
  const env = { ...process.env, AIO_REVERSE_STATE: stateFile };
  delete env.ELECTRON_RUN_AS_NODE;
  return _electron.launch({
    executablePath: code, env, timeout: 60000,
    args: ['--new-window', '--disable-workspace-trust', '--disable-updates', '--skip-welcome', '--skip-release-notes',
      `--user-data-dir=${profile}`, `--extensions-dir=${extensions}`, `--extensionDevelopmentPath=${observer}`, workspace],
  });
}

async function main() {
  const upstream = process.env.AIO_SOURCE || path.resolve(__dirname, '../../AIO');
  const { _electron } = createRequire(path.join(upstream, 'package.json'))('playwright');
  const code = process.env.VSCODE_EXECUTABLE_PATH;
  if (!code || !path.isAbsolute(code)) throw new Error('Set VSCODE_EXECUTABLE_PATH to Code.exe.');
  const vsix = path.resolve(process.argv[2] || path.join(__dirname, '../dist/aio-ide.vsix'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-reverse-sync-'));
  const projectA = path.join(root, '项目 A');
  const projectC = path.join(root, '独立 C');
  const profile = path.join(root, 'profile');
  const extensions = path.join(root, 'extensions');
  const observer = path.join(root, 'observer');
  const stateFile = path.join(root, 'state.json');
  await Promise.all([fs.mkdir(projectA), fs.mkdir(projectC), writeObserver(observer)]);
  await installVsix(code, vsix, [`--user-data-dir=${profile}`, `--extensions-dir=${extensions}`]);

  let app;
  try {
    app = await launch(_electron, code, profile, extensions, observer, projectA, stateFile);
    await app.firstWindow();
    let frame = await workbenchFrame(app);
    let projects = await waitForProjects(frame, [projectA]);
    assert.equal(projects.filter(value => samePath(value, projectA)).length, 1);
    await waitFor(async () => (await readState(stateFile))?.openCalls === 2, 'first explicit workbench opens');
    await app.close();
    app = undefined;

    app = await launch(_electron, code, profile, extensions, observer, projectC, stateFile);
    await app.firstWindow();
    frame = await workbenchFrame(app);
    projects = await waitForProjects(frame, [projectA, projectC]);
    assert.equal(projects.length, 2, 'Repeatedly opening C created duplicate AIO projects.');
    assert.equal(projects.filter(value => samePath(value, projectA)).length, 1);
    assert.equal(projects.filter(value => samePath(value, projectC)).length, 1);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const state = await readState(stateFile);
    assert.deepEqual(state.startups.map(folders => folders.map(folder => path.basename(folder))), [['项目 A'], ['独立 C']],
      'Reverse synchronization caused an extra workspace reload.');
    assert.deepEqual(state.lastWorkspace.map(folder => path.basename(folder)), ['独立 C']);
    assert.equal(state.openCalls, 4, 'Each independent workspace should explicitly open AIO twice for the idempotency check.');
    const actualProjects = projects.map(value => path.basename(value)).sort();
    process.stdout.write(JSON.stringify({
      version: state.aioVersion,
      workspaces: state.startups.map(folders => folders.map(folder => path.basename(folder))),
      projects: actualProjects,
      duplicates: 0,
      extraReloads: 0,
    }) + '\n');
  } finally {
    if (app) await app.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
