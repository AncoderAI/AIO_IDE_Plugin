'use strict'

const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const path = require('node:path')
const readline = require('node:readline')

const COLLAPSE_DELAY_MS = 350

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
    this.useExplicitWidths = (/cursor/i.test(vscode.env?.appName || '') || vscode.env?.uriScheme === 'cursor')
    this.baselineLayout = undefined
    this.expandedLayout = undefined
    this.panel = undefined
    this.hoverObserver = undefined
    this.hoveringPreview = false
    this.awaitingAioReentry = false
    this.previewRequested = false
    this.windowFocused = vscode.window.state?.focused !== false
    this.collapsed = false
    this.managed = false
    this.abandoned = false
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
      return this.baselineLayout
    })
  }

  attach(panel) {
    return this.run(async () => {
      if (this.managed && this.panel === panel) return true
      this.panel = panel
      const layout = cloneLayout(await this.vscode.commands.executeCommand('vscode.getEditorLayout'))
      if (!isSimpleTwoGroupLayout(layout)) return false
      this.expandedLayout = layout
      this.managed = true
      const editorDisposable = this.vscode.window.onDidChangeActiveTextEditor?.((editor) => {
        if (editor && this.collapsed && !this.useExplicitWidths) {
          // VS Code restores the split before it activates a file opened from Explorer.
          // Re-maximize AIO until the user explicitly hovers the preview button.
          this.collapsed = false
          void this.collapse()
        }
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
          if (!this.previewRequested) {
            this.hoveringPreview = false
            this.scheduleCollapse()
            return
          }
          this.awaitingAioReentry = false
          this.hoveringPreview = true
          clearTimeout(this.timer)
          this.timer = undefined
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
      || !this.windowFocused || !this.panel) return
    const delay = this.options.collapseDelayMs ?? COLLAPSE_DELAY_MS
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.hoveringPreview && this.windowFocused && this.panel) {
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
      if (this.useExplicitWidths) {
        await this.vscode.commands.executeCommand('vscode.setEditorLayout', this.expandedLayout)
      } else {
        await this.vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup')
      }
      this.collapsed = false
      await this.panel?.webview?.postMessage?.({ type: 'aio:file-preview-state', collapsed: false })
      return true
    })
  }

  collapse() {
    return this.run(async () => {
      if (!this.managed || this.abandoned || this.collapsed || this.hoveringPreview
        || !this.windowFocused || !this.panel) return false
      const layout = await this.currentLayout()
      if (!sameSimpleLayout(layout, this.expandedLayout)) {
        this.abandon()
        return false
      }
      if (this.useExplicitWidths) {
        await this.vscode.commands.executeCommand('vscode.setEditorLayout', {
          orientation: 0, groups: [{ size: 0.001 }, { size: 0.999 }],
        })
      } else {
        this.panel.reveal?.(this.panel.viewColumn)
        await this.vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup')
      }
      this.collapsed = true
      this.previewRequested = false
      await this.panel?.webview?.postMessage?.({ type: 'aio:file-preview-state', collapsed: true })
      return true
    })
  }

  showFromTrigger() {
    this.previewRequested = true
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
          if (this.useExplicitWidths) await this.vscode.commands.executeCommand('vscode.setEditorLayout', this.expandedLayout)
          else await this.vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup')
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
      this.previewRequested = false
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
