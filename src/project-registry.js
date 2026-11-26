'use strict'

const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const REGISTRY_PREFIX = 'aio.projectRegistry.v1.'

function normalizedPath(pathModule, value) {
  const normalized = pathModule.resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function authorityOf(uri) {
  return { scheme: uri.scheme, authority: uri.authority || '' }
}

function registryKey(pathModule, scheme, authority, projectPath) {
  const identity = `${scheme}\0${authority}\0${normalizedPath(pathModule, projectPath)}`
  return REGISTRY_PREFIX + createHash('sha256').update(identity).digest('hex')
}

function projectPath(project) {
  return project?.primaryFolder || project?.path || project?.folders?.[0]
}

class ProjectRegistry {
  constructor(vscode, context, options = {}) {
    this.vscode = vscode
    this.context = context
    this.path = options.path || path
    this.fs = options.fs || fs
    this.homeDirectory = options.homeDirectory || os.homedir()
    this.service = undefined
    this.disposables = []
    this.queue = Promise.resolve()
    this.projectImporter = undefined
  }

  identity() {
    const folder = (this.vscode.workspace.workspaceFolders || [])[0]
    return folder ? authorityOf(folder.uri) : undefined
  }

  async canonical(projectPath) {
    const resolved = this.path.resolve(projectPath)
    try { return await this.fs.realpath(resolved) } catch { return resolved }
  }

  metadata(projectPath, state, identity = this.identity()) {
    if (!identity) return undefined
    const canonical = this.path.resolve(projectPath)
    return {
      key: registryKey(this.path, identity.scheme, identity.authority, canonical),
      value: { version: 1, ...identity, path: canonical, state, updatedAt: Date.now() },
    }
  }

  async read(projectPath, identity = this.identity()) {
    const descriptor = this.metadata(projectPath, 'active', identity)
    return descriptor ? this.context.globalState.get(descriptor.key) : undefined
  }

  async write(projectPath, state, identity = this.identity()) {
    const canonical = await this.canonical(projectPath)
    const descriptor = this.metadata(canonical, state, identity)
    if (!descriptor) return undefined
    await this.context.globalState.update(descriptor.key, descriptor.value)
    return descriptor.value
  }

  async markActivePaths(paths, force = true, identity = this.identity()) {
    if (!identity) return []
    const recorded = []
    for (const projectPath of paths) {
      const canonical = await this.canonical(projectPath)
      const normalized = normalizedPath(this.path, canonical)
      if (normalized === normalizedPath(this.path, this.path.parse(canonical).root)
        || normalized === normalizedPath(this.path, this.homeDirectory)) continue
      const existing = await this.read(canonical, identity)
      if (existing?.state === 'removed' && !force) continue
      const uri = this.uriForPath(canonical, identity)
      let stat
      try { stat = await this.vscode.workspace.fs.stat(uri) } catch { continue }
      const fileType = this.vscode.FileType || { Directory: 2 }
      if (!(stat.type & fileType.Directory)) continue
      await this.write(canonical, 'active', identity)
      recorded.push(canonical)
    }
    return recorded
  }

  async markRemovedPath(projectPath) {
    return this.write(projectPath, 'removed')
  }

  uriForPath(projectPath, identity = this.identity()) {
    const current = (this.vscode.workspace.workspaceFolders || [])[0]?.uri
    if (identity && current && identity.scheme !== 'file' && current.scheme === identity.scheme
      && (current.authority || '') === identity.authority && typeof current.with === 'function') {
      return current.with({ path: this.path.resolve(projectPath).split(this.path.sep).join('/') })
    }
    return this.vscode.Uri.file(projectPath)
  }

  entries(identity = this.identity()) {
    if (!identity || typeof this.context.globalState.keys !== 'function') return []
    return this.context.globalState.keys()
      .filter((key) => key.startsWith(REGISTRY_PREFIX))
      .map((key) => this.context.globalState.get(key))
      .filter((entry) => entry?.version === 1 && entry.scheme === identity.scheme && entry.authority === identity.authority)
  }

  serial(operation) {
    const result = this.queue.then(operation, operation)
    this.queue = result.catch(() => undefined)
    return result
  }

  setProjectImporter(importer) { this.projectImporter = importer }

  async recordWorkspaceFolders(folders, sync = true) {
    if (this.vscode.workspace.isTrusted === false || !Array.isArray(folders) || !folders.length) return []
    return this.serial(async () => {
      const recorded = []
      for (const folder of folders) {
        if (!folder?.uri?.fsPath) continue
        const identity = authorityOf(folder.uri)
        if (identity.scheme !== 'file' && identity.scheme !== 'vscode-remote') continue
        const canonical = await this.canonical(folder.uri.fsPath)
        const existing = await this.read(canonical, identity)
        if (existing?.state === 'removed') continue
        const values = await this.markActivePaths([canonical], false, identity)
        recorded.push(...values)
      }
      if (sync && this.service) {
        if (this.projectImporter) await this.projectImporter(recorded)
        else for (const projectPath of recorded) await this.service.request('projects:add-selected', [projectPath])
      }
      return recorded
    })
  }

  async syncService(service) {
    this.service = service
    return this.serial(async () => {
      const identity = this.identity()
      if (!identity) return
      const projects = await service.request('projects:list-initial', [])
      const existingPaths = new Set()
      for (const project of projects) {
        const root = projectPath(project)
        if (!root) continue
        const canonical = await this.canonical(root)
        const existing = await this.read(root, identity)
        if (existing?.state === 'removed') {
          await service.request('projects:remove', [project.id, project.harness])
        } else if (!existing) {
          await this.write(root, 'active', identity)
          existingPaths.add(normalizedPath(this.path, canonical))
        } else {
          existingPaths.add(normalizedPath(this.path, canonical))
        }
      }
      const currentRoot = (this.vscode.workspace.workspaceFolders || [])[0]?.uri?.fsPath
      const entries = this.entries(identity).filter((entry) => entry.state === 'active')
        .sort((left, right) => Number(Boolean(currentRoot && normalizedPath(this.path, left.path) === normalizedPath(this.path, currentRoot)))
          - Number(Boolean(currentRoot && normalizedPath(this.path, right.path) === normalizedPath(this.path, currentRoot))))
      for (const entry of entries) {
        const canonical = await this.canonical(entry.path)
        if (existingPaths.has(normalizedPath(this.path, canonical))) continue
        let stat
        try { stat = await this.vscode.workspace.fs.stat(this.uriForPath(entry.path, identity)) } catch { continue }
        const fileType = this.vscode.FileType || { Directory: 2 }
        if (!(stat.type & fileType.Directory)) continue
        try {
          await service.request('projects:add-selected', [entry.path])
          existingPaths.add(normalizedPath(this.path, canonical))
        } catch { /* broad or otherwise rejected directories must not block valid projects */ }
      }
    })
  }

  detachService(service) {
    if (!service || this.service === service) this.service = undefined
  }

  async start() {
    await this.recordWorkspaceFolders(this.vscode.workspace.workspaceFolders || [], false)
    if (this.vscode.workspace.onDidChangeWorkspaceFolders) {
      const disposable = this.vscode.workspace.onDidChangeWorkspaceFolders((event) => {
        void this.recordWorkspaceFolders(event.added || [], true)
      })
      this.disposables.push(disposable)
      this.context.subscriptions.push(disposable)
    }
  }

  dispose() {
    this.detachService()
    this.projectImporter = undefined
    for (const disposable of this.disposables.splice(0)) disposable.dispose()
  }
}

module.exports = { ProjectRegistry, REGISTRY_PREFIX, authorityOf, normalizedPath, projectPath, registryKey }
