(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = { createTauriBridge: factory }
    return
  }
  factory(root.acquireVsCodeApi(), root)
})(typeof globalThis === 'object' ? globalThis : this, function createTauriBridge(vscode, target) {
  'use strict'

  if (!vscode || typeof vscode.postMessage !== 'function') throw new TypeError('VS Code webview API is unavailable')
  if (!target || typeof target.addEventListener !== 'function') throw new TypeError('Webview event target is unavailable')

  let nextId = 1
  const pending = new Map()
  const listeners = new Map()

  function terminalForEvent(event) {
    const element = event.target
    return element && typeof element.closest === 'function' ? element.closest('.xterm') : null
  }

  function onTerminalClipboardShortcut(event) {
    if (event.type !== 'keydown' || !event.shiftKey || (!event.ctrlKey && !event.metaKey) || event.altKey || !terminalForEvent(event)) return
    const key = String(event.key).toLowerCase()
    if (key !== 'c' && key !== 'v') return
    // Keep these OS clipboard shortcuts out of xterm's input encoder. The
    // browser's trusted copy/paste event is still handled by xterm itself,
    // including its internal selection and bracketed-paste mode.
    event.stopImmediatePropagation()
    if (key === 'c' && target.document?.execCommand) {
      event.preventDefault()
      target.document.execCommand('copy')
    }
  }

  target.addEventListener('keydown', onTerminalClipboardShortcut, true)
  target.addEventListener('aio:file-drop-request', (event) => {
    const detail = event.detail
    if (!detail || !Number.isSafeInteger(detail.id) || !Array.isArray(detail.candidates)) return
    vscode.postMessage({ type: 'aio:file-drop', id: detail.id, candidates: detail.candidates })
  })
  target.addEventListener('aio:file-reference-result', (event) => {
    const detail = event.detail
    if (!detail || !Number.isSafeInteger(detail.id)) return
    vscode.postMessage({ type: 'aio:file-reference-result', id: detail.id, inserted: detail.inserted === true })
  })

  function invoke(command, args) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      vscode.postMessage({ type: 'aio:request', id, command, args: args || {} })
    })
  }

  function listen(eventName, callback) {
    if (typeof eventName !== 'string' || typeof callback !== 'function') {
      return Promise.reject(new TypeError('Invalid event subscription'))
    }
    let callbacks = listeners.get(eventName)
    if (!callbacks) {
      callbacks = new Set()
      listeners.set(eventName, callbacks)
    }
    callbacks.add(callback)
    return Promise.resolve(() => {
      callbacks.delete(callback)
      if (callbacks.size === 0) listeners.delete(eventName)
    })
  }

  target.addEventListener('message', ({ data }) => {
    if (!data || typeof data !== 'object') return
    if (data.type === 'aio:insert-file-references' && Number.isSafeInteger(data.id) && Array.isArray(data.references)) {
      target.dispatchEvent(new target.CustomEvent('aio:insert-file-references', {
        detail: { id: data.id, references: data.references },
      }))
      return
    }
    if (data.type === 'aio:file-drop-response' && Number.isSafeInteger(data.id)) {
      target.dispatchEvent(new target.CustomEvent('aio:file-drop-resolved', {
        detail: {
          id: data.id,
          references: Array.isArray(data.references) ? data.references : [],
          error: typeof data.error === 'string' ? data.error : undefined,
        },
      }))
      return
    }
    if (data.type === 'aio:response' && Number.isSafeInteger(data.id)) {
      const response = pending.get(data.id)
      if (!response) return
      pending.delete(data.id)
      if (typeof data.error === 'string') response.reject(new Error(data.error))
      else response.resolve(data.result)
      return
    }
    if (data.type !== 'aio:event' || typeof data.event !== 'string') return
    for (const callback of listeners.get(data.event) || []) {
      try { callback({ payload: data.payload }) } catch (error) { console.error('AIO event listener failed:', error) }
    }
  })

  const bridge = Object.freeze({
    core: Object.freeze({ invoke }),
    event: Object.freeze({ listen }),
  })
  Object.defineProperty(target, '__TAURI__', {
    value: bridge,
    configurable: false,
    enumerable: true,
    writable: false,
  })
  return bridge
})
