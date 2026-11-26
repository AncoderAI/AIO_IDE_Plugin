'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const { ProjectRegistry, REGISTRY_PREFIX } = require('../src/project-registry')
const { WorkbenchHost } = require('../src/workbench')

function memento() {
  const values = new Map()
  return {
    get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
    update: async (key, value) => { if (value === undefined) values.delete(key); else values.set(key, value) },
    keys: () => [...values.keys()],
    values,
  }
}

function folder(fsPath, scheme = 'file', authority = '') {
  return {
    uri: {
      scheme, authority, fsPath,
      with(change) { return { scheme, authority, fsPath: change.path, path: change.path, with: this.with } },
    },
  }
}

function environment(root = 'D:\\C') {
  const globalState = memento()
  let workspaceListener
  const workspaceFolders = [folder(root)]
  const vscode = {
    FileType: { File: 1, Directory: 2 },
    Uri: { file: (fsPath) => ({ scheme: 'file', authority: '', fsPath }) },
    workspace: {
      isTrusted: true,
      workspaceFolders,
      fs: { stat: async () => ({ type: 2 }) },
      onDidChangeWorkspaceFolders: (listener) => { workspaceListener = listener; return { dispose() {} } },
      getWorkspaceFolder: () => workspaceFolders[0],
    },
  }
  const context = { globalState, subscriptions: [] }
  return { vscode, context, globalState, emitAdded: (added) => workspaceListener({ added }) }
}

function service(initial) {
  const projects = new Map(initial.map((project) => [project.primaryFolder, { harness: 'omp', ...project }]))
  const calls = []
  return {
    calls, projects,
    async request(channel, args) {
      calls.push([channel, args])
      if (channel === 'projects:list-initial') return [...projects.values()]
      if (channel === 'projects:add-selected') {
        const root = args[0]
        if (!projects.has(root)) projects.set(root, { id: 'id-' + projects.size, harness: 'omp', primaryFolder: root, path: root })
        return projects.get(root)
      }
      if (channel === 'projects:remove') {
        const target = [...projects.values()].find((project) => project.id === args[0])
        return target ? projects.delete(target.primaryFolder) : false
      }
      throw new Error('Unexpected channel ' + channel)
    },
  }
}

test('records a new workspace before workbench opens and merges prior backend projects later', async () => {
  const env = environment('D:\\C')
  const registry = new ProjectRegistry(env.vscode, env.context, { path: path.win32, fs: { realpath: async (value) => value } })
  await registry.start()
  assert.equal([...env.globalState.values.keys()].filter((key) => key.startsWith(REGISTRY_PREFIX)).length, 1)

  const backend = service([
    { id: 'a', primaryFolder: 'D:\\A', path: 'D:\\A' },
    { id: 'b', primaryFolder: 'D:\\B', path: 'D:\\B' },
  ])
  await registry.syncService(backend)
  assert.deepEqual([...backend.projects.keys()].sort(), ['D:\\A', 'D:\\B', 'D:\\C'])
  const firstAdds = backend.calls.filter(([channel]) => channel === 'projects:add-selected').length
  await registry.syncService(backend)
  assert.equal(backend.calls.filter(([channel]) => channel === 'projects:add-selected').length, firstAdds,
    'Existing projects must not be touched or reordered on repeated sync.')
  assert.equal([...env.globalState.values.keys()].filter((key) => key.startsWith(REGISTRY_PREFIX)).length, 3)

  const imports = []
  registry.setProjectImporter(async (paths) => {
    imports.push(paths)
    for (const projectPath of paths) await backend.request('projects:add-selected', [projectPath])
  })
  await env.emitAdded([folder('D:\\D')])
  await registry.queue
  assert.deepEqual(imports, [['D:\\D']])
  assert.ok(backend.projects.has('D:\\D'))
  registry.dispose()
})

test('a removed-project tombstone cleans stale profiles and never re-adds the project', async () => {
  const env = environment('D:\\A')
  const registry = new ProjectRegistry(env.vscode, env.context, { path: path.win32, fs: { realpath: async (value) => value } })
  await registry.start()
  await registry.write('D:\\B', 'active')
  await registry.markRemovedPath('D:\\B')
  const stale = service([
    { id: 'a', primaryFolder: 'D:\\A', path: 'D:\\A' },
    { id: 'b', primaryFolder: 'D:\\B', path: 'D:\\B' },
  ])
  await registry.syncService(stale)
  assert.deepEqual([...stale.projects.keys()], ['D:\\A'])
  assert.equal((await registry.read('D:\\B')).state, 'removed')
})

test('registry entries are isolated by remote authority and reopening is idempotent', async () => {
  const env = environment('/work/C')
  env.vscode.workspace.workspaceFolders[0] = folder('/work/C', 'vscode-remote', 'ssh-remote+one')
  const registry = new ProjectRegistry(env.vscode, env.context, { path: path.posix, fs: { realpath: async (value) => value } })
  await registry.start()
  await registry.write('/work/other-host', 'active', { scheme: 'vscode-remote', authority: 'ssh-remote+two' })
  const backend = service([])
  await registry.syncService(backend)
  await registry.syncService(backend)
  assert.deepEqual([...backend.projects.keys()], ['/work/C'])
  assert.equal(registry.entries().length, 1)
})

test('imports a missing current root last and skips filesystem and home roots', async () => {
  const env = environment('D:\\current')
  const registry = new ProjectRegistry(env.vscode, env.context, {
    path: path.win32, homeDirectory: 'D:\\home', fs: { realpath: async (value) => value },
  })
  await registry.write('D:\\other', 'active')
  await registry.start()
  assert.deepEqual(await registry.markActivePaths(['D:\\', 'D:\\home'], false), [])
  const backend = service([])
  await registry.syncService(backend)
  assert.deepEqual(backend.calls.filter(([channel]) => channel === 'projects:add-selected').map(([, args]) => args[0]), [
    'D:\\other', 'D:\\current',
  ])
})

test('workbench project removal writes a tombstone after backend removal succeeds', async () => {
  const removed = []
  const vscode = { window: { createOutputChannel: () => ({ append() {}, appendLine() {}, dispose() {} }) } }
  const host = new WorkbenchHost(vscode, {}, { projectRegistry: { markRemovedPath: async (value) => removed.push(value) } })
  const backend = service([{ id: 'b', primaryFolder: 'D:\\B', path: 'D:\\B' }])
  assert.equal(await host.desktopRequest({ channel: 'projects:remove', args: ['b', 'omp'] }, backend), true)
  assert.deepEqual(removed, ['D:\\B'])
  host.dispose()
})
