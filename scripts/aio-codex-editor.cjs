'use strict'

const { spawnSync } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')
const {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs')
const { isAbsolute, join } = require('node:path')

const MAX_TASK_BYTES = 64 * 1024

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function atomicJson(filename, value) {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  renameSync(temporary, filename)
}

function runFallback(draftPath) {
  const serialized = process.env.AIO_CODEX_EDITOR_FALLBACK_ARGV
  if (!serialized) throw new Error('AIO Codex editor was opened without a pending task')
  const fallback = JSON.parse(serialized)
  if (!Array.isArray(fallback) || !fallback.length || fallback.some((value) => typeof value !== 'string' || value.includes('\0'))) {
    throw new Error('Configured fallback editor is invalid')
  }
  const result = spawnSync(fallback[0], [...fallback.slice(1), draftPath], {
    shell: false,
    stdio: 'inherit',
    windowsHide: false,
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}

function main() {
  const draftPath = process.argv.at(-1)
  const spool = process.env.AIO_CODEX_EDITOR_SPOOL
  if (!draftPath || !isAbsolute(draftPath)) throw new Error('Codex editor draft path is invalid')
  if (!spool || !isAbsolute(spool)) throw new Error('AIO Codex editor spool is unavailable')
  const spoolInfo = lstatSync(spool)
  if (!spoolInfo.isDirectory() || spoolInfo.isSymbolicLink()) throw new Error('AIO Codex editor spool is not a stable directory')

  const requestPath = join(spool, 'request.json')
  if (!existsSync(requestPath)) return runFallback(draftPath)
  const requestInfo = lstatSync(requestPath)
  if (!requestInfo.isFile() || requestInfo.isSymbolicLink() || requestInfo.size > MAX_TASK_BYTES * 2) {
    throw new Error('AIO Codex editor request is invalid')
  }

  const request = JSON.parse(readFileSync(requestPath, 'utf8'))
  const nonce = request?.nonce
  const text = request?.text
  if (request?.v !== 1 || typeof nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(nonce)
    || typeof text !== 'string' || Buffer.byteLength(text) > MAX_TASK_BYTES
    || request.bytes !== Buffer.byteLength(text) || request.sha256 !== digest(text)) {
    throw new Error('AIO Codex editor request failed integrity validation')
  }

  const ackPath = join(spool, 'ack.json')
  const consumedPath = join(spool, `${nonce}.request.json`)
  renameSync(requestPath, consumedPath)
  try {
    const draftInfo = lstatSync(draftPath)
    if (!draftInfo.isFile() || draftInfo.isSymbolicLink()) throw new Error('Codex editor draft is not a stable file')
    const existing = readFileSync(draftPath)
    if (existing.length) {
      atomicJson(ackPath, {
        v: 1,
        nonce,
        status: 'draft-not-empty',
        bytes: existing.length,
        sha256: digest(existing),
      })
      process.exitCode = 73
      return
    }

    writeFileSync(draftPath, text, { encoding: 'utf8', flag: 'w' })
    const written = readFileSync(draftPath)
    if (written.length !== request.bytes || digest(written) !== request.sha256) {
      throw new Error('Codex editor draft write failed integrity validation')
    }
    atomicJson(ackPath, {
      v: 1,
      nonce,
      status: 'consumed',
      bytes: written.length,
      sha256: request.sha256,
    })
  } catch (error) {
    if (!existsSync(ackPath)) {
      atomicJson(ackPath, {
        v: 1,
        nonce,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
    process.exitCode = 74
  } finally {
    rmSync(consumedPath, { force: true })
  }
}

try {
  main()
} catch (error) {
  process.stderr.write(`[aio-codex-editor] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 72
}
