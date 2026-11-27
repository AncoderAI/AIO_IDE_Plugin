'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PassThrough, Writable } = require('node:stream')
const test = require('node:test')

const { WorkbenchHost } = require('../src/workbench')

function createServiceChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).trim().split('\n')) {
        if (!line) continue
        const request = JSON.parse(line)
        setImmediate(() => child.stdout.write(JSON.stringify({
          id: request.id,
          result: request.channel === 'coding-plugins:list' ? [{ id: 'omp' }] : [],
        }) + '\n'))
      }
      callback()
    },
  })
  child.kill = () => child.emit('exit', 0, null)
  return child
}

test('workbench renders and handles messages before project synchronization completes', async (context) => {
  const extensionPath = path.resolve(__dirname, '..')
  const profileRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aio-startup-panel-'))
  context.after(() => fs.promises.rm(profileRoot, { recursive: true, force: true }))

  let resolveProjectSync
  let projectSyncFinished = false
  const projectSync = new Promise((resolve) => {
    resolveProjectSync = () => {
      projectSyncFinished = true
      resolve()
    }
  })
  let releaseRuntime
  const runtime = new Promise((resolve) => { releaseRuntime = resolve })
  let showHtml
  const htmlAssigned = new Promise((resolve) => { showHtml = resolve })
  const sent = []
  let receiveMessage
  let disposePanel = () => {}
  const panel = {
    active: true,
    reveal() {},
    dispose() { disposePanel() },
    onDidDispose(listener) {
      disposePanel = listener
      return { dispose() { disposePanel = () => {} } }
    },
    webview: {
      cspSource: 'vscode-webview:',
      set html(value) { showHtml(value) },
      asWebviewUri: String,
      onDidReceiveMessage(listener) {
        receiveMessage = listener
        return { dispose() { receiveMessage = undefined } }
      },
      async postMessage(message) {
        sent.push(message)
        return true
      },
    },
  }
  const vscode = {
    Uri: { file: (value) => value },
    workspace: { fs: { createDirectory: async () => {} } },
    window: {
      createOutputChannel: () => ({ append() {}, appendLine() {}, dispose() {} }),
      showErrorMessage: async () => {},
    },
  }
  const contextMock = {
    extensionPath,
    storageUri: { fsPath: profileRoot },
    asAbsolutePath: (value) => path.join(extensionPath, value),
    extension: { packageJSON: { version: 'test' } },
  }
  const host = new WorkbenchHost(vscode, contextMock, {
    projectRegistry: {
      syncService: () => projectSync,
      detachService() {},
    },
    previewGroupController: {
      captureBaseline: async () => {},
      close: async () => {},
      dispose: async () => {},
    },
    service: {
      resolveNodeRuntime: () => runtime,
      spawn: createServiceChild,
    },
  })
  host.createWorkbenchPanel = async () => panel

  const opening = host.open()
  const html = await htmlAssigned
  assert.match(html, /Content-Security-Policy/)
  assert.match(html, /webview-bridge\.js/)
  releaseRuntime({ executable: 'node', runAsNode: false })
  const opened = await opening

  assert.equal(opened, panel)
  assert.equal(projectSyncFinished, false)
  assert.equal(typeof receiveMessage, 'function')

  receiveMessage({
    type: 'aio:request',
    id: 17,
    command: 'desktop_request',
    args: { channel: 'coding-plugins:list', args: [] },
  })
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(sent.at(-1), { type: 'aio:response', id: 17, result: [{ id: 'omp' }] })
  assert.equal(projectSyncFinished, false)

  resolveProjectSync()
  await projectSync
  host.dispose()
})
