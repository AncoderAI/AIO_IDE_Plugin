'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const test = require('node:test')

const { discoverClis, resolveCandidate } = require('../src/discovery')
const { chooseWorkingDirectory, ompThemeEnvironment, registerLauncher, terminalLaunch } = require('../src/launcher')

test('discovers Windows command shims from PATH', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-discovery-'))
  await fs.writeFile(path.join(directory, 'claude.cmd'), '@echo off\r\n')
  const result = await resolveCandidate('claude', {
    platform: 'win32',
    environment: { PATH: directory, PATHEXT: '.EXE;.CMD' },
    homeDirectory: directory,
  })
  assert.equal(result, path.join(directory, 'claude.cmd'))
})

test('configured executable takes precedence and all three CLIs are reported', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-config-'))
  const executable = path.join(directory, process.platform === 'win32' ? 'custom.exe' : 'custom')
  await fs.writeFile(executable, '')
  if (process.platform !== 'win32') await fs.chmod(executable, 0o755)
  const configuration = { get: (key) => key === 'ompPath' ? executable : undefined }
  const results = await discoverClis(configuration, { environment: { PATH: '' }, homeDirectory: directory })
  assert.equal(results.length, 3)
  assert.equal(results[0].executable, executable)
  assert.equal(results[0].configured, true)
})

test('Windows cmd shims use cmd arguments without shell text concatenation', () => {
  const result = terminalLaunch('C:\\Program Files\\AIO\\claude.cmd', 'win32', { ComSpec: 'cmd.exe' })
  assert.deepEqual(result, {
    shellPath: 'cmd.exe',
    shellArgs: '/d /v:off /s /c ""%AIO_CLI_EXECUTABLE%""',
    env: { AIO_CLI_EXECUTABLE: 'C:\\Program Files\\AIO\\claude.cmd' },
  })
})

test('OMP config overlay survives Windows command shims without joining arbitrary arguments', () => {
  const result = terminalLaunch('C:\Program Files\AIO\omp.cmd', 'win32', { ComSpec: 'cmd.exe' },
    ['--config', 'C:\Program Files\AIO\aio-omp-config.yml'])
  assert.deepEqual(result, {
    shellPath: 'cmd.exe',
    shellArgs: '/d /v:off /s /c ""%AIO_CLI_EXECUTABLE%" "%AIO_CLI_ARG_0%" "%AIO_CLI_ARG_1%""',
    env: {
      AIO_CLI_EXECUTABLE: 'C:\Program Files\AIO\omp.cmd',
      AIO_CLI_ARG_0: '--config',
      AIO_CLI_ARG_1: 'C:\Program Files\AIO\aio-omp-config.yml',
    },
  })
})

test('Windows cmd launch preserves Chinese, spaces, ampersands, and percent signs', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-cmd-'))
  const directory = path.join(root, '中文 空格 & 100%')
  await fs.mkdir(directory)
  const executable = path.join(directory, 'claude.cmd')
  await fs.writeFile(executable, '@echo off\r\necho AIO-SHIM-OK\r\n')
  const launch = terminalLaunch(executable, 'win32', process.env)

  const output = await new Promise((resolve, reject) => {
    const child = spawn(launch.shellPath, [launch.shellArgs], {
      env: { ...process.env, ...launch.env },
      windowsVerbatimArguments: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(`cmd exited ${code}: ${stderr}`)))
  })
  assert.match(output, /AIO-SHIM-OK/)
})

test('relative PATH entries and relative configured paths are ignored', async () => {
  const configuration = { get: (key) => key === 'ompPath' ? 'tools/omp' : undefined }
  const results = await discoverClis(configuration, {
    environment: { PATH: `relative${path.delimiter}.` },
    homeDirectory: os.tmpdir(),
  })
  assert.equal(results[0].executable, undefined)
  assert.equal(results[0].configured, true)
})

test('working directory supports multi-root selection and folder URIs', async () => {
  const picks = [{ label: 'two', folder: { uri: { fsPath: 'D:\\two' } } }]
  const vscode = {
    window: { showQuickPick: async () => picks[0] },
    workspace: {
      workspaceFolders: [
        { name: 'one', uri: { fsPath: 'D:\\one' } },
        { name: 'two', uri: { fsPath: 'D:\\two' } },
      ],
    },
  }
  assert.equal(await chooseWorkingDirectory(vscode), 'D:\\two')

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-cwd-'))
  assert.equal(await chooseWorkingDirectory(vscode, { fsPath: directory }), directory)
  assert.equal(await chooseWorkingDirectory({
    window: { showOpenDialog: async () => undefined },
    workspace: { workspaceFolders: [] },
  }, { fsPath: path.join(directory, 'missing') }), undefined)
})

function vscodeMock({ trusted = true, configuredPath } = {}) {
  const callbacks = new Map()
  const terminals = []
  const actions = []
  const vscode = {
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    ThemeIcon: class ThemeIcon { constructor(id) { this.id = id } },
    commands: {
      registerCommand: (name, callback) => {
        callbacks.set(name, callback)
        return { dispose() {} }
      },
      executeCommand: async (command) => { actions.push(command) },
    },
    window: {
      activeColorTheme: { kind: 2 },
      onDidChangeActiveTerminal: () => ({ dispose() {} }),
      activeTextEditor: undefined,
      createTerminal: (options) => {
        const terminal = { options, show(preserveFocus) { this.preserveFocus = preserveFocus } }
        terminals.push(terminal)
        return terminal
      },
      showInformationMessage: async () => undefined,
      showOpenDialog: async () => [{ fsPath: 'D:\\selected' }],
      showQuickPick: async (items) => items[0],
      showWarningMessage: async () => undefined,
    },
    workspace: {
      getConfiguration: () => ({ get: () => configuredPath }),
      getWorkspaceFolder: () => undefined,
      isTrusted: trusted,
      workspaceFolders: [],
    },
  }
  return { vscode, callbacks, terminals, actions }
}

test('registers all public commands and starts a configured CLI terminal', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-launch-'))
  const executable = path.join(directory, process.platform === 'win32' ? 'omp.exe' : 'omp')
  await fs.writeFile(executable, '')
  if (process.platform !== 'win32') await fs.chmod(executable, 0o755)
  const { vscode, callbacks, terminals, actions } = vscodeMock({ configuredPath: executable })
  const context = { subscriptions: [], extensionPath: 'C:\extension' }
  registerLauncher(vscode, context)

  assert.deepEqual([...callbacks.keys()], [
    'aio.openTerminal', 'aio.openOmp', 'aio.openClaude', 'aio.openCodex', 'aio.detectClis',
    'aio.copyTerminalSelection', 'aio.pasteIntoTerminal',
  ])
  assert.equal(context.subscriptions.length, 8)
  await callbacks.get('aio.openOmp')()
  assert.equal(terminals.length, 1)
  assert.equal(terminals[0].options.cwd, 'D:\\selected')
  assert.deepEqual(terminals[0].options.env, { COLORFGBG: '15;0' })
  assert.deepEqual(terminals[0].options.shellArgs, [
    '--config', path.join('C:\extension', 'workbench', 'service', 'aio-omp-config.yml'),
  ])
  assert.equal(terminals[0].preserveFocus, false)
  assert.ok(actions.includes('workbench.action.terminal.focus'))
  vscode.window.activeTerminal = terminals[0]
  await callbacks.get('aio.copyTerminalSelection')()
  await callbacks.get('aio.pasteIntoTerminal')()
  assert.deepEqual(actions.slice(-2), ['workbench.action.terminal.copySelection', 'workbench.action.terminal.paste'])
  vscode.window.activeTerminal = { name: 'other terminal' }
  const before = actions.length
  await callbacks.get('aio.pasteIntoTerminal')()
  assert.equal(actions.length, before)

  await callbacks.get('aio.openClaude')()
  await callbacks.get('aio.openCodex')()
  assert.equal(terminals[1].options.env, undefined)
  assert.equal(terminals[2].options.env, undefined)
})

test('OMP receives only a theme fallback matching the active VS Code appearance', () => {
  const ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 }
  assert.deepEqual(ompThemeEnvironment({
    ColorThemeKind,
    window: { activeColorTheme: { kind: ColorThemeKind.Dark } },
  }), { COLORFGBG: '15;0' })
  assert.deepEqual(ompThemeEnvironment({
    ColorThemeKind,
    window: { activeColorTheme: { kind: ColorThemeKind.HighContrastLight } },
  }), { COLORFGBG: '0;15' })
})

test('does not launch from an untrusted workspace', async () => {
  const { vscode, callbacks, terminals } = vscodeMock({ trusted: false })
  registerLauncher(vscode, { subscriptions: [] })
  await callbacks.get('aio.openCodex')()
  assert.equal(terminals.length, 0)
})
