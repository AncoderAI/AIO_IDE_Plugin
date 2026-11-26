'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

test('all plugin-owned OMP terminal paths use the prediction-free overlay', () => {
  const serviceRoot = path.resolve(__dirname, '../workbench/service')
  const config = fs.readFileSync(path.join(serviceRoot, 'aio-omp-config.yml'), 'utf8')
  const service = fs.readFileSync(path.join(serviceRoot, 'workbench-service.cjs'), 'utf8')
  assert.ok(config.includes('predictions: false'))
  assert.ok(service.includes('entry.agent === "omp") return ["--config"'))
  assert.ok(service.includes('"aio-omp-config.yml"), "--session-dir"'))
  assert.ok(service.includes('if (agent === "omp")'))
  assert.ok(service.includes('args: ["--config", require("node:path").resolve(__dirname, "aio-omp-config.yml")]'))
})
