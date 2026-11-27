'use strict';

const vscode = require('vscode');
const { registerLauncher } = require('./launcher');
const { registerWorkbench } = require('./workbench');
const { registerFileReferenceTree } = require('./file-reference-tree');
const path = require('node:path');
const { resumeProjectHandoff } = require('./project-handoff');
const { ProjectRegistry } = require('./project-registry');
const { localize } = require('./localize');

async function activate(context) {
  registerLauncher(vscode, context);
  const projectRegistry = new ProjectRegistry(vscode, context);
  context.subscriptions.push(projectRegistry);
  void projectRegistry.start().catch((error) => vscode.window.showErrorMessage(String(error)));
  const workbenchHost = registerWorkbench(vscode, context, { projectRegistry });
  projectRegistry.setProjectImporter((paths) => workbenchHost.addProjectCandidates(
    paths.map((value) => ({ kind: 'path', value })), true));

  const entries = [
    ['OMP', 'aio.openOmp'],
    ['Claude Code', 'aio.openClaude'],
    ['Codex', 'aio.openCodex'],
    [localize(vscode, 'fullWorkbench'), 'aio.openWorkbench'],
  ].map(([label, command]) => {
    const item = new vscode.TreeItem(label);
    item.iconPath = new vscode.ThemeIcon(command === 'aio.openWorkbench' ? 'layout' : 'terminal');
    item.command = { command, title: label };
    return item;
  });
  registerFileReferenceTree(vscode, context, workbenchHost, entries);
  const activityView = vscode.window.createTreeView('aio.sidebarLaunchers', {
    treeDataProvider: { getChildren: () => [], getTreeItem: (item) => item },
  });
  const openFromActivityBar = async () => {
    if (!activityView.visible || !vscode.workspace.isTrusted) return;
    try {
      await vscode.commands.executeCommand('workbench.view.explorer');
      await workbenchHost.open();
    } catch (error) {
      await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };
  context.subscriptions.push(activityView, activityView.onDidChangeVisibility(openFromActivityBar));

  try {
    const resumed = await resumeProjectHandoff(vscode, context, workbenchHost, path);
    if (vscode.workspace.isTrusted && vscode.workspace.getConfiguration('aio').get('openWorkbenchOnStartup', true)) {
      if (!resumed) await workbenchHost.open();
      await openFromActivityBar();
    }
  }
  catch (error) { await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
}

module.exports = { activate };
