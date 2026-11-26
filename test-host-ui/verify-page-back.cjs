'use strict';

const assert = require('node:assert/strict');

async function waitFor(predicate, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for ' + description);
}

async function pageTitle(frame) {
  return frame.locator('.title-toolbar__identity strong').innerText();
}

async function revealSidebar(frame) {
  const sidebar = frame.locator('.auto-hide-panel--sidebar, .app-shell > .sidebar').first();
  const collapsed = async () => await sidebar.getAttribute('data-collapsed') === 'true'
    || (await sidebar.getAttribute('class') || '').includes('aio-panel-hidden');
  if (await sidebar.isVisible().catch(() => false)
    && !await collapsed()) return sidebar;
  const trigger = frame.locator('.panel-edge-trigger--sidebar, .aio-panel-edge--left').first();
  await trigger.hover({ force: true });
  await waitFor(async () => await sidebar.isVisible().catch(() => false) && !await collapsed(), 'sidebar reveal');
  return sidebar;
}

async function clickPage(frame, label) {
  const sidebar = await revealSidebar(frame);
  await sidebar.getByText(label, { exact: true }).last().click();
  await waitFor(async () => await pageTitle(frame) === label, `${label} page`);
  return sidebar;
}

async function closePage(frame) {
  const close = frame.getByRole('button', { name: /^(关闭页面|返回上一界面|Close page|Back)$/ }).last();
  const svg = close.locator('svg');
  const text = (await close.innerText()).trim();
  assert.ok(await svg.count() === 1 || text === '×', 'Page back control must render as the right-side X icon button.');
  await close.click();
}

async function moveToWorkArea(window, frame) {
  const box = await (await frame.frameElement()).boundingBox();
  const viewport = await frame.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(box);
  await window.mouse.move(box.x + viewport.width - 20, box.y + Math.min(90, viewport.height / 2));
}

async function assertPinned(window, frame, sidebar, expectedTitle) {
  await moveToWorkArea(window, frame);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(await pageTitle(frame), expectedTitle);
  assert.equal(await sidebar.isVisible(), true, `Sidebar disappeared on ${expectedTitle}.`);
  assert.notEqual(await sidebar.getAttribute('data-collapsed'), 'true', `Sidebar collapsed on ${expectedTitle}.`);
  assert.equal((await sidebar.getAttribute('class') || '').includes('aio-panel-hidden'), false, `Sidebar collapsed on ${expectedTitle}.`);
}

async function verifyPageBack(window, frame) {
  const workbenchTab = window.locator('.tabs-container .tab').filter({ hasText: 'AIO 工作台' });
  assert.equal(await workbenchTab.count(), 1);
  const initialTitle = await pageTitle(frame);
  assert.notEqual(initialTitle, '项目');
  assert.notEqual(initialTitle, '设置');

  const terminalButton = frame.getByRole('button', { name: /(切换终端|Toggle terminal)/ }).first();
  await terminalButton.click();
  const terminal = frame.locator('.xterm').first();
  await terminal.waitFor({ state: 'visible' });
  await frame.evaluate(() => { window.__aioPageBackTerminal = document.querySelector('.xterm'); });

  let sidebar = await clickPage(frame, '项目');
  await assertPinned(window, frame, sidebar, '项目');
  sidebar = await clickPage(frame, '设置');
  await assertPinned(window, frame, sidebar, '设置');

  await closePage(frame);
  await waitFor(async () => await pageTitle(frame) === '项目', 'return to Projects');
  await assertPinned(window, frame, sidebar, '项目');
  await closePage(frame);
  await waitFor(async () => await pageTitle(frame) === initialTitle, 'return to session');

  await moveToWorkArea(window, frame);
  await waitFor(async () => await sidebar.getAttribute('data-collapsed') === 'true'
    || (await sidebar.getAttribute('class') || '').includes('aio-panel-hidden'), 'session sidebar auto-hide', 6000);
  assert.equal(await terminal.isVisible(), true, 'Returning to session did not restore the existing terminal.');
  assert.equal(await frame.evaluate(() => document.querySelector('.xterm') === window.__aioPageBackTerminal), true,
    'Page navigation replaced or closed the terminal.');
  assert.equal(await workbenchTab.count(), 1, 'Page close button closed the AIO editor tab.');

  return {
    history: [initialTitle, '项目', '设置', '项目', initialTitle],
    sidebarPinnedOnPages: true,
    sidebarAutoHiddenOnSession: true,
    terminalPreserved: true,
    workbenchTabs: 1,
  };
}

module.exports = { verifyPageBack };
