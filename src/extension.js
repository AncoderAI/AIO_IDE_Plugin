'use strict';

const vscode = require('vscode');
const { registerLauncher } = require('./launcher');

function activate(context) {
  registerLauncher(vscode, context);

  const entries = [
    ['OMP', 'aio.openOmp'],
    ['Claude Code', 'aio.openClaude'],
    ['Codex', 'aio.openCodex'],
  ].map(([label, command]) => {
    const item = new vscode.TreeItem(label);
    item.iconPath = new vscode.ThemeIcon('terminal');
    item.command = { command, title: label };
    return item;
  });
  context.subscriptions.push(vscode.window.registerTreeDataProvider('aio.launchers', {
    getChildren: parent => parent ? [] : entries,
    getTreeItem: item => item,
  }));
}

module.exports = { activate };
