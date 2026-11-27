'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { panelCopy } = require('../src/panel-auto-hide')
const { historyCopy } = require('../src/history-view')

test('plugin-added workbench text supports English and Simplified Chinese', () => {
  assert.deepEqual(panelCopy('en'), {
    left: 'Show sidebar', preview: 'File preview', showPreview: 'Show file preview',
  })
  assert.deepEqual(panelCopy('zh-CN'), {
    left: '显示左侧栏', preview: '文件预览', showPreview: '显示文件预览',
  })
  assert.deepEqual(historyCopy('en-US'), { empty: 'No history sessions', loading: 'Loading…' })
  assert.deepEqual(historyCopy('zh-Hans'), { empty: '没有历史会话', loading: '正在加载…' })
})

test('plugin-added workbench text follows live AIO locale changes', () => {
  for (const file of ['panel-auto-hide.js', 'history-view.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8')
    assert.match(source, /observe\(document\.documentElement, \{ attributes: true, attributeFilter: \['lang'\] \}\)/)
  }
})
