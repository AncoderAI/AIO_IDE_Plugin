'use strict'

const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const path = require('node:path')
const readline = require('node:readline')

const INITIAL_VISIBLE_MS = 2000
const COLLAPSE_DELAY_MS = 180

function cloneLayout(layout) {
  return layout && JSON.parse(JSON.stringify(layout))
}

function isSimpleTwoGroupLayout(layout) {
  return Boolean(layout && layout.orientation === 0 && Array.isArray(layout.groups)
    && layout.groups.length === 2 && layout.groups.every((group) => !Array.isArray(group.groups)))
}

function isSingleGroupLayout(layout) {
  return Boolean(layout && Array.isArray(layout.groups) && layout.groups.length === 1
    && !Array.isArray(layout.groups[0].groups))
}

function sameSimpleLayout(left, right) {
  if (!isSimpleTwoGroupLayout(left) || !isSimpleTwoGroupLayout(right)) return false
  return left.groups.every((group, index) => Math.abs((group.size || 0) - (right.groups[index].size || 0)) < 0.02)
}

class WindowsPreviewHoverObserver extends EventEmitter {
  constructor(context, options = {}) {
    super()
    this.context = context
    this.options = options
    this.child = undefined
    this.lines = undefined
  }

  start() {
    if (this.child || process.platform !== 'win32' || process.arch !== 'x64') return false
    const vscodeProcessId = Number.parseInt(process.env.VSCODE_PID || '', 10)
    if (!Number.isSafeInteger(vscodeProcessId) || vscodeProcessId <= 0) return false
    const script = this.context.asAbsolutePath(path.join('src', 'preview-hover.ps1'))
    const executable = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe'
    this.child = (this.options.spawn || spawn)(executable, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-TargetProcessId', String(vscodeProcessId), '-ExtensionHostProcessId', String(process.pid),
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    this.child.once('error', () => this.stop())
    this.child.once('exit', () => this.stop())
    this.lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    this.lines.on('line', (line) => {
      if (line === 'inside' || line === 'outside' || line === 'inactive') this.emit('state', line)
    })
    return true
  }

  stop() {
    this.lines?.close()
    this.lines = undefined
    const child = this.child
    this.child = undefined
    child?.kill()
  }

  dispose() { this.stop() }
}

class PreviewGroupController {
  constructor(vscode, context, options = {}) {
    this.vscode = vscode
    this.context = context
    this.options = options
    this.baselineLayout = undefined
    this.expandedLayout = undefined
    this.panel = undefined
    this.hoverObserver = undefined
    this.hoveringPreview = false
    this.awaitingAioReentry = false
    this.fileEditorFocused = false
    this.windowFocused = vscode.window.state?.focused !== false
    this.collapsed = false
    this.managed = false
    this.abandoned = false
    this.readyAt = 0
    this.timer = undefined
    this.disposables = []
    this.queue = Promise.resolve()
  }

  run(operation) {
    const result = this.queue.then(operation, operation)
    this.queue = result.catch(() => undefined)
    return result
  }

  captureBaseline() {
    return this.run(async () => {
      if (!this.baselineLayout) {
        this.baselineLayout = cloneLayout(await this.vscode.commands.executeCommand('vscode.getEditorLayout'))
      }
    })
  }

  attach(panel) {
    return this.run(async () => {
      this.panel = panel
      const layout = cloneLayout(await this.vscode.commands.executeCommand('vscode.getEditorLayout'))
      if (!isSingleGroupLayout(this.baselineLayout) || !isSimpleTwoGroupLayout(layout)) return false
      this.expandedLayout = layout
      this.managed = true
      this.fileEditorFocused = Boolean(this.vscode.window.activeTextEditor)
      this.readyAt = Date.now() + (this.options.initialVisibleMs ?? INITIAL_VISIBLE_MS)
      const editorDisposable = this.vscode.window.onDidChangeActiveTextEditor?.((editor) => {
        this.fileEditorFocused = Boolean(editor)
        // VS Code has already restored a maximized layout before it can make a
        // file editor active. Toggling here would maximize the file group and
        // hide AIO again.
        if (editor && this.collapsed) {
          this.collapsed = false
          void this.panel?.webview?.postMessage?.({ type: 'aio:file-preview-state', collapsed: false })
        } else if (editor) void this.expand('editor')
        else this.scheduleCollapse()
      })
      if (editorDisposable) this.disposables.push(editorDisposable)
      const windowDisposable = this.vscode.window.onDidChangeWindowState?.(({ focused }) => {
        this.windowFocused = focused
        if (focused) this.scheduleCollapse()
        else clearTimeout(this.timer)
      })
      if (windowDisposable) this.disposables.push(windowDisposable)
      const panelDisposable = panel.onDidChangeViewState?.(({ webviewPanel }) => {
        if (webviewPanel.active) {
          this.fileEditorFocused = false
          this.scheduleCollapse()
        }
      })
      if (panelDisposable) this.disposables.push(panelDisposable)
      const factory = this.options.hoverObserverFactory
        || ((targetContext) => new WindowsPreviewHoverObserver(targetContext, this.options.hoverObserver))
      this.hoverObserver = factory(this.context)
      this.hoverObserver.on?.('state', (state) => {
        if (state === 'inactive') return
        if (state === 'inside') {
          this.awaitingAioReentry = false
          this.hoveringPreview = true
          void this.expand('hover')
        } else if (!this.awaitingAioReentry) {
          this.hoveringPreview = false
          this.scheduleCollapse()
        }
      })
      this.hoverObserver.start?.()
      this.scheduleCollapse()
      return true
    })
  }

  scheduleCollapse() {
    clearTimeout(this.timer)
    if (!this.managed || this.abandoned || this.collapsed || this.hoveringPreview
      || this.fileEditorFocused || !this.windowFocused || !this.panel?.active) return
    const delay = Math.max(this.options.collapseDelayMs ?? COLLAPSE_DELAY_MS, this.readyAt - Date.now())
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.hoveringPreview && !this.fileEditorFocused && this.windowFocused && this.panel?.active) {
        void this.collapse()
      }
    }, delay)
    this.timer.unref?.()
  }

  currentLayout() {
    return this.vscode.commands.executeCommand('vscode.getEditorLayout')
  }

  abandon() {
    this.abandoned = true
    this.managed = false
    clearTimeout(this.timer)
    this.timer = undefined
    this.hoverObserver?.dispose?.()
    this.hoverObserver = undefined
    void this.panel?.webview?.postMessage?.({ type: 'aio:file-preview-state', collapsed: false })
  }

  expand(_source = 'trigger') {
    return this.run(async () => {
      clearTimeout(this.timer)
      this.timer = undefined
      if (!this.managed || this.abandoned || !this.collapsed) return false
      const layout = await this.currentLayout()
      if (!isSimpleTwoGroupLayout(layout)) {
        this.abandon()
        return false
      }
      await this.vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup')
      this.collapsed = false
      await this.panel?.webview?.postMessage?.({ type: 'aio:file-preview-state', collapsed: false })
      return true
    })
  }

  collapse() {
    return this.run(async () => {
      if (!this.managed || this.abandoned || this.collapsed || this.hoveringPreview || this.fileEditorFocused
        || !this.windowFocused || !this.panel?.active || Date.now() < this.readyAt) return false
      const layout = await this.currentLayout()
      if (!sameSimpleLayout(layout, this.expandedLayout)) {
        this.abandon()
        return false
      }
      await this.vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup')
      this.collapsed = true
      await this.panel?.webview?.postMessage?.({ type: 'aio:file-preview-state', collapsed: true })
      return true
    })
  }

  showFromTrigger() {
    this.awaitingAioReentry = true
    this.hoveringPreview = true
    return this.expand('trigger')
  }

  aioPointerEntered() {
    this.awaitingAioReentry = false
    this.hoveringPreview = false
    this.scheduleCollapse()
  }

  close() {
    return this.run(async () => {
      clearTimeout(this.timer)
      this.timer = undefined
      this.hoverObserver?.dispose?.()
      this.hoverObserver = undefined
      for (const disposable of this.disposables.splice(0)) disposable.dispose()
      if (this.collapsed && this.managed && !this.abandoned && !this.vscode.window.visibleTextEditors?.length) {
        const layout = await this.currentLayout()
        if (isSimpleTwoGroupLayout(layout)) {
          await this.vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup')
        } else {
          this.abandoned = true
        }
      }
      this.panel = undefined
      this.baselineLayout = undefined
      this.expandedLayout = undefined
      this.collapsed = false
      this.managed = false
      this.abandoned = false
      this.hoveringPreview = false
      this.awaitingAioReentry = false
      this.fileEditorFocused = false
    })
  }

  dispose() { return this.close() }
}

module.exports = {
  PreviewGroupController,
  WindowsPreviewHoverObserver,
  isSingleGroupLayout,
  isSimpleTwoGroupLayout,
  sameSimpleLayout,
}
