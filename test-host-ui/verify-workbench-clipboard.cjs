'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

async function waitFor(predicate, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function aioFrame(window) {
  return waitFor(async () => {
    for (const frame of window.frames()) {
      if (await frame.evaluate(() => Boolean(window.__TAURI__ && document.querySelector('#root'))).catch(() => false)) return frame;
    }
  }, 'AIO workbench frame did not reload.');
}

async function prepareClaudeFixture(frame, executable) {
  await frame.evaluate(async (node) => {
    const invoke = (channel, ...args) => window.__TAURI__.core.invoke('desktop_request', { channel, args });
    await invoke('coding-plugins:set', 'claude', 'install');
    await invoke('coding-plugins:set-executable', 'claude', node);
  }, executable);
}

async function reopenWorkbench(window, oldFrame) {
  const tab = window.getByRole('tab', { name: /AIO 工作台/i }).first();
  await tab.click({ button: 'middle' });
  await waitFor(() => !window.frames().includes(oldFrame), 'The original AIO workbench did not close.');
  // The service persists plugin state during its graceful stdin shutdown.
  await new Promise(resolve => setTimeout(resolve, 1000));
  const activity = window.locator('.activitybar');
  const sidebar = window.locator('.part.sidebar');
  if (!(await sidebar.getByText('完整工作台', { exact: true }).isVisible().catch(() => false))) {
    await activity.getByRole('tab', { name: /^AIO\b/i }).click();
  }
  await sidebar.getByText('完整工作台', { exact: true }).click();
  return aioFrame(window);
}

async function compileClaudeFixture(project) {
  const source = path.join(project, 'clipboard-fixture.cs');
  const executable = path.join(project, 'clipboard-fixture.exe');
  const projectLiteral = project.replaceAll('"', '""');
  await fs.writeFile(source, `
using System;
using System.IO;
using System.Text;
class ClipboardFixture {
  static int Main(string[] args) {
    Console.InputEncoding = new UTF8Encoding(false);
    Console.OutputEncoding = new UTF8Encoding(false);
    if (args.Length == 1 && args[0] == "--version") { Console.WriteLine("1.0.0 (Claude Code)"); return 0; }
    for (int row = 0; row < 80; row++) Console.WriteLine("AIO-WEBVIEW-COPY AIO-WEBVIEW-COPY AIO-WEBVIEW-COPY AIO-WEBVIEW-COPY AIO-WEBVIEW-COPY");
    int index = 0;
    string line;
    while ((line = Console.ReadLine()) != null) {
      index++;
      File.WriteAllText(Path.Combine(@"${projectLiteral}", "workbench-input-" + index + ".txt"), line, new UTF8Encoding(false));
      Console.WriteLine("RECEIVED");
    }
    return 0;
  }
}`, 'utf8');
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  execFileSync(compiler, ['/nologo', '/target:exe', '/out:' + executable, source], { windowsHide: true, stdio: 'pipe' });
  return executable;
}

async function openFreshClaudeTerminal(window, frame) {
  await frame.evaluate(() => {
    window.addEventListener('aio:terminal-register', (event) => { window.__aioClipboardTestTerminal = event.detail; });
  });
  const picker = frame.getByTestId('coding-runtime-select').getByRole('button').first();
  await waitFor(() => picker.isVisible().catch(() => false), 'Claude fixture was not reflected in the workbench UI.');
  await picker.click();
  await frame.getByText('Claude Code', { exact: true }).last().click();
  await waitFor(() => frame.locator('.terminal-surface:not([hidden]) .xterm').isVisible().catch(() => false),
    'Claude fixture xterm did not open.');
  const terminal = frame.locator('.terminal-surface:not([hidden]) .xterm').last();
  await terminal.click();
  return terminal;
}

async function selectMiddleRow(window, terminal) {
  const screen = terminal.locator('.xterm-screen');
  const box = await screen.boundingBox();
  assert.ok(box, 'Workbench xterm screen must be visible.');
  // xterm's triple-click path selects the complete rendered row and is stable
  // across DPR, font, and webview iframe offsets.
  await screen.click({ position: { x: box.width / 2, y: box.height / 2 }, clickCount: 3 });
  await new Promise(resolve => setTimeout(resolve, 100));
}

async function readClipboardUntil(app, marker) {
  return waitFor(async () => {
    const text = await app.evaluate(({ clipboard }) => clipboard.readText());
    return text.includes(marker) ? text : undefined;
  }, 'Workbench xterm copy did not reach the OS clipboard.', 3000);
}

async function pasteAndSubmit(window, app, terminal, target, value, viaContextMenu) {
  await fs.rm(target, { force: true });
  await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), value);
  await terminal.click();
  if (viaContextMenu) {
    await terminal.click({ button: 'right' });
    const item = window.getByRole('menuitem', { name: /^(粘贴|Paste)$/i });
    await item.waitFor({ state: 'visible' });
    await item.click();
  } else {
    await window.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  }
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await fs.stat(target).catch(() => null), null, 'Pasting into xterm must not submit the command.');
  await window.keyboard.press('Enter');
  await waitFor(() => fs.readFile(target, 'utf8').catch(() => undefined), 'Pasted xterm command was not submitted by Enter.');
  assert.equal(await fs.readFile(target, 'utf8'), value);
}

/**
 * Real VS Code Webview+xterm clipboard acceptance. The caller must preserve
 * and restore the OS clipboard around this opt-in probe.
 */
async function verifyWorkbenchClipboard(window, initialFrame, app, project) {
  assert.equal(process.platform, 'win32', 'Workbench clipboard acceptance currently targets Windows.');
  const executable = await compileClaudeFixture(project);
  await prepareClaudeFixture(initialFrame, executable);
  const frame = await reopenWorkbench(window, initialFrame);
  const terminal = await openFreshClaudeTerminal(window, frame);
  const context = JSON.parse(await terminal.getAttribute('data-vscode-context'));
  assert.equal(context.webviewSection, 'aioTerminal');
  assert.equal(context.preventDefaultContextMenuItems, true);

  const marker = 'AIO-WEBVIEW-COPY';
  await new Promise(resolve => setTimeout(resolve, 400));
  await selectMiddleRow(window, terminal);
  const selection = await frame.evaluate((expected) => {
    const registered = window.__aioClipboardTestTerminal;
    const text = registered?.getSelection?.() || '';
    return { hasSelection: registered?.hasSelection?.() === true, length: text.length, markerMatched: text.includes(expected) };
  }, marker);
  assert.equal(selection.hasSelection, true, 'The registered xterm did not observe the mouse selection.');
  assert.equal(selection.markerMatched, true, 'The xterm mouse selection missed the fixture marker.');
  assert.ok(selection.length >= marker.length, 'The xterm mouse selection was unexpectedly empty.');
  await app.evaluate(({ clipboard }) => clipboard.writeText(''));
  await window.keyboard.press('Control+C');
  const shortcutCopy = await readClipboardUntil(app, marker);
  assert.ok(shortcutCopy.includes(marker), 'Ctrl+C did not copy the xterm mouse selection.');

  await selectMiddleRow(window, terminal);
  await app.evaluate(({ clipboard }) => clipboard.writeText(''));
  await terminal.click({ button: 'right' });
  const copyItem = window.getByRole('menuitem', { name: /^(复制|Copy)$/i });
  await copyItem.waitFor({ state: 'visible' });
  await copyItem.click();
  const contextCopy = await readClipboardUntil(app, marker);
  assert.ok(contextCopy.includes(marker), 'The xterm context-menu copy command did not copy its selection.');

  await pasteAndSubmit(window, app, terminal, path.join(project, 'workbench-input-1.txt'), 'Ctrl+V 粘贴', false);
  await pasteAndSubmit(window, app, terminal, path.join(project, 'workbench-input-2.txt'), '右键粘贴', true);
  return { mouseSelection: true, ctrlCopy: true, ctrlPaste: true, contextCopy: true, contextPaste: true, pasteSubmitted: false };
}

module.exports = { verifyWorkbenchClipboard };
