'use strict'

const { spawn, spawnSync } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')

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

function probeNodeRuntime(executable, runAsNode, spawnSyncImpl = spawnSync) {
  const environment = { ...process.env }
  delete environment.NODE_OPTIONS
  delete environment.NODE_PATH
  if (runAsNode) environment.ELECTRON_RUN_AS_NODE = '1'
  const result = spawnSyncImpl(executable, ['-e', "require('node:sqlite'); process.stdout.write(process.versions.node)"], {
    cwd: path.parse(executable).root,
    encoding: 'utf8',
    env: environment,
    timeout: 5_000,
    windowsHide: true,
  })
  return result.status === 0 ? String(result.stdout).trim() : ''
}

function resolveNodeRuntime(options = {}) {
  const hostVersion = options.hostVersion || process.versions.node
  const hostExecutable = options.hostExecutable || process.execPath
  const spawnSyncImpl = options.spawnSync || spawnSync
  const probe = options.probeNodeRuntime || probeNodeRuntime
  const host = { executable: hostExecutable, runAsNode: Boolean(process.versions.electron) }
  if (versionAtLeast(hostVersion) && versionAtLeast(probe(host.executable, host.runAsNode, spawnSyncImpl))) return host

  for (const candidate of options.candidates || externalNodeCandidates(options.platform, options.environment)) {
    try {
      if (!fs.statSync(candidate).isFile()) continue
      const version = probe(candidate, false, spawnSyncImpl)
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

  start() {
    if (this.child) return
    const runtime = (this.options.resolveNodeRuntime || resolveNodeRuntime)()
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
    if (!this.child) return
    this.stopping = true
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

function renderWorkbenchHtml(html, webview, uiUri, bridgeUri) {
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
  result = result.replace(/<head(\s[^>]*)?>/i, (head) => `${head}\n<meta http-equiv="Content-Security-Policy" content="${csp}">\n<base href="${base}">\n<script nonce="${token}" src="${bridgeUri}"></script>`)
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
    this.options = options
    this.panel = undefined
    this.service = undefined
    this.openFolders = []
    this.disposables = []
    this.opening = undefined
    this.log = vscode.window.createOutputChannel('AIO 工作台')
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

  async createPanel() {
    const uiRoot = this.context.asAbsolutePath(path.join('workbench', 'ui'))
    const serviceRoot = this.context.asAbsolutePath(path.join('workbench', 'service'))
    const servicePath = path.join(serviceRoot, 'workbench-service.cjs')
    const indexPath = path.join(uiRoot, 'index.html')
    if (!fs.existsSync(servicePath) || !fs.existsSync(indexPath)) {
      throw new Error('AIO 工作台资源未构建。请先运行 npm run build:workbench。')
    }
    const storageUri = this.context.storageUri || this.context.globalStorageUri
    await this.vscode.workspace.fs.createDirectory(storageUri)
    const panel = this.vscode.window.createWebviewPanel('aio.workbench', 'AIO 工作台', this.vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      enableCommandUris: false,
      localResourceRoots: [this.vscode.Uri.file(uiRoot), this.vscode.Uri.file(path.join(this.context.extensionPath, 'src'))],
    })
    this.panel = panel
    const panelDisposable = panel.onDidDispose(() => this.close(panel))
    this.disposables.push(panelDisposable)
    let service
    try {
      const profilePath = path.join(storageUri.fsPath, 'workbench')
      await fs.promises.mkdir(profilePath, { recursive: true })
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
      service.start()
      const uiUri = panel.webview.asWebviewUri(this.vscode.Uri.file(uiRoot))
      const bridgeUri = panel.webview.asWebviewUri(this.vscode.Uri.file(this.context.asAbsolutePath(path.join('src', 'webview-bridge.js'))))
      const source = await fs.promises.readFile(indexPath, 'utf8')
      if (this.panel !== panel || this.service !== service) throw new Error('AIO 工作台面板已关闭')
      panel.webview.html = renderWorkbenchHtml(source, panel.webview, uiUri, bridgeUri)
      const messageDisposable = panel.webview.onDidReceiveMessage((message) => { void this.handleMessage(message, panel, service) })
      this.disposables.push(messageDisposable)
      return panel
    } catch (error) {
      if (this.service === service) this.service = undefined
      service?.stop()
      if (this.panel === panel) this.panel = undefined
      for (const disposable of this.disposables.splice(0)) disposable.dispose()
      panel.dispose()
      throw error
    }
  }

  async handleMessage(message, panel = this.panel, service = this.service) {
    if (!validWebviewRequest(message) || !panel || !service || this.panel !== panel || this.service !== service) return
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
    // The shared renderer reads the task list at startup even on the Tauri
    // backend, which has no scheduled tasks.
    if (channel === 'long-run:list-tasks' && args.length === 0) return []
    if (channel === 'projects:add-selected') throw new Error('请通过 VS Code 的目录选择器添加项目')
    if (channel === 'projects:add') {
      const selection = await this.vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: '选择 AIO 项目目录' })
      if (!selection?.[0]) return null
      channel = 'projects:add-selected'
      args = [selection[0].fsPath]
    } else if (channel === 'coding-plugins:choose-executable') {
      if (args.length) throw new TypeError('Invalid executable picker request')
      const selection = await this.vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, title: '选择 AI CLI 可执行文件' })
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
    const service = this.service
    this.service = undefined
    service?.stop()
    for (const disposable of this.disposables.splice(0)) disposable.dispose()
  }

  dispose() {
    this.panel?.dispose()
    this.close()
    this.log.dispose()
  }
}

function registerWorkbench(vscode, context, options) {
  const host = new WorkbenchHost(vscode, context, options)
  context.subscriptions.push(
    vscode.commands.registerCommand('aio.openWorkbench', (resource) => host.open(resource).catch((error) => vscode.window.showErrorMessage(errorMessage(error)))),
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
