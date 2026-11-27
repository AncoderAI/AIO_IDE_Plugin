'use strict'

const { execFile, spawn } = require('node:child_process')
const runFile = require('node:util').promisify(execFile)
const { randomBytes } = require('node:crypto')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const { LazyHistory, key, previewKey, providers, queryWithNode } = require('./lazy-history')
const { openCli } = require('./launcher')
const { PreviewGroupController } = require('./preview-group')
const { resolveDroppedDirectories, resolveDroppedReferences, validFileDropRequest } = require('./file-drop')
const {
  HANDOFF_TTL_MS, clearProjectHandoff, currentWorkspaceMatches, projectRoot, registeredProject,
  projectFolderUri, samePath, storeProjectHandoff, uniquePaths,
} = require('./project-handoff')

const MAX_REQUEST_BYTES = 2 * 1024 * 1024
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 90_000
const MIN_NODE_VERSION = [22, 13, 0]

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function versionAtLeast(version, minimum = MIN_NODE_VERSION) {
  const values = String(version).split('.').map((value) => Number.parseInt(value, 10))
  if (values.some((value) => !Number.isFinite(value))) return false
  for (let index = 0; index < minimum.length; index++) {
    if ((values[index] || 0) > minimum[index]) return true
    if ((values[index] || 0) < minimum[index]) return false
  }
  return true
}

function externalNodeCandidates(platform = process.platform, environment = process.env) {
  const executable = platform === 'win32' ? 'node.exe' : 'node'
  return String(environment.PATH || '')
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter((entry) => entry && path.isAbsolute(entry))
    .map((entry) => path.join(entry, executable))
}

async function probeNodeRuntime(executable, runAsNode) {
  const environment = { ...process.env }
  delete environment.NODE_OPTIONS
  delete environment.NODE_PATH
  if (runAsNode) environment.ELECTRON_RUN_AS_NODE = '1'
  try {
    const { stdout } = await runFile(executable, ['-e', "require('node:sqlite'); process.stdout.write(process.versions.node)"], {
      cwd: path.parse(executable).root,
      encoding: 'utf8',
      env: environment,
      timeout: 5_000,
      windowsHide: true,
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

async function resolveNodeRuntime(options = {}) {
  const hostVersion = options.hostVersion || process.versions.node
  const hostExecutable = options.hostExecutable || process.execPath
  const probe = options.probeNodeRuntime || probeNodeRuntime
  const host = { executable: hostExecutable, runAsNode: Boolean(process.versions.electron) }
  if (versionAtLeast(hostVersion) && versionAtLeast(await probe(host.executable, host.runAsNode))) return host

  for (const candidate of options.candidates || externalNodeCandidates(options.platform, options.environment)) {
    try {
      if (!(await fs.promises.stat(candidate)).isFile()) continue
      const version = await probe(candidate, false)
      if (versionAtLeast(version)) return { executable: candidate, runAsNode: false }
    } catch {}
  }
  throw new Error('AIO 工作台需要 Node.js 22.13 或更高版本。请安装 Node.js 22/24 并加入系统 PATH。')
}

class WorkbenchService extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    this.pending = new Map()
    this.nextId = 1
    this.child = undefined
    this.lines = undefined
    this.stopping = false
    this.disconnected = false
  }

  async start() {
    if (this.child || this.stopping) return
    const runtime = await (this.options.resolveNodeRuntime || resolveNodeRuntime)()
    if (this.child || this.stopping) return
    const environment = { ...process.env, AIO_VERSION: this.options.version }
    delete environment.NODE_OPTIONS
    delete environment.NODE_PATH
    if (runtime.runAsNode) environment.ELECTRON_RUN_AS_NODE = '1'
    this.child = (this.options.spawn || spawn)(runtime.executable, [
      this.options.servicePath,
      this.options.profilePath,
      this.options.resourceRoot,
    ], {
      cwd: this.options.resourceRoot,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child.stderr.on('data', (chunk) => this.options.log?.append(String(chunk)))
    this.child.stdin.on('error', (error) => this.disconnect(errorMessage(error)))
    this.child.stdout.on('error', (error) => this.disconnect(errorMessage(error)))
    this.child.once('error', (error) => this.disconnect(errorMessage(error)))
    this.child.once('exit', (code, signal) => {
      if (!this.stopping) this.disconnect(`AIO 工作台服务已退出 (${signal || (code ?? 'unknown')})`)
      this.emit('exit', { code, signal })
    })
    this.lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    this.lines.on('line', (line) => this.acceptLine(line))
  }

  acceptLine(line) {
    if (Buffer.byteLength(line) > MAX_RESPONSE_BYTES) return this.disconnect('AIO 工作台服务返回的数据超过限制')
    let message
    try { message = JSON.parse(line) } catch { return this.disconnect('AIO 工作台服务返回了无效数据') }
    if (message && (typeof message.id === 'number' || typeof message.id === 'string')) {
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      clearTimeout(request.timer)
      if (typeof message.error === 'string') request.reject(new Error(message.error))
      else request.resolve(message.result)
      return
    }
    if (message && typeof message.event === 'string') {
      const event = message.event === 'coding:changed' || message.event === 'coding:delta' ? 'coding-event' : 'desktop-event'
      this.emit('event', { event, payload: message })
    }
  }

  request(channel, args) {
    if (this.disconnected) return Promise.reject(new Error('AIO 工作台服务不可用'))
    if (!this.child?.stdin?.writable) return Promise.reject(new Error('AIO 工作台服务不可用'))
    const id = this.nextId++
    const frame = JSON.stringify({ id, channel, args }) + '\n'
    if (Buffer.byteLength(frame) > MAX_REQUEST_BYTES) return Promise.reject(new Error('AIO 工作台请求超过限制'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('AIO 工作台服务响应超时'))
      }, REQUEST_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.child.stdin.write(frame, (error) => {
          if (!error) return
          const request = this.pending.get(id)
          if (!request) return
          this.pending.delete(id)
          clearTimeout(request.timer)
          request.reject(error)
        })
      } catch (error) {
        const request = this.pending.get(id)
        this.pending.delete(id)
        clearTimeout(request.timer)
        request.reject(error)
      }
    })
  }

  disconnect(message) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error(message))
    }
    this.pending.clear()
    if (!this.disconnected) {
      this.disconnected = true
      this.emit('disconnect', message)
    }
  }

  stop() {
    this.stopping = true
    if (!this.child) return
    this.lines?.close()
    this.child.stdin?.end()
    const child = this.child
    const timer = setTimeout(() => child.kill(), 9_000)
    timer.unref?.()
    child.once('exit', () => clearTimeout(timer))
    this.child = undefined
    this.disconnect('AIO 工作台已关闭')
  }
}

function nonce() {
  return randomBytes(24).toString('base64url')
}

function renderWorkbenchHtml(html, webview, uiUri, bridgeUri, fileDropUri, panelScriptUri, panelStyleUri, historyUri) {
  const token = nonce()
  const base = String(uiUri).replace(/\/?$/, '/')
  const csp = [
    "default-src 'none'",
    `script-src ${webview.cspSource} 'nonce-${token}'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${webview.cspSource} data: blob: https:`,
    `font-src ${webview.cspSource} data:`,
    `base-uri ${webview.cspSource}`,
    "connect-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
  ].join('; ')
  let result = html.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>\s*/gi, '')
  result = result.replace(/<head(\s[^>]*)?>/i, (head) => `${head}\n<meta http-equiv="Content-Security-Policy" content="${csp}">\n<base href="${base}">${panelStyleUri ? `\n<link rel="stylesheet" href="${panelStyleUri}">` : ''}\n<script nonce="${token}" src="${bridgeUri}"></script>${fileDropUri ? `\n<script nonce="${token}" src="${fileDropUri}"></script>` : ''}${panelScriptUri ? `\n<script nonce="${token}" src="${panelScriptUri}"></script>` : ''}`)
  if (historyUri) result = result.replace('</head>', `<script nonce="${token}" src="${historyUri}"></script></head>`)
  result = result.replace(/<script\b(?![^>]*\bnonce=)/gi, `<script nonce="${token}"`)
  return result
}

function validWebviewRequest(message) {
  if (!message || message.type !== 'aio:request' || !Number.isSafeInteger(message.id)) return false
  if (typeof message.command !== 'string' || !message.args || typeof message.args !== 'object' || Array.isArray(message.args)) return false
  try { return Buffer.byteLength(JSON.stringify(message)) <= MAX_REQUEST_BYTES } catch { return false }
}

class WorkbenchHost {
  constructor(vscode, context, options = {}) {
    this.vscode = vscode
    this.context = context
    this.history = options.history || new LazyHistory({
      queryCodex: async (filename, cwd) => queryWithNode(await resolveNodeRuntime(), filename, cwd),
    })
    this.options = options
    this.panel = undefined
    this.service = undefined
    this.openFolders = []
    this.disposables = []
    this.opening = undefined
    this.referenceSequence = 0
    this.referenceRequests = new Map()
    this.terminalClipboardSequence = 0
    this.terminalClipboardRequests = new Map()
    this.panelListeners = new Set()
    this.projectSwitch = undefined
    this.previewGroup = options.previewGroupController || new PreviewGroupController(vscode, context, options.previewGroup)
    this.previewReadyPanels = new WeakSet()
    this.log = vscode.window.createOutputChannel('AIO 工作台')
  }

  onDidChangePanel(listener) {
    this.panelListeners.add(listener)
    return { dispose: () => this.panelListeners.delete(listener) }
  }

  notifyPanelChanged() {
    for (const listener of this.panelListeners) listener(Boolean(this.panel))
  }

  isOpen() { return Boolean(this.panel && this.service) }

  async terminalClipboardState(panel = this.panel) {
    if (!panel?.active || !this.service) return { available: false, text: '' }
    const id = ++this.terminalClipboardSequence
    const response = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.terminalClipboardRequests.delete(id)
        resolve({ available: false, text: '' })
      }, 1000)
      timer.unref?.()
      this.terminalClipboardRequests.set(id, { resolve, timer })
    })
    if (!await panel.webview.postMessage({ type: 'aio:terminal-copy-request', id })) {
      const request = this.terminalClipboardRequests.get(id)
      if (request) {
        this.terminalClipboardRequests.delete(id)
        clearTimeout(request.timer)
        request.resolve({ available: false, text: '' })
      }
    }
    return response
  }

  async copyTerminalSelection() {
    const state = await this.terminalClipboardState()
    if (!state.available || !state.text) return false
    await this.vscode.env.clipboard.writeText(state.text)
    return true
  }

  async pasteIntoTerminal() {
    const panel = this.panel
    const state = await this.terminalClipboardState(panel)
    if (!state.available || !state.terminalId || this.panel !== panel || !panel?.active) return false
    const text = await this.vscode.env.clipboard.readText()
    if (!text || this.panel !== panel || !panel.active) return false
    return panel.webview.postMessage({ type: 'aio:terminal-paste', terminalId: state.terminalId, text })
  }

  async insertDroppedCandidates(candidates) {
    if (!this.panel || !this.service) {
      await this.vscode.window.showWarningMessage('请先打开 AIO 完整工作台，再引用文件或文件夹。')
      return false
    }
    const references = await resolveDroppedReferences(this.vscode, path, candidates)
    if (!references.length) {
      await this.vscode.window.showWarningMessage('所选项目不在当前 VS Code 工作区中，或已经不存在。')
      return false
    }
    const id = ++this.referenceSequence
    const result = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.referenceRequests.delete(id)
        resolve(false)
      }, 5000)
      timer.unref?.()
      this.referenceRequests.set(id, { resolve, timer })
    })
    const posted = await this.panel.webview.postMessage({ type: 'aio:insert-file-references', id, references })
    if (!posted) {
      const request = this.referenceRequests.get(id)
      if (request) {
        this.referenceRequests.delete(id)
        clearTimeout(request.timer)
        request.resolve(false)
      }
    }
    const inserted = await result
    if (!inserted) await this.vscode.window.showWarningMessage('当前工作台没有可接收文件引用的对话框或终端输入区。')
    return inserted
  }

  async addProjectCandidates(candidates, allowOutsideWorkspace = false) {
    if (!this.panel || !this.service) {
      await this.vscode.window.showWarningMessage('请先打开 AIO 完整工作台，再添加项目。')
      return 0
    }
    const directories = await resolveDroppedDirectories(this.vscode, path, candidates, !allowOutsideWorkspace)
    if (!directories.length) {
      await this.vscode.window.showWarningMessage('请拖入有效的文件夹。工作台内只接受当前 VS Code 工作区中的目录。')
      return 0
    }
    await this.options.projectRegistry?.markActivePaths?.(directories, true)
    let queued = 0
    for (const directory of directories) {
      if (this.openFolders.includes(directory)) continue
      this.openFolders.push(directory)
      queued++
    }
    if (queued) this.postEvent('desktop-event', { event: 'app:open-folder', payload: null })
    return queued
  }

  activateProjectPath(requestedPath) {
    if (this.projectSwitch) {
      return samePath(path, this.projectSwitch.path, String(requestedPath))
        ? this.projectSwitch.promise
        : Promise.resolve(false)
    }
    const promise = this.performProjectSwitch(requestedPath).finally(() => {
      if (this.projectSwitch?.promise === promise) this.projectSwitch = undefined
    })
    this.projectSwitch = { path: String(requestedPath), promise }
    return promise
  }

  async performProjectSwitch(requestedPath) {
    if (!this.panel || !this.service) return false
    if (typeof requestedPath !== 'string' || !requestedPath || /[\u0000-\u001f\u007f-\u009f]/.test(requestedPath)) return false
    const projects = await this.service.request('projects:list-initial', [])
    const project = registeredProject(path, projects, requestedPath)
    if (!project) {
      await this.vscode.window.showWarningMessage('该目录不是 AIO 已登记的项目。')
      return false
    }
    const target = projectRoot(project)
    const roots = uniquePaths(path, projects.map(projectRoot))
    if (currentWorkspaceMatches(this.vscode, path, target)) return true
    if (!this.context.globalState) throw new Error('AIO 项目切换状态不可用')
    const uri = projectFolderUri(this.vscode, path, target)
    const stat = await this.vscode.workspace.fs.stat(uri)
    const fileType = this.vscode.FileType || { Directory: 2 }
    if (!(stat.type & fileType.Directory)) throw new Error('AIO 项目目录已经不存在')
    await storeProjectHandoff(this.context, path, {
      target,
      projects: roots,
      expiresAt: Date.now() + HANDOFF_TTL_MS,
      token: randomBytes(16).toString('hex'),
    })
    try {
      await this.vscode.commands.executeCommand('vscode.openFolder', uri, false)
      return true
    } catch (error) {
      await clearProjectHandoff(this.context, path, target)
      throw error
    }
  }

  async open(resource) {
    const folder = resource?.scheme === 'file' ? resource.fsPath : undefined
    if (folder && !this.openFolders.includes(folder)) this.openFolders.push(folder)
    if (this.panel) {
      this.panel.reveal()
      if (folder) this.postEvent('desktop-event', { event: 'app:open-folder', payload: null })
      return this.panel
    }
    if (this.opening) return this.opening
    this.opening = this.createPanel().finally(() => { this.opening = undefined })
    return this.opening
  }

  async createWorkbenchPanel(uiRoot) {
    // Keep AIO in its own editor group. Locking this newly-created empty group
    // makes Explorer open files in another group even after the user clicks AIO.
    await this.previewGroup.captureBaseline()
    const explorerOnRight = this.vscode.workspace.getConfiguration('workbench.sideBar').get('location') === 'right'
    if (explorerOnRight) await this.vscode.commands.executeCommand('workbench.action.moveSideBarLeft')
    await this.vscode.commands.executeCommand('workbench.action.newGroupRight')
    const panel = this.vscode.window.createWebviewPanel('aio.workbench', 'AIO 工作台', this.vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      enableCommandUris: false,
      localResourceRoots: [this.vscode.Uri.file(uiRoot), this.vscode.Uri.file(path.join(this.context.extensionPath, 'src'))],
    })
    try {
      await this.vscode.commands.executeCommand('workbench.action.lockEditorGroup')
      return panel
    } catch (error) {
      panel.dispose()
      await this.previewGroup.close()
      throw error
    }
  }

  async createPanel() {
    const uiRoot = this.context.asAbsolutePath(path.join('workbench', 'ui'))
    const serviceRoot = this.context.asAbsolutePath(path.join('workbench', 'service'))
    const servicePath = path.join(serviceRoot, 'workbench-service.cjs')
    const indexPath = path.join(uiRoot, 'index.html')
    if (!fs.existsSync(servicePath) || !fs.existsSync(indexPath)) {
      throw new Error('AIO 工作台资源未构建。请先运行 npm run build:workbench。')
    }
    const storageUri = this.context.storageUri || this.context.globalStorageUri
    const source = await fs.promises.readFile(indexPath, 'utf8')
    const panel = await this.createWorkbenchPanel(uiRoot)
    let service
    try {
      this.panel = panel
      const panelDisposable = panel.onDidDispose(() => this.close(panel))
      this.disposables.push(panelDisposable)
      const profilePath = path.join(storageUri.fsPath, 'workbench')
      service = new WorkbenchService({
        version: this.context.extension?.packageJSON?.version || 'development',
        profilePath,
        resourceRoot: serviceRoot,
        servicePath,
        log: this.log,
        ...this.options.service,
      })
      this.service = service
      if (this.panel !== panel) throw new Error('AIO 工作台面板已关闭')
      service.on('event', ({ event, payload }) => {
        if (this.service === service && this.panel === panel) this.postEvent(event, payload, panel)
      })
      service.on('disconnect', (message) => {
        this.log.appendLine(message)
        if (this.service === service && this.panel === panel) void this.vscode.window.showErrorMessage(message)
      })
      const uiUri = panel.webview.asWebviewUri(this.vscode.Uri.file(uiRoot))
      const bridgeUri = panel.webview.asWebviewUri(this.vscode.Uri.file(this.context.asAbsolutePath(path.join('src', 'webview-bridge.js'))))
      const fileDropUri = panel.webview.asWebviewUri(this.vscode.Uri.file(this.context.asAbsolutePath(path.join('src', 'file-drop.js'))))
      const panelScriptUri = panel.webview.asWebviewUri(this.vscode.Uri.file(this.context.asAbsolutePath(path.join('src', 'panel-auto-hide.js'))))
      const panelStyleUri = panel.webview.asWebviewUri(this.vscode.Uri.file(this.context.asAbsolutePath(path.join('src', 'panel-auto-hide.css'))))
      if (this.panel !== panel || this.service !== service) throw new Error('AIO 工作台面板已关闭')
      const ready = fs.promises.mkdir(profilePath, { recursive: true }).then(() => {
        if (this.panel !== panel) throw new Error('AIO 工作台面板已关闭')
        return service.start()
      })
      const messageDisposable = panel.webview.onDidReceiveMessage((message) => {
        void ready.then(() => this.handleMessage(message, panel, service), () => {})
      })
      this.disposables.push(messageDisposable)
      const historyUri = panel.webview.asWebviewUri(this.vscode.Uri.file(this.context.asAbsolutePath(path.join('src', 'history-view.js'))))
      panel.webview.html = renderWorkbenchHtml(source, panel.webview, uiUri, bridgeUri, fileDropUri, panelScriptUri, panelStyleUri, historyUri)
      await ready
      if (this.panel !== panel) throw new Error('AIO 工作台面板已关闭')
      this.projectSync = Promise.resolve(this.options.projectRegistry?.syncService?.(service)).catch((error) => {
        if (this.service === service) this.log.appendLine('AIO 项目同步失败 ' + errorMessage(error))
      })
      this.notifyPanelChanged()
      return panel
    } catch (error) {
      if (this.service === service) this.service = undefined
      this.options.projectRegistry?.detachService?.(service)
      service?.stop()
      if (this.panel === panel) {
        this.panel = undefined
        this.notifyPanelChanged()
      }
      for (const disposable of this.disposables.splice(0)) disposable.dispose()
      panel.dispose()
      throw error
    }
  }

  async handleMessage(message, panel = this.panel, service = this.service) {
    if (!panel || !service || this.panel !== panel || this.service !== service) return
    if (message?.type === 'aio:file-preview-ready') {
      if (this.previewReadyPanels.has(panel)) return
      this.previewReadyPanels.add(panel)
      await this.previewGroup.attach(panel)
      return
    }
    if (message?.type === 'aio:file-preview-group' && message.action === 'show') {
      await this.previewGroup.showFromTrigger()
      return
    }
    if (message?.type === 'aio:file-preview-group' && message.action === 'aio-enter') {
      this.previewGroup.aioPointerEntered()
      return
    }
    if (message?.type === 'aio:project-activate') {
      try { await this.activateProjectPath(message.path) }
      catch (error) { await this.vscode.window.showErrorMessage(errorMessage(error)) }
      return
    }
    if (message?.type === 'aio:file-reference-result' && Number.isSafeInteger(message.id)) {
      const request = this.referenceRequests.get(message.id)
      if (!request) return
      this.referenceRequests.delete(message.id)
      clearTimeout(request.timer)
      request.resolve(message.inserted === true)
      return
    }
    if (message?.type === 'aio:terminal-selection' && Number.isSafeInteger(message.id)) {
      const request = this.terminalClipboardRequests.get(message.id)
      if (!request) return
      this.terminalClipboardRequests.delete(message.id)
      clearTimeout(request.timer)
      request.resolve({
        available: message.available === true,
        terminalId: typeof message.terminalId === 'string' ? message.terminalId : undefined,
        text: typeof message.text === 'string' ? message.text : '',
      })
      return
    }
    if (validFileDropRequest(message)) {
      if (message.type === 'aio:project-drop') {
        try {
          const added = await this.addProjectCandidates(message.candidates, false)
          if (this.panel === panel && this.service === service) {
            await panel.webview.postMessage({ type: 'aio:project-drop-response', id: message.id, added })
          }
        } catch (error) {
          this.log.appendLine(`AIO 项目导入失败: ${errorMessage(error)}`)
          if (this.panel === panel && this.service === service) {
            await panel.webview.postMessage({
              type: 'aio:project-drop-response', id: message.id, added: 0, error: errorMessage(error),
            })
          }
        }
        return
      }
      try {
        const references = await resolveDroppedReferences(this.vscode, path, message.candidates)
        if (this.panel === panel && this.service === service) {
          await panel.webview.postMessage({ type: 'aio:file-drop-response', id: message.id, references })
        }
      } catch (error) {
        this.log.appendLine(`AIO 文件引用失败: ${errorMessage(error)}`)
        if (this.panel === panel && this.service === service) {
          await panel.webview.postMessage({
            type: 'aio:file-drop-response', id: message.id, references: [], error: errorMessage(error),
          })
        }
      }
      return
    }
    if (!validWebviewRequest(message)) return
    try {
      let result
      if (message.command === 'set_title_bar_theme') {
        if (message.args.theme !== 'light' && message.args.theme !== 'dark') throw new TypeError('Invalid title bar theme')
        result = true
      } else if (message.command === 'desktop_request') {
        result = await this.desktopRequest(message.args, service)
      } else {
        throw new Error(`Unsupported AIO bridge command: ${message.command}`)
      }
      if (this.panel === panel && this.service === service) await panel.webview.postMessage({ type: 'aio:response', id: message.id, result })
    } catch (error) {
      if (this.panel === panel && this.service === service) await panel.webview.postMessage({ type: 'aio:response', id: message.id, error: errorMessage(error) })
    }
  }

  async desktopRequest(input, service = this.service) {
    if (typeof input.channel !== 'string' || input.channel.length < 1 || input.channel.length > 128) throw new TypeError('Invalid desktop channel')
    if (!Array.isArray(input.args) || input.args.length > 16) throw new TypeError('Invalid desktop arguments')
    let { channel, args } = input
    // The desktop renderer requests these catalogs during bootstrap and navigation.
    // This host exposes the history catalog through the explicit per-provider actions.
    if (['sessions:list', 'terminal:list-restorable', 'coding:list', 'coding:list-summaries', 'app:list-coding-cli-history'].includes(channel)) {
      return channel === 'terminal:list-restorable' ? {} : []
    }
    if (channel === 'app:refresh-coding-cli-history') return null
    if (channel === 'projects:list') {
      await this.projectSync
      return service.request('projects:list-initial', [])
    }
    if (['aio-history:cached', 'aio-history:list', 'aio-history:resume'].includes(channel)) {
      const [folder, provider, id] = args
      if (this.vscode.workspace.isTrusted === false || typeof folder !== 'string' ||
          !path.isAbsolute(folder) || !providers.has(provider)) throw new Error('无效的历史会话请求')
      const records = await service.request('projects:list-initial', [])
      const project = records.find(row => key(row.primaryFolder || row.path) === key(folder))
      if (!project) throw new Error('该目录不是 AIO 已登记的项目')
      const cwd = project.primaryFolder || project.path
      const previews = this.context.workspaceState
      const cacheKey = previewKey(cwd, provider)
      const saved = previews?.get(cacheKey, []) || []
      if (channel === 'aio-history:cached') return saved
      const clickedCachedSession = channel === 'aio-history:resume' && saved.some(row => row.id === id) &&
        !this.history.hasCatalog(cwd, provider)
      if (channel === 'aio-history:list' || clickedCachedSession) {
        const buckets = []
        const storage = this.context.storageUri || this.context.globalStorageUri
        if (provider === 'omp' && storage) {
          const restored = await service.request('terminal:list-restorable', [[project.id]])
          for (const row of restored[project.id] || []) {
            if (row.agent === 'omp' && /^[a-f0-9-]{36}$/i.test(row.id)) {
              buckets.push(path.join(storage.fsPath, 'workbench', 'terminal-sessions', row.id))
            }
          }
        }
        const rows = await this.history.list(cwd, provider, buckets)
        await previews?.update(cacheKey, rows)
        if (channel === 'aio-history:list') return rows
      }
      const sessionArgs = this.history.resumeArgs(cwd, provider, id)
      const config = this.context.asAbsolutePath('workbench/service/aio-omp-config.yml')
      return Boolean(await openCli(this.vscode, provider, this.vscode.Uri.file(cwd), config, sessionArgs))
    }
    // The shared renderer reads the task list at startup even on the Tauri
    // backend, which has no scheduled tasks.
    if (channel === 'long-run:list-tasks' && args.length === 0) return []
    if (channel === 'projects:remove') {
      const projects = await service.request('projects:list-initial', [])
      const project = projects.find((candidate) => candidate.id === args[0])
      const removed = await service.request(channel, args)
      if (removed && project) await this.options.projectRegistry?.markRemovedPath?.(project.primaryFolder || project.path)
      return removed
    }
    if (channel === 'projects:add-selected') throw new Error('请通过 VS Code 的目录选择器添加项目')
    if (channel === 'projects:add') {
      const selection = await this.vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: '选择 AIO 项目目录' })
      if (!selection?.[0]) return null
      channel = 'projects:add-selected'
      args = [selection[0].fsPath]
    } else if (channel === 'coding-plugins:choose-executable') {
      if (args.length) throw new TypeError('Invalid executable picker request')
      const selection = await this.vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, title: '选择 AI CLI 可执行文件', filters: process.platform === 'win32' ? { 'Windows 可执行文件': ['exe'] } : undefined })
      return selection?.[0]?.fsPath || null
    } else if (channel === 'app:take-open-folder') {
      if (args.length) throw new TypeError('Invalid open folder request')
      const folder = this.openFolders.shift()
      if (!folder) return null
      channel = 'projects:add-selected'
      args = [folder]
    }
    if (!service) throw new Error('AIO 工作台服务不可用')
    if (channel === 'projects:list-worktrees') {
      try {
        return await service.request(channel, args)
      } catch (error) {
        if (/Git repository root inspection failed: fatal: not a git repository/i.test(errorMessage(error))) return []
        throw error
      }
    }
    return service.request(channel, args)
  }

  postEvent(event, payload, panel = this.panel) {
    if (panel && this.panel === panel) void panel.webview.postMessage({ type: 'aio:event', event, payload })
  }

  close(panel = this.panel) {
    if (panel && this.panel !== panel) return
    this.panel = undefined
    void this.previewGroup.close()
    this.notifyPanelChanged()
    for (const request of this.referenceRequests.values()) {
      clearTimeout(request.timer)
      request.resolve(false)
    }
    this.referenceRequests.clear()
    for (const request of this.terminalClipboardRequests.values()) {
      clearTimeout(request.timer)
      request.resolve({ available: false, text: '' })
    }
    this.terminalClipboardRequests.clear()
    const service = this.service
    this.service = undefined
    this.options.projectRegistry?.detachService?.(service)
    service?.stop()
    for (const disposable of this.disposables.splice(0)) disposable.dispose()
  }

  dispose() {
    this.panel?.dispose()
    this.close()
    this.log.dispose()
    void this.previewGroup.dispose()
  }
}

function registerWorkbench(vscode, context, options) {
  const host = new WorkbenchHost(vscode, context, options)
  context.subscriptions.push(
    vscode.commands.registerCommand('aio.openWorkbench', (resource) => host.open(resource).catch((error) => vscode.window.showErrorMessage(errorMessage(error)))),
    vscode.commands.registerCommand('aio.openRegisteredProject', (projectPath) => host.activateProjectPath(projectPath)
      .catch((error) => vscode.window.showErrorMessage(errorMessage(error)))),
    vscode.commands.registerCommand('aio.copyWorkbenchTerminalSelection', () => host.copyTerminalSelection()),
    vscode.commands.registerCommand('aio.pasteIntoWorkbenchTerminal', () => host.pasteIntoTerminal()),
    host,
  )
  return host
}

module.exports = {
  WorkbenchHost,
  WorkbenchService,
  externalNodeCandidates,
  registerWorkbench,
  renderWorkbenchHtml,
  resolveNodeRuntime,
  validWebviewRequest,
  versionAtLeast,
}
