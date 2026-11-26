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
  const sidebar = frame.locator('.auto-hide-panel--sidebar, .app-shell > .sidebar').first();
  const sidebarTrigger = frame.locator('.panel-edge-trigger--sidebar, .aio-panel-edge--left').first();
  const inspector = frame.locator('.auto-hide-panel--inspector, .app-shell .inspector').first();
  const inspectorTrigger = frame.locator('.panel-edge-trigger--inspector, .aio-panel-edge--right').first();
  const input = frame.locator('.composer textarea:not([disabled]), .coding-cli-composer textarea:not([disabled])').first();

  const mountedAt = await frame.evaluate(() => performance.now());
  if (!(await visible(sidebar))) {
    const diagnostic = await frame.evaluate(() => ({
      elapsed: Math.round(performance.now()),
      theme: document.documentElement.dataset,
      shellChildren: [...(document.querySelector('.app-shell')?.children || [])].map(element => element.className),
      sidebarClasses: [...document.querySelectorAll('[class*="sidebar"]')].map(element => element.className).slice(0, 20),
    }));
    throw new Error('Initial sidebar is unavailable: ' + JSON.stringify(diagnostic));
  }
  assert.equal(await visible(sidebar), true, 'The sidebar must be visible during the four-second introduction.');
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
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1400, 850));
  await new Promise(resolve => setTimeout(resolve, 300));
  const moveOutsidePanel = async (side) => {
    const box = await workbench.boundingBox();
    assert.ok(box);
    await workbench.hover({ position: {
      x: side === 'left' ? Math.max(20, box.width - 30) : 12,
      y: Math.min(100, box.height / 2),
    } });
  };
  const hoverEdge = async (side) => {
    const box = await (await frame.frameElement()).boundingBox();
    const viewport = await frame.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(box);
    await window.mouse.move(box.x + box.width / 2, box.y + 80);
    await window.mouse.move(side === 'left' ? box.x + 2 : box.x + viewport.width - 2,
      box.y + Math.min(180, viewport.height - 2), { steps: 8 });
    await new Promise(resolve => setTimeout(resolve, 100));
  };

  if (await visible(input)) await input.focus();
  const focusBeforeEdges = await frame.evaluate(() => document.activeElement?.tagName + '.' + document.activeElement?.className);
  await hoverEdge('left');
  await waitFor(frame, () => visible(sidebar), 'left edge to reveal the sidebar');
  const sidebarBox = await sidebar.boundingBox();
  const middleWhileSidebar = await workbench.boundingBox();
  assert.ok(sidebarBox && middleWhileSidebar && overlaps(sidebarBox, middleWhileSidebar), 'Sidebar must overlay the middle workspace.');
  assert.ok(middleWhileSidebar.width >= rootBox.width - 4, 'Revealed sidebar must not consume middle workspace width.');
  await waitFor(frame, async () => await frame.evaluate(() => document.activeElement?.tagName + '.' + document.activeElement?.className) === focusBeforeEdges,
    'sidebar edge focus restoration', 1000);
  await moveOutsidePanel('left');
  await waitFor(frame, async () => !(await visible(sidebar)), 'sidebar to hide after pointer leaves');

  await hoverEdge('right');
  await waitFor(frame, () => visible(inspector), 'right edge to reveal the inspector');
  const inspectorBox = await inspector.boundingBox();
  const middleWhileInspector = await workbench.boundingBox();
  assert.ok(inspectorBox && middleWhileInspector && overlaps(inspectorBox, middleWhileInspector), 'Inspector must overlay the middle workspace.');
  assert.ok(middleWhileInspector.width >= rootBox.width - 4, 'Revealed inspector must not consume middle workspace width.');
  await waitFor(frame, async () => await frame.evaluate(() => document.activeElement?.tagName + '.' + document.activeElement?.className) === focusBeforeEdges,
    'inspector edge focus restoration', 1000);
  await moveOutsidePanel('right');
  await waitFor(frame, async () => !(await visible(inspector)), 'inspector to hide after pointer leaves');

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
  });
  const protectedLayers = await frame.evaluate(() => ({
    composer: document.elementsFromPoint(2, 230).some(element => element.closest?.('.composer')),
    terminal: document.elementsFromPoint(innerWidth - 2, 350).some(element => element.closest?.('.terminal-surface')),
  }));
  assert.deepEqual(protectedLayers, { composer: true, terminal: true }, 'Protected edge fixtures are not under their edge triggers.');
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
    'Panel edge triggers intercepted clicks intended for input or terminal regions.');

  return {
    introVisible: true,
    sidebarOverlay: true,
    inspectorOverlay: true,
    middleWidth: Math.round(middleBox.width),
    focusPreserved: true,
    inputEdgeIgnored: true,
    terminalEdgeIgnored: true,
    protectedClicksDelivered: true,
    narrowPanelsMounted: true,
    noInertOrScrim: true,
  };
}

module.exports = { verifyAutoPanels };
