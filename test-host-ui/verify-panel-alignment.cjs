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

async function geometry(frame) {
  return frame.evaluate(() => {
    const rect = (selector) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box && { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    };
    const visibleRect = (selector) => {
      for (const element of document.querySelectorAll(selector)) {
        const box = element.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) {
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
        }
      }
    };
    const sidebar = document.querySelector('.sidebar');
    const content = document.querySelector('.workbench__content');
    return {
      sidebar: rect('.sidebar'),
      content: rect('.workbench__content'),
      terminal: rect('.terminal-surface:not([hidden])'),
      composer: visibleRect('.coding-cli-composer, .conversation-bottom-dock .composer'),
      opacity: sidebar ? Number.parseFloat(getComputedStyle(sidebar).opacity) : 0,
      marginLeft: content ? Number.parseFloat(getComputedStyle(content).marginLeft) : 0,
      sidebarClass: sidebar?.className || '',
    };
  });
}

function assertSeparated(sample, phase) {
  if (!sample.sidebar || sample.opacity <= 0.01 || sample.sidebar.right <= 0) return;
  for (const [name, box] of [['content', sample.content], ['terminal', sample.terminal], ['composer', sample.composer]]) {
    assert.ok(box, name + ' is missing during ' + phase + '.');
    assert.ok(box.left >= sample.sidebar.right - 2,
      name + ' overlaps the sidebar during ' + phase + ': ' + JSON.stringify({ sidebar: sample.sidebar, box }));
  }
}

async function sampleTransition(frame, duration = 450) {
  const samples = [];
  const deadline = Date.now() + duration;
  while (Date.now() < deadline) {
    samples.push(await geometry(frame));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return samples;
}

async function moveOutsideSidebar(frame) {
  const content = frame.locator('.workbench__content');
  const box = await content.boundingBox();
  await content.hover({ position: { x: Math.max(20, box.width - 30), y: Math.min(120, box.height / 2) } });
}

async function verifyPanelAlignment(window, initialFrame, project) {
  assert.equal(process.platform, 'win32', 'Panel alignment acceptance currently targets Windows.');
  const executable = await compileClaudeFixture(project);
  await prepareClaudeFixture(initialFrame, executable);
  const frame = await reopenWorkbench(window, initialFrame);
  const terminal = await openFreshClaudeTerminal(window, frame);
  const composer = frame.locator('.coding-cli-composer textarea:visible, .composer textarea:visible').first();
  await composer.click();
  await window.keyboard.type('ALIGNMENT-DRAFT');
  assert.equal(await composer.inputValue(), 'ALIGNMENT-DRAFT');
  const xtermInput = terminal.locator('textarea').first();
  await xtermInput.focus();
  await frame.evaluate(() => { window.__aioAlignmentFocus = document.activeElement; });

  const sidebar = frame.locator('.sidebar').last();
  const toggle = frame.locator('.aio-panel-toggle-left').first();
  await moveOutsideSidebar(frame);
  await waitFor(async () => (await sidebar.getAttribute('class') || '').includes('aio-panel-hidden'), 'initial sidebar collapse', 7000);
  await waitFor(async () => (await geometry(frame)).marginLeft < 1, 'initial sidebar collapse animation');
  const hidden = await geometry(frame);
  assert.ok(hidden.content && hidden.terminal && hidden.composer);
  const hiddenRightEdges = [hidden.content.right, hidden.terminal.right, hidden.composer.right];

  const openingPromise = sampleTransition(frame, 600);
  await toggle.hover();
  const opening = await openingPromise;
  await waitFor(async () => !(await sidebar.getAttribute('class') || '').includes('aio-panel-hidden'), 'sidebar expansion');
  const expanded = await geometry(frame);
  opening.forEach(sample => assertSeparated(sample, 'opening animation'));
  assertSeparated(expanded, 'expanded state');
  assert.ok(opening.some(sample => sample.marginLeft > hidden.marginLeft + 1
    && sample.marginLeft < expanded.marginLeft - 1), 'Opening animation exposed no intermediate layout frame.');
  assert.ok(expanded.content.width < hidden.content.width - expanded.sidebar.width * 0.7,
    'Expanded sidebar did not reserve layout width: ' + JSON.stringify({
      hiddenContent: hidden.content, expandedContent: expanded.content, sidebar: expanded.sidebar,
      hiddenTerminal: hidden.terminal, expandedTerminal: expanded.terminal,
      hiddenComposer: hidden.composer, expandedComposer: expanded.composer,
    }));
  for (const [index, right] of [expanded.content.right, expanded.terminal.right, expanded.composer.right].entries()) {
    assert.ok(Math.abs(right - hiddenRightEdges[index]) <= 2, 'Right edge moved while opening the sidebar: '
      + JSON.stringify({ index, hidden: hiddenRightEdges[index], expanded: right }));
  }
  assert.equal(await frame.evaluate(() => document.activeElement === window.__aioAlignmentFocus), true,
    'Sidebar expansion stole terminal focus.');
  assert.equal(await composer.inputValue(), 'ALIGNMENT-DRAFT', 'Sidebar expansion changed composer content.');

  const closingPromise = sampleTransition(frame, 600);
  await moveOutsideSidebar(frame);
  const closing = await closingPromise;
  await waitFor(async () => (await sidebar.getAttribute('class') || '').includes('aio-panel-hidden'), 'sidebar collapse');
  await waitFor(async () => (await geometry(frame)).marginLeft < 1, 'sidebar collapse animation');
  const restored = await geometry(frame);
  closing.forEach(sample => assertSeparated(sample, 'closing animation'));
  assert.ok(closing.some(sample => sample.marginLeft > restored.marginLeft + 1
    && sample.marginLeft < expanded.marginLeft - 1), 'Closing animation exposed no intermediate layout frame.');
  assert.ok(Math.abs(restored.content.width - hidden.content.width) <= 2, 'Collapsed sidebar did not restore workbench width.');
  assert.ok(Math.abs(restored.terminal.width - hidden.terminal.width) <= 2, 'Collapsed sidebar did not restore terminal width.');
  assert.ok(Math.abs(restored.composer.width - hidden.composer.width) <= 2, 'Collapsed sidebar did not restore composer width.');
  for (const [index, right] of [restored.content.right, restored.terminal.right, restored.composer.right].entries()) {
    assert.ok(Math.abs(right - hiddenRightEdges[index]) <= 2, 'Right edge moved while closing the sidebar.');
  }
  assert.equal(await frame.evaluate(() => document.activeElement === window.__aioAlignmentFocus), true,
    'Sidebar collapse stole terminal focus.');
  assert.equal(await composer.inputValue(), 'ALIGNMENT-DRAFT', 'Sidebar collapse changed composer content.');

  return {
    expandedNoOverlap: true,
    openingNoOverlap: true,
    closingNoOverlap: true,
    animatedIntermediateFrame: true,
    restoredWidth: true,
    stableRightEdge: true,
    focusPreserved: true,
    composerPreserved: true,
    terminalVisible: await terminal.isVisible(),
  };
}

module.exports = { geometry, verifyPanelAlignment };
