'use strict';
const vscode = require('vscode');
exports.run = async function () {
  await vscode.commands.executeCommand('aio.openWorkbench', vscode.workspace.workspaceFolders[0].uri);
  if (process.env.AIO_TEST_PROJECT_IMPORT === '1') {
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const original = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const imported = process.env.AIO_TEST_PROJECT_IMPORT_PATH;
    const receipt = path.join(original, '.aio-project-import-result.json');
    try {
      const beforeWorkspaceFolders = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.toString(true));
      const uri = vscode.Uri.file(imported);
      const added = await vscode.commands.executeCommand('aio.importProjectInWorkbench', uri, [uri]);
      const afterWorkspaceFolders = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.toString(true));
      await fs.writeFile(receipt, JSON.stringify({ added, beforeWorkspaceFolders, afterWorkspaceFolders }));
    } catch (error) {
      await fs.writeFile(receipt, JSON.stringify({ added: 0, error: error instanceof Error ? error.message : String(error) }));
    }
  }
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
