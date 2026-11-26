'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')
const {
  extractDropCandidates, formatReference, hasSupportedDropType, insertReferences, resolveDroppedReferences, validFileDropRequest,
} = require('../src/file-drop')

function transfer(values) {
  return { getData: (type) => values[type] || '' }
}

test('extracts URI and folder path resources without losing mixed drops', () => {
  const result = extractDropCandidates(transfer({
    'text/uri-list': '# files\r\nfile:///D:/项目/a%20b.ts\r\n',
    'application/vnd.code.uri-list': 'file:///D:/项目/extra.ts\r\n',
    resourceurls: JSON.stringify(['file:///D:/项目/a%20b.ts']),
    codefiles: JSON.stringify(['D:\\项目\\folder', 'D:\\项目\\a b.ts']),
  }))
  assert.deepEqual(result, [
    { kind: 'uri', value: 'file:///D:/项目/a%20b.ts' },
    { kind: 'uri', value: 'file:///D:/项目/extra.ts' },
    { kind: 'path', value: 'D:\\项目\\folder' },
    { kind: 'path', value: 'D:\\项目\\a b.ts' },
  ])
  assert.equal(hasSupportedDropType({ types: ['Files', 'text/uri-list'] }), true)
  assert.equal(hasSupportedDropType({
    types: ['Files', 'text/uri-list'], items: [{ kind: 'file', type: 'image/png' }],
  }), false)
})

test('rejects raw control characters and rejects the whole drop above sixteen items', () => {
  const paths = Array.from({ length: 20 }, (_, index) => `C:\\repo\\${index}`)
  assert.throws(() => extractDropCandidates(transfer({ codefiles: JSON.stringify(paths) })), /最多引用 16/)
  assert.throws(
    () => extractDropCandidates(transfer({ codefiles: JSON.stringify(['C:\\repo\\bad\nname']) })),
    /控制字符/,
  )
})

test('inserts quoted references at a controlled textarea caret without submitting', () => {
  const events = []
  const textarea = {
    value: 'inspect now', selectionStart: 7, selectionEnd: 7,
    setRangeText(text, start, end) { this.value = this.value.slice(0, start) + text + this.value.slice(end); this.selectionStart = start + text.length },
    dispatchEvent(event) { events.push(event); return true }, focus() { this.focused = true },
  }
  const root = { InputEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options) } } }
  assert.equal(insertReferences({ kind: 'textarea', element: textarea }, ['@"D:\\项目\\a b.ts"', '@"D:\\项目\\folder"'], root), true)
  assert.equal(textarea.value, 'inspect @"D:\\项目\\a b.ts" @"D:\\项目\\folder" now')
  assert.deepEqual(events.map(({ type }) => type), ['input'])
  assert.equal(textarea.focused, true)
})

test('pastes references into xterm without enter, newline or control bytes', () => {
  let pasted
  const input = { dispatchEvent(event) { pasted = event.clipboardData.getData('text/plain'); return true }, focus() { this.focused = true } }
  class DataTransfer { setData(type, value) { this[type] = value } getData(type) { return this[type] } }
  class ClipboardEvent { constructor(type, options) { this.type = type; Object.assign(this, options) } }
  assert.equal(insertReferences({ kind: 'terminal', element: input }, ['@"C:\\repo\\a b.ts"'], { DataTransfer, ClipboardEvent }), true)
  assert.equal(pasted, '@"C:\\repo\\a b.ts"')
  assert.doesNotMatch(pasted, /[\r\n\x1b]/)
  assert.equal(input.focused, true)
  assert.equal(insertReferences({ kind: 'terminal', element: input }, ['bad\x1b[31m'], { DataTransfer, ClipboardEvent }), false)
})

test('validates bounded host requests and rejects decoded control characters', async () => {
  const request = {
    type: 'aio:file-drop', id: 7,
    candidates: [{ kind: 'uri', value: 'file:///D:/repo/good.ts' }, { kind: 'path', value: 'D:\\repo\\folder' }],
  }
  assert.equal(validFileDropRequest(request), true)
  assert.equal(validFileDropRequest({ ...request, candidates: [{ kind: 'path', value: 'bad\npath' }] }), false)

  function uri(raw, fsPath) {
    return { raw, fsPath, toString: () => raw }
  }
  const root = uri('file:///D:/repo', 'D:\\repo')
  const vscode = {
    FileType: { File: 1, Directory: 2 },
    Uri: {
      parse(value) {
        const decoded = decodeURIComponent(value)
        return uri(value, decoded.replace(/^file:\/\/\//, '').replaceAll('/', '\\'))
      },
      joinPath(folder, ...parts) {
        const fsPath = path.win32.join(folder.fsPath, ...parts)
        return uri('file:///' + fsPath.replaceAll('\\', '/'), fsPath)
      },
    },
    workspace: {
      workspaceFolders: [{ uri: root }],
      getWorkspaceFolder(candidate) { return candidate.fsPath.toLowerCase().startsWith(root.fsPath.toLowerCase()) ? this.workspaceFolders[0] : undefined },
      fs: { stat: async (candidate) => ({ type: candidate.fsPath.endsWith('folder') ? 2 : 1 }) },
    },
  }
  assert.deepEqual(await resolveDroppedReferences(vscode, path.win32, request.candidates), [
    '@"D:\\repo\\good.ts"', '@"D:\\repo\\folder"',
  ])
  await assert.rejects(
    resolveDroppedReferences(vscode, path.win32, [{ kind: 'uri', value: 'file:///D:/repo/bad%0Aname' }]),
    /unsupported characters/,
  )
  assert.throws(() => formatReference('bad\x1bpath'), /unsupported characters/)
})
