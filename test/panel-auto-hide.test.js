'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { shouldSuppressEdgeReveal } = require('../src/panel-auto-hide')

function element(matches) {
  return { closest: (selector) => matches.some((value) => selector.includes(value)) ? {} : null }
}

test('edge reveal is suppressed over composer and the entire terminal surface', () => {
  assert.equal(shouldSuppressEdgeReveal([element(['.composer'])]), true)
  assert.equal(shouldSuppressEdgeReveal([element(['.coding-cli-composer'])]), true)
  assert.equal(shouldSuppressEdgeReveal([element(['.terminal-drawer'])]), true)
  assert.equal(shouldSuppressEdgeReveal([element(['.terminal-surface'])]), true)
  assert.equal(shouldSuppressEdgeReveal([element(['.xterm'])]), true)
  assert.equal(shouldSuppressEdgeReveal([element(['.conversation-pane'])]), false)
})
