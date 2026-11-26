'use strict';
const vscode = require('vscode');
exports.run = async function () {
  await vscode.commands.executeCommand('aio.openWorkbench', vscode.workspace.workspaceFolders[0].uri);
  if (process.env.AIO_TEST_FILE_DROP === '1') {
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const cwd = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const ready = path.join(cwd, '.aio-reference-test');
    const deadline = Date.now() + 85000;
    while (Date.now() < deadline && !(await fs.stat(ready).catch(() => null))) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (await fs.stat(ready).catch(() => null)) {
      const file = vscode.Uri.file(path.join(cwd, 'first.txt'));
      const folder = vscode.Uri.file(cwd);
      const inserted = await vscode.commands.executeCommand('aio.referenceInWorkbench', file, [file, folder]);
      await fs.writeFile(ready + '.result', String(inserted));
    }
  }
  // Keep the test host alive while Playwright inspects the actual Webview.
  await new Promise(resolve => setTimeout(resolve, 100000));
};
