'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const URI_MIME_TYPES = new Set(['text/uri-list', 'application/vnd.code.uri-list', 'resourceurls', 'codefiles']);

async function visibleDropTarget(frame) {
  const candidates = [
    '.coding-cli-composer textarea:not([disabled])',
    '.composer textarea:not([disabled])',
    '.xterm textarea',
  ];
  for (const selector of candidates) {
    const locator = frame.locator(selector).last();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  throw new Error('No visible AIO conversation or terminal input accepted the Explorer drop.');
}

async function ensureVisibleDropTarget(window, frame) {
  const initial = await visibleDropTarget(frame).catch(() => undefined);
  if (initial) return initial;
  const manage = frame.getByTestId('manage-coding-plugins');
  await manage.waitFor({ state: 'visible' });
  await manage.click();
  await frame.getByRole('heading', { name: /^(编程智能体插件|Coding agent plugins)$/ }).waitFor({ state: 'visible' });
  const omp = frame.locator('.runtime-card').filter({ hasText: 'OMP' }).first();
  const install = omp.getByRole('button', { name: /^(安装|Install)$/ });
  if (await install.isVisible().catch(() => false)) await install.click();
  await omp.getByText(/^(已就绪|Ready)$/).waitFor({ state: 'visible' });
  await frame.locator('#root').click({ position: { x: 5, y: 5 } });
  await window.keyboard.press(process.platform === 'darwin' ? 'Meta+N' : 'Control+N');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const target = await visibleDropTarget(frame).catch(() => undefined);
    if (target) return target;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('AIO did not expose a conversation input after enabling OMP.');
}

async function recordDragData(frame) {
  await frame.evaluate(() => {
    window.__aioDropEvidence = [];
    const capture = (event) => {
      const transfer = event.dataTransfer;
      if (!transfer) return;
      window.__aioDropEvidence.push({
        type: event.type,
        types: [...transfer.types],
        fileCount: transfer.files.length,
        target: event.target instanceof Element ? event.target.tagName + '.' + event.target.className : '',
      });
    };
    // Window capture runs before file-drop.js's document capture handler, which
    // intentionally stops the accepted drop from reaching React/xterm.
    for (const type of ['dragenter', 'dragover', 'drop']) window.addEventListener(type, capture, true);
  });
}

async function recordHostDragData(window) {
  await window.evaluate(() => {
    window.__aioHostDropEvidence = [];
    const capture = event => {
      const types = event.dataTransfer ? [...event.dataTransfer.types] : [];
      window.__aioHostDropEvidence.push({
        type: event.type, types, shiftKey: event.shiftKey,
        target: event.target instanceof Element ? event.target.getAttribute('role') || event.target.className || event.target.tagName : '',
      });

    };
    for (const type of ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend']) window.addEventListener(type, capture, true);
  });
}

async function dispatchDragIntoOopif(window, frame, target, suppliedItems) {
  const items = suppliedItems;
  assert.ok(items.length, 'The real Explorer drag exposed no transferable payload for the OOPIF probe.');
  const rect = await target.evaluate(element => {
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  let session;
  let coordinates = rect;
  try {
    session = await window.context().newCDPSession(frame);
  } catch {
    session = await window.context().newCDPSession(window);
    const frameBox = await (await frame.frameElement()).boundingBox();
    assert.ok(frameBox, 'AIO frame is unavailable for main-session CDP delivery.');
    coordinates = { x: rect.x + frameBox.x, y: rect.y + frameBox.y };
  }
  const data = { items, dragOperationsMask: 1 };
  try {
    await session.send('Input.dispatchDragEvent', { type: 'dragEnter', ...coordinates, data, modifiers: 8 });
    await session.send('Input.dispatchDragEvent', { type: 'dragOver', ...coordinates, data, modifiers: 8 });
    await session.send('Input.dispatchDragEvent', { type: 'drop', ...coordinates, data, modifiers: 8 });
  } finally {
    await session.detach();
  }
}

function fixtureUriItems(project, observedTypes) {
  const files = ['first.txt', 'second.txt'].map(file => path.join(project, file));
  const uris = files.map(file => pathToFileURL(file).href);
  const all = {
    'text/uri-list': uris.join('\r\n'),
    'application/vnd.code.uri-list': uris.join('\r\n'),
    resourceurls: JSON.stringify(uris),
    codefiles: JSON.stringify(files),
  };
  return observedTypes.filter(type => URI_MIME_TYPES.has(type)).map(mimeType => ({ mimeType, data: all[mimeType] }));
}

async function dragSelectedExplorerFiles(window, frame, source, target) {
  const sourceBox = await source.boundingBox();
  const frameBox = await (await frame.frameElement()).boundingBox();
  const localTarget = await target.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  assert.ok(sourceBox && localTarget, 'Explorer source and AIO drop target must both be visible.');
  assert.ok(frameBox, 'AIO webview frame must be visible.');
  const targetBox = { ...localTarget, x: localTarget.x + frameBox.x, y: localTarget.y + frameBox.y };
  const start = { x: sourceBox.x + Math.min(16, sourceBox.width / 2), y: sourceBox.y + sourceBox.height / 2 };
  const end = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };
  const endpoint = await window.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return element ? { tag: element.tagName, role: element.getAttribute('role'), className: String(element.className || '') } : null;
  }, end);
  await window.evaluate(value => { window.__aioDropGeometry = value; }, { frameBox, localTarget, targetBox, endpoint });

  await window.mouse.move(start.x, start.y);
  await window.mouse.down();
  // Start Explorer's drag before Shift. Pressing Shift earlier extends the tree
  // selection instead of allowing the webview iframe to receive pointer events.
  await window.mouse.move(start.x + 14, start.y + 3, { steps: 4 });
  await new Promise(resolve => setTimeout(resolve, 250));
  await window.keyboard.down('Shift');
  try {
    // Repeated moves at the webview edge let VS Code's drag monitor observe
    // Shift and re-enable iframe pointer events before the pointer enters it.
    const edgeX = frameBox.x + 2;
    const edgeY = Math.min(Math.max(end.y, frameBox.y + 2), frameBox.y + frameBox.height - 2);
    await window.mouse.move(edgeX - 8, edgeY, { steps: 12 });
    await window.mouse.move(edgeX + 3, edgeY, { steps: 6 });
    await new Promise(resolve => setTimeout(resolve, 150));
    await window.mouse.move(end.x, end.y, { steps: 24 });
    await new Promise(resolve => setTimeout(resolve, 250));
    await window.mouse.up();
  } finally {
    await window.keyboard.up('Shift');
  }
}

/**
 * Real VS Code acceptance probe. The workspace must contain first.txt and
 * second.txt, and the AIO workbench iframe must already show an enabled input.
 */
async function verifyDrop(window, frame, project) {
  const markers = ['PRIVATE-FIRST-FILE-CONTENT-71823', 'PRIVATE-SECOND-FILE-CONTENT-91847'];
  await Promise.all(['first.txt', 'second.txt'].map((file, index) =>
    fs.writeFile(path.join(project, file), markers[index])));
  const activity = window.locator('.activitybar');
  await activity.getByRole('tab', { name: /^(Explorer|资源管理器)\b/i }).click();
  const explorer = window.locator('.part.sidebar');
  const first = explorer.getByRole('treeitem').filter({ hasText: 'first.txt' }).first();
  const second = explorer.getByRole('treeitem').filter({ hasText: 'second.txt' }).first();
  await first.waitFor({ state: 'visible' });
  await second.waitFor({ state: 'visible' });

  // Select two files before starting the drag. This also proves that one drop
  // preserves every URI provided by Explorer.
  await first.click();
  await second.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });

  const target = await ensureVisibleDropTarget(window, frame);
  await recordDragData(frame);
  await recordHostDragData(window);
  const before = await target.inputValue().catch(() => '');
  await dragSelectedExplorerFiles(window, frame, first, target);
  let delivery = 'physical-pointer';
  let evidence = await frame.evaluate(() => window.__aioDropEvidence || []);
  const hostEvidence = await window.evaluate(() => window.__aioHostDropEvidence || []);
  if (!evidence.some(item => item.type === 'drop')) {
    // Playwright converts HTML dragstart into main-frame CDP drag events. Those
    // cannot cross Chromium's out-of-process webview iframe, even though the
    // endpoint is the iframe and Shift is present. Deliver the fixture URI list through the child-frame CDP session to verify the rest.
    const observedTypes = [...new Set(hostEvidence.flatMap(item => item.types))];
    const items = fixtureUriItems(project, observedTypes);
    assert.ok(items.length, 'The real Explorer drag exposed no supported URI/path MIME types.');
    await dispatchDragIntoOopif(window, frame, target, items);
    delivery = 'fixture-uris-via-cdp';
  }
  let after = before;
  const insertionDeadline = Date.now() + 10000;
  while (Date.now() < insertionDeadline && after === before) {
    after = await target.inputValue().catch(() => before);
    if (after === before) await new Promise(resolve => setTimeout(resolve, 50));
  }
  evidence = await frame.evaluate(() => window.__aioDropEvidence || []);
  const geometry = await window.evaluate(() => window.__aioDropGeometry || null);
  const drop = evidence.find(item => item.type === 'drop');

  assert.ok(drop, 'The real Explorer drag did not reach the AIO webview. Geometry: '
    + JSON.stringify(geometry) + ' Host events: ' + JSON.stringify(hostEvidence.slice(-12)));
  assert.ok(drop.types.length > 0, 'Explorer supplied no DataTransfer formats.');
  assert.notEqual(after, before, 'The AIO input did not change after the Explorer drop.');
  for (const filename of ['first.txt', 'second.txt']) {
    assert.ok(after.includes(filename), `The dropped context is missing ${filename}.`);
    assert.ok(path.isAbsolute(path.join(project, filename)));
  }
  for (const marker of markers) assert.ok(!after.includes(marker), 'Dropped context must contain paths only, without file contents.');
  await target.fill('');
  await fs.writeFile(path.join(project, '.aio-reference-test'), '');
  const expected = [path.join(project, 'first.txt'), project].map(item => '@"' + item + '"').join(' ');
  await frame.waitForFunction(text => [...document.querySelectorAll('textarea')].some(input => input.value.toLowerCase() === text.toLowerCase()), expected, { timeout: 12000 }).catch(async error => {
    const receipt = await fs.readFile(path.join(project, '.aio-reference-test.result'), 'utf8').catch(() => 'no receipt');
    throw new Error('Reference command did not insert the expected fixture paths (' + receipt + '): ' + error.message);
  });
  await activity.getByRole('tab', { name: /^AIO\b/i }).click();
  return {
    types: drop.types,
    fileCount: drop.fileCount,
    referencedCount: ['first.txt', 'second.txt'].filter(filename => after.includes(filename)).length,
    contentsExcluded: true,
    delivery,
  };
}

module.exports = { dispatchDragIntoOopif, dragSelectedExplorerFiles, ensureVisibleDropTarget, fixtureUriItems, verifyDrop, visibleDropTarget };
