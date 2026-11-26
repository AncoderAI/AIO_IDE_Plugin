'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  openFreshClaudeTerminal,
  prepareClaudeFixture,
  reopenWorkbench,
} = require('./verify-workbench-clipboard.cjs');

async function waitFor(predicate, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function compileKeyFixture(project) {
  const source = path.join(project, 'key-routing-fixture.cs');
  const executable = path.join(project, 'key-routing-fixture.exe');
  const log = path.join(project, 'key-routing.log');
  const ready = path.join(project, 'key-routing.ready');
  const logLiteral = log.replaceAll('"', '""');
  const readyLiteral = ready.replaceAll('"', '""');
  await fs.writeFile(source, `
using System;
using System.IO;
using System.Text;
class KeyRoutingFixture {
  static int Main(string[] args) {
    Console.InputEncoding = new UTF8Encoding(false);
    Console.OutputEncoding = new UTF8Encoding(false);
    if (args.Length == 1 && args[0] == "--version") { Console.WriteLine("1.0.0 (Claude Code)"); return 0; }
    Console.WriteLine("AIO-KEY-ROUTING-READY");
    File.WriteAllText(@"${readyLiteral}", "ready", new UTF8Encoding(false));
    while (true) {
      ConsoleKeyInfo key = Console.ReadKey(true);
      string value;
      if (key.Key == ConsoleKey.Escape) value = "ESC";
      else if (key.Key == ConsoleKey.LeftArrow) value = "LEFT";
      else if (key.Key == ConsoleKey.Tab && (key.Modifiers & ConsoleModifiers.Shift) != 0) value = "SHIFT_TAB";
      else if (!Char.IsControl(key.KeyChar)) value = "CHAR:" + key.KeyChar;
      else value = "KEY:" + key.Key;
      File.AppendAllText(@"${logLiteral}", value + "\\n", new UTF8Encoding(false));
    }
  }
}`, 'utf8');
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  execFileSync(compiler, ['/nologo', '/target:exe', '/out:' + executable, source], { windowsHide: true, stdio: 'pipe' });
  return { executable, log, ready };
}

async function logLines(filename) {
  const text = await fs.readFile(filename, 'utf8').catch(() => '');
  return text.split(/\r?\n/).filter(Boolean);
}

async function openTextEditor(window, filename) {
  const activity = window.locator('.activitybar');
  await activity.getByRole('tab', { name: /^(Explorer|资源管理器)\b/i }).click();
  const explorer = window.locator('.part.sidebar');
  await explorer.getByText(path.basename(filename), { exact: true }).first().click();
  const editorRoot = window.locator('.monaco-editor[data-uri$="/first.txt"]:visible').last();
  const editor = editorRoot.locator('.view-lines');
  await editor.waitFor({ state: 'visible' });
  return { editor, editorRoot };
}

async function verifyKeyRouting(window, initialFrame, project) {
  assert.equal(process.platform, 'win32', 'Key-routing acceptance currently targets Windows.');
  const fixture = await compileKeyFixture(project);
  await fs.rm(fixture.log, { force: true });
  await prepareClaudeFixture(initialFrame, fixture.executable);
  const frame = await reopenWorkbench(window, initialFrame);
  await openFreshClaudeTerminal(window, frame);
  await waitFor(() => fs.stat(fixture.ready).catch(() => undefined), 'Key-routing fixture did not become ready.');

  const blank = frame.locator('.conversation-pane:visible').first();
  await blank.click({ position: { x: 20, y: 20 } });
  await window.keyboard.type('/x');
  await window.keyboard.press('Escape');
  await window.keyboard.press('ArrowLeft');
  await window.keyboard.press('Shift+Tab');
  const expected = ['CHAR:/', 'CHAR:x', 'ESC', 'LEFT', 'SHIFT_TAB'];
  // ConPTY may deliver the escape sequences in separate scheduler turns.
  await new Promise(resolve => setTimeout(resolve, 500));
  const routed = await waitFor(async () => {
    const lines = await logLines(fixture.log);
    return expected.every(value => lines.includes(value)) ? lines : undefined;
  }, 'AIO blank-area key routing did not reach the active xterm.');

  const beforeMenu = await logLines(fixture.log);
  const picker = frame.getByTestId('coding-runtime-select').getByRole('button').first();
  await picker.click();
  await window.keyboard.press('ArrowDown');
  await window.keyboard.press('Escape');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(await logLines(fixture.log), beforeMenu, 'Menu navigation leaked into the xterm.');

  await frame.locator('.terminal-tabs > button').last().click();
  await waitFor(() => frame.locator('.terminal-tab').count().then(count => count >= 2), 'Second xterm did not open.');
  const tabs = frame.locator('.terminal-tab > button[role="tab"]');
  await tabs.nth(0).click();
  await waitFor(() => frame.locator('.terminal-surface:not([hidden]) .xterm').evaluate((element) => element.contains(document.activeElement)),
    'First xterm did not focus after tab switch.');
  await tabs.nth(1).click();
  await waitFor(() => frame.locator('.terminal-surface:not([hidden]) .xterm').evaluate((element) => element.contains(document.activeElement)),
    'Second xterm did not focus after tab switch.');

  const composer = frame.locator('.coding-cli-composer textarea:visible, .composer textarea:visible').first();
  await composer.click();
  await window.keyboard.type('COMPOSER-INPUT');
  assert.equal(await composer.inputValue(), 'COMPOSER-INPUT');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.deepEqual(await logLines(fixture.log), routed, 'Composer input leaked into the xterm.');

  const file = path.join(project, 'first.txt');
  const { editor, editorRoot } = await openTextEditor(window, file);
  const editorBox = await editor.boundingBox();
  assert.ok(editorBox, 'The first.txt Monaco editor must be visible.');
  await editor.click({ position: { x: Math.min(120, editorBox.width - 4), y: 10 } });
  const activeEditorUri = await window.evaluate(() => document.activeElement?.closest('.monaco-editor')?.getAttribute('data-uri'));
  assert.equal(activeEditorUri, await editorRoot.getAttribute('data-uri'), 'Clicking first.txt did not focus its Monaco editor.');
  await window.keyboard.type('EDITOR-');
  await blank.hover();
  await window.keyboard.type('HOVER');
  await window.keyboard.press('Control+S');
  await waitFor(async () => (await fs.readFile(file, 'utf8').catch(() => '')).includes('EDITOR-HOVER'),
    'File editor did not retain keyboard focus while hovering AIO.');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.deepEqual(await logLines(fixture.log), routed, 'File editor or hover input leaked into the xterm.');
  await window.locator('.activitybar').getByRole('tab', { name: /^AIO\b/i }).click();

  return {
    blankAreaFocusedTerminal: true,
    slashCharacter: true,
    escape: true,
    arrow: true,
    shiftTab: true,
    composerOwnsInput: true,
    editorOwnsInput: true,
    hoverDoesNotActivate: true,
    menuKeysStayInMenu: true,
    terminalSwitchFocusesVisibleXterm: true,
  };
}

module.exports = { verifyKeyRouting };
