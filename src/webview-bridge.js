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
  const terminals = new Map()
  let activeTerminal
  let terminalKeyboardOwned = false
  let terminalFocusIntent = false
  let focusGeneration = 0

  function terminalForElement(element) {
    const root = element && typeof element.closest === 'function' ? element.closest('.xterm') : null
    return root ? terminals.get(root) : undefined
  }

  function visibleTerminal() {
    if (activeTerminal?.isVisible()) return activeTerminal
    activeTerminal = [...terminals.values()].find((terminal) => terminal.isVisible())
    return activeTerminal
  }

  function isInteractive(element) {
    return Boolean(element && typeof element.closest === 'function' && element.closest(
      'input, textarea, select, button, a[href], [contenteditable]:not([contenteditable="false"]), [role="button"], [role="menu"], [role="menuitem"], [role="dialog"], [role="listbox"], [role="option"], [role="tab"], [role="separator"], [aria-haspopup][aria-expanded="true"]',
    ))
  }

  function blocksTerminalFocus(element) {
    return Boolean(element && typeof element.closest === 'function' && element.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="menu"], [role="menuitem"], [role="dialog"], [role="listbox"], [role="option"], [aria-modal="true"], [aria-haspopup][aria-expanded="true"]',
    ))
  }

  function focusOwnedTerminal() {
    const generation = ++focusGeneration
    const schedule = target.requestAnimationFrame || ((callback) => target.setTimeout(callback, 0))
    schedule(() => {
      if (generation !== focusGeneration || !terminalKeyboardOwned || target.document?.hasFocus?.() === false) return
      visibleTerminal()?.focus()
    })
  }

  function onTerminalClipboardShortcut(event) {
    if (event.type !== 'keydown' || (!event.ctrlKey && !event.metaKey) || event.altKey) return
    const terminal = terminalForElement(event.target)
    if (!terminal) return
    const key = String(event.key).toLowerCase()
    if (key !== 'c' && key !== 'v') return
    if (key === 'c' && !terminal.hasSelection()) return
    event.stopImmediatePropagation()
    if (key === 'c') {
      event.preventDefault()
      target.document?.execCommand?.('copy')
    }
  }

  target.addEventListener('keydown', onTerminalClipboardShortcut, true)
  target.addEventListener('focusin', (event) => {
    const terminal = terminalForElement(event.target)
    if (terminal) {
      activeTerminal = terminal
      if (terminalFocusIntent) terminalKeyboardOwned = true
    } else if (isInteractive(event.target)) {
      terminalKeyboardOwned = false
      focusGeneration++
    }
  }, true)
  target.addEventListener('pointerdown', (event) => {
    const terminal = terminalForElement(event.target)
    if (terminal) {
      activeTerminal = terminal
      terminalKeyboardOwned = true
      terminalFocusIntent = true
      return
    }
    if (!event.target?.closest?.('.app-shell')) return
    terminalFocusIntent = !blocksTerminalFocus(event.target)
    terminalKeyboardOwned = terminalFocusIntent && !isInteractive(event.target) && visibleTerminal() !== undefined
    if (terminalKeyboardOwned) focusOwnedTerminal()
    else focusGeneration++
  }, true)
  target.addEventListener('blur', () => {
    terminalKeyboardOwned = false
    terminalFocusIntent = false
    focusGeneration++
  })
  target.addEventListener('aio:terminal-focus-request', () => {
    if (!terminalFocusIntent || blocksTerminalFocus(target.document?.activeElement)) return
    terminalKeyboardOwned = visibleTerminal() !== undefined
    if (terminalKeyboardOwned) focusOwnedTerminal()
  })
  target.addEventListener('aio:terminal-register', (event) => {
    const detail = event.detail
    if (!detail || typeof detail.id !== 'string' || !detail.element
      || typeof detail.hasSelection !== 'function' || typeof detail.getSelection !== 'function'
      || typeof detail.isVisible !== 'function' || typeof detail.paste !== 'function'
      || typeof detail.focus !== 'function') return
    terminals.set(detail.element, detail)
    if (detail.isVisible()) activeTerminal = detail
  })
  target.addEventListener('aio:terminal-unregister', (event) => {
    const id = event.detail?.id
    for (const [element, terminal] of terminals) {
      if (terminal.id !== id) continue
      terminals.delete(element)
      if (activeTerminal === terminal) activeTerminal = undefined
    }
    if (!activeTerminal) activeTerminal = [...terminals.values()].find((terminal) => terminal.isVisible())
    if (!activeTerminal) {
      terminalKeyboardOwned = false
      terminalFocusIntent = false
    }
  })
  target.addEventListener('aio:file-drop-request', (event) => {
    const detail = event.detail
    if (!detail || !Number.isSafeInteger(detail.id) || !Array.isArray(detail.candidates)) return
    vscode.postMessage({ type: 'aio:file-drop', id: detail.id, candidates: detail.candidates })
  })
  target.addEventListener('aio:project-drop-request', (event) => {
    const detail = event.detail
    if (!detail || !Number.isSafeInteger(detail.id) || !Array.isArray(detail.candidates)) return
    vscode.postMessage({ type: 'aio:project-drop', id: detail.id, candidates: detail.candidates })
  })
  target.addEventListener('aio:project-activate', (event) => {
    const path = event.detail?.path
    if (typeof path === 'string') vscode.postMessage({ type: 'aio:project-activate', path })
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
    if (data.type === 'aio:terminal-copy-request' && Number.isSafeInteger(data.id)) {
      const terminal = visibleTerminal()
      vscode.postMessage({
        type: 'aio:terminal-selection',
        id: data.id,
        available: terminal !== undefined,
        terminalId: terminal?.id,
        text: terminal?.hasSelection() ? terminal.getSelection() : '',
      })
      return
    }
    if (data.type === 'aio:terminal-paste' && typeof data.terminalId === 'string' && typeof data.text === 'string') {
      if (activeTerminal?.id === data.terminalId && activeTerminal.isVisible()) {
        activeTerminal.paste(data.text)
        activeTerminal.focus()
      }
      return
    }
    if (data.type === 'aio:insert-file-references' && Number.isSafeInteger(data.id) && Array.isArray(data.references)) {
      target.dispatchEvent(new target.CustomEvent('aio:insert-file-references', {
        detail: { id: data.id, references: data.references },
      }))
      return
    }
    if (data.type === 'aio:project-drop-response' && Number.isSafeInteger(data.id)) {
      target.dispatchEvent(new target.CustomEvent('aio:project-drop-resolved', {
        detail: { id: data.id, added: data.added, error: data.error },
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
