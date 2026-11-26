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
    let leftKeyboardInside = false
    let rightKeyboardInside = false
    let keyboardNavigation = false
    let interactionGeneration = 0
    let pendingFocusRestore
    let introElapsed = false
    let introTimer
    const wired = new WeakSet()
    const mountRequested = new Set()
    let sidebarWasMounted = false
    let inspectorWasMounted = false

    const edge = (side) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'aio-panel-edge aio-panel-edge--' + side
      button.setAttribute('aria-label', side === 'left' ? '显示左侧栏' : '显示右侧栏')
      button.dataset.aioPanelEdge = side
      return button
    }
    const leftEdge = edge('left')
    const rightEdge = edge('right')

    const setPanel = (panel, visible) => {
      if (!panel) return
      panel.classList.toggle('aio-panel-hidden', !visible)
      if (panel.inert !== !visible) panel.inert = !visible
      if (panel.getAttribute('aria-hidden') !== String(!visible)) panel.setAttribute('aria-hidden', String(!visible))
    }

    const toolbarToggle = (side) => {
      if (!app) return
      if (side === 'left') return app.querySelector('.title-toolbar__nav button')
      const actions = app.querySelectorAll('.title-toolbar__actions button')
      return actions.length > 1 ? actions[actions.length - 1] : undefined
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
      toggle.click()
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
      if (side === 'left') leftVisible = true
      else rightVisible = true
      if (alreadyVisible && mounted) return
      refresh()
    }

    const hide = (side) => {
      if (side === 'left') {
        if (!introElapsed || leftInside || leftKeyboardInside) return
        leftVisible = false
      } else {
        if (rightInside || rightKeyboardInside) return
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
        if (event.relatedTarget === (side === 'left' ? leftEdge : rightEdge)) return
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

    function refresh() {
      app = document.querySelector('.app-shell')
      if (!app) return
      app.classList.add('aio-auto-hide-panels')
      if (!leftEdge.isConnected) app.append(leftEdge)
      if (!rightEdge.isConnected) app.append(rightEdge)
      const workbench = app.querySelector(':scope > .workbench')
      if (workbench?.hasAttribute('inert')) workbench.removeAttribute('inert')
      const nextSidebar = app.querySelector(':scope > .sidebar')
      const nextInspector = app.querySelector('.inspector')
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
          if (!leftInside && !leftKeyboardInside) {
            leftVisible = false
            refresh()
          }
        }, 4000)
      }
    }

    for (const [trigger, side] of [[leftEdge, 'left'], [rightEdge, 'right']]) {
      trigger.addEventListener('focus', () => {
        if (keyboardNavigation) {
          if (side === 'left') leftKeyboardInside = true
          else rightKeyboardInside = true
        }
        show(side)
      })
      trigger.addEventListener('blur', (event) => {
        const panel = side === 'left' ? sidebar : inspector
        if (panel?.contains(event.relatedTarget)) return
        if (side === 'left') leftKeyboardInside = false
        else rightKeyboardInside = false
        root.setTimeout(() => hide(side), 0)
      })
    }

    root.addEventListener('pointermove', (event) => {
      const containsPoint = (panel) => {
        if (!panel || panel.classList.contains('aio-panel-hidden')) return false
        const rect = panel.getBoundingClientRect()
        return event.clientX >= rect.left && event.clientX <= rect.right
          && event.clientY >= rect.top && event.clientY <= rect.bottom
      }
      leftInside = containsPoint(sidebar)
      rightInside = containsPoint(inspector)
      const protectedTarget = event.target?.closest?.(PROTECTED_REVEAL)
        || shouldSuppressEdgeReveal(document.elementsFromPoint?.(event.clientX, event.clientY))
      if (protectedTarget) {
        leftEdge.style.pointerEvents = 'none'
        rightEdge.style.pointerEvents = 'none'
        let changed = false
        if (introElapsed && leftVisible && !leftInside) { leftVisible = false; changed = true }
        if (rightVisible && !rightInside) { rightVisible = false; changed = true }
        if (changed) refresh()
        return
      }
      if (event.clientX <= 7) show('left')
      else if (event.clientX >= root.innerWidth - 7) show('right')
      else {
        if (!sidebar?.matches(':hover')) hide('left')
        if (!inspector?.matches(':hover')) hide('right')
      }
    }, true)
    root.addEventListener('dragover', (event) => {
      if (event.clientX <= 7) show('left')
    }, true)
    const leaveWorkbench = () => {
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
    root.addEventListener('pointerdown', () => {
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
            || node.querySelector?.('.app-shell, .sidebar, .inspector, .workbench, .title-toolbar'))))
      if (relevant) refresh()
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['inert'] })
    refresh()
    return () => {
      observer.disconnect()
      if (introTimer) root.clearTimeout(introTimer)
      leftEdge.remove()
      rightEdge.remove()
      sidebar?.classList.remove('aio-panel-hidden')
      inspector?.classList.remove('aio-panel-hidden')
      app?.classList.remove('aio-auto-hide-panels')
      delete document.documentElement.dataset.aioAutoHidePanels
    }
  }

  return { installAutoHidePanels, shouldSuppressEdgeReveal }
})
