'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')
const { setTimeout: delay } = require('node:timers/promises')
const { PreviewGroupController, isSimpleTwoGroupLayout, sameSimpleLayout } = require('../src/preview-group')

const baseline = { orientation: 0, groups: [{ size: 1 }] }
const expanded = { orientation: 0, groups: [{ size: 0.45 }, { size: 0.55 }] }

function fixture() {
  let currentLayout = structuredClone(baseline)
  let activeEditor
  const actions = []
  const editorListeners = new Set()
  const windowListeners = new Set()
  const hover = new EventEmitter()
  hover.start = () => true
  hover.dispose = () => { hover.disposed = true }
  const messages = []
  const vscode = {
    commands: {
      executeCommand: async (command) => {
        if (command === 'vscode.getEditorLayout') return structuredClone(currentLayout)
        actions.push(command)
      },
    },
    window: {
      state: { focused: true },
      visibleTextEditors: [],
      get activeTextEditor() { return activeEditor },
      onDidChangeActiveTextEditor: (listener) => {
        editorListeners.add(listener)
        return { dispose: () => editorListeners.delete(listener) }
      },
      onDidChangeWindowState: (listener) => {
        windowListeners.add(listener)
        return { dispose: () => windowListeners.delete(listener) }
      },
    },
  }
  const panel = {
    active: true,
    viewColumn: 2,
    reveal() { actions.push('panel.reveal'); this.active = true },
    webview: { postMessage: async (message) => { messages.push(message); return true } },
    onDidChangeViewState: () => ({ dispose() {} }),
  }
  return {
    vscode, panel, hover, actions, messages,
    setLayout(layout) { currentLayout = structuredClone(layout) },
    getLayout() { return currentLayout },
    focusEditor(editor) {
      activeEditor = editor
      panel.active = !editor
      for (const listener of editorListeners) listener(editor)
    },
    focusWindow(focused) {
      vscode.window.state.focused = focused
      for (const listener of windowListeners) listener({ focused })
    },
  }
}

async function managedController(setup) {
  const controller = new PreviewGroupController(setup.vscode, {}, {
    collapseDelayMs: 0,
    hoverObserverFactory: () => setup.hover,
  })
  await controller.captureBaseline()
  setup.setLayout(expanded)
  assert.equal(await controller.attach(setup.panel), true)
  return controller
}

test('preview starts collapsed and only the hover trigger restores it', async () => {
  const setup = fixture()
  const controller = await managedController(setup)
  setup.hover.emit('state', 'inside')
  await delay(15)
  await controller.queue
  assert.equal(controller.collapsed, true)
  assert.equal(setup.actions.at(-1), 'workbench.action.toggleMaximizeEditorGroup')
  assert.deepEqual(setup.messages.at(-1), { type: 'aio:file-preview-state', collapsed: true })

  assert.equal(await controller.showFromTrigger(), true)
  assert.equal(controller.collapsed, false)
  assert.equal(setup.actions.at(-1), 'workbench.action.toggleMaximizeEditorGroup')
  assert.deepEqual(setup.messages.at(-1), { type: 'aio:file-preview-state', collapsed: false })

  setup.hover.emit('state', 'inactive')
  await delay(10)
  assert.equal(controller.collapsed, false, 'inactive native observer must keep the fallback preview open')
  controller.aioPointerEntered()
  await delay(10)
  await controller.queue
  assert.equal(controller.collapsed, true, 're-entering ordinary AIO content may collapse the preview')
  await controller.close()
  assert.equal(setup.hover.disposed, true)
})

test('native preview hover keeps it open and leaving collapses it even while its editor is focused', async () => {
  const setup = fixture()
  const controller = await managedController(setup)
  await delay(10)
  await controller.queue
  assert.equal(await controller.showFromTrigger(), true)
  setup.hover.emit('state', 'inside')
  await delay(10)
  await controller.queue
  assert.equal(controller.collapsed, false)

  setup.focusEditor({ document: {} })
  setup.hover.emit('state', 'outside')
  await delay(10)
  await controller.queue
  assert.equal(controller.collapsed, true)
  assert.equal(setup.panel.active, true)
  assert.equal(setup.actions.at(-2), 'panel.reveal')

  assert.equal(await controller.showFromTrigger(), true)
  setup.focusWindow(false)
  setup.hover.emit('state', 'outside')
  await delay(10)
  assert.equal(controller.collapsed, false)
  await controller.close()
})

test('a user-created third group abandons management and close never merges it', async () => {
  const setup = fixture()
  const controller = await managedController(setup)
  const third = { orientation: 0, groups: [{ size: 0.3 }, { size: 0.3 }, { size: 0.4 }] }
  setup.setLayout(third)
  await delay(30)
  await controller.queue
  assert.equal(controller.abandoned, true)
  const actionCount = setup.actions.length
  await controller.close()
  assert.deepEqual(setup.getLayout(), third)
  assert.equal(setup.actions.length, actionCount)
})

test('attach accepts a cleaned two-group layout after a stale multi-group baseline and is idempotent', async () => {
  const setup = fixture()
  const controller = new PreviewGroupController(setup.vscode, {}, {
    collapseDelayMs: 0,
    hoverObserverFactory: () => setup.hover,
  })
  setup.setLayout({ orientation: 0, groups: [{}, {}, {}] })
  await controller.captureBaseline()
  setup.setLayout(expanded)
  assert.equal(await controller.attach(setup.panel), true)
  assert.equal(await controller.attach(setup.panel), true)
  await delay(10)
  await controller.queue
  assert.equal(controller.collapsed, true)
  await controller.close()
})

test('focused editors do not reveal a collapsed preview', async () => {
  const setup = fixture()
  const controller = await managedController(setup)
  await delay(30)
  await controller.queue
  assert.equal(controller.collapsed, true)
  const editor = { document: {} }
  setup.vscode.window.visibleTextEditors = [editor]
  setup.focusEditor(editor)
  await controller.queue
  assert.equal(controller.collapsed, true)
  assert.equal(setup.actions.at(-2), 'panel.reveal')
  const toggles = setup.actions.filter((action) => action === 'workbench.action.toggleMaximizeEditorGroup').length
  await controller.close()
  assert.equal(setup.actions.filter((action) => action === 'workbench.action.toggleMaximizeEditorGroup').length, toggles)
})

test('layout classifier accepts only an unchanged simple horizontal pair', () => {
  assert.equal(isSimpleTwoGroupLayout(expanded), true)
  assert.equal(isSimpleTwoGroupLayout({ orientation: 1, groups: expanded.groups }), false)
  assert.equal(isSimpleTwoGroupLayout({ orientation: 0, groups: [{ groups: [] }, {}] }), false)
  assert.equal(sameSimpleLayout(expanded, { orientation: 0, groups: [{ size: 0.46 }, { size: 0.54 }] }), true)
  assert.equal(sameSimpleLayout(expanded, { orientation: 0, groups: [{ size: 0.3 }, { size: 0.7 }] }), false)
})
