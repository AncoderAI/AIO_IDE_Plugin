'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const {
  currentWorkspaceMatches, handoffStorageKey, projectFolderUri, registeredProject, resumeProjectHandoff,
  storeProjectHandoff,
} = require('../src/project-handoff')
const { WorkbenchHost } = require('../src/workbench')

function globalState(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
    update: async (key, value) => { if (value === undefined) values.delete(key); else values.set(key, value) },
    value: (key) => values.get(key),
  }
}

test('stores independent destination handoffs and resumes only the matching workspace', async () => {
  const state = globalState()
  const context = { globalState: state }
  const now = 1_000
  await storeProjectHandoff(context, path.win32, { target: 'D:\\one', projects: ['D:\\one'], expiresAt: now + 100 })
  await storeProjectHandoff(context, path.win32, {
    target: 'D:\\two', projects: Array.from({ length: 18 }, (_, index) => `D:\\project-${index}`), expiresAt: now + 100,
  })
  assert.ok(state.value(handoffStorageKey(path.win32, 'D:\\one')))
  assert.ok(state.value(handoffStorageKey(path.win32, 'D:\\two')))

  const calls = []
  const host = {
    open: async () => { calls.push('open') },
    addProjectCandidates: async (candidates, outside) => { calls.push({ candidates, outside }) },
  }
  const vscode = { workspace: { workspaceFolders: [{ uri: { fsPath: 'D:\\two' } }] } }
  assert.equal(await resumeProjectHandoff(vscode, context, host, path.win32, now), true)
  assert.equal(calls[0], 'open')
  assert.equal(calls[1].candidates.length, 19)
  assert.deepEqual(calls[1].candidates.at(-1), { kind: 'path', value: 'D:\\two' })
  assert.equal(calls[1].outside, true)
  assert.equal(state.value(handoffStorageKey(path.win32, 'D:\\two')), undefined)
  assert.ok(state.value(handoffStorageKey(path.win32, 'D:\\one')))
})

test('matches only a single-folder workspace and an AIO registered project root', () => {
  const vscode = { workspace: { workspaceFolders: [{ uri: { fsPath: 'D:\\repo' } }] } }
  assert.equal(currentWorkspaceMatches(vscode, path.win32, 'd:\\REPO'), true)
  vscode.workspace.workspaceFolders.push({ uri: { fsPath: 'D:\\other' } })
  assert.equal(currentWorkspaceMatches(vscode, path.win32, 'D:\\repo'), false)
  assert.equal(registeredProject(path.win32, [
    { id: 'a', primaryFolder: 'D:\\repo' }, { id: 'b', path: 'D:\\other' },
  ], 'd:\\OTHER').id, 'b')
})

test('keeps the current remote scheme and authority when opening another remote project', () => {
  const remote = {
    scheme: 'vscode-remote', authority: 'ssh-remote+host', fsPath: '/work/one',
    with(change) { return { scheme: this.scheme, authority: this.authority, path: change.path } },
  }
  const vscode = { workspace: { workspaceFolders: [{ uri: remote }] }, Uri: { file: () => { throw new Error('local URI used') } } }
  assert.deepEqual(projectFolderUri(vscode, path.posix, '/work/two'), {
    scheme: 'vscode-remote', authority: 'ssh-remote+host', path: '/work/two',
  })
})

test('workbench validates the clicked project, writes a short handoff and opens the folder once', async () => {
  const state = globalState()
  const commands = []
  let releaseOpen
  const openGate = new Promise((resolve) => { releaseOpen = resolve })
  const warnings = []
  const target = 'D:\\projects\\two'
  const targetUri = { scheme: 'file', fsPath: target, toString: () => 'file:///D:/projects/two' }
  const vscode = {
    FileType: { Directory: 2 },
    Uri: { file: () => targetUri },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: 'D:\\projects\\one' } }],
      fs: { stat: async () => ({ type: 2 }) },
    },
    commands: { executeCommand: async (...args) => { commands.push(args); await openGate } },
    window: {
      createOutputChannel: () => ({ append() {}, appendLine() {}, dispose() {} }),
      showWarningMessage: async (message) => { warnings.push(message) },
    },
  }
  const host = new WorkbenchHost(vscode, { globalState: state })
  host.panel = {}
  host.service = { request: async (channel, args) => {
    assert.equal(channel, 'projects:list-initial')
    assert.deepEqual(args, [])
    return [
      { id: 'one', primaryFolder: 'D:\\projects\\one' },
      { id: 'two', primaryFolder: target },
    ]
  } }
  const first = host.activateProjectPath(target)
  const duplicate = host.activateProjectPath(target.toLowerCase())
  assert.strictEqual(first, duplicate)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(commands.length, 1)
  releaseOpen()
  assert.equal(await first, true)
  assert.equal(await duplicate, true)
  assert.deepEqual(commands, [['vscode.openFolder', targetUri, false]])
  const handoff = state.value(handoffStorageKey(path.win32, target))
  assert.equal(handoff.target, target)
  assert.deepEqual(handoff.projects, ['D:\\projects\\one', target])
  assert.equal(await host.activateProjectPath('D:\\not-registered'), false)
  assert.match(warnings.at(-1), /(not registered in AIO|不是 AIO 已登记)/)
  host.panel = undefined
  host.service = undefined
  host.dispose()
})
