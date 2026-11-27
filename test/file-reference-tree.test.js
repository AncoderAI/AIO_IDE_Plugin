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
  assert.throws(() => resourceCandidates([Array.from({ length: 17 }, (_, index) => uri(`file:///${index}`))]), /at most 16/)
})

test('registers a native drop target while workbench is open and routes both entry points', async () => {
  const views = []
  const commands = new Map()
  let open = false
  let panelListener
  const inserted = []
  const imported = []
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
    addProjectCandidates: async (candidates, allowOutside) => { imported.push({ candidates, allowOutside }); return candidates.length },
  }
  const entry = new TreeItem('OMP')
  registerFileReferenceTree(vscode, { subscriptions: [] }, host, [entry])
  assert.equal(views.length, 2)
  assert.deepEqual(views[0].options.treeDataProvider.getChildren(), [entry])
  open = true
  panelListener(true)
  const children = views[0].options.treeDataProvider.getChildren()
  const projectTarget = children.find((item) => item.id === 'aio.projectImportDropTarget')
  const target = children.find((item) => item.id === 'aio.referenceDropTarget')
  assert.equal(target.contextValue, 'aioReferenceDropTarget')

  await views[0].options.dragAndDropController.handleDrop(target, new Map([
    ['application/vnd.code.uri-list', item('file:///D:/repo/a.ts')],
  ]))
  assert.deepEqual(inserted[0], [{ kind: 'uri', value: 'file:///D:/repo/a.ts' }])
  await views[0].options.dragAndDropController.handleDrop(projectTarget, new Map([
    ['codefiles', item(JSON.stringify(['D:\\outside-project']))],
  ]))
  assert.deepEqual(imported[0], {
    candidates: [{ kind: 'path', value: 'D:\\outside-project' }], allowOutside: true,
  })

  const uri = (value) => ({ scheme: 'file', toString: () => value })
  await commands.get('aio.referenceInWorkbench')(uri('file:///D:/repo/a.ts'), [uri('file:///D:/repo/a.ts'), uri('file:///D:/repo/folder')])
  assert.deepEqual(inserted[1], [
    { kind: 'uri', value: 'file:///D:/repo/a.ts' }, { kind: 'uri', value: 'file:///D:/repo/folder' },
  ])
  await commands.get('aio.importProjectInWorkbench')(uri('file:///D:/repo/folder'))
  assert.deepEqual(imported[1], {
    candidates: [{ kind: 'uri', value: 'file:///D:/repo/folder' }], allowOutside: true,
  })
})

test('workbench host waits for the visible input to accept resolved references', async () => {
  const messages = []
  const warnings = []
  const droppedUri = { fsPath: 'D:\\repo\\a b.ts', toString: () => 'file:///D:/repo/a%20b.ts' }
  const vscode = {
    FileType: { File: 1, Directory: 2 },
    Uri: {
      parse: (value) => value.endsWith('/folder')
        ? { scheme: 'file', fsPath: 'D:\\repo\\folder', toString: () => value }
        : droppedUri,
      file: (fsPath) => ({ scheme: 'file', fsPath, toString: () => 'file:///' + fsPath }),
    },
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
  vscode.workspace.fs.stat = async () => ({ type: 2 })
  const added = await host.addProjectCandidates([{ kind: 'uri', value: 'file:///D:/repo/folder' }], false)
  assert.equal(added, 1)
  assert.deepEqual(host.openFolders, ['D:\\repo\\folder'])
  assert.deepEqual(messages.at(-1), { type: 'aio:event', event: 'desktop-event', payload: { event: 'app:open-folder', payload: null } })
  host.panel = undefined
  host.service = undefined
  host.dispose()
})
