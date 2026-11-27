'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { CLI_DEFINITIONS, discoverCli, discoverClis } = require('./discovery')
const { localize } = require('./localize')
const cliTerminals = new WeakSet()

async function folderPathFromUri(uri) {
  if (!uri?.fsPath) return undefined
  try {
    return (await fs.stat(uri.fsPath)).isDirectory() ? uri.fsPath : path.dirname(uri.fsPath)
  } catch {
    return undefined
  }
}

async function chooseWorkingDirectory(vscode, uri) {
  const explicitPath = await folderPathFromUri(uri)
  if (explicitPath) return explicitPath

  const editorUri = vscode.window.activeTextEditor?.document?.uri
  const editorFolder = editorUri && vscode.workspace.getWorkspaceFolder(editorUri)
  if (editorFolder) return editorFolder.uri.fsPath

  const folders = vscode.workspace.workspaceFolders || []
  if (folders.length === 1) return folders[0].uri.fsPath
  if (folders.length > 1) {
    const selected = await vscode.window.showQuickPick(
      folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
      { placeHolder: localize(vscode, 'chooseProjectFolder') },
    )
    return selected?.folder.uri.fsPath
  }

  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: localize(vscode, 'openCliHere'),
  })
  return selected?.[0]?.fsPath
}

function terminalLaunch(executable, platform = process.platform, environment = process.env, extraArgs = []) {
  const extension = path.extname(executable).toLowerCase()
  if (platform === 'win32' && (extension === '.cmd' || extension === '.bat')) {
    if (extraArgs.some(argument => /["\u0000-\u001f]/.test(argument))) throw new Error(localize(undefined, 'invalidCliArgument'))
    const argumentNames = extraArgs.map((_, index) => 'AIO_CLI_ARG_' + index)
    return {
      shellPath: environment.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
      shellArgs: '/d /v:off /s /c ""%AIO_CLI_EXECUTABLE%"' + argumentNames.map(name => ' "%' + name + '%"').join('') + '"',
      env: { AIO_CLI_EXECUTABLE: executable, ...Object.fromEntries(argumentNames.map((name, index) => [name, extraArgs[index]])) },
    }
  }
  if (platform === 'win32' && extension === '.ps1') {
    return {
      shellPath: environment.SystemRoot
        ? path.join(environment.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe',
      shellArgs: ['-NoLogo', '-NoProfile', '-File', executable, ...extraArgs],
    }
  }
  return { shellPath: executable, shellArgs: extraArgs }
}

function ompThemeEnvironment(vscode) {
  const kind = vscode.window.activeColorTheme?.kind
  const light = kind === vscode.ColorThemeKind?.Light || kind === vscode.ColorThemeKind?.HighContrastLight
  return { COLORFGBG: light ? '0;15' : '15;0' }
}

async function requireTrustedWorkspace(vscode) {
  if (vscode.workspace.isTrusted !== false) return true
  await vscode.window.showWarningMessage(localize(vscode, 'untrustedWorkspace'))
  return false
}

async function showMissingCli(vscode, definition) {
  const action = await vscode.window.showWarningMessage(
    localize(vscode, 'missingCli', definition),
    localize(vscode, 'openSettings'),
  )
  if (action === localize(vscode, 'openSettings')) {
    await vscode.commands.executeCommand('workbench.action.openSettings', `aio.${definition.setting}`)
  }
}

async function openCli(vscode, id, uri, ompConfigPath, sessionArgs = []) {
  if (!(await requireTrustedWorkspace(vscode))) return undefined
  const configuration = vscode.workspace.getConfiguration('aio')
  const definition = await discoverCli(id, configuration)
  if (!definition.executable) {
    await showMissingCli(vscode, definition)
    return undefined
  }
  const cwd = await chooseWorkingDirectory(vscode, uri)
  if (!cwd) return undefined

  const launch = terminalLaunch(definition.executable, process.platform, process.env,
    [...(id === 'omp' && ompConfigPath ? ['--config', ompConfigPath] : []), ...sessionArgs,
      ...(id === 'codex' ? ['-c', 'disable_paste_burst=true'] : [])])
  if (id === 'omp') launch.env = { ...launch.env, ...ompThemeEnvironment(vscode) }
  const terminal = vscode.window.createTerminal({
    name: `AIO · ${definition.label}`,
    cwd,
    iconPath: new vscode.ThemeIcon('terminal'),
    ...launch,
  })
  cliTerminals.add(terminal)
  terminal.show(false)
  // A tree or Quick Pick can still own keyboard focus while the panel is opening.
  // Let VS Code focus its input when the terminal widget is ready.
  if (vscode.workspace.getConfiguration('terminal.integrated').get('defaultLocation') !== 'editor') {
    await vscode.commands.executeCommand('workbench.action.terminal.focus')
  }
  return terminal
}

async function selectCli(vscode) {
  const configuration = vscode.workspace.getConfiguration('aio')
  const results = await discoverClis(configuration)
  const selected = await vscode.window.showQuickPick(results.map((result) => ({
    label: result.label,
    description: result.executable || localize(vscode, 'notFound'),
    id: result.id,
  })), { placeHolder: localize(vscode, 'chooseCli') })
  return selected?.id
}

async function reportDetection(vscode) {
  const results = await discoverClis(vscode.workspace.getConfiguration('aio'))
  const summary = results
    .map((result) => `${result.label}: ${result.executable || localize(vscode, 'notFound')}`)
    .join(' | ')
  await vscode.window.showInformationMessage(summary)
  return results
}

function registerLauncher(vscode, context) {
  const ompConfigPath = context.asAbsolutePath
    ? context.asAbsolutePath(path.join('workbench', 'service', 'aio-omp-config.yml'))
    : path.join(context.extensionPath || '', 'workbench', 'service', 'aio-omp-config.yml')
  const register = (command, callback) => {
    const disposable = vscode.commands.registerCommand(command, callback)
    context.subscriptions.push(disposable)
  }

  register('aio.openTerminal', async (uri) => {
    const id = await selectCli(vscode)
    return id ? openCli(vscode, id, uri, id === 'omp' ? ompConfigPath : undefined) : undefined
  })
  register('aio.openOmp', (uri) => openCli(vscode, 'omp', uri, ompConfigPath))
  register('aio.openClaude', (uri) => openCli(vscode, 'claude', uri))
  register('aio.openCodex', (uri) => openCli(vscode, 'codex', uri))
  register('aio.detectClis', () => reportDetection(vscode))
  for (const [command, action] of [
    ['aio.copyTerminalSelection', 'workbench.action.terminal.copySelection'],
    ['aio.pasteIntoTerminal', 'workbench.action.terminal.paste'],
  ]) {
    register(command, () => {
      if (cliTerminals.has(vscode.window.activeTerminal)) return vscode.commands.executeCommand(action)
    })
  }
  const updateClipboardActions = (terminal) =>
    vscode.commands.executeCommand('setContext', 'aio.activeCliTerminal', cliTerminals.has(terminal))
  context.subscriptions.push(vscode.window.onDidChangeActiveTerminal(updateClipboardActions))
  void updateClipboardActions(vscode.window.activeTerminal)
}

module.exports = {
  chooseWorkingDirectory,
  openCli,
  ompThemeEnvironment,
  registerLauncher,
  reportDetection,
  requireTrustedWorkspace,
  selectCli,
  terminalLaunch,
}
