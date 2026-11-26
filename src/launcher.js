'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { CLI_DEFINITIONS, discoverCli, discoverClis } = require('./discovery')
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
      { placeHolder: '选择 AI 编程 CLI 的项目目录' },
    )
    return selected?.folder.uri.fsPath
  }

  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: '在此打开 AI 编程 CLI',
  })
  return selected?.[0]?.fsPath
}

function terminalLaunch(executable, platform = process.platform, environment = process.env, extraArgs = []) {
  const extension = path.extname(executable).toLowerCase()
  if (platform === 'win32' && (extension === '.cmd' || extension === '.bat')) {
    return {
      shellPath: environment.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
      shellArgs: extraArgs.length
        ? '/d /v:off /s /c ""%AIO_CLI_EXECUTABLE%" --config "%AIO_OMP_CONFIG%""'
        : '/d /v:off /s /c ""%AIO_CLI_EXECUTABLE%""',
      env: { AIO_CLI_EXECUTABLE: executable, ...(extraArgs.length ? { AIO_OMP_CONFIG: extraArgs[1] } : {}) },
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
  await vscode.window.showWarningMessage('AIO 无法在未受信任的工作区中启动本机 AI 编程 CLI。')
  return false
}

async function showMissingCli(vscode, definition) {
  const action = await vscode.window.showWarningMessage(
    `未找到 ${definition.label}。请安装该 CLI，或配置 aio.${definition.setting}。`,
    '打开设置',
  )
  if (action === '打开设置') {
    await vscode.commands.executeCommand('workbench.action.openSettings', `aio.${definition.setting}`)
  }
}

async function openCli(vscode, id, uri, ompConfigPath) {
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
    id === 'omp' && ompConfigPath ? ['--config', ompConfigPath] : [])
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
    description: result.executable || '未找到',
    id: result.id,
  })), { placeHolder: '选择一个 AI 编程 CLI' })
  return selected?.id
}

async function reportDetection(vscode) {
  const results = await discoverClis(vscode.workspace.getConfiguration('aio'))
  const summary = results
    .map((result) => `${result.label}：${result.executable || '未找到'}`)
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
