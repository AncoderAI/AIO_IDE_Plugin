'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { localize } = require('./localize')

const providers = new Set(['omp', 'claude', 'codex'])
const { createHash } = require('node:crypto')
const sessionId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const MAX_ROWS = 100
const readLimit = 32768

function key(value) {
  const normalized = path.resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function previewKey(cwd, provider) {
  const digest = createHash('sha256').update(key(cwd)).digest('hex')
  return 'aio.history-preview.v1.' + digest + '.' + provider
}

function compactTitle(value) {
  return typeof value === 'string' ? Array.from(value.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim()).slice(0, 100).join('') : ''
}

function userText(message) {
  if (typeof message?.content === 'string') return compactTitle(message.content)
  if (!Array.isArray(message?.content)) return ''
  return compactTitle(message.content.filter(block => block?.type === 'text').map(block => block.text).join(' '))
}

function parseSessionPreview(buffer) {
  let header
  let title
  for (const line of buffer.toString('utf8').split(/\r?\n/)) {
    try {
      const row = JSON.parse(line)
      if (!header && (row.type === 'session' || (typeof row.cwd === 'string' && typeof row.sessionId === 'string'))) header = row
      if (!row.isMeta && !row.isSidechain && !row.isSynthetic && (row.type === 'user' ||
          (row.type === 'message' && row.message?.role === 'user'))) {
        title ||= userText(row.message)
      }
      if (header && title) break
    } catch { /* Incomplete metadata record. */ }
  }
  return { header, title }
}

function codexRows(filename, cwd) {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(filename, { readOnly: true })
  try {
    const caseInsensitive = process.platform === 'win32' ? ' COLLATE NOCASE' : ''
    const columns = db.prepare('PRAGMA table_info(threads)').all()
    const title = columns.some(column => column.name === 'first_user_message')
      ? "COALESCE(NULLIF(TRIM(first_user_message), ''), title)"
      : 'title'
    return db.prepare('SELECT id, ' + title + ' AS title, updated_at AS updatedAt FROM threads WHERE cwd = ?' +
      caseInsensitive + ' AND archived = 0 ORDER BY updated_at DESC LIMIT 100').all(cwd)
  } finally {
    db.close()
  }
}

class LazyHistory {
  constructor({ home = os.homedir(), env = process.env, io = fs, queryCodex = codexRows, onRead = () => {} } = {}) {
    this.home = home
    this.env = env
    this.io = io
    this.queryCodex = queryCodex
    this.onRead = onRead
    this.catalogs = new Map()
  }

  async list(cwd, provider, additionalBuckets = []) {
    if (!providers.has(provider) || !path.isAbsolute(cwd)) throw new Error(localize(undefined, 'invalidHistoryRequest'))
    const record = kind => this.onRead({ cwd, provider, kind })
    const files = provider === 'codex'
      ? await this.listCodex(cwd, record)
      : await this.listFiles(cwd, provider, record, additionalBuckets)
    this.catalogs.set(JSON.stringify([key(cwd), provider]), new Map(files.map(row => [row.id, row])))
    return files.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
  }

  async listCodex(cwd, record) {
    const root = this.env.CODEX_HOME || path.join(this.home, '.codex')
    record('metadata')
    const names = await this.io.readdir(root).catch(error => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const indexes = names.filter(name => /^state_\d+\.sqlite$/.test(name))
      .sort((left, right) => Number(right.match(/\d+/)[0]) - Number(left.match(/\d+/)[0]))
    if (!indexes.length) return []
    record('index')
    return (await this.queryCodex(path.join(root, indexes[0]), cwd))
      .filter(row => sessionId.test(row.id))
      .map(row => ({ ...row, title: compactTitle(row.title) || row.id, updatedAt: row.updatedAt * 1000 }))
  }

  async listFiles(cwd, provider, record, additionalBuckets) {
    const omp = provider === 'omp'
    const root = omp
      ? path.join(this.env.PI_CODING_AGENT_DIR || path.join(this.home, '.omp', 'agent'), 'sessions')
      : path.join(this.env.CLAUDE_CONFIG_DIR || path.join(this.home, '.claude'), 'projects')
    const encoded = cwd.replace(omp ? /[:\\/]/g : /[^\p{L}\p{N}]/gu, '-')
    const buckets = omp ? [`--${encoded.replace(/^-+|-+$/g, '')}--`, encoded] : [encoded]
    const directories = buckets.filter(bucket => bucket && bucket !== '.' && bucket !== '..').map(bucket => path.join(root, bucket))
    const rows = []
    for (const directory of new Set([...directories, ...additionalBuckets])) {
      record('directory')
      const entries = await this.io.readdir(directory, { withFileTypes: true }).catch(error => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      const files = entries.filter(item => item.isFile() && item.name.endsWith('.jsonl'))
        .sort((left, right) => right.name.localeCompare(left.name)).slice(0, MAX_ROWS * 2)
      for (const entry of files) {
        if (rows.length >= MAX_ROWS) break
        const filename = path.join(directory, entry.name)
        const info = await this.io.lstat(filename)
        if (!info.isFile()) continue
        record('metadata')
        const handle = await this.io.open(filename, 'r')
        let preview
        try {
          const buffer = Buffer.alloc(readLimit)
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
          preview = parseSessionPreview(buffer.subarray(0, bytesRead))
        } finally { await handle.close() }
        const { header, title } = preview
        if (!header || typeof header.cwd !== 'string' || key(header.cwd) !== key(cwd)) continue
        const id = omp ? header.id : header.sessionId
        if (!sessionId.test(id || '') || rows.some(row => row.id === id)) continue
        rows.push({ id, filename, title: title || id, updatedAt: info.mtimeMs })
      }
    }
    return rows.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  resumeArgs(cwd, provider, id) {
    const row = this.catalogs.get(JSON.stringify([key(cwd), provider]))?.get(id)
    if (!row) throw new Error(localize(undefined, 'loadHistoryFirst'))
    return provider === 'codex' ? ['resume', row.id] : ['--resume', provider === 'omp' ? row.filename : row.id]
  }

  hasCatalog(cwd, provider) {
    return this.catalogs.has(JSON.stringify([key(cwd), provider]))
  }
}

async function queryWithNode(runtime, filename, cwd) {
  if (typeof require('node:module').isBuiltin === 'function' && require('node:module').isBuiltin('node:sqlite')) {
    return codexRows(filename, cwd)
  }
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.NODE_PATH
  if (runtime.runAsNode) env.ELECTRON_RUN_AS_NODE = '1'
  const { stdout } = await promisify(execFile)(runtime.executable, [
    '-e', 'console.log(JSON.stringify(require(process.argv[1]).codexRows(process.argv[2], process.argv[3])))',
    __filename, filename, cwd,
  ], { env, windowsHide: true, timeout: 5000 })
  return JSON.parse(stdout)
}

module.exports = { LazyHistory, codexRows, key, previewKey, providers, queryWithNode }
