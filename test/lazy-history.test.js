'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const test = require('node:test')
const { DatabaseSync } = require('node:sqlite')
const { LazyHistory } = require('../src/lazy-history')
const { WorkbenchHost } = require('../src/workbench')

const firstId = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'

test('cold workbench routes zero requests to history, then selects only the clicked project and CLI', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-lazy-history-'))
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 3 }))
  const cwd = path.join(home, '项目 A')
  const other = path.join(home, '项目 B')
  const codex = path.join(home, '.codex')
  await fs.mkdir(codex)
  const database = new DatabaseSync(path.join(codex, 'state_5.sqlite'))
  database.exec('CREATE TABLE threads (id TEXT, title TEXT, updated_at INTEGER, cwd TEXT, archived INTEGER, first_user_message TEXT)')
  const insert = database.prepare('INSERT INTO threads VALUES (?, ?, 1, ?, 0, ?)')
  insert.run(firstId, '系统生成标题', cwd, '  项目 A\n首次输入  ')
  insert.run(secondId, '项目 B 会话', other, '项目 B 的内容')
  database.close()

  const reads = []
  const calls = []
  const history = new LazyHistory({ home, env: {}, onRead: event => reads.push(event) })
  const vscode = { workspace: { isTrusted: true }, window: { createOutputChannel: () => ({ dispose() {} }) } }
  const host = new WorkbenchHost(vscode, {}, { history })
  const service = {
    async request(channel) {
      calls.push(channel)
      return [{ primaryFolder: cwd }, { primaryFolder: other }]
    },
  }
  const invoke = (channel, args = []) => host.desktopRequest({ channel, args }, service)
  await Promise.all(['projects:list', 'sessions:list', 'terminal:list-restorable', 'coding:list',
    'coding:list-summaries', 'app:list-coding-cli-history'].map(channel => invoke(channel)))
  assert.deepEqual(calls, ['projects:list-initial'])
  assert.deepEqual(reads, [])
  await assert.rejects(invoke('aio-history:resume', [cwd, 'codex', firstId]), /(Load this project's history|先加载)/)
  assert.deepEqual(reads, [])
  assert.deepEqual(await invoke('aio-history:list', [cwd, 'codex']), [
    { id: firstId, title: '项目 A 首次输入', updatedAt: 1000 },
  ])
  assert.deepEqual(reads, [
    { cwd, provider: 'codex', kind: 'metadata' }, { cwd, provider: 'codex', kind: 'index' },
  ])
  assert.deepEqual(history.resumeArgs(cwd, 'codex', firstId), ['resume', firstId])
  assert.throws(() => history.resumeArgs(other, 'codex', firstId), /(Load this project's history|先加载)/)
  await assert.rejects(invoke('aio-history:list', [path.join(home, 'unknown'), 'claude']), /(not registered|已登记)/)
  assert.equal(reads.length, 2)
})

test('OMP and Claude load only their requested project buckets', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-provider-buckets-'))
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 3 }))
  const cwd = path.join(home, 'project avoid collision')
  const claude = path.join(home, '.claude', 'projects', cwd.replace(/[^\p{L}\p{N}]/gu, '-'))
  const omp = path.join(home, '.omp', 'agent', 'sessions', '--' + cwd.replace(/[:\\/]/g, '-').replace(/^-+|-+$/g, '') + '--')
  for (const folder of [claude, omp]) await fs.mkdir(folder, { recursive: true })
  const file = path.join(omp, 'session.jsonl')
  const writeRows = (file, rows) => fs.writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  await writeRows(file, [
    { type: 'session', id: firstId, cwd },
    { type: 'message', message: { role: 'assistant', content: '不使用助手消息' } },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'OMP 首次输入' }] } },
    { type: 'message', message: { role: 'user', content: 'OMP 第二次输入' } },
  ])
  await writeRows(path.join(claude, 'session.jsonl'), [
    { type: 'user', sessionId: secondId, cwd, isMeta: true, message: { content: '自动元数据' } },
    { type: 'user', sessionId: secondId, cwd, message: { content: [{ type: 'tool_result', content: '工具输出' }] } },
    { type: 'user', sessionId: secondId, cwd, message: { content: 'Claude 首次输入' } },
  ])
  const reads = []
  const history = new LazyHistory({ home, env: {}, onRead: e => reads.push(e) })
  assert.deepEqual((await history.list(cwd, 'omp')).map(row => [row.id, row.title]), [[firstId, 'OMP 首次输入']])
  assert.ok(reads.every(row => row.provider === 'omp'))
  assert.deepEqual(history.resumeArgs(cwd, 'omp', firstId), ['--resume', file])
  assert.deepEqual((await history.list(cwd, 'claude')).map(row => [row.id, row.title]), [[secondId, 'Claude 首次输入']])
  assert.deepEqual(history.resumeArgs(cwd, 'claude', secondId), ['--resume', secondId])
})
