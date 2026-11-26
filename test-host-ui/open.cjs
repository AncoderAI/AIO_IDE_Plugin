'use strict';
const vscode = require('vscode');
exports.run = async function () {
  await vscode.commands.executeCommand('aio.openWorkbench', vscode.workspace.workspaceFolders[0].uri);
  // Keep the test host alive while Playwright inspects the actual Webview.
  await new Promise(resolve => setTimeout(resolve, 100000));
};
