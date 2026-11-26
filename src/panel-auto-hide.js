(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else api.installAutoHidePanels(root)
})(typeof globalThis === 'object' ? globalThis : this, function createAutoHidePanelApi() {
  'use strict'

  const PROTECTED_REVEAL = '.composer, .coding-cli-composer, .terminal-drawer, .terminal-surface, .xterm'

  function shouldSuppressEdgeReveal(elements) {
    return Array.from(elements || []).some((element) =>
      element && typeof element.closest === 'function' && element.closest(PROTECTED_REVEAL))
  }

  function installAutoHidePanels(root) {
    const document = root.document
    if (!document || document.documentElement.dataset.aioAutoHidePanels === 'true') return
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', () => installAutoHidePanels(root), { once: true })
      return
    }
    document.documentElement.dataset.aioAutoHidePanels = 'true'
    let app
    let sidebar
    let inspector
    let leftVisible = true
    let rightVisible = false
    let leftInside = false
    let rightInside = false
    let pointerX = -1
    let pointerY = -1
    let leftKeyboardInside = false
    let rightKeyboardInside = false
    let keyboardNavigation = false
    let pointerInOrdinaryAio = false
    let interactionGeneration = 0
    let pendingFocusRestore
    let introElapsed = false
    let introTimer
    const wired = new WeakSet()
    const wiredToggles = new WeakSet()
    const mountRequested = new Set()
    let sidebarWasMounted = false
    let inspectorWasMounted = false
    let pagePinned = false
    let previewReady = false

    const createLeftToggle = () => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'icon-button icon-button--regular aio-panel-toggle-left'
      button.setAttribute('aria-label', '显示左侧栏')
      button.title = '显示左侧栏'
      button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>'
      return button
    }
    const leftToggle = createLeftToggle()
    let rightToggle
    let internalToggleClick = false
    const previewEdge = document.createElement('button')
    previewEdge.type = 'button'
    previewEdge.className = 'aio-file-preview-edge'
    previewEdge.textContent = '文件预览'
    previewEdge.setAttribute('aria-label', '显示文件预览')
    previewEdge.title = '文件预览'
    const requestFilePreview = () => root.dispatchEvent(new root.CustomEvent('aio:file-preview-request'))
    previewEdge.addEventListener('pointerenter', requestFilePreview)
    previewEdge.addEventListener('focus', requestFilePreview)
    previewEdge.addEventListener('click', requestFilePreview)

    const setPanel = (panel, visible) => {
      if (!panel) return
      panel.classList.toggle('aio-panel-hidden', !visible)
      if (panel.inert !== !visible) panel.inert = !visible
      if (panel.getAttribute('aria-hidden') !== String(!visible)) panel.setAttribute('aria-hidden', String(!visible))
      const toggle = panel === sidebar ? leftToggle : panel === inspector ? rightToggle : undefined
      if (toggle) {
        toggle.setAttribute('aria-expanded', String(visible))
        toggle.classList.toggle('is-active', visible)
      }
    }

    const pointInside = (panel) => {
      if (!panel || panel.classList.contains('aio-panel-hidden')) return false
      const rect = panel.getBoundingClientRect()
      return pointerX >= rect.left && pointerX <= rect.right
        && pointerY >= rect.top && pointerY <= rect.bottom
    }

    const toolbarToggle = (side) => {
      if (!app) return
      if (side === 'left') return app.querySelector('.title-toolbar__nav button:not(.aio-panel-toggle-left, .aio-file-preview-edge)')
      const actions = app.querySelectorAll('.title-toolbar__actions button')
      return actions.length > 1 ? actions[1] : undefined
    }

    const requestPanel = (side) => {
      if ((side === 'left' ? sidebar : inspector)) return
      if (mountRequested.has(side)) return
      const toggle = toolbarToggle(side)
      if (!toggle) return
      mountRequested.add(side)
      const focused = document.activeElement
      const generation = interactionGeneration
      pendingFocusRestore = { focused, generation, expires: Date.now() + 500 }
      internalToggleClick = true
      try { toggle.click() } finally { internalToggleClick = false }
      if (document.activeElement === toggle) {
        if (focused && focused !== document.body && typeof focused.focus === 'function') focused.focus({ preventScroll: true })
        else toggle.blur()
      }
      const restoreFocus = () => {
        if (generation !== interactionGeneration) return
        if (focused && focused !== document.body && focused.isConnected && typeof focused.focus === 'function') {
          if (document.hasFocus?.() === false) return
          focused.focus({ preventScroll: true })
        } else if (document.activeElement?.closest?.('.title-toolbar, .inspector')) {
          document.activeElement.blur?.()
        }
      }
      for (const delay of [0, 50, 200]) root.setTimeout(restoreFocus, delay)
      root.setTimeout(() => {
        if (pendingFocusRestore?.generation === generation) pendingFocusRestore = undefined
      }, 500)
      root.setTimeout(() => mountRequested.delete(side), 500)
    }

    const show = (side) => {
      const mounted = side === 'left' ? sidebar : inspector
      if (!mounted) requestPanel(side)
      const alreadyVisible = side === 'left' ? leftVisible : rightVisible
      const focused = document.activeElement
      const generation = interactionGeneration
      if (side === 'left') leftVisible = true
      else rightVisible = true
      if (alreadyVisible && mounted) return
      refresh()
      if (mounted) {
        root.setTimeout(() => {
          if (generation !== interactionGeneration) return
          const panel = side === 'left' ? sidebar : inspector
          if (!panel?.contains(document.activeElement) || document.activeElement === focused) return
          if (focused && focused !== document.body && focused.isConnected && typeof focused.focus === 'function') {
            if (document.hasFocus?.() !== false) focused.focus({ preventScroll: true })
          } else {
            document.activeElement.blur?.()
          }
        }, 0)
      }
    }

    const hide = (side) => {
      if (side === 'left') {
        if (pagePinned || !introElapsed || leftInside || pointInside(sidebar) || leftKeyboardInside) return
        leftVisible = false
      } else {
        if (rightInside || pointInside(inspector) || rightKeyboardInside) return
        rightVisible = false
      }
      refresh()
    }

    const wirePanel = (panel, side) => {
      if (!panel || wired.has(panel)) return
      wired.add(panel)
      panel.addEventListener('pointerenter', () => {
        if (side === 'left') leftInside = true
        else rightInside = true
        show(side)
      })
      panel.addEventListener('pointerleave', (event) => {
        if (event.relatedTarget === (side === 'left' ? leftToggle : rightToggle)) return
        if (side === 'left') leftInside = false
        else rightInside = false
        root.setTimeout(() => hide(side), 0)
      })
      panel.addEventListener('focusin', () => {
        show(side)
      })
      panel.addEventListener('focusout', (event) => {
        if (panel.contains(event.relatedTarget)) return
        if (side === 'left') leftKeyboardInside = false
        else rightKeyboardInside = false
        root.setTimeout(() => hide(side), 0)
      })
    }

    const wireToggle = (button, side) => {
      if (!button || wiredToggles.has(button)) return
      wiredToggles.add(button)
      button.addEventListener('pointerenter', () => {
        if (side !== 'right' || button === rightToggle) show(side)
      })
      button.addEventListener('focus', () => {
        if (side === 'right' && button !== rightToggle) return
        if (keyboardNavigation) {
          if (side === 'left') leftKeyboardInside = true
          else rightKeyboardInside = true
        }
        show(side)
      })
      button.addEventListener('click', (event) => {
        if (side === 'right' && button !== rightToggle) return
        if (internalToggleClick) return
        event.preventDefault()
        event.stopImmediatePropagation()
        show(side)
      }, true)
      button.addEventListener('pointerleave', () => {
        const generation = interactionGeneration
        root.setTimeout(() => {
          if (!button.isConnected) return
          if (side === 'right' && button !== rightToggle) return
          const panel = side === 'left' ? sidebar : inspector
          if (generation !== interactionGeneration || button.matches(':hover') || panel?.matches(':hover')) return
          hide(side)
        }, 320)
      })
      button.addEventListener('blur', (event) => {
        const panel = side === 'left' ? sidebar : inspector
        if (panel?.contains(event.relatedTarget)) return
        if (side === 'left') leftKeyboardInside = false
        else rightKeyboardInside = false
        root.setTimeout(() => hide(side), 0)
      })
    }

    const ensureToolbarToggles = () => {
      const nav = app?.querySelector('.title-toolbar__nav')
      if (nav && (nav.firstElementChild !== previewEdge || previewEdge.nextElementSibling !== leftToggle)) {
        nav.prepend(previewEdge, leftToggle)
      }
      wireToggle(leftToggle, 'left')
      const actions = app?.querySelectorAll('.title-toolbar__actions button')
      const candidate = actions && actions.length > 1 ? actions[1] : undefined
      const inspectorIcon = candidate?.querySelector('path[d*="15 3v18"]')
      const sessionView = !app?.querySelector('.workbench-page')
      if (candidate && sessionView && inspectorIcon && !candidate.classList.contains('aio-close-subpage')) {
        if (rightToggle && rightToggle !== candidate) rightToggle.classList.remove('aio-panel-toggle-right')
        rightToggle = candidate
        rightToggle.classList.add('aio-panel-toggle-right')
        wireToggle(rightToggle, 'right')
      } else if (rightToggle) {
        rightToggle.classList.remove('aio-panel-toggle-right')
        rightToggle = undefined
      }
    }

    function refresh() {
      app = document.querySelector('.app-shell')
      if (!app) return
      app.classList.add('aio-auto-hide-panels')
      ensureToolbarToggles()
      if (!previewReady) {
        previewReady = true
        root.dispatchEvent(new root.CustomEvent('aio:file-preview-ready'))
      }
      const workbench = app.querySelector(':scope > .workbench')
      if (workbench?.hasAttribute('inert')) workbench.removeAttribute('inert')
      const nextSidebar = app.querySelector(':scope > .auto-hide-panel--sidebar, :scope > .sidebar')
      const nextInspector = app.querySelector('.auto-hide-panel--inspector, .inspector')
      const nextPagePinned = Boolean(app.querySelector('.workbench-page'))
      if (nextPagePinned) leftVisible = true
      else if (pagePinned) {
        if (introElapsed && !leftInside && !leftKeyboardInside) leftVisible = false
      }
      pagePinned = nextPagePinned
      if (sidebarWasMounted && !nextSidebar && introElapsed) leftVisible = false
      if (inspectorWasMounted && !nextInspector) rightVisible = false
      sidebar = nextSidebar
      inspector = nextInspector
      if (sidebar) {
        sidebarWasMounted = true
        mountRequested.delete('left')
      }
      if (inspector) {
        inspectorWasMounted = true
        mountRequested.delete('right')
      }
      if (!sidebar && leftVisible) requestPanel('left')
      wirePanel(sidebar, 'left')
      wirePanel(inspector, 'right')
      setPanel(sidebar, leftVisible)
      setPanel(inspector, rightVisible)
      if (sidebar && !introTimer) {
        introTimer = root.setTimeout(() => {
          introElapsed = true
          if (!leftInside && !sidebar?.matches(':hover') && !leftKeyboardInside) {
            leftVisible = false
            refresh()
          }
        }, 4000)
      }
    }

    root.addEventListener('pointermove', (event) => {
      pointerX = event.clientX
      pointerY = event.clientY
      const ordinaryAio = !event.target?.closest?.('.aio-file-preview-edge')
      if (ordinaryAio !== pointerInOrdinaryAio) {
        pointerInOrdinaryAio = ordinaryAio
        if (ordinaryAio) root.dispatchEvent(new root.CustomEvent('aio:file-preview-aio-enter'))
      }
      leftInside = pointInside(sidebar)
      rightInside = pointInside(inspector)
      const protectedTarget = event.target?.closest?.(PROTECTED_REVEAL)
        || shouldSuppressEdgeReveal(document.elementsFromPoint?.(event.clientX, event.clientY))
      if (protectedTarget) {
        let changed = false
        if (introElapsed && leftVisible && !leftInside) { leftVisible = false; changed = true }
        if (rightVisible && !rightInside) { rightVisible = false; changed = true }
        if (changed) refresh()
        return
      }
      if (leftVisible || rightVisible) {
        root.setTimeout(() => {
          leftInside = pointInside(sidebar)
          rightInside = pointInside(inspector)
          if (leftVisible && !leftInside && !leftToggle.matches(':hover')) hide('left')
          if (rightVisible && !rightInside && !rightToggle?.matches(':hover')) hide('right')
        }, 320)
      }
    }, true)
    root.addEventListener('dragover', (event) => {
      if (event.clientX <= 7) show('left')
    }, true)
    const leaveWorkbench = () => {
      pointerInOrdinaryAio = false
      leftInside = false
      rightInside = false
      if (introElapsed) leftVisible = false
      rightVisible = false
      refresh()
    }
    root.addEventListener('blur', leaveWorkbench)
    document.addEventListener('mouseleave', leaveWorkbench)
    root.addEventListener('pointerout', (event) => {
      if (!event.relatedTarget) leaveWorkbench()
    }, true)
    root.addEventListener('pointerdown', (event) => {
      keyboardNavigation = false
      interactionGeneration++
    }, true)
    root.addEventListener('keydown', (event) => {
      keyboardNavigation = event.key === 'Tab'
      interactionGeneration++
    }, true)
    root.addEventListener('focusin', (event) => {
      const pending = pendingFocusRestore
      if (!pending || pending.generation !== interactionGeneration || pending.expires < Date.now()) return
      if (!event.target?.closest?.('.title-toolbar, .inspector')) return
      if (pending.focused && pending.focused !== document.body && pending.focused.isConnected
        && typeof pending.focused.focus === 'function') {
        pending.focused.focus({ preventScroll: true })
      } else {
        event.target.blur?.()
      }
    }, true)

    const observer = new root.MutationObserver((records) => {
      const relevant = records.some((record) => record.type === 'attributes'
        || [...record.addedNodes, ...record.removedNodes].some((node) => node.nodeType === 1
          && (node.matches?.('.app-shell, .sidebar, .inspector, .workbench, .title-toolbar')
            || node.matches?.('.workbench-page')
            || node.querySelector?.('.app-shell, .sidebar, .inspector, .workbench, .workbench-page, .title-toolbar'))))
      if (relevant) refresh()
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['inert'] })
    refresh()
    return () => {
      observer.disconnect()
      if (introTimer) root.clearTimeout(introTimer)
      leftToggle.remove()
      rightToggle?.classList.remove('aio-panel-toggle-right')
      previewEdge.remove()
      sidebar?.classList.remove('aio-panel-hidden')
      inspector?.classList.remove('aio-panel-hidden')
      app?.classList.remove('aio-auto-hide-panels')
      delete document.documentElement.dataset.aioAutoHidePanels
    }
  }

  return { installAutoHidePanels, shouldSuppressEdgeReveal }
})
