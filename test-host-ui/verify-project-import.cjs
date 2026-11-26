'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function waitForJson(filename, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw new Error('Timed out waiting for project import receipt: ' + filename);
}

async function workbenchProjectPaths(frame) {
  const projects = await frame.evaluate(() => window.__TAURI__.core.invoke('desktop_request', {
    channel: 'projects:list-initial', args: [],
  }));
  return projects.map(project => project.primaryFolder).sort((left, right) => left.localeCompare(right));
}

async function verifyProjectImport(frame, originalProject, importedProject) {
  const receiptPath = path.join(originalProject, '.aio-project-import-result.json');
  const receipt = await waitForJson(receiptPath);
  assert.equal(receipt.added, 1, receipt.error || 'The AIO project import command did not add exactly one project.');
  assert.deepEqual(receipt.afterWorkspaceFolders, receipt.beforeWorkspaceFolders,
    'Importing an AIO project must not mutate VS Code workspaceFolders.');
  assert.equal(receipt.beforeWorkspaceFolders.length, 1, 'The isolated VS Code test must keep exactly one workspace folder.');

  const expected = [path.resolve(originalProject), path.resolve(importedProject)]
    .sort((left, right) => left.localeCompare(right));
  const deadline = Date.now() + 15000;
  let actual = [];
  while (Date.now() < deadline) {
    actual = (await workbenchProjectPaths(frame)).map(value => path.resolve(value))
      .sort((left, right) => left.localeCompare(right));
    if (expected.every(value => actual.some(candidate => candidate.toLowerCase() === value.toLowerCase()))) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  for (const value of expected) {
    assert.ok(actual.some(candidate => candidate.toLowerCase() === value.toLowerCase()),
      `AIO project library is missing ${path.basename(value)}.`);
  }
  return { imported: true, projectCount: actual.length, workspaceFolderCount: receipt.afterWorkspaceFolders.length };
}

module.exports = { verifyProjectImport, waitForJson, workbenchProjectPaths };
