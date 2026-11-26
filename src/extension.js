'use strict';

const vscode = require('vscode');
const { registerLauncher } = require('./launcher');
const { registerWorkbench } = require('./workbench');

function activate(context) {
  registerLauncher(vscode, context);
  registerWorkbench(vscode, context);

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
  context.subscriptions.push(vscode.window.registerTreeDataProvider('aio.launchers', {
    getChildren: parent => parent ? [] : entries,
    getTreeItem: item => item,
  }));
}

module.exports = { activate };
