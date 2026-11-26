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

async function waitFor(predicate, description, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for ' + description);
}

async function workbenchSurface(app) {
  return waitFor(async () => {
    for (const page of app.windows().filter(window => !window.isClosed()).reverse()) {
      for (const frame of page.frames()) {
        const report = await frame.evaluate(async () => {
          if (!window.__TAURI__ || !document.querySelector('#root')?.innerText.trim()) return undefined;
          const meta = await window.__TAURI__.core.invoke('desktop_request', { channel: 'app:get-meta', args: [] });
          return { version: meta.version, text: document.querySelector('#root').innerText.slice(0, 120) };
        }).catch(() => undefined);
        if (report) return { page, frame, report };
      }
    }
  }, 'automatically opened AIO workbench');
}

async function verifySingleWorkbench(surface) {
  const frames = [];
  for (const frame of surface.page.frames()) {
    if (await frame.evaluate(() => Boolean(window.__TAURI__ && document.querySelector('#root'))).catch(() => false)) frames.push(frame);
  }
  assert.equal(frames.length, 1, 'AIO autostart created more than one workbench Webview.');
  const tabs = surface.page.locator('.tabs-container .tab').filter({ hasText: 'AIO 工作台' });
  assert.equal(await tabs.count(), 1, 'AIO autostart created more than one editor tab.');
  assert.ok(surface.report.text.includes('AIO') || surface.report.text.includes('项目'), 'AIO React workbench did not render.');
}

async function launch(_electron, code, profile, extensions, workspace) {
  const args = ['--new-window', '--disable-workspace-trust', '--disable-updates', '--skip-welcome', '--skip-release-notes',
    `--user-data-dir=${profile}`, `--extensions-dir=${extensions}`];
  if (workspace) args.push(workspace);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return _electron.launch({ executablePath: code, env, timeout: 60000, args });
}

async function runWindow(_electron, code, profile, extensions, workspace) {
  const app = await launch(_electron, code, profile, extensions, workspace);
  try {
    await app.firstWindow({ timeout: 60000 });
    const surface = await workbenchSurface(app);
    await verifySingleWorkbench(surface);
    return surface.report.version;
  } finally {
    await app.close();
  }
}

async function main() {
  const upstream = process.env.AIO_SOURCE || path.resolve(__dirname, '../../AIO');
  const { _electron } = createRequire(path.join(upstream, 'package.json'))('playwright');
  const code = process.env.VSCODE_EXECUTABLE_PATH;
  if (!code || !path.isAbsolute(code)) throw new Error('Set VSCODE_EXECUTABLE_PATH to Code.exe.');
  const vsix = path.resolve(process.argv[2] || path.join(__dirname, '../dist/aio-ide.vsix'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-autostart-'));
  const project = path.join(root, '首次项目');
  const profile = path.join(root, 'profile');
  const extensions = path.join(root, 'extensions');
  await Promise.all([fs.mkdir(project), fs.mkdir(path.join(profile, 'User'), { recursive: true })]);
  await fs.writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({ 'window.restoreWindows': 'none' }));
  await installVsix(code, vsix, [`--user-data-dir=${profile}`, `--extensions-dir=${extensions}`]);
  try {
    const first = await runWindow(_electron, code, profile, extensions, project);
    const restart = await runWindow(_electron, code, profile, extensions, project);
    const empty = await runWindow(_electron, code, profile, extensions, undefined);
    assert.equal(first, restart);
    assert.equal(restart, empty);
    process.stdout.write(JSON.stringify({ version: first, firstLaunch: 1, restart: 1, emptyWindow: 1, duplicateTabs: 0 }) + '\n');
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
