'use strict';

const assert = require('node:assert/strict');
const {
  compileClaudeFixture,
  openFreshClaudeTerminal,
  prepareClaudeFixture,
  reopenWorkbench,
} = require('./verify-workbench-clipboard.cjs');

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
  const trigger = frame.getByRole('button', { name: '显示左侧栏', exact: true }).first();
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

async function assertFullPage(frame, sidebar, expectedTitle) {
  await new Promise(resolve => setTimeout(resolve, 350));
  const boxes = await frame.evaluate(() => {
    const box = (selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect && { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const visible = (selector) => [...document.querySelectorAll(selector)].filter(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }).length;
    return {
      sidebar: box('.sidebar'),
      toolbar: box('.title-toolbar'),
      content: box('.workbench__content'),
      page: box('.workbench-page'),
      terminals: visible('.terminal-surface:not([hidden])'),
      composers: visible('.coding-cli-composer, .conversation-bottom-dock'),
    };
  });
  for (const name of ['sidebar', 'toolbar', 'content', 'page']) assert.ok(boxes[name], name + ' is missing on ' + expectedTitle + '.');
  const near = (left, right, label) => assert.ok(Math.abs(left - right) <= 2,
    expectedTitle + ' ' + label + ' differs by ' + Math.abs(left - right).toFixed(2) + 'px. ' + JSON.stringify(boxes));
  near(boxes.page.top, boxes.toolbar.bottom, 'top');
  near(boxes.page.bottom, boxes.content.bottom, 'bottom');
  near(boxes.page.left, boxes.sidebar.right, 'left');
  near(boxes.page.right, boxes.content.right, 'right');
  assert.equal(boxes.terminals, 0, expectedTitle + ' left a visible terminal occupying page space.');
  assert.equal(boxes.composers, 0, expectedTitle + ' left a visible composer occupying page space.');
  assert.equal(await sidebar.isVisible(), true);
  return boxes;
}

async function verifyPageBack(window, initialFrame, project) {
  const executable = await compileClaudeFixture(project);
  await prepareClaudeFixture(initialFrame, executable);
  const frame = await reopenWorkbench(window, initialFrame);
  const workbenchTab = window.locator('.tabs-container .tab').filter({ hasText: 'AIO 工作台' });
  assert.equal(await workbenchTab.count(), 1);
  const initialTitle = await pageTitle(frame);
  assert.notEqual(initialTitle, '项目');
  assert.notEqual(initialTitle, '设置');

  const terminal = await openFreshClaudeTerminal(window, frame);
  await frame.evaluate(() => { window.__aioPageBackTerminal = document.querySelector('.xterm'); });
  const composer = frame.locator('.coding-cli-composer textarea:visible, .composer textarea:visible').first();
  await composer.click();
  await window.keyboard.type('PAGE-BACK-DRAFT');
  assert.equal(await composer.inputValue(), 'PAGE-BACK-DRAFT');

  let sidebar = await clickPage(frame, '项目');
  await assertPinned(window, frame, sidebar, '项目');
  await assertFullPage(frame, sidebar, '项目');
  sidebar = await clickPage(frame, '设置');
  await assertPinned(window, frame, sidebar, '设置');
  await assertFullPage(frame, sidebar, '设置');

  await closePage(frame);
  await waitFor(async () => await pageTitle(frame) === '项目', 'return to Projects');
  await assertPinned(window, frame, sidebar, '项目');
  await assertFullPage(frame, sidebar, '项目');
  await closePage(frame);
  await waitFor(async () => (await frame.locator('.workbench-page').count()) === 0 && await terminal.isVisible(), 'return to session');

  await moveToWorkArea(window, frame);
  await waitFor(async () => await sidebar.getAttribute('data-collapsed') === 'true'
    || (await sidebar.getAttribute('class') || '').includes('aio-panel-hidden'), 'session sidebar auto-hide', 6000);
  assert.equal(await terminal.isVisible(), true, 'Returning to session did not restore the existing terminal.');
  assert.equal(await frame.evaluate(() => document.querySelector('.xterm') === window.__aioPageBackTerminal), true,
    'Page navigation replaced or closed the terminal.');
  assert.equal(await composer.isVisible(), true, 'Returning to session did not restore the composer.');
  assert.equal(await composer.inputValue(), 'PAGE-BACK-DRAFT', 'Page navigation lost the unsent composer draft.');
  assert.equal(await workbenchTab.count(), 1, 'Page close button closed the AIO editor tab.');

  return {
    history: [initialTitle, '项目', '设置', '项目', initialTitle],
    sidebarPinnedOnPages: true,
    sidebarAutoHiddenOnSession: true,
    terminalPreserved: true,
    composerDraftPreserved: true,
    pagesFillAvailableArea: true,
    noTerminalOrComposerOnPages: true,
    workbenchTabs: 1,
  };
}

module.exports = { verifyPageBack };
