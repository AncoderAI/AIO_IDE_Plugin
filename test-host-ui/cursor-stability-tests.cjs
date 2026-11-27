'use strict';

const fs = require('node:fs/promises');
const vscode = require('vscode');

function normalizedLayout(layout) {
  const visit = group => group.groups
    ? { orientation: group.orientation, groups: group.groups.map(visit) }
    : { size: Math.round(Number(group.size || 0) * 1000) / 1000 };
  return visit(layout);
}

async function sampleLayout(label, duration = 2400) {
  const samples = [];
  const deadline = Date.now() + duration;
  while (Date.now() < deadline || samples.length < 12) {
    if (Date.now() > deadline + 30000) throw new Error(label + " layout sampling timed out");
    samples.push(JSON.stringify(normalizedLayout(
      await vscode.commands.executeCommand('vscode.getEditorLayout'),
    )));
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  const states = [...new Set(samples)];
  const tailStates = new Set(samples.slice(-8));
  if (states.length > 2 || tailStates.size !== 1) {
    throw new Error(`${label} kept changing editor layout: ${states.join(' -> ')}`);
  }
  return { samples: samples.length, states: states.length, final: JSON.parse(samples.at(-1)) };
}

async function runStabilityTest() {
  const extension = vscode.extensions.getExtension('ancoder.aio-ide');
  if (!extension) throw new Error('Installed AIO extension is unavailable in Cursor.');
  await extension.activate();
  const panel = await vscode.commands.executeCommand('aio.openWorkbench');
  if (!panel?.webview) throw new Error('AIO workbench did not open in Cursor.');
  const startup = await sampleLayout('startup');

  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) throw new Error('Cursor stability test needs a workspace.');
  const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'first.txt'));
  await vscode.window.showTextDocument(document, { preview: false });
  const fileFocus = await sampleLayout('file focus');

  await vscode.commands.executeCommand('workbench.action.newGroupLeft');
  const multipleGroups = await sampleLayout('multiple groups');
  panel.dispose();
  return { appName: vscode.env.appName, uriScheme: vscode.env.uriScheme, startup, fileFocus, multipleGroups };
}

async function run() {
  const filename = process.env.AIO_CURSOR_STABILITY_RESULT;
  try {
    const result = await runStabilityTest();
    await fs.writeFile(filename, JSON.stringify({ status: 'passed', ...result }), 'utf8');
  } catch (error) {
    await fs.writeFile(filename, JSON.stringify({
      status: 'failed',
      message: error instanceof Error ? error.stack || error.message : String(error),
    }), 'utf8');
    throw error;
  }
}

module.exports = { run };
