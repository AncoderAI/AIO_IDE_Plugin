'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

test('inactive terminal output is bounded and replayed only when visible', () => {
  const assets = path.resolve(__dirname, '../workbench/ui/assets')
  const filename = fs.readdirSync(assets).find((name) => /^TerminalDrawer-.*\.js$/.test(name))
  assert.ok(filename, 'missing generated TerminalDrawer asset')
  const source = fs.readFileSync(path.join(assets, filename), 'utf8')

  assert.match(source, /AIOHiddenOutput=i\.useRef\(""\)/)
  assert.match(source, /const P=262144/)
  assert.match(source, /AIOHiddenCallbacks\.current\.length<32/)
  assert.match(source, /AIOFlushHidden\.current\(\);try\{\$\.current\?\.fit\(\)/)
  assert.match(source, /l\.terminalId===s\.current\)AIOWriteOutput\(l\.data/)
  assert.match(source, /ve\?AIOWriteOutput\(ve/)
  assert.doesNotMatch(source, /l\.terminalId===s\.current\)r\.write\(l\.data/)
  assert.match(source, /inactive terminal output was truncated/)
})

test('the reproducible UI build contains the inactive terminal source and generated patches', () => {
  const build = fs.readFileSync(path.resolve(__dirname, '../scripts/build-workbench.cjs'), 'utf8')
  assert.match(build, /hiddenOutputRef = useRef\(''\)/)
  assert.match(build, /visibleRef\.current \|\| waitingForOutput/)
  assert.match(build, /--patch-inactive-terminal-output/)
  assert.match(build, /function patchGeneratedInactiveTerminalOutput\(\)/)
})
