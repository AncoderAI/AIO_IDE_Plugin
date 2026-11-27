'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function waitFor(predicate, description, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for ' + description);
}

function separated(left, right) {
  return left.x + left.width <= right.x + 2 || right.x + right.width <= left.x + 2
    || left.y + left.height <= right.y + 2 || right.y + right.height <= left.y + 2;
}

async function editorGroups(window) {
  return window.locator('.editor-group-container').evaluateAll(groups => groups.map(group => {
    const rect = group.getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  }));
}

async function verifyPreviewGroup(window, frame, project) {
  const editor = window.locator('.monaco-editor[data-uri$="/first.txt"]').first();
  await editor.waitFor({ state: 'attached' });
  const tab = window.locator('.tab').filter({ hasText: 'first.txt' }).first();
  await tab.waitFor({ state: 'attached' });

  const initialWorkbench = await (await frame.frameElement()).boundingBox();
  assert.ok(initialWorkbench);
  const groupCount = (await editorGroups(window)).length;
  await waitFor(async () => {
    const fileBox = await editor.boundingBox();
    return !fileBox || fileBox.width < 40;
  }, 'file preview to start collapsed');
  const expandedWorkbench = await (await frame.frameElement()).boundingBox();
  assert.ok(expandedWorkbench && expandedWorkbench.width >= initialWorkbench.width, 'AIO did not start with the preview width released.');
  assert.equal((await editorGroups(window)).length, groupCount, 'Collapsing preview must preserve editor group count.');
  assert.equal(await tab.count(), 1, 'The open file tab was discarded while its group was collapsed.');
  const previewEdge = frame.locator('.aio-file-preview-edge').first();
  await previewEdge.waitFor({ state: 'visible' });
  const sidebarButton = frame.locator('.aio-panel-toggle-left');
  const assertButtonOrder = async () => {
    await previewEdge.waitFor({ state: 'visible' });
    await sidebarButton.waitFor({ state: 'visible' });
    const previewButtonBox = await previewEdge.boundingBox();
    const sidebarButtonBox = await sidebarButton.boundingBox();
    assert.ok(previewButtonBox && sidebarButtonBox && previewButtonBox.x + previewButtonBox.width <= sidebarButtonBox.x + 1,
      'File preview must appear to the left of the sidebar button.');
  };
  await assertButtonOrder();
  assert.equal(await previewEdge.getAttribute('aria-keyshortcuts'), null);
  await previewEdge.focus();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.ok(((await editor.boundingBox())?.width || 0) < 40, 'Keyboard focus must not reveal the file preview.');
  await previewEdge.evaluate(element => element.click());
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.ok(((await editor.boundingBox())?.width || 0) < 40, 'Programmatic click must not reveal the file preview.');
  await previewEdge.hover();
  await waitFor(async () => ((await editor.boundingBox())?.width || 0) > 120, 'file preview button hover to restore the file group');
  const restoredEditor = await editor.boundingBox();
  const restoredWorkbench = await (await frame.frameElement()).boundingBox();
  assert.ok(restoredEditor && restoredWorkbench && separated(restoredEditor, restoredWorkbench));
  await assertButtonOrder();
  const marker = 'AIO_PREVIEW_SAVED_73491';
  await editor.click();
  await window.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await window.keyboard.type(marker);
  await window.keyboard.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
  await waitFor(async () => (await fs.readFile(path.join(project, 'first.txt'), 'utf8').catch(() => '')).includes(marker), 'saved editor contents');
  const workbench = frame.locator('.workbench');
  const workbenchBox = await workbench.boundingBox();
  await workbench.hover({ position: { x: workbenchBox.width / 2, y: Math.min(80, workbenchBox.height / 2) } });
  await waitFor(async () => ((await editor.boundingBox())?.width || 0) < restoredEditor.width * 0.7, 'saved preview group to collapse');
  await assertButtonOrder();
  await previewEdge.hover();
  await waitFor(async () => (await editor.boundingBox())?.width > restoredEditor.width * 0.7, 'saved preview group restore');
  assert.ok((await editor.locator('.view-lines').innerText()).includes(marker), 'Restored editor lost its saved model text.');

  await editor.click();
  await workbench.hover({ position: { x: workbenchBox.width / 2, y: Math.min(80, workbenchBox.height / 2) } });
  await waitFor(async () => ((await editor.boundingBox())?.width || 0) < restoredEditor.width * 0.7,
    'focused file preview to collapse after pointer exit');

  await previewEdge.hover();
  await waitFor(async () => (await editor.boundingBox())?.width > restoredEditor.width * 0.7,
    'file preview restore before adding a third group');
  await editor.click();
  await window.keyboard.press(process.platform === 'darwin' ? 'Meta+\\' : 'Control+\\');
  await waitFor(async () => (await editorGroups(window)).length > groupCount, 'third editor group');
  await new Promise(resolve => setTimeout(resolve, 700));
  const complexBefore = await editorGroups(window);
  await window.evaluate(() => { window.__aioComplexGroups = [...document.querySelectorAll('.editor-group-container')]; });
  await workbench.click({ position: { x: workbenchBox.width / 2, y: Math.min(80, workbenchBox.height / 2) } });
  await new Promise(resolve => setTimeout(resolve, 2500));
  const complexAfter = await editorGroups(window);
  assert.equal(complexAfter.length, complexBefore.length, 'Complex editor layout was regrouped.');
  assert.equal(await window.evaluate(() => {
    const current = [...document.querySelectorAll('.editor-group-container')];
    return current.length === window.__aioComplexGroups.length
      && current.every((group, index) => group === window.__aioComplexGroups[index]);
  }), true, 'Complex editor group nodes or order changed.');
  assert.ok(complexAfter.every((group, index) => index === 0 || group.x > complexAfter[index - 1].x),
    'Complex editor groups no longer preserve their left-to-right order.');

  return {
    initiallyCollapsed: true,
    hoverOnly: true,
    releasedWidth: Math.round(expandedWorkbench.width - restoredWorkbench.width),
    restored: true,
    savedTextPreserved: true,
    tabPreserved: true,
    focusedExitCollapsed: true,
    complexGroups: complexAfter.length,
  };
}

module.exports = { editorGroups, verifyPreviewGroup };
