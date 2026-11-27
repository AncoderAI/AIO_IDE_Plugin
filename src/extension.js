'use strict';

const vscode = require('vscode');
const { registerLauncher } = require('./launcher');
const { registerWorkbench } = require('./workbench');
const { registerFileReferenceTree } = require('./file-reference-tree');
const path = require('node:path');
const { resumeProjectHandoff } = require('./project-handoff');
const { ProjectRegistry } = require('./project-registry');

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
    ['完整工作台', 'aio.openWorkbench'],
  ].map(([label, command]) => {
    const item = new vscode.TreeItem(label);
    item.iconPath = new vscode.ThemeIcon(command === 'aio.openWorkbench' ? 'layout' : 'terminal');
    item.command = { command, title: label };
    return item;
  });
  registerFileReferenceTree(vscode, context, workbenchHost, entries);
  try {
    const resumed = await resumeProjectHandoff(vscode, context, workbenchHost, path);
    if (!resumed && vscode.workspace.isTrusted) await workbenchHost.open();
  }
  catch (error) { await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
}

module.exports = { activate };
