'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const { PassThrough, Writable } = require('node:stream')
const path = require('node:path')
const test = require('node:test')

const { createTauriBridge } = require('../src/webview-bridge')
const { WorkbenchHost, WorkbenchService, externalNodeCandidates, renderWorkbenchHtml, resolveNodeRuntime, validWebviewRequest, versionAtLeast } = require('../src/workbench')

test('generated xterm chunk exposes only the scoped clipboard capability', () => {
  const assets = path.resolve(__dirname, '../workbench/ui/assets')
  const chunk = fs.readdirSync(assets).find((name) => /^TerminalDrawer-.*\.js$/.test(name))
  assert.ok(chunk)
  const source = fs.readFileSync(path.join(assets, chunk), 'utf8')
  assert.match(source, /data-vscode-context/)
  assert.match(source, /webviewSection:"aioTerminal"/)
  assert.match(source, /aio:terminal-register/)
  assert.match(source, /aio:terminal-unregister/)
  assert.match(source, /isVisible:/)
  assert.match(source, /document\.hasFocus\(\)&&/)
  const main = fs.readdirSync(assets).find((name) => /^main-.*\.js$/.test(name))
  assert.ok(main)
  assert.match(fs.readFileSync(path.join(assets, main), 'utf8'), /!Ge\.current\|\|u\.defaultPrevented/)
})

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

test('webview keeps terminal copy and paste shortcuts in the browser clipboard path', () => {
  const target = new EventEmitter()
  target.addEventListener = target.on.bind(target)
  target.dispatchEvent = (event) => { target.emit(event.type, event); return true }
  let copies = 0
  target.document = { execCommand: (command) => { if (command === 'copy') copies++; return true } }
  const sent = []
  createTauriBridge({ postMessage: (message) => sent.push(message) }, target)
  const xterm = { closest: (selector) => selector === '.xterm' ? xterm : null }
  let selected = true
  let pasted
  let focused = false
  target.emit('aio:terminal-register', {
    detail: {
      id: 'terminal-1', element: xterm,
      hasSelection: () => selected,
      getSelection: () => 'selected output',
      isVisible: () => true,
      paste: (text) => { pasted = text },
      focus: () => { focused = true },
    },
  })
  const event = (key, extras = {}) => {
    const state = { stopped: false, prevented: false }
    target.emit('keydown', {
      type: 'keydown', key, target: xterm, ctrlKey: true, shiftKey: true, metaKey: false, altKey: false,
      stopImmediatePropagation: () => { state.stopped = true },
      preventDefault: () => { state.prevented = true },
      ...extras,
    })
    return state
  }

  assert.deepEqual(event('c', { shiftKey: false }), { stopped: true, prevented: true })
  assert.equal(copies, 1)
  assert.deepEqual(event('v', { shiftKey: false }), { stopped: true, prevented: false })
  selected = false
  assert.deepEqual(event('c', { shiftKey: false }), { stopped: false, prevented: false })
  assert.deepEqual(event('c', { target: { closest: () => null } }), { stopped: false, prevented: false })

  target.emit('message', { data: { type: 'aio:terminal-copy-request', id: 7 } })
  assert.deepEqual(sent.at(-1), { type: 'aio:terminal-selection', id: 7, available: true, terminalId: 'terminal-1', text: '' })
  selected = true
  target.emit('message', { data: { type: 'aio:terminal-copy-request', id: 8 } })
  assert.deepEqual(sent.at(-1), { type: 'aio:terminal-selection', id: 8, available: true, terminalId: 'terminal-1', text: 'selected output' })
  target.emit('message', { data: { type: 'aio:terminal-paste', terminalId: 'terminal-1', text: 'external text' } })
  assert.equal(pasted, 'external text')
  assert.equal(focused, true)
  target.emit('aio:terminal-register', {
    detail: {
      id: 'terminal-2', element: { closest: () => null },
      hasSelection: () => false, getSelection: () => '', isVisible: () => true,
      paste: () => { throw new Error('wrong terminal') }, focus() {},
    },
  })
  pasted = undefined
  target.emit('message', { data: { type: 'aio:terminal-paste', terminalId: 'terminal-1', text: 'stale text' } })
  assert.equal(pasted, undefined)
})

test('webview gives keyboard ownership only after a deliberate non-editing click', () => {
  const target = new EventEmitter()
  target.addEventListener = target.on.bind(target)
  const frames = []
  target.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length }
  target.document = { hasFocus: () => true }
  createTauriBridge({ postMessage() {} }, target)
  let focused = ''
  const terminalElement = (id) => ({
    closest: (selector) => selector === '.xterm' ? terminalElement.cache.get(id) : null,
  })
  terminalElement.cache = new Map()
  const first = terminalElement('first')
  const second = terminalElement('second')
  const visibility = { first: true, second: true }
  terminalElement.cache.set('first', first)
  terminalElement.cache.set('second', second)
  const register = (id, element) => target.emit('aio:terminal-register', { detail: {
    id, element, hasSelection: () => false, getSelection: () => '',
    isVisible: () => visibility[id], paste() {}, focus: () => { focused = id },
  } })
  register('first', first)
  const background = {
    closest: (selector) => selector === '.app-shell' ? background : null,
  }
  const input = {
    closest: (selector) => selector.includes('input') ? input : selector === '.app-shell' ? background : null,
  }
  const button = {
    closest: (selector) => selector.includes('button') ? button : selector === '.app-shell' ? background : null,
  }

  target.emit('focusin', { target: first })
  target.emit('aio:terminal-focus-request')
  assert.equal(focused, '')
  target.emit('pointerover', { target: background })
  assert.equal(focused, '')
  target.emit('pointerdown', { target: background })
  frames.shift()()
  assert.equal(focused, 'first')

  focused = ''
  target.emit('pointerdown', { target: input })
  target.emit('aio:terminal-focus-request')
  assert.equal(focused, '')
  target.emit('pointerdown', { target: button })
  target.emit('aio:terminal-focus-request')
  frames.shift()()
  assert.equal(focused, 'first')
  focused = ''
  target.emit('pointerdown', { target: background })
  target.emit('blur')
  frames.shift()()
  assert.equal(focused, '')

  register('second', second)
  target.emit('focusin', { target: second })
  target.emit('pointerdown', { target: background })
  frames.shift()()
  assert.equal(focused, 'second')
  visibility.first = true
  visibility.second = false
  focused = ''
  target.emit('pointerdown', { target: button })
  target.emit('aio:terminal-focus-request')
  frames.shift()()
  assert.equal(focused, 'first')
})

test('webview bridge routes project-directory drops and acknowledgements', () => {
  const target = new EventEmitter()
  target.addEventListener = target.on.bind(target)
  target.dispatchEvent = (event) => { target.emit(event.type, event); return true }
  target.CustomEvent = class { constructor(type, options) { this.type = type; Object.assign(this, options) } }
  const sent = []
  createTauriBridge({ postMessage: (value) => sent.push(value) }, target)
  target.emit('aio:project-drop-request', {
    detail: { id: 21, candidates: [{ kind: 'path', value: 'D:\\project' }] },
  })
  assert.deepEqual(sent[0], {
    type: 'aio:project-drop', id: 21, candidates: [{ kind: 'path', value: 'D:\\project' }],
  })
  let result
  target.on('aio:project-drop-resolved', (event) => { result = event.detail })
  target.emit('message', { data: { type: 'aio:project-drop-response', id: 21, added: 1 } })
  assert.deepEqual(result, { id: 21, added: 1, error: undefined })
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
  const output = renderWorkbenchHtml('<html><head><script type="module" src="./assets/app.js"></script></head></html>', webview, 'vscode-resource:/ui', 'vscode-resource:/bridge.js', 'vscode-resource:/file-drop.js')
  assert.match(output, /Content-Security-Policy/)
  assert.match(output, /connect-src 'none'/)
  assert.ok(output.indexOf('bridge.js') < output.indexOf('app.js'))
  assert.ok(output.indexOf('bridge.js') < output.indexOf('file-drop.js'))
  assert.ok(output.indexOf('file-drop.js') < output.indexOf('app.js'))
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

test('workbench clipboard commands require the active panel and a visible terminal', async () => {
  const clipboard = { value: 'outside text', reads: 0, writes: [], deactivateOnRead: false }
  const vscode = {
    env: { clipboard: {
      readText: async () => { clipboard.reads++; if (clipboard.deactivateOnRead) panel.active = false; return clipboard.value },
      writeText: async (text) => { clipboard.writes.push(text) },
    } },
    window: { createOutputChannel: () => ({ append() {}, appendLine() {}, dispose() {} }) },
  }
  const host = new WorkbenchHost(vscode, {})
  const messages = []
  const service = {}
  const panel = {
    active: true,
    webview: {
      postMessage: async (message) => {
        messages.push(message)
        if (message.type === 'aio:terminal-copy-request') {
          setImmediate(() => host.handleMessage({
            type: 'aio:terminal-selection', id: message.id, available: true, terminalId: 'terminal-1', text: 'selected text',
          }, panel, service))
        }
        return true
      },
    },
  }
  host.panel = panel
  host.service = service

  assert.equal(await host.copyTerminalSelection(), true)
  assert.deepEqual(clipboard.writes, ['selected text'])
  assert.equal(await host.pasteIntoTerminal(), true)
  assert.equal(clipboard.reads, 1)
  assert.deepEqual(messages.at(-1), { type: 'aio:terminal-paste', terminalId: 'terminal-1', text: 'outside text' })

  clipboard.deactivateOnRead = true
  const messageCount = messages.length
  assert.equal(await host.pasteIntoTerminal(), false)
  assert.equal(messages.length, messageCount + 1)
  assert.equal(messages.at(-1).type, 'aio:terminal-copy-request')
  panel.active = false
  assert.equal(await host.pasteIntoTerminal(), false)
  assert.equal(clipboard.reads, 2)
  host.panel = undefined
  host.service = undefined
  host.dispose()
})

test('workbench panel gets a new locked editor group', async () => {
  const actions = []
  const panel = { id: 'aio-panel' }
  const vscode = {
    ViewColumn: { Active: -1 },
    Uri: { file: (value) => value },
    commands: { executeCommand: async (command) => { actions.push(command) } },
    window: {
      createOutputChannel: () => ({ append() {}, appendLine() {}, dispose() {} }),
      createWebviewPanel: (_type, _title, column) => {
        assert.equal(column, -1)
        actions.push('createWebviewPanel')
        return panel
      },
    },
  }
  const context = { extensionPath: 'C:\\extension' }
  const host = new WorkbenchHost(vscode, context)
  const result = await host.createWorkbenchPanel('C:\\extension\\workbench\\ui')

  assert.equal(result, panel)
  assert.deepEqual(actions, [
    'workbench.action.newGroupRight',
    'createWebviewPanel',
    'workbench.action.lockEditorGroup',
  ])
  host.dispose()
})
