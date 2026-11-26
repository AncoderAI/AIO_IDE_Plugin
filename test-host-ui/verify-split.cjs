'use strict';

const assert = require('node:assert/strict');

exports.verifySplit = async function (window, frame) {
  const activity = window.locator('.activitybar');
  await activity.getByRole('tab', { name: /^(Explorer|资源管理器)\b/i }).click();
  const explorer = window.locator('.part.sidebar');
  for (const file of ['first.txt', 'second.txt']) {
    // Focus the actual Webview first so a split that only works while the file
    // group retains focus cannot pass.
    await frame.locator('#root').click({ position: { x: 5, y: 5 } });
    await explorer.getByText(file, { exact: true }).click();
    const editor = window.locator('.monaco-editor[data-uri$="/' + file + '"]').first();
    await editor.waitFor({ state: 'visible' });
    const fileBox = await editor.boundingBox();
    const workbenchBox = await (await frame.frameElement()).boundingBox();
    assert.ok(fileBox?.width > 0 && workbenchBox?.width > 0, 'File and workbench must be visible');
    assert.ok(fileBox.x + fileBox.width <= workbenchBox.x + 2 ||
      workbenchBox.x + workbenchBox.width <= fileBox.x + 2 ||
      fileBox.y + fileBox.height <= workbenchBox.y + 2 ||
      workbenchBox.y + workbenchBox.height <= fileBox.y + 2, 'Editors must occupy separate groups');
  }
  await activity.getByRole('tab', { name: /^AIO\b/i }).click();
};
