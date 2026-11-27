'use strict';

const assert = require('node:assert/strict');

async function waitFor(frame, predicate, description, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for ' + description);
}

async function visible(locator) { return locator.isVisible().catch(() => false); }

function overlaps(left, right) {
  return left.x < right.x + right.width && right.x < left.x + left.width
    && left.y < right.y + right.height && right.y < left.y + left.height;
}

async function hoverFrameElement(window, locator, position) {
  const box = await locator.boundingBox();
  assert.ok(box);
  await window.mouse.move(
    box.x + (position?.x ?? box.width / 2),
    box.y + (position?.y ?? box.height / 2),
  );
  await new Promise(resolve => setTimeout(resolve, 100));
}

async function verifyAutoPanels(window, frame, app) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1000, 760));
  const root = frame.locator('#root');
  const workbench = frame.locator('.workbench');
  const workbenchContent = frame.locator('.workbench__content');
  const sidebar = frame.locator('.auto-hide-panel--sidebar, .app-shell > .sidebar').first();
  const sidebarTrigger = frame.locator('.aio-panel-toggle-left').first();
  const inspector = frame.locator('.auto-hide-panel--inspector, .app-shell .inspector').first();
  const inspectorTrigger = frame.locator('.aio-panel-toggle-right').first();
  const input = frame.locator('.composer textarea:not([disabled]), .coding-cli-composer textarea:not([disabled])').first();

  const mountedAt = await frame.evaluate(() => performance.now());
  if (!(await visible(sidebar))) {
    const diagnostic = await frame.evaluate(() => ({
      elapsed: Math.round(performance.now()),
      theme: document.documentElement.dataset,
      shellChildren: [...(document.querySelector('.app-shell')?.children || [])].map(element => element.className),
      sidebarClasses: [...document.querySelectorAll('[class*="sidebar"]')].map(element => element.className).slice(0, 20),
      sidebarWrapper: document.querySelector('.auto-hide-panel--sidebar')?.className,
      pages: document.querySelectorAll('.workbench-page').length,
    }));
    throw new Error('Initial sidebar is unavailable: ' + JSON.stringify(diagnostic));
  }
  assert.equal(await visible(sidebar), true, 'The sidebar must be visible during the four-second introduction.');
  const transitionMs = await sidebar.evaluate((element) =>
    Math.max(...getComputedStyle(element).transitionDuration.split(',').map((value) =>
      value.trim().endsWith('ms') ? Number.parseFloat(value) : Number.parseFloat(value) * 1000)));
  assert.ok(transitionMs > 0 && transitionMs <= 1000,
    'Sidebar transition must complete within one second (' + transitionMs + 'ms).');
  const sidebarSeenAt = Date.now();
  const initialRootBox = await root.boundingBox();
  assert.ok(initialRootBox);
  const moveOutsideHost = () => workbench.hover({ position: {
    x: Math.max(20, initialRootBox.width - 20), y: 12,
  } });
  const introSidebarBox = await sidebar.boundingBox();
  assert.ok(introSidebarBox);
  await window.mouse.move(introSidebarBox.x + 30, introSidebarBox.y + 100);
  const beforeFourSeconds = Math.max(0, 3500 - (Date.now() - sidebarSeenAt));
  if (beforeFourSeconds) await new Promise(resolve => setTimeout(resolve, beforeFourSeconds));
  assert.equal(await visible(sidebar), true, 'The sidebar disappeared before the four-second introduction elapsed.');
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(await visible(sidebar), true, 'The sidebar collapsed at four seconds while the pointer remained inside.');
  await moveOutsideHost();

  try {
    await waitFor(frame, async () => !(await visible(sidebar)), 'automatic sidebar to hide after four seconds', 2500);
  } catch (error) {
    const state = await frame.evaluate(() => ({
      installed: document.documentElement.dataset.aioAutoHidePanels,
      shell: document.querySelector('.app-shell')?.className,
      sidebar: document.querySelector('.sidebar')?.className,
      sidebarWrapper: document.querySelector('.auto-hide-panel--sidebar')?.className,
      pages: document.querySelectorAll('.workbench-page').length,
      active: document.activeElement?.outerHTML?.slice(0, 200),
    }));
    throw new Error(error.message + ': ' + JSON.stringify(state));
  }
  const rootBox = await root.boundingBox();
  const middleBox = await workbench.boundingBox();
  assert.ok(rootBox && middleBox);
  assert.ok(middleBox.width >= rootBox.width - 4, 'Hidden side panels must release the middle workspace width.');
  assert.equal(await workbench.evaluate(element => element.hasAttribute('inert')), false,
    'Collapsed panels must not leave the middle workspace inert.');
  assert.equal(await frame.locator('.panel-scrim:visible').count(), 0,
    'Collapsed panels must not leave a scrim over the middle workspace.');
  const toolbarGeometry = await frame.evaluate(() => {
    const left = document.querySelector('.aio-panel-toggle-left');
    const right = document.querySelector('.aio-panel-toggle-right');
    const identity = document.querySelector('.title-toolbar__identity');
    return {
      leftBeforeIdentity: Boolean(left && identity && (left.compareDocumentPosition(identity) & Node.DOCUMENT_POSITION_FOLLOWING)),
      leftX: left?.getBoundingClientRect().x,
      identityX: identity?.getBoundingClientRect().x,
      rightInActions: Boolean(right?.closest('.title-toolbar__actions')),
      leftPath: left?.querySelector('path')?.getAttribute('d') || '',
      rightPath: right?.querySelector('path')?.getAttribute('d') || '',
      leftRects: left?.querySelectorAll('rect').length || 0,
      rightRects: right?.querySelectorAll('rect').length || 0,
    };
  });
  assert.equal(toolbarGeometry.leftBeforeIdentity, true, 'Left panel button must precede the project identity.');
  assert.ok(toolbarGeometry.leftX < toolbarGeometry.identityX);
  assert.equal(toolbarGeometry.rightInActions, true, 'Right panel button must remain in the existing toolbar action group.');
  assert.ok(/9\s+3v18/i.test(toolbarGeometry.leftPath) && /15\s+3v18/i.test(toolbarGeometry.rightPath),
    'Left and right panel icons are not mirrored.');
  assert.equal(toolbarGeometry.leftRects, toolbarGeometry.rightRects, 'Panel icon frames are not symmetric.');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1400, 850));
  await new Promise(resolve => setTimeout(resolve, 300));
  const moveOutsidePanel = async (side) => {
    const point = await frame.evaluate((wantedSide) => {
      const workbenchRect = document.querySelector('.workbench').getBoundingClientRect();
      const y = Math.min(workbenchRect.bottom - 12, workbenchRect.top + Math.max(180, workbenchRect.height / 2));
      const values = wantedSide === 'left'
        ? Array.from({ length: Math.ceil(innerWidth / 4) }, (_, index) => innerWidth - 2 - index * 4)
        : Array.from({ length: Math.ceil(innerWidth / 4) }, (_, index) => 2 + index * 4);
      const x = values.find(candidate => !document.elementsFromPoint(candidate, y).some(element =>
        element.closest?.('.sidebar, .inspector, .aio-panel-toggle-left, .aio-panel-toggle-right')));
      return x === undefined ? { blocked: true } : { x, y, blocked: false };
    }, side);
    if (point.blocked) {
      const hostBox = await window.locator('.activitybar').boundingBox();
      assert.ok(hostBox);
      await window.mouse.move(hostBox.x + hostBox.width / 2, hostBox.y + hostBox.height / 2, { steps: 8 });
    } else {
      const frameBox = await (await frame.frameElement()).boundingBox();
      assert.ok(frameBox);
      await window.mouse.move(frameBox.x + point.x, frameBox.y + point.y, { steps: 8 });
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  };
  const hoverEdge = async (side) => {
    await (side === 'left' ? sidebarTrigger : inspectorTrigger).hover();
    await new Promise(resolve => setTimeout(resolve, 100));
  };
  const ordinaryEdge = async (side) => {
    const box = await (await frame.frameElement()).boundingBox();
    const viewport = await frame.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await window.mouse.move(side === 'left' ? box.x + 2 : box.x + viewport.width - 2, box.y + 180);
    await new Promise(resolve => setTimeout(resolve, 200));
  };

  await ordinaryEdge('left');
  assert.equal(await visible(sidebar), false, 'Ordinary left edge unexpectedly revealed sidebar.');
  await ordinaryEdge('right');
  assert.equal(await visible(inspector), false, 'Ordinary right edge unexpectedly revealed inspector.');

  const hoverWithAnimation = async () => {
    const samples = [];
    await sidebarTrigger.hover();
    const deadline = Date.now() + 450;
    while (Date.now() < deadline) {
      samples.push(await sidebar.evaluate(element => Number.parseFloat(getComputedStyle(element).opacity)));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(samples.some(value => value > 0 && value < 1), 'Sidebar animation exposed no intermediate frame.');
  };

  if (await visible(input)) await input.focus();
  const focusBeforeEdges = await frame.evaluate(() => document.activeElement?.tagName + '.' + document.activeElement?.className);
  await hoverWithAnimation();
  await waitFor(frame, () => visible(sidebar), 'left edge to reveal the sidebar');
  const sidebarBox = await sidebar.boundingBox();
  const middleWhileSidebar = await workbench.boundingBox();
  const contentWhileSidebar = await workbenchContent.boundingBox();
  assert.ok(sidebarBox && middleWhileSidebar && contentWhileSidebar
    && contentWhileSidebar.x >= sidebarBox.x + sidebarBox.width - 2, 'Sidebar must reserve space beside the middle workspace.');
  assert.ok(middleWhileSidebar.width >= rootBox.width - 4, 'Revealed sidebar must not consume middle workspace width.');
  await waitFor(frame, async () => await frame.evaluate(() => document.activeElement?.tagName + '.' + document.activeElement?.className) === focusBeforeEdges,
    'sidebar edge focus restoration', 1000);
  await moveOutsidePanel('left');
  await waitFor(frame, async () => !(await visible(sidebar)), 'sidebar to hide after pointer leaves');

  await hoverEdge('right');
  await waitFor(frame, () => visible(inspector), 'right edge to reveal the inspector');
  try {
    await waitFor(frame, async () => {
      const panelBox = await inspector.boundingBox();
      const centerBox = await workbench.boundingBox();
      return panelBox && centerBox && overlaps(panelBox, centerBox);
    }, 'inspector slide-in animation');
  } catch (error) {
    throw new Error(error.message + ': ' + JSON.stringify({
      inspector: await inspector.boundingBox(),
      workbench: await workbench.boundingBox(),
      inspectorClass: await inspector.getAttribute('class'),
    }));
  }
  const inspectorBox = await inspector.boundingBox();
  const middleWhileInspector = await workbench.boundingBox();
  assert.ok(inspectorBox && middleWhileInspector && overlaps(inspectorBox, middleWhileInspector), 'Inspector must overlay the middle workspace.');
  assert.ok(middleWhileInspector.width >= rootBox.width - 4, 'Revealed inspector must not consume middle workspace width.');
  await waitFor(frame, async () => await frame.evaluate(() => document.activeElement?.tagName + '.' + document.activeElement?.className) === focusBeforeEdges,
    'inspector edge focus restoration', 1000);
  await moveOutsidePanel('right');
  await waitFor(frame, async () => !(await visible(inspector)), 'inspector to hide after pointer leaves');

  await sidebarTrigger.click();
  await waitFor(frame, () => visible(sidebar), 'left toolbar click to reveal sidebar');
  await sidebarTrigger.click();
  assert.equal(await visible(sidebar), true, 'Clicking the visible left toolbar button closed the sidebar.');
  await moveOutsidePanel('left');
  await waitFor(frame, async () => !(await visible(sidebar)), 'sidebar hide after click reveal');
  await inspectorTrigger.click();
  await waitFor(frame, () => visible(inspector), 'right toolbar click to reveal inspector');
  await inspectorTrigger.click();
  assert.equal(await visible(inspector), true, 'Clicking the visible inspector button closed the inspector.');
  await moveOutsidePanel('right');
  await waitFor(frame, async () => !(await visible(inspector)), 'inspector hide after click reveal');

  assert.equal(await frame.locator('.floating-inspector-resize .resize-handle:visible').count(), 0,
    'The hidden inspector left its resize handle over the terminal.');

  await frame.evaluate(() => {
    const make = (className, side, top) => {
      const region = document.createElement('div');
      region.className = `${className} aio-panel-protected-fixture`;
      Object.assign(region.style, { position: 'fixed', inset: 'auto', left: 'auto', right: 'auto', [side]: '0', top: `${top}px`, width: '30px', height: '64px', zIndex: '60' });
      const input = document.createElement('textarea');
      input.setAttribute('aria-label', className + ' edge fixture');
      Object.assign(input.style, { width: '100%', height: '100%' });
      input.addEventListener('click', () => { window.__aioProtectedClicks = (window.__aioProtectedClicks || 0) + 1; });
      region.append(input);
      document.body.append(region);
    };
    make('composer', 'left', 210);
    make('terminal-surface', 'right', 330);
    const bottom = document.createElement('div');
    bottom.className = 'terminal-surface aio-terminal-bottom-fixture';
    Object.assign(bottom.style, { position: 'fixed', inset: 'auto 0 0 0', height: '64px', zIndex: '60' });
    document.body.append(bottom);
  });
  const protectedLayers = await frame.evaluate(() => ({
    composer: document.elementsFromPoint(2, 230).some(element => element.closest?.('.composer')),
    terminal: document.elementsFromPoint(innerWidth - 2, 350).some(element => element.closest?.('.terminal-surface')),
  }));
  assert.deepEqual(protectedLayers, { composer: true, terminal: true }, 'Protected edge fixtures are not under their edge triggers.');
  assert.equal(await frame.locator('.aio-panel-edge').count(), 0, 'Legacy full-edge mouse triggers must be absent.');
  const composerEdge = frame.getByLabel('composer edge fixture');
  const terminalEdge = frame.getByLabel('terminal-surface edge fixture');
  await composerEdge.hover({ position: { x: 6, y: 20 } });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await visible(sidebar), false, 'Input edge hover unexpectedly revealed the sidebar.');
  await composerEdge.click({ position: { x: 6, y: 20 } });
  const terminalBox = await terminalEdge.boundingBox();
  assert.ok(terminalBox);
  await terminalEdge.hover({ position: { x: terminalBox.width - 6, y: 20 } });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await visible(inspector), false, 'Terminal edge hover unexpectedly revealed the inspector.');
  await terminalEdge.click({ position: { x: terminalBox.width - 6, y: 20 } });
  assert.equal(await frame.evaluate(() => window.__aioProtectedClicks || 0), 2,
    'Panel toggles interfered with clicks intended for input or terminal regions.');
  const bottomTerminal = frame.locator('.aio-terminal-bottom-fixture');
  const bottomBox = await bottomTerminal.boundingBox();
  await bottomTerminal.hover({ position: { x: 4, y: 30 } });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await visible(sidebar), false, 'Bottom terminal left edge unexpectedly revealed sidebar.');
  await bottomTerminal.hover({ position: { x: bottomBox.width - 4, y: 30 } });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await visible(inspector), false, 'Bottom terminal right edge unexpectedly revealed inspector.');

  return {
    introVisible: true,
    sidebarReservedSpace: true,
    inspectorOverlay: true,
    middleWidth: Math.round(middleBox.width),
    focusPreserved: true,
    inputEdgeIgnored: true,
    terminalEdgeIgnored: true,
    protectedClicksDelivered: true,
    narrowPanelsMounted: true,
    noInertOrScrim: true,
    toolbarButtonsOnly: true,
    visibleClickDoesNotClose: true,
    toolbarOrder: true,
    mirroredIcons: true,
    hoverAndClick: true,
    animated: true,
    ordinaryEdgesIgnored: true,
    bottomTerminalIgnored: true,
  };
}

module.exports = { verifyAutoPanels };
