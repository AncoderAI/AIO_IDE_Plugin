'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

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
  await fs.mkdir(project);
  let app;
  try {
    const env = { ...process.env };
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
    const aioTab = window.locator('.activitybar').getByRole('tab', { name: /^AIO\b/i });
    await aioTab.click();
    const sidebar = window.locator('.part.sidebar');
    for (const label of ['OMP', 'Claude Code', 'Codex', '完整工作台']) {
      await sidebar.getByText(label, { exact: true }).waitFor({ state: 'visible' });
    }
    const errors = [];
    window.on('pageerror', (error) => errors.push(error.message));
    window.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text().slice(0, 300)); });
    const deadline = Date.now() + 75000;
    while (Date.now() < deadline) {
      for (const frame of window.frames()) {
        const ready = await frame.evaluate(() =>
          Boolean(window.__TAURI__ && document.querySelector('#root button') && document.querySelector('#root')?.innerText.trim())
        ).catch(() => false);
        if (!ready) continue;
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
        console.log(JSON.stringify(report));
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    throw new Error('Workbench React root did not render. ' + errors.slice(-15).join('\n'));
  } finally {
    if (app) await app.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
