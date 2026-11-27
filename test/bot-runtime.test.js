'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const servicePath = path.resolve(__dirname, '../workbench/service/workbench-service.cjs')
const cliPath = path.resolve(__dirname, '../workbench/service/aio-bot-cli.cjs')
const editorPath = path.resolve(__dirname, '../workbench/service/aio-codex-editor.cjs')

test('bundled service contains scoped Bot control and the Codex submission safeguards', () => {
  const service = fs.readFileSync(servicePath, 'utf8')
  assert.ok(service.includes('var BotControlService = class'))
  assert.ok(service.includes('case "terminal:submit-task"'))
  assert.ok(service.includes('AIO_BOT_CAPABILITY'))
  assert.ok(service.includes('aio-bot-cli.cjs'))
  assert.ok(service.includes('disable_paste_burst=true'))
  assert.ok(service.includes('launch.args.splice(0, 2)'))
  assert.ok(service.includes('AIO_CODEX_EDITOR_SPOOL'))
  assert.ok(service.includes('submitCodexEditorTask'))
  assert.ok(service.includes('terminal.terminal.write("\\x07")'))
  assert.ok(service.includes('Codex already has a draft; multiline task was not injected or submitted'))
  assert.ok(service.includes('terminal.terminal.write("\\x1B")'))
  assert.ok(service.includes('terminal.terminal.write("\\x1B[H")'))
  assert.ok(service.includes('terminal.terminal.write("\\r")'))
  assert.ok(!service.includes('Codex follow-up tasks must be single-line'))
  assert.ok(service.includes('ready: ["Ask Codex", "Worked for ", "esc to edit previous message"]'))
  assert.ok(service.includes('busy: ["Working(", "esc to interrupt"]'))
  assert.ok(service.includes('terminal.terminal.write(terminal.bracketedPasteMode ?'))
  assert.ok(service.includes('session.events.splice(0)'))
})

test('bundled Bot CLI transports native-first and warm UTF-8 text exactly', async () => {
  const { requestBotControl } = require(cliPath)
  const received = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, request) => {
    received.push({
      authorization: request.headers.authorization,
      path: new URL(url).pathname,
      method: request.method,
      body: JSON.parse(request.body),
    })
    return { ok: true, json: async () => ({ ok: true }) }
  }
  const prompt = '@\n请检查多行任务。\n\n- 保留空行\n- 保留中文\n@\n'
  try {
    await requestBotControl('http://127.0.0.1:1', 'test-token', {
      command: 'create', args: { agent: 'codex', initialPrompt: prompt }, json: true,
    })
    await requestBotControl('http://127.0.0.1:1', 'test-token', {
      command: 'send', args: { terminalId: 'worker-id', prompt }, json: true,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(received, [
    {
      authorization: 'Bearer test-token', path: '/v1/terminals', method: 'POST',
      body: { agent: 'codex', initialPrompt: prompt },
    },
    {
      authorization: 'Bearer test-token', path: '/v1/terminals/worker-id/input', method: 'POST',
      body: { data: prompt },
    },
  ])
})

test('bundled Codex editor consumes one nonce exactly and preserves an existing draft', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-codex-editor-test-'))
  const spool = path.join(root, 'spool')
  const draft = path.join(root, 'draft.md')
  fs.mkdirSync(spool)
  fs.writeFileSync(draft, '')
  const run = (extraEnvironment = {}) => spawnSync(process.execPath, [editorPath, draft], {
    encoding: 'utf8',
    env: { ...process.env, AIO_CODEX_EDITOR_SPOOL: spool, ...extraEnvironment },
    windowsHide: true,
  })
  const request = (text) => {
    const nonce = randomUUID()
    const bytes = Buffer.byteLength(text)
    const sha256 = createHash('sha256').update(text).digest('hex')
    fs.rmSync(path.join(spool, 'ack.json'), { force: true })
    fs.writeFileSync(path.join(spool, 'request.json'), JSON.stringify({ v: 1, nonce, text, bytes, sha256 }))
    return { nonce, bytes, sha256 }
  }

  try {
    const text = '@\n请保留这一行。\n\n- item one\n- 项目二\n@\n'
    const first = request(text)
    const consumed = run()
    assert.equal(consumed.status, 0, consumed.stderr)
    assert.equal(fs.readFileSync(draft, 'utf8'), text)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(spool, 'ack.json'), 'utf8')), {
      v: 1, ...first, status: 'consumed',
    })
    assert.equal(fs.existsSync(path.join(spool, 'request.json')), false)

    const existing = 'manual IME draft 手工输入'
    fs.writeFileSync(draft, existing)
    const second = request('must not overwrite\nthis draft')
    const rejected = run()
    assert.equal(rejected.status, 73, rejected.stderr)
    assert.equal(fs.readFileSync(draft, 'utf8'), existing)
    const acknowledgment = JSON.parse(fs.readFileSync(path.join(spool, 'ack.json'), 'utf8'))
    assert.equal(acknowledgment.nonce, second.nonce)
    assert.equal(acknowledgment.status, 'draft-not-empty')
    assert.equal(fs.existsSync(path.join(spool, 'request.json')), false)

    fs.writeFileSync(draft, 'manual')
    fs.rmSync(path.join(spool, 'ack.json'), { force: true })
    const fallback = run({
      AIO_CODEX_EDITOR_FALLBACK_ARGV: JSON.stringify([
        process.execPath,
        '-e',
        "require('node:fs').appendFileSync(process.argv[1], '-fallback')",
      ]),
    })
    assert.equal(fallback.status, 0, fallback.stderr)
    assert.equal(fs.readFileSync(draft, 'utf8'), 'manual-fallback')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
