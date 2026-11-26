'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync, spawn } = require('node:child_process');

async function waitForFile(filename, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fs.stat(filename).catch(() => null)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for ' + filename);
}

async function preserveWindowsClipboard(root) {
  if (process.platform !== 'win32') return async () => {};
  const ready = path.join(root, 'clipboard-ready');
  const restore = path.join(root, 'clipboard-restore');
  const helper = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-STA', '-File',
    path.join(__dirname, 'preserve-clipboard.ps1'), ready, restore,
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let error = '';
  helper.stderr.on('data', chunk => { error += chunk; });
  await Promise.race([
    waitForFile(ready),
    new Promise((_, reject) => helper.once('exit', code => reject(new Error(`Clipboard helper exited ${code}: ${error}`)))),
  ]);
  return async () => {
    await fs.writeFile(restore, 'restore');
    await Promise.race([
      new Promise((resolve, reject) => helper.once('exit', code => code === 0 ? resolve() : reject(new Error(`Clipboard restore failed ${code}: ${error}`)))),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Clipboard restore timed out')), 10000)),
    ]);
  };
}

async function installVsix(code, vsix, profileArguments) {
  const directory = path.dirname(code);
  const candidates = [directory];
  for (const entry of await fs.readdir(directory)) {
    if (/^[0-9a-f]{8,}$/i.test(entry)) candidates.push(path.join(directory, entry));
  }
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

async function main() {
  const upstream = process.env.AIO_SOURCE || path.resolve(__dirname, '../../AIO');
  const { _electron } = createRequire(path.join(upstream, 'package.json'))('playwright');
  const code = process.env.VSCODE_EXECUTABLE_PATH;
  if (!code || !path.isAbsolute(code)) throw new Error('Set VSCODE_EXECUTABLE_PATH to the absolute path of Code.exe.');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-webview-'));
  const project = path.join(root, 'project');
  const importedProject = path.join(root, '导入 项目');
  const clipboardTest = process.env.AIO_TEST_CLIPBOARD === '1' || process.env.AIO_TEST_WORKBENCH_CLIPBOARD === '1';
  await fs.mkdir(project);
  await fs.mkdir(importedProject);
  for (const file of ['first.txt', 'second.txt']) await fs.writeFile(path.join(project, file), file);
  let app;
  let restoreClipboard = async () => {};
  try {
    if (clipboardTest) restoreClipboard = await preserveWindowsClipboard(root);
    if (process.platform === 'win32') {
      const settings = {};
      for (const cli of ['omp', 'claude', 'codex']) {
        const shim = path.join(root, cli + '.cmd');
        const commands = ['@echo off', 'chcp 65001 >nul'];
        if (clipboardTest && cli === 'omp') commands.push(
          'for /L %%i in (1,1,80) do echo AIO-COPY AIO-COPY AIO-COPY AIO-COPY AIO-COPY AIO-COPY AIO-COPY AIO-COPY',
          `> "${path.join(project, cli + '.ready')}" echo ready`,
        );
        commands.push('set /p "typed="', '> ' + cli + '.focus echo %typed%', '');
        await fs.writeFile(shim, commands.join('\r\n'));
        settings['aio.' + cli + 'Path'] = shim;
      }
      const user = path.join(root, 'profile', 'User');
      await fs.mkdir(user, { recursive: true });
      await fs.writeFile(path.join(user, 'settings.json'), JSON.stringify(settings));
    }
    const env = { ...process.env, AIO_TEST_PROJECT_IMPORT_PATH: importedProject };
    delete env.ELECTRON_RUN_AS_NODE;
    const profileArgs = ['--user-data-dir=' + path.join(root, 'profile'), '--extensions-dir=' + path.join(root, 'extensions')];
    let developmentPath = path.resolve(process.env.AIO_EXTENSION_PATH || path.join(__dirname, '..'));
    if (process.argv[2]) {
      await installVsix(code, path.resolve(process.argv[2]), profileArgs);
      // The test harness is the development extension. AIO itself must resolve
      // from the VSIX installed in this profile.
      developmentPath = path.join(root, 'ui-test');
      await fs.mkdir(developmentPath);
      await fs.writeFile(path.join(developmentPath, 'package.json'), JSON.stringify({
        name: 'ui-test', publisher: 'local', version: '0.0.1', engines: { vscode: '^1.97.0' },
      }));
    }
    app = await _electron.launch({
      executablePath: code, env, timeout: 60000,
      args: ['--new-window', '--disable-workspace-trust', '--disable-updates',
        '--skip-welcome', '--skip-release-notes', ...profileArgs,
        '--extensionDevelopmentPath=' + developmentPath,
        '--extensionTestsPath=' + path.join(__dirname, 'open.cjs'), project],
    });
    const window = await app.firstWindow();
    if (process.env.AIO_TEST_PREVIEW_GROUP === '1') await fs.writeFile(path.join(project, '.aio-open-preview-now'), '');
    const aioTab = window.locator('.activitybar').getByRole('tab', { name: /^AIO\b/i });
    const sidebar = window.locator('.part.sidebar');
    if (process.env.AIO_TEST_PREVIEW_GROUP !== '1') {
      await aioTab.click();
      for (const label of ['OMP', 'Claude Code', 'Codex', '完整工作台']) {
        await sidebar.getByText(label, { exact: true }).waitFor({ state: 'visible' });
      }
    }
    const errors = [];
    window.on('pageerror', (error) => errors.push(error.message));
    window.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text().slice(0, 300)); });
    const deadline = Date.now() + 75000;
    if (process.env.AIO_TEST_AUTO_PANELS === '1') await fs.writeFile(path.join(project, '.aio-open-panels-now'), '');
    while (Date.now() < deadline) {
      for (const frame of window.frames()) {
        const ready = await frame.evaluate(() =>
          Boolean(window.__TAURI__ && document.querySelector('#root button') && document.querySelector('#root')?.innerText.trim())
        ).catch(() => false);
        if (!ready) continue;
        if (process.env.AIO_TEST_AUTO_PANELS === '1') {
          console.log(await require('./verify-auto-panels.cjs').verifyAutoPanels(window, frame, app));
          return;
        }
        if (process.env.AIO_TEST_PREVIEW_GROUP === '1') {
          console.log(await require('./verify-preview-group.cjs').verifyPreviewGroup(window, frame, project));
          return;
        }
        await frame.waitForFunction(() => document.documentElement.dataset.theme === 'dark', undefined, { timeout: 10000 });
        const report = await frame.evaluate(async () => {
          const invoke = (channel, ...args) => window.__TAURI__.core.invoke('desktop_request', { channel, args });
          const [meta, plugins, projects] = await Promise.all([invoke('app:get-meta'), invoke('coding-plugins:list'), invoke('projects:list-initial')]);
          const project = projects.find(item => item.name === 'project');
          const worktrees = project && await invoke('projects:list-worktrees', project.primaryFolder);
          return { version: meta.version, plugins: plugins.map(plugin => plugin.id), projects: projects.map(p => p.name), worktrees, ui: document.querySelector('#root').innerText.slice(0, 200) };
        });
        assert.deepEqual(report.plugins, ['omp', 'claude', 'codex']);
        if (!report.projects.includes('project')) continue;
        assert.deepEqual(report.worktrees, []);
        if (process.env.AIO_TEST_PROJECT_IMPORT === '1') {
          console.log(await require('./verify-project-import.cjs').verifyProjectImport(frame, project, importedProject));
          return;
        }
        await require('./verify-split.cjs').verifySplit(window, frame);
        if (process.env.AIO_TEST_FILE_DROP === '1') {
          console.log(await require('./verify-drop.cjs').verifyDrop(window, frame, project));
        }
        if (process.env.AIO_TEST_NATIVE_DROP === '1') {
          await require('./verify-native-drop.cjs').verifyNativeDrop(window, project);
        }
        if (process.env.AIO_TEST_WORKBENCH_CLIPBOARD === '1') {
          console.log(await require('./verify-workbench-clipboard.cjs').verifyWorkbenchClipboard(window, frame, app, project, process.execPath));
        }
        if (process.env.AIO_TEST_KEY_ROUTING === '1') {
          console.log(await require('./verify-key-routing.cjs').verifyKeyRouting(window, frame, project));
          return;
        }
        if (process.env.AIO_TEST_FILE_DROP === '1' || process.env.AIO_TEST_NATIVE_DROP === '1') return;
        if (process.platform === 'win32') {
          for (const [cli, label] of [['omp', 'OMP'], ['claude', 'Claude Code'], ['codex', 'Codex']]) {
            await sidebar.getByText(label, { exact: true }).click();
            await window.waitForFunction(() => !!document.activeElement?.closest('.xterm'));
            const token = clipboardTest && cli === 'omp' ? '粘贴-终端-OMP' : 'focus-' + cli;
            if (clipboardTest && cli === 'omp') {
              await waitForFile(path.join(project, cli + '.ready'));
              await new Promise(resolve => setTimeout(resolve, 300));
              const screen = window.locator('.panel .xterm-screen').last();
              const box = await screen.boundingBox();
              assert.ok(box, 'The OMP terminal screen must be visible.');
              const copy = window.locator('.panel .title-actions').getByRole('button', { name: '复制终端选区' });
              await copy.waitFor({ state: 'visible' });
              let copied = '';
              const marker = 'AIO-COPY';
              // The fixture fills the viewport so mouse selection does not depend
              // on a particular font, row height, or terminal startup position.
              const y = box.y + box.height / 2;
              await app.evaluate(({ clipboard }) => clipboard.writeText(''));
              await window.mouse.move(box.x + box.width / 3, y);
              await window.mouse.down();
              await window.mouse.move(box.x + box.width * 2 / 3, y, { steps: 8 });
              await window.mouse.up();
              const selectionDeadline = Date.now() + 2000;
              while (Date.now() < selectionDeadline && !(await copy.isEnabled())) {
                await new Promise(resolve => setTimeout(resolve, 50));
              }
              if (await copy.isEnabled()) {
                await copy.click();
                const copyDeadline = Date.now() + 2000;
                while (Date.now() < copyDeadline && !copied.includes(marker)) {
                  copied = await app.evaluate(({ clipboard }) => clipboard.readText());
                  if (!copied.includes(marker)) await new Promise(resolve => setTimeout(resolve, 50));
                }
              }
              assert.ok(copied.includes(marker), 'The terminal title copy action did not copy the mouse selection.');

              await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), token);
              await window.getByRole('button', { name: '粘贴到终端' }).click();
              await new Promise(resolve => setTimeout(resolve, 300));
              assert.equal(await fs.stat(path.join(project, cli + '.focus')).catch(() => null), null,
                'Pasting must fill the CLI input without submitting it.');
            } else {
              await window.keyboard.type(token);
            }
            await window.keyboard.press('Enter');
            const output = path.join(project, cli + '.focus');
            const until = Date.now() + 10000;
            while (Date.now() < until && !(await fs.readFile(output, 'utf8').catch(() => '')).trim()) {
              await new Promise(resolve => setTimeout(resolve, 100));
            }
            assert.equal((await fs.readFile(output, 'utf8')).trim(), token);
          }
        }
        console.log(JSON.stringify(report));
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    throw new Error('Workbench React root did not render. ' + errors.slice(-15).join('\n'));
  } finally {
    if (app) await app.close();
    await restoreClipboard();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
