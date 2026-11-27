'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

async function waitFor(predicate, description, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for ' + description);
}

async function installVsix(code, vsix, profileArguments) {
  const directory = path.dirname(code);
  const candidates = [directory, ...(await fs.readdir(directory))
    .filter(name => /^[0-9a-f]{8,}$/i.test(name)).map(name => path.join(directory, name))];
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

async function launch(_electron, code, profileArguments, workspace) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return _electron.launch({
    executablePath: code,
    env,
    timeout: 60000,
    args: ['--new-window', '--disable-workspace-trust', '--disable-updates', '--skip-welcome', '--skip-release-notes',
      ...profileArguments, workspace],
  });
}

async function workbenchWindow(app) {
  return waitFor(async () => {
    for (const page of app.windows().filter(window => !window.isClosed()).reverse()) {
      for (const frame of page.frames()) {
        if (await frame.evaluate(() => Boolean(window.__TAURI__ && document.querySelector('#root')?.innerText.trim())).catch(() => false)) {
          return page;
        }
      }
    }
  }, 'AIO workbench');
}

function editorGroups(window) {
  return window.locator('.part.editor .editor-group-container');
}

async function groupReport(window) {
  return editorGroups(window).evaluateAll(groups => groups.map(group => {
    const rect = group.getBoundingClientRect();
    const tabs = [...group.querySelectorAll('.tab')].map(tab => tab.textContent.trim()).filter(Boolean);
    return { x: Math.round(rect.x), width: Math.round(rect.width), tabs };
  }).sort((left, right) => left.x - right.x));
}

async function assertOnlyAio(window) {
  await waitFor(async () => (await editorGroups(window).count()) === 1, 'startup to contain only the AIO group');
  const report = await groupReport(window);
  assert.equal(report.length, 1);
  assert.equal(report[0].tabs.some(tab => /AIO (工作台|Workbench)/i.test(tab)), true);
}

async function openFileBesideAio(window, filename) {
  await window.keyboard.press('Control+Shift+E');
  await window.locator('.explorer-folders-view').getByText(filename, { exact: true }).first().click();
  await waitFor(async () => {
    const groups = await groupReport(window);
    return groups.length === 2 && groups[0].tabs.some(name => name.includes(filename)) &&
      groups[1].tabs.some(name => /AIO (工作台|Workbench)/i.test(name));
  }, 'file preview beside AIO');
  const report = await groupReport(window);
  assert.equal(report[0].tabs.some(tab => tab.includes(filename)), true, 'File preview must be left of AIO.');
  assert.equal(report[1].tabs.some(tab => /AIO (工作台|Workbench)/i.test(tab)), true, 'AIO must remain rightmost.');
  assert.equal(report.every(group => group.tabs.length > 0), true, 'Opening a file left an empty editor group.');
}

async function addEmptyLeftGroup(window, filename) {
  await window.locator('.tab').filter({ hasText: filename }).click();
  await window.keyboard.press('Control+Shift+P');
  const input = window.locator('.quick-input-widget input[role=combobox]');
  await input.fill('>View: New Editor Group to the Left');
  await window.getByRole('option', { name: /New Editor Group to the Left/i }).first().waitFor();
  await window.keyboard.press('Enter');
  await waitFor(async () => (await editorGroups(window).count()) === 3, 'deliberate empty left group');
  assert.equal((await groupReport(window)).filter(group => group.tabs.length === 0).length, 1);
}

async function main() {
  const upstream = process.env.AIO_SOURCE || path.resolve(__dirname, '../../AIO');
  const { _electron } = createRequire(path.join(upstream, 'package.json'))('playwright');
  const code = process.env.VSCODE_EXECUTABLE_PATH;
  if (!code || !path.isAbsolute(code)) throw new Error('Set VSCODE_EXECUTABLE_PATH to Code.exe.');
  const vsix = path.resolve(process.argv[2] || path.join(__dirname, '../dist/aio-ide.vsix'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-no-empty-group-'));
  const project = path.join(root, 'project');
  const profile = path.join(root, 'profile');
  const extensions = path.join(root, 'extensions');
  const filename = 'first.txt';
  const profileArguments = [`--user-data-dir=${profile}`, `--extensions-dir=${extensions}`];
  await Promise.all([
    fs.mkdir(project),
    fs.mkdir(path.join(profile, 'User'), { recursive: true }),
  ]);
  await fs.writeFile(path.join(project, filename), 'preview fixture');
  await fs.writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({ 'window.restoreWindows': 'all' }));
  await installVsix(code, vsix, profileArguments);
  let app;
  try {
    app = await launch(_electron, code, profileArguments, project);
    let window = await workbenchWindow(app);
    await assertOnlyAio(window);
    await openFileBesideAio(window, filename);
    await addEmptyLeftGroup(window, filename);
    await app.close();

    app = await launch(_electron, code, profileArguments, project);
    window = await workbenchWindow(app);
    await waitFor(async () => {
      const report = await groupReport(window);
      return report.length === 2 && report.every(group => group.tabs.length > 0);
    }, 'restored blank group to be removed');
    const report = await groupReport(window);
    assert.equal(report[0].tabs.some(tab => tab.includes(filename)), true);
    assert.equal(report[1].tabs.some(tab => /AIO (工作台|Workbench)/i.test(tab)), true);
    process.stdout.write(JSON.stringify({ startupGroups: 1, fileAndAioGroups: 2, restoredEmptyGroups: 0 }) + '\n');
  } finally {
    await app?.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
