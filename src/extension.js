'use strict';

const vscode = require('vscode');
const { registerLauncher } = require('./launcher');
const { registerWorkbench } = require('./workbench');
const { registerFileReferenceTree } = require('./file-reference-tree');

function activate(context) {
  registerLauncher(vscode, context);
  const workbenchHost = registerWorkbench(vscode, context);

  const entries = [
    ['OMP', 'aio.openOmp'],
    ['Claude Code', 'aio.openClaude'],
    ['Codex', 'aio.openCodex'],
    ['完整工作台', 'aio.openWorkbench'],
  ].map(([label, command]) => {
    const item = new vscode.TreeItem(label);
    item.iconPath = new vscode.ThemeIcon(command === 'aio.openWorkbench' ? 'layout' : 'terminal');
    item.command = { command, title: label };
    return item;
  });
  registerFileReferenceTree(vscode, context, workbenchHost, entries);
}

module.exports = { activate };
