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
    name: 'aio-project-switch-observer', publisher: 'local', version: '0.0.1',
    engines: { vscode: '^1.97.0' }, activationEvents: ['onStartupFinished'], main: './index.js',
  }));
  await fs.writeFile(path.join(extensionPath, 'index.js'), String.raw`
'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
async function readState(filename) { try { return JSON.parse(await fs.readFile(filename, 'utf8')); } catch { return { startups: [] }; } }
async function activate() {
  const filename = process.env.AIO_SWITCH_STATE;
  const projectB = process.env.AIO_SWITCH_PROJECT_B;
  const folders = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
  const state = await readState(filename);
  state.startups.push(folders);
  await fs.writeFile(filename, JSON.stringify(state));
  if (state.initialized) return;
  const extension = vscode.extensions.getExtension('ancoder.aio-ide');
  if (!extension) throw new Error('AIO extension was not installed.');
  await extension.activate();
  await vscode.commands.executeCommand('aio.openWorkbench', vscode.workspace.workspaceFolders[0].uri);
  // Wait for the renderer to subscribe to app:open-folder before exercising
  // the same native TreeView import path a user triggers after the panel opens.
  await new Promise(resolve => setTimeout(resolve, 2000));
  const before = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
  const uri = vscode.Uri.file(projectB);
  const added = await vscode.commands.executeCommand('aio.importProjectInWorkbench', uri, [uri]);
  const after = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
  Object.assign(state, { initialized: true, added, importBefore: before, importAfter: after });
  await fs.writeFile(filename, JSON.stringify(state));
}
module.exports = { activate };
`);
}

async function readState(filename) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); } catch { return undefined; }
}

async function waitForState(filename, predicate, description, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await readState(filename);
    if (state && predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for ' + description);
}

async function workbenchFrame(app, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const window of app.windows().filter(page => !page.isClosed()).reverse()) {
      for (const frame of window.frames()) {
        const ready = await frame.evaluate(() => Boolean(window.__TAURI__ && document.querySelector('#root'))).catch(() => false);
        if (ready) return { window, frame };
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('AIO workbench was not restored after the workspace switch.');
}

async function projectPaths(frame) {
  return frame.evaluate(async () => {
    const projects = await window.__TAURI__.core.invoke('desktop_request', { channel: 'projects:list-initial', args: [] });
    return projects.map(project => project.primaryFolder);
  });
}

function equalPath(left, right) { return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase(); }

async function clickProject(window, frame, project) {
  let row = frame.locator('.project-row__main').filter({ hasText: path.basename(project) }).first();
  if (!(await row.isVisible().catch(() => false))) {
    const root = frame.locator('#root');
    const box = await root.boundingBox();
    if (box) await root.hover({ position: { x: 6, y: Math.min(180, box.height / 2) } });
    await new Promise(resolve => setTimeout(resolve, 300));
    const show = frame.getByRole('button', { name: /(显示侧栏|Show sidebar)/i }).first();
    if (await show.isVisible().catch(() => false)) await show.click();
    else {
      const toolbarShow = frame.locator('.title-toolbar__nav button').first();
      if (await toolbarShow.isVisible().catch(() => false)) await toolbarShow.click();
    }
    row = frame.locator('.project-row__main').filter({ hasText: path.basename(project) }).first();
  }
  await row.waitFor({ state: 'attached' });
  await row.click({ force: true });
}

async function assertLibrary(frame, projects, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let actual = [];
  while (Date.now() < deadline) {
    actual = await projectPaths(frame);
    if (projects.every(project => actual.some(candidate => equalPath(candidate, project)))) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  for (const project of projects) assert.ok(actual.some(candidate => equalPath(candidate, project)), `AIO library is missing ${project}.`);
}

async function main() {
  const upstream = process.env.AIO_SOURCE || path.resolve(__dirname, '../../AIO');
  const { _electron } = createRequire(path.join(upstream, 'package.json'))('playwright');
  const code = process.env.VSCODE_EXECUTABLE_PATH;
  if (!code || !path.isAbsolute(code)) throw new Error('Set VSCODE_EXECUTABLE_PATH to Code.exe.');
  const vsix = path.resolve(process.argv[2] || path.join(__dirname, '../dist/aio-ide.vsix'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-project-switch-'));
  const projectA = path.join(root, '项目 A');
  const projectB = path.join(root, '项目 B');
  const profile = path.join(root, 'profile');
  const extensions = path.join(root, 'extensions');
  const observer = path.join(root, 'observer');
  const stateFile = path.join(root, 'state.json');
  await Promise.all([fs.mkdir(projectA), fs.mkdir(projectB), writeObserver(observer), fs.mkdir(path.join(profile, 'User'), { recursive: true })]);
  await fs.writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
    'window.zoomLevel': -2,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
  }));
  await installVsix(code, vsix, [`--user-data-dir=${profile}`, `--extensions-dir=${extensions}`]);

  let app;
  try {
    const env = { ...process.env, AIO_SWITCH_STATE: stateFile, AIO_SWITCH_PROJECT_B: projectB };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath: code, env, timeout: 60000,
      args: ['--new-window', '--disable-workspace-trust', '--disable-updates', '--skip-welcome', '--skip-release-notes',
        `--user-data-dir=${profile}`, `--extensions-dir=${extensions}`, `--extensionDevelopmentPath=${observer}`, projectA],
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(2200, 1200));
    let state = await waitForState(stateFile, value => value.initialized, 'initial AIO project import');
    assert.equal(state.added, 1);
    assert.deepEqual(state.importAfter, state.importBefore, 'Automatic project import changed the VS Code workspace.');
    assert.ok(state.importBefore.length === 1 && equalPath(state.importBefore[0], projectA));

    let surface = await workbenchFrame(app);
    await assertLibrary(surface.frame, [projectA, projectB]);
    await clickProject(surface.window, surface.frame, projectB);
    state = await waitForState(stateFile, value => value.startups.some(folders => folders.length === 1 && equalPath(folders[0], projectB)), 'workspace B');
    surface = await workbenchFrame(app);
    await assertLibrary(surface.frame, [projectA, projectB]);
    await clickProject(surface.window, surface.frame, projectA);
    state = await waitForState(stateFile, value => value.startups.filter(folders => folders.length === 1 && equalPath(folders[0], projectA)).length >= 2, 'workspace A restore');
    surface = await workbenchFrame(app);
    await assertLibrary(surface.frame, [projectA, projectB]);
    await new Promise(resolve => setTimeout(resolve, 1500));
    state = await readState(stateFile);
    assert.deepEqual(state.startups.map(folders => folders.map(folder => path.basename(folder))), [['项目 A'], ['项目 B'], ['项目 A']],
      'Workspace switching reloaded unexpectedly or entered a loop.');
    const result = { switched: ['项目 A', '项目 B', '项目 A'], projectsPersisted: 2, unexpectedReloads: 0 };
    if (process.env.AIO_SWITCH_RESULT) await fs.writeFile(process.env.AIO_SWITCH_RESULT, JSON.stringify(result));
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    if (app) await app.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

main().catch(async error => {
  if (process.env.AIO_SWITCH_RESULT) await fs.writeFile(process.env.AIO_SWITCH_RESULT, JSON.stringify({ error: error.stack || error.message }));
  console.error(error);
  process.exitCode = 1;
});
