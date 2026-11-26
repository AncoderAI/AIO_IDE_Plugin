(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else api.installFileDrop(root)
})(typeof globalThis === 'object' ? globalThis : this, function createFileDropApi() {
  'use strict'

  const MAX_ITEMS = 16
  const MAX_TRANSFER_BYTES = 64 * 1024
  const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/
  const MIME_TYPES = ['text/uri-list', 'application/vnd.code.uri-list', 'resourceurls', 'codefiles']

  function safeTransferText(transfer, type) {
    try {
      const value = transfer.getData(type)
      return typeof value === 'string' && value.length <= MAX_TRANSFER_BYTES ? value : ''
    } catch { return '' }
  }

  function addCandidate(candidates, kind, value) {
    if (typeof value !== 'string' || !value) return
    if (CONTROL_CHARACTERS.test(value)) throw new TypeError('拖入路径包含不支持的控制字符')
    if (candidates.some((candidate) => candidate.kind === kind && candidate.value === value)) return
    if (candidates.length >= MAX_ITEMS) throw new RangeError(`AIO 一次最多引用 ${MAX_ITEMS} 个文件或文件夹`)
    candidates.push({ kind, value })
  }

  function parseJsonTransfer(candidates, type, raw) {
    if (!raw) return
    let values
    try { values = JSON.parse(raw) } catch { return }
    if (!Array.isArray(values)) return
    for (const value of values) {
      if (type === 'codefiles') addCandidate(candidates, 'path', value)
      else addCandidate(candidates, 'uri', value)
    }
  }

  function extractDropCandidates(transfer) {
    if (!transfer || typeof transfer.getData !== 'function') return []
    const candidates = []
    const uriList = safeTransferText(transfer, 'text/uri-list')
    const vscodeUriList = safeTransferText(transfer, 'application/vnd.code.uri-list')
    for (const list of [uriList, vscodeUriList]) {
      for (const line of list.split(/\r?\n/)) {
        const value = line.trim()
        if (value && !value.startsWith('#')) addCandidate(candidates, 'uri', value)
      }
    }
    for (const type of ['resourceurls', 'codefiles']) parseJsonTransfer(candidates, type, safeTransferText(transfer, type))
    return candidates
  }

  function dropTarget(element, document) {
    if (!element || typeof element.closest !== 'function') return undefined
    const composer = element.closest('.composer, .coding-cli-composer')
    const textarea = composer?.querySelector('textarea:not([disabled])')
    if (textarea) return { kind: 'textarea', element: textarea }
    const terminal = element.closest('.xterm')
    const terminalInput = terminal?.querySelector('textarea')
    if (terminalInput) return { kind: 'terminal', element: terminalInput }
    return undefined
  }

  function hasSupportedDropType(transfer) {
    // Preserve the existing Composer image attachment path for OS/browser file
    // drags. VS Code Explorer resource drags expose URI/path MIME data without
    // image File items in the Webview.
    if (Array.from(transfer?.items || []).some((item) => item.kind === 'file' && /^image\//i.test(item.type))) return false
    const types = Array.from(transfer?.types || [], (type) => String(type).toLowerCase())
    return MIME_TYPES.some((type) => types.includes(type))
  }

  function insertReferences(target, references, root) {
    const text = references.join(' ')
    if (!text || CONTROL_CHARACTERS.test(text)) return false
    if (target.kind === 'textarea') {
      const textarea = target.element
      const start = textarea.selectionStart ?? textarea.value.length
      const end = textarea.selectionEnd ?? textarea.value.length
      const prefix = start > 0 && !/\s/.test(textarea.value[start - 1]) ? ' ' : ''
      const suffix = end < textarea.value.length && !/\s/.test(textarea.value[end]) ? ' ' : ''
      const inserted = prefix + text + suffix
      const nextValue = textarea.value.slice(0, start) + inserted + textarea.value.slice(end)
      // React tracks the instance value setter. Using the native prototype
      // setter lets the bubbling input event update controlled component state.
      const nativeSetter = Object.getOwnPropertyDescriptor(root.HTMLTextAreaElement?.prototype || {}, 'value')?.set
      if (nativeSetter) {
        nativeSetter.call(textarea, nextValue)
        textarea.setSelectionRange(start + inserted.length, start + inserted.length)
      } else {
        textarea.setRangeText(inserted, start, end, 'end')
      }
      textarea.dispatchEvent(new root.InputEvent('input', { bubbles: true, inputType: 'insertText', data: inserted }))
      textarea.focus()
      return true
    }
    const clipboard = new root.DataTransfer()
    clipboard.setData('text/plain', text)
    target.element.dispatchEvent(new root.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }))
    target.element.focus()
    return true
  }

  function validFileDropRequest(message) {
    if (!message || message.type !== 'aio:file-drop' || !Number.isSafeInteger(message.id) || !Array.isArray(message.candidates)) return false
    if (message.candidates.length < 1 || message.candidates.length > MAX_ITEMS) return false
    if (!message.candidates.every((candidate) => candidate && (candidate.kind === 'uri' || candidate.kind === 'path')
      && typeof candidate.value === 'string' && candidate.value.length > 0 && candidate.value.length <= 8192
      && !CONTROL_CHARACTERS.test(candidate.value))) return false
    try { return JSON.stringify(message).length <= MAX_TRANSFER_BYTES } catch { return false }
  }

  function insidePath(pathModule, root, candidate) {
    const relative = pathModule.relative(root, candidate)
    return relative === '' || (!relative.startsWith('..' + pathModule.sep) && relative !== '..' && !pathModule.isAbsolute(relative))
  }

  function uriForPath(vscode, pathModule, candidate) {
    if (!pathModule.isAbsolute(candidate)) return undefined
    for (const folder of vscode.workspace.workspaceFolders || []) {
      if (!insidePath(pathModule, folder.uri.fsPath, candidate)) continue
      const relative = pathModule.relative(folder.uri.fsPath, candidate)
      return relative ? vscode.Uri.joinPath(folder.uri, ...relative.split(pathModule.sep)) : folder.uri
    }
    return undefined
  }

  function formatReference(path) {
    if (typeof path !== 'string' || !path || path.length > 8192 || CONTROL_CHARACTERS.test(path)) throw new TypeError('Dropped path contains unsupported characters')
    return `@"${path.replace(/"/g, '\\"')}"`
  }

  async function resolveDroppedReferences(vscode, pathModule, candidates) {
    const references = []
    const seen = new Set()
    for (const candidate of candidates) {
      let uri
      try {
        uri = candidate.kind === 'uri' ? vscode.Uri.parse(candidate.value, true) : uriForPath(vscode, pathModule, candidate.value)
      } catch { continue }
      if (!uri || !vscode.workspace.getWorkspaceFolder(uri)) continue
      if (CONTROL_CHARACTERS.test(uri.toString(true)) || CONTROL_CHARACTERS.test(uri.fsPath)) {
        throw new TypeError('Dropped path contains unsupported characters')
      }
      let stat
      try { stat = await vscode.workspace.fs.stat(uri) } catch { continue }
      const fileType = vscode.FileType || { File: 1, Directory: 2 }
      if (!(stat.type & (fileType.File | fileType.Directory))) continue
      const key = uri.toString(true)
      if (seen.has(key)) continue
      seen.add(key)
      references.push(formatReference(uri.fsPath))
    }
    return references
  }

  function installFileDrop(root) {
    if (!root?.document || root.__AIO_FILE_DROP_INSTALLED__) return
    Object.defineProperty(root, '__AIO_FILE_DROP_INSTALLED__', { value: true })
    let sequence = 0
    const pending = new Map()
    let lastFocusedTarget
    let hint
    let hintTimer
    const hideHint = () => {
      if (hintTimer) root.clearTimeout(hintTimer)
      hintTimer = undefined
      hint?.remove()
      hint = undefined
    }
    const showHint = (text = '松开以引用文件或文件夹 · 从 Explorer 拖入时请按住 Shift', duration) => {
      if (hint && !duration) return
      hideHint()
      hint = root.document.createElement('div')
      hint.textContent = text
      hint.setAttribute('role', 'status')
      Object.assign(hint.style, {
        position: 'fixed', zIndex: '2147483647', left: '50%', top: '18px', transform: 'translateX(-50%)',
        padding: '8px 12px', borderRadius: '6px', color: 'var(--foreground)',
        background: 'var(--vscode-editorWidget-background, #252526)',
        border: '1px solid var(--vscode-focusBorder, #007acc)', pointerEvents: 'none',
      })
      root.document.body.appendChild(hint)
      if (duration) hintTimer = root.setTimeout(hideHint, duration)
    }
    const usableTarget = (target) => Boolean(target?.element && target.element.isConnected !== false
      && !target.element.disabled && !target.element.closest?.('[inert]')
      && (typeof target.element.getClientRects !== 'function' || target.element.getClientRects().length > 0))
    const fallbackTarget = () => {
      if (usableTarget(lastFocusedTarget)) return lastFocusedTarget
      for (const selector of ['.coding-cli-composer textarea:not([disabled])', '.composer textarea:not([disabled])']) {
        for (const element of root.document.querySelectorAll(selector)) {
          const target = { kind: 'textarea', element }
          if (usableTarget(target)) return target
        }
      }
      return undefined
    }
    root.document.addEventListener('focusin', (event) => {
      const target = dropTarget(event.target, root.document)
      if (target) lastFocusedTarget = target
    }, true)
    root.document.addEventListener('dragover', (event) => {
      if (!hasSupportedDropType(event.dataTransfer) || !dropTarget(event.target, root.document)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      showHint()
    }, true)
    root.document.addEventListener('dragleave', (event) => {
      if (!event.relatedTarget) hideHint()
    }, true)
    root.document.addEventListener('drop', (event) => {
      const target = dropTarget(event.target, root.document)
      if (!target || !hasSupportedDropType(event.dataTransfer)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      hideHint()
      let candidates
      try { candidates = extractDropCandidates(event.dataTransfer) } catch (error) {
        showHint(error instanceof Error ? error.message : String(error), 2500)
        return
      }
      if (!candidates.length) {
        showHint('无法读取拖入项，请从 Explorer 拖动并按住 Shift', 2500)
        return
      }
      const id = ++sequence
      pending.set(id, target)
      root.dispatchEvent(new root.CustomEvent('aio:file-drop-request', { detail: { id, candidates } }))
    }, true)
    root.addEventListener('aio:file-drop-resolved', (event) => {
      const id = event.detail?.id
      let target = pending.get(id)
      if (!target) return
      pending.delete(id)
      const references = Array.isArray(event.detail.references) ? event.detail.references : []
      if (event.detail.error) {
        showHint(event.detail.error, 2500)
        return
      }
      if (!references.length) {
        showHint('只能引用当前 VS Code 工作区中存在的文件或文件夹', 2500)
        return
      }
      if (!usableTarget(target)) target = fallbackTarget()
      if (!target) {
        showHint('当前工作台没有可接收文件引用的对话框或终端输入区', 3000)
        return
      }
      insertReferences(target, references, root)
    })
    root.addEventListener('aio:insert-file-references', (event) => {
      const id = event.detail?.id
      const references = Array.isArray(event.detail?.references) ? event.detail.references : []
      const target = fallbackTarget()
      const inserted = Boolean(target && insertReferences(target, references, root))
      if (!inserted) showHint('当前工作台没有可接收文件引用的对话框或终端输入区', 3000)
      root.dispatchEvent(new root.CustomEvent('aio:file-reference-result', { detail: { id, inserted } }))
    })
  }

  return {
    CONTROL_CHARACTERS, extractDropCandidates, formatReference, hasSupportedDropType, insertReferences, installFileDrop,
    resolveDroppedReferences, validFileDropRequest,
  }
})
