'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const servicePath = path.resolve(__dirname, '../workbench/service/workbench-service.cjs')
const cliPath = path.resolve(__dirname, '../workbench/service/aio-bot-cli.cjs')

test('bundled service contains scoped Bot control and the Codex submission safeguards', () => {
  const service = fs.readFileSync(servicePath, 'utf8')
  assert.ok(service.includes('var BotControlService = class'))
  assert.ok(service.includes('case "terminal:submit-task"'))
  assert.ok(service.includes('AIO_BOT_CAPABILITY'))
  assert.ok(service.includes('aio-bot-cli.cjs'))
  assert.ok(service.includes('disable_paste_burst=true'))
  assert.ok(service.includes('launch.args.splice(0, 2)'))
  assert.ok(service.includes('Codex follow-up tasks must be single-line'))
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
