'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const serviceRoot = path.resolve(__dirname, '../workbench/service')
const servicePath = path.join(serviceRoot, 'workbench-service.cjs')

class Sidecar {
  constructor(profile, pluginStorage) {
    const env = { ...process.env }
    if (pluginStorage) env.AIO_PLUGIN_STORAGE = pluginStorage
    else delete env.AIO_PLUGIN_STORAGE
    delete env.NODE_OPTIONS
    delete env.NODE_PATH
    this.child = spawn(process.execPath, [servicePath, profile, serviceRoot, '--smoke'], {
      cwd: serviceRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.nextId = 0
    this.pending = new Map()
    this.stderr = ''
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk })
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(this.error('sidecar ready timed out')), 15000)
      const fail = (error) => { clearTimeout(timer); reject(error) }
      this.child.once('error', fail)
      this.child.once('exit', (code) => fail(this.error(`sidecar exited before ready (${code})`)))
      this.onReady = () => { clearTimeout(timer); resolve() }
    })
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', (line) => this.receive(line))
  }

  error(message) {
    return new Error(message + (this.stderr ? `\n${this.stderr}` : ''))
  }

  receive(line) {
    const message = JSON.parse(line)
    if (message.event === 'workbench:ready') return this.onReady?.()
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.error) pending.reject(new Error(message.error))
    else pending.resolve(message.result)
  }

  async request(channel, ...args) {
    await this.ready
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(this.error(channel + ' timed out'))
      }, 15000)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ id, channel, args }) + '\n')
    })
  }

  async close() {
    if (this.child.exitCode !== null) return
    this.child.stdin.end()
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(this.error('sidecar close timed out')), 15000)
      this.child.once('exit', (result) => { clearTimeout(timer); resolve(result) })
    })
    assert.equal(code, 0, this.stderr)
  }
}

function byId(plugins, id) {
  const plugin = plugins.find((candidate) => candidate.id === id)
  assert.ok(plugin, `missing ${id} plugin`)
  return plugin
}

test('coding plugin state is shared across projects, restarts, and legacy profiles', { timeout: 60000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-shared-plugins-'))
  const shared = path.join(root, 'global', 'coding-agents')
  const active = new Set()
  const open = async (profile, storage = shared) => {
    const sidecar = new Sidecar(profile, storage)
    await sidecar.ready
    active.add(sidecar)
    return sidecar
  }
  const close = async (sidecar) => {
    active.delete(sidecar)
    await sidecar.close()
  }
  t.after(async () => {
    await Promise.all([...active].map((sidecar) => sidecar.close().catch(() => undefined)))
    await fs.rm(root, { recursive: true, force: true, maxRetries: 4 })
  })

  let sidecar = await open(path.join(root, 'workspace-a'))
  for (const id of ['omp', 'claude', 'codex']) {
    await sidecar.request('coding-plugins:set', id, 'uninstall')
    await sidecar.request('coding-plugins:set', id, 'install')
  }
  await close(sidecar)

  sidecar = await open(path.join(root, 'workspace-b'))
  let plugins = await sidecar.request('coding-plugins:list')
  assert.ok(plugins.every((plugin) => plugin.installed && plugin.enabled), 'project B lost installed plugins')
  await sidecar.request('coding-plugins:set', 'omp', 'disable')
  await sidecar.request('coding-plugins:set', 'codex', 'uninstall')
  plugins = await sidecar.request('coding-plugins:list')
  assert.equal(byId(plugins, 'omp').enabled, false)
  assert.equal(byId(plugins, 'codex').installed, false)
  assert.equal(byId(plugins, 'claude').installed, true)
  assert.equal(byId(plugins, 'claude').enabled, true)
  await close(sidecar)

  sidecar = await open(path.join(root, 'workspace-a'))
  plugins = await sidecar.request('coding-plugins:list')
  assert.equal(byId(plugins, 'omp').enabled, false, 'disabled state did not survive restart')
  assert.equal(byId(plugins, 'codex').installed, false, 'uninstall did not survive restart')
  assert.equal(byId(plugins, 'claude').enabled, true, 'peer plugin was affected')
  await close(sidecar)

  const liveA = await open(path.join(root, 'workspace-live-a'))
  const liveB = await open(path.join(root, 'workspace-live-b'))
  await Promise.all([
    liveA.request('coding-plugins:set', 'omp', 'enable'),
    liveB.request('coding-plugins:set', 'codex', 'install'),
  ])
  await Promise.all([
    liveA.request('coding-plugins:set', 'omp', 'disable'),
    liveB.request('coding-plugins:set', 'codex', 'uninstall'),
  ])
  assert.equal(byId(await liveB.request('coding-plugins:list'), 'omp').enabled, false,
    'live window did not observe the peer disable')
  assert.equal(byId(await liveA.request('coding-plugins:list'), 'codex').installed, false,
    'live window did not observe the peer uninstall')
  assert.equal(byId(await liveA.request('coding-plugins:list'), 'codex').installed, false)
  assert.equal(byId(await liveB.request('coding-plugins:list'), 'omp').enabled, false)
  await Promise.all([close(liveA), close(liveB)])
  sidecar = await open(path.join(root, 'workspace-live-check'))
  plugins = await sidecar.request('coding-plugins:list')
  assert.equal(byId(plugins, 'omp').enabled, false, 'concurrent omp change was lost')
  assert.equal(byId(plugins, 'codex').installed, false, 'concurrent codex change was lost')
  assert.equal(byId(plugins, 'claude').enabled, true, 'concurrent changes affected the peer plugin')
  await close(sidecar)

  const userRoot = path.join(root, 'migration', 'User')
  const legacyRoot = path.join(userRoot, 'workspaceStorage', 'old-hash', 'ancoder.aio-ide', 'workbench')
  sidecar = await open(legacyRoot, null)
  await sidecar.request('coding-plugins:set', 'omp', 'disable')
  await sidecar.request('coding-plugins:set', 'codex', 'uninstall')
  await close(sidecar)

  const migratedStorage = path.join(userRoot, 'globalStorage', 'ancoder.aio-ide', 'coding-agents')
  const upgradedProfile = path.join(userRoot, 'workspaceStorage', 'new-hash', 'ancoder.aio-ide', 'workbench')
  sidecar = await open(upgradedProfile, migratedStorage)
  plugins = await sidecar.request('coding-plugins:list')
  assert.equal(byId(plugins, 'omp').enabled, false, 'legacy disabled state was not migrated')
  assert.equal(byId(plugins, 'codex').installed, false, 'legacy uninstall was not migrated')
  assert.equal(byId(plugins, 'claude').enabled, true, 'legacy peer state was not migrated')
  await close(sidecar)

  await fs.writeFile(path.join(migratedStorage, 'coding-cli-plugins.json.lock'), JSON.stringify({
    pid: 2147483647, createdAt: Date.now(),
  }))
  sidecar = await open(path.join(root, 'recovered-lock'), migratedStorage)
  plugins = await sidecar.request('coding-plugins:set', 'omp', 'enable')
  assert.equal(byId(plugins, 'omp').enabled, true, 'dead process lock was not recovered')
  await close(sidecar)

  const invalid = new Sidecar(path.join(root, 'invalid-storage'), 'relative-plugin-storage')
  invalid.child.stdin.end()
  await assert.rejects(invalid.ready, /AIO_PLUGIN_STORAGE must be an absolute path/)
})
