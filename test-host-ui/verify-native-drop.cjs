'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function waitForFile(filename, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = await fs.readFile(filename, 'utf8').catch(() => undefined);
    if (text !== undefined) return text;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for native terminal drop result.');
}

async function dragExplorerItemToTerminal(window, source) {
  const target = window.locator('.panel .xterm-screen').last();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  assert.ok(sourceBox && targetBox, 'Explorer source and native terminal must both be visible.');

  await window.mouse.move(sourceBox.x + Math.min(16, sourceBox.width / 2), sourceBox.y + sourceBox.height / 2);
  await window.mouse.down();
  await window.mouse.move(sourceBox.x + 16, sourceBox.y + sourceBox.height / 2 + 2, { steps: 4 });
  await new Promise(resolve => setTimeout(resolve, 200));
  await window.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 24 });
  await new Promise(resolve => setTimeout(resolve, 250));
  await window.mouse.up();
}

function droppedPath(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
}

async function verifyOneDrop(window, project, source, expectedPath) {
  const result = path.join(project, 'omp.focus');
  await fs.rm(result, { force: true });
  await dragExplorerItemToTerminal(window, source);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(await fs.stat(result).catch(() => null), null,
    'Dropping an Explorer path must fill the terminal input without submitting it.');

  await window.keyboard.press('Enter');
  const received = droppedPath(await waitForFile(result));
  assert.equal(path.resolve(received).toLowerCase(), path.resolve(expectedPath).toLowerCase(),
    'The native terminal must receive only the dropped project path.');
  await fs.rm(result, { force: true });
}

/**
 * Real Windows VS Code probe for the extension-created integrated terminal.
 * It uses Explorer's default drag behavior without Shift or the clipboard.
 */
async function verifyNativeDrop(window, project) {
  assert.equal(process.platform, 'win32', 'Native terminal drop acceptance is Windows-specific.');
  const directory = path.join(project, 'drop-folder');
  await fs.mkdir(directory, { recursive: true });
  const activity = window.locator('.activitybar');
  const aioTab = activity.getByRole('tab', { name: /^AIO\b/i });
  const explorerTab = activity.getByRole('tab', { name: /^(Explorer|资源管理器)\b/i });
  const cases = [
    { label: 'first.txt', expected: path.join(project, 'first.txt') },
    { label: path.basename(directory), expected: directory },
  ];

  for (const item of cases) {
    const aioSidebar = window.locator('.part.sidebar');
    if (!(await aioSidebar.getByText('OMP', { exact: true }).isVisible().catch(() => false))) await aioTab.click();
    await aioSidebar.getByText('OMP', { exact: true }).click();
    await window.waitForFunction(() => Boolean(document.activeElement?.closest('.xterm')));

    await explorerTab.click();
    const explorer = window.locator('.part.sidebar');
    const source = explorer.getByText(item.label, { exact: true }).first();
    await source.waitFor({ state: 'visible' });
    await source.click();
    await verifyOneDrop(window, project, source, item.expected);
  }

  await aioTab.click();
  return { filePath: true, directoryPath: true, submittedByDrop: false, clipboardUsed: false };
}

module.exports = { dragExplorerItemToTerminal, verifyNativeDrop };
