'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const { localize } = require('../src/localize')

test('native extension copy resolves in English and Simplified Chinese', () => {
  assert.equal(localize({ env: { language: 'en' } }, 'fullWorkbench'), 'Full Workbench')
  assert.equal(localize({ env: { language: 'zh-cn' } }, 'fullWorkbench'), '完整工作台')
  assert.equal(localize({ env: { language: 'zh-tw' } }, 'referenceLimit', { count: 16 }), 'AIO 一次最多引用 16 个文件或文件夹')
})

test('all package localization placeholders exist in both catalogs', () => {
  const manifest = fs.readFileSync('package.json', 'utf8')
  const english = JSON.parse(fs.readFileSync('package.nls.json', 'utf8'))
  const chinese = JSON.parse(fs.readFileSync('package.nls.zh-cn.json', 'utf8'))
  const keys = [...manifest.matchAll(/%([^%]+)%/g)].map(match => match[1])
  assert.deepEqual(Object.keys(english).sort(), Object.keys(chinese).sort())
  for (const key of keys) {
    assert.equal(typeof english[key], 'string', `missing English package string ${key}`)
    assert.equal(typeof chinese[key], 'string', `missing Chinese package string ${key}`)
  }
})
