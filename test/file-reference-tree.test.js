'use strict'

const assert = require('node:assert/strict')
const { EventEmitter: NodeEventEmitter } = require('node:events')
const test = require('node:test')
const { readDropCandidates, registerFileReferenceTree, resourceCandidates } = require('../src/file-reference-tree')
const { WorkbenchHost } = require('../src/workbench')

function item(value) { return { asString: async () => value } }

test('reads native TreeView URI and path drag formats without code editor contents', async () => {
  const transfer = new Map([
    ['text/uri-list', item('file:///D:/repo/a.ts')],
    ['codefiles', item(JSON.stringify(['D:\\repo\\folder']))],
    ['codeeditors', item(JSON.stringify([{ resource: { external: 'file:///D:/repo/unsaved.ts' }, contents: 'private' }]))],
  ])
  assert.deepEqual(await readDropCandidates(transfer), [
    { kind: 'uri', value: 'file:///D:/repo/a.ts' },
    { kind: 'path', value: 'D:\\repo\\folder' },
  ])
})

test('collects all selected Explorer URIs for the context command', () => {
  const uri = (value) => ({ scheme: 'file', toString: () => value })
  assert.deepEqual(resourceCandidates([uri('file:///one'), [uri('file:///one'), uri('file:///two')]]), [
    { kind: 'uri', value: 'file:///one' }, { kind: 'uri', value: 'file:///two' },
  ])
  assert.throws(() => resourceCandidates([Array.from({ length: 17 }, (_, index) => uri(`file:///${index}`))]), /最多引用 16/)
})

test('registers a native drop target while workbench is open and routes both entry points', async () => {
  const views = []
  const commands = new Map()
  let open = false
  let panelListener
  const inserted = []
  class EventEmitter {
    constructor() { this.emitter = new NodeEventEmitter(); this.event = (listener) => { this.emitter.on('event', listener); return { dispose() {} } } }
    fire(value) { this.emitter.emit('event', value) }
    dispose() {}
  }
  class TreeItem { constructor(label) { this.label = label } }
  const vscode = {
    EventEmitter, TreeItem,
    ThemeIcon: class { constructor(id) { this.id = id } },
    window: {
      createTreeView: (id, options) => { views.push({ id, options }); return { dispose() {} } },
      showWarningMessage: async () => undefined,
    },
    commands: { registerCommand: (id, callback) => { commands.set(id, callback); return { dispose() {} } } },
  }
  const host = {
    isOpen: () => open,
    onDidChangePanel: (listener) => { panelListener = listener; return { dispose() {} } },
    insertDroppedCandidates: async (candidates) => { inserted.push(candidates); return true },
  }
  const entry = new TreeItem('OMP')
  registerFileReferenceTree(vscode, { subscriptions: [] }, host, [entry])
  assert.equal(views.length, 2)
  assert.deepEqual(views[0].options.treeDataProvider.getChildren(), [entry])
  open = true
  panelListener(true)
  const target = views[0].options.treeDataProvider.getChildren().at(-1)
  assert.equal(target.contextValue, 'aioReferenceDropTarget')

  await views[0].options.dragAndDropController.handleDrop(target, new Map([
    ['application/vnd.code.uri-list', item('file:///D:/repo/a.ts')],
  ]))
  assert.deepEqual(inserted[0], [{ kind: 'uri', value: 'file:///D:/repo/a.ts' }])

  const uri = (value) => ({ scheme: 'file', toString: () => value })
  await commands.get('aio.referenceInWorkbench')(uri('file:///D:/repo/a.ts'), [uri('file:///D:/repo/a.ts'), uri('file:///D:/repo/folder')])
  assert.deepEqual(inserted[1], [
    { kind: 'uri', value: 'file:///D:/repo/a.ts' }, { kind: 'uri', value: 'file:///D:/repo/folder' },
  ])
})

test('workbench host waits for the visible input to accept resolved references', async () => {
  const messages = []
  const warnings = []
  const droppedUri = { fsPath: 'D:\\repo\\a b.ts', toString: () => 'file:///D:/repo/a%20b.ts' }
  const vscode = {
    FileType: { File: 1, Directory: 2 },
    Uri: { parse: () => droppedUri },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: 'D:\\repo' } }],
      getWorkspaceFolder: () => ({ uri: { fsPath: 'D:\\repo' } }),
      fs: { stat: async () => ({ type: 1 }) },
    },
    window: {
      createOutputChannel: () => ({ append() {}, appendLine() {}, dispose() {} }),
      showWarningMessage: async (message) => { warnings.push(message) },
    },
  }
  const host = new WorkbenchHost(vscode, {})
  const panel = { webview: { postMessage: async (message) => { messages.push(message); return true } } }
  const service = {}
  host.panel = panel
  host.service = service
  const result = host.insertDroppedCandidates([{ kind: 'uri', value: 'file:///D:/repo/a%20b.ts' }])
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(messages[0].references, ['@"D:\\repo\\a b.ts"'])
  await host.handleMessage({ type: 'aio:file-reference-result', id: messages[0].id, inserted: true }, panel, service)
  assert.equal(await result, true)
  assert.deepEqual(warnings, [])
  host.panel = undefined
  host.service = undefined
  host.dispose()
})
