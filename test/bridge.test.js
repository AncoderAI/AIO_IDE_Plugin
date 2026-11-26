'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough, Writable } = require('node:stream')
const test = require('node:test')

const { createTauriBridge } = require('../src/webview-bridge')
const { WorkbenchHost, WorkbenchService, externalNodeCandidates, renderWorkbenchHtml, resolveNodeRuntime, validWebviewRequest, versionAtLeast } = require('../src/workbench')

test('webview bridge correlates requests and forwards named events', async () => {
  const target = new EventEmitter()
  target.addEventListener = target.on.bind(target)
  const sent = []
  const bridge = createTauriBridge({ postMessage: (value) => sent.push(value) }, target)
  const result = bridge.core.invoke('desktop_request', { channel: 'projects:list', args: [] })
  assert.equal(sent[0].command, 'desktop_request')
  target.emit('message', { data: { type: 'aio:response', id: sent[0].id, result: ['project'] } })
  assert.deepEqual(await result, ['project'])

  let received
  const unlisten = await bridge.event.listen('coding-event', (event) => { received = event.payload })
  target.emit('message', { data: { type: 'aio:event', event: 'coding-event', payload: { event: 'coding:delta' } } })
  assert.deepEqual(received, { event: 'coding:delta' })
  unlisten()
})

test('workbench service uses NDJSON request response and event routing', async () => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  let written = ''
  child.stdin = new Writable({ write(chunk, _encoding, callback) { written += String(chunk); callback() } })
  child.kill = () => {}
  const service = new WorkbenchService({
    version: 'test', servicePath: 'C:\\service.cjs', profilePath: 'C:\\profile', resourceRoot: 'C:\\resource',
    resolveNodeRuntime: () => ({ executable: 'C:\\node.exe', runAsNode: false }),
    spawn: () => child,
  })
  service.start()
  const response = service.request('projects:list', [])
  await new Promise((resolve) => setImmediate(resolve))
  const request = JSON.parse(written.trim())
  child.stdout.write(JSON.stringify({ event: 'coding:delta', payload: { text: 'ok' } }) + '\n')
  child.stdout.write(JSON.stringify({ id: request.id, result: ['ok'] }) + '\n')
  assert.deepEqual(await response, ['ok'])
  const event = await new Promise((resolve) => {
    service.once('event', resolve)
    child.stdout.write(JSON.stringify({ event: 'sessions:changed', payload: null }) + '\n')
  })
  assert.equal(event.event, 'desktop-event')
  assert.equal(event.payload.event, 'sessions:changed')
  assert.doesNotThrow(() => child.stdin.emit('error', new Error('closed pipe')))
  await assert.rejects(service.request('projects:list', []), /服务不可用/)
  service.stop()
})

test('HTML rendering installs bridge before app scripts and enforces CSP', () => {
  const webview = { cspSource: 'vscode-webview:', asWebviewUri: String }
  const output = renderWorkbenchHtml('<html><head><script type="module" src="./assets/app.js"></script></head></html>', webview, 'vscode-resource:/ui', 'vscode-resource:/bridge.js')
  assert.match(output, /Content-Security-Policy/)
  assert.match(output, /connect-src 'none'/)
  assert.ok(output.indexOf('bridge.js') < output.indexOf('app.js'))
  assert.match(output, /<script nonce="[^"]+" type="module"/)
})

test('runtime and message validation rejects unsafe inputs', () => {
  assert.equal(versionAtLeast('22.13.0'), true)
  assert.equal(versionAtLeast('22.12.9'), false)
  assert.deepEqual(externalNodeCandidates('win32', { PATH: 'relative;C:\\Node;"D:\\Tools"' }), ['C:\\Node\\node.exe', 'D:\\Tools\\node.exe'])
  assert.equal(validWebviewRequest({ type: 'aio:request', id: 1, command: 'desktop_request', args: {} }), true)
  assert.equal(validWebviewRequest({ type: 'aio:request', id: 1, command: 'desktop_request', args: [] }), false)
  assert.throws(() => resolveNodeRuntime({
    hostVersion: '24.0.0', hostExecutable: 'code.exe', candidates: [], probeNodeRuntime: () => '',
  }), /Node\.js 22\.13/)
  assert.deepEqual(resolveNodeRuntime({
    hostVersion: '24.0.0', hostExecutable: 'code.exe', probeNodeRuntime: () => '24.0.0',
  }), { executable: 'code.exe', runAsNode: false })
})

test('an old request cannot reply into a replacement panel', async () => {
  const vscode = { window: { createOutputChannel: () => ({ append() {}, appendLine() {}, dispose() {} }) } }
  const host = new WorkbenchHost(vscode, {})
  const messages = []
  const oldPanel = { webview: { postMessage: (message) => { messages.push(message); return Promise.resolve(true) } } }
  const newPanel = { webview: { postMessage: () => Promise.resolve(true) } }
  let resolveRequest
  const oldService = { request: () => new Promise((resolve) => { resolveRequest = resolve }) }
  host.panel = oldPanel
  host.service = oldService
  const pending = host.handleMessage({
    type: 'aio:request', id: 7, command: 'desktop_request', args: { channel: 'projects:list', args: [] },
  }, oldPanel, oldService)
  await new Promise((resolve) => setImmediate(resolve))
  host.panel = newPanel
  host.service = { request() {} }
  resolveRequest([])
  await pending
  assert.deepEqual(messages, [])
  host.panel = undefined
  host.service = undefined
  host.dispose()
})

test('concurrent opens share one panel creation', async () => {
  const vscode = { window: { createOutputChannel: () => ({ append() {}, appendLine() {}, dispose() {} }) } }
  const host = new WorkbenchHost(vscode, {})
  const panel = { id: 'shared' }
  let complete
  let creations = 0
  host.createPanel = () => {
    creations++
    return new Promise((resolve) => { complete = () => resolve(panel) })
  }
  const first = host.open()
  const second = host.open()
  complete()
  assert.equal(await first, panel)
  assert.equal(await second, panel)
  assert.equal(creations, 1)
  host.dispose()
})
