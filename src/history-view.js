'use strict'

if (typeof window !== 'undefined') {
  const agents = [['omp', 'OMP'], ['claude', 'Claude Code'], ['codex', 'Codex']]
  const mounted = new WeakSet()
  const invoke = (channel, args) => window.__TAURI__.core.invoke('desktop_request', { channel, args })

  function button(text, action) {
    const element = document.createElement('button')
    element.type = 'button'
    element.textContent = text
    element.addEventListener('click', action)
    return element
  }

  function historySection(project, provider, label) {
    const section = document.createElement('div')
    section.className = 'aio-history-provider'
    section.dataset.provider = provider
    const results = document.createElement('div')
    results.className = 'aio-history-results'
    results.setAttribute('aria-live', 'polite')
    const load = button(label, async () => {
      load.disabled = true
      results.textContent = '正在加载…'
      try {
        const rows = await invoke('aio-history:list', [project, provider])
        results.replaceChildren()
        if (!rows.length) results.textContent = '没有历史会话'
        for (const row of rows) {
          const title = label + ' · ' + row.title
          const item = button(title, async () => {
            item.disabled = true
            try {
              await invoke('aio-history:resume', [project, provider, row.id])
            } catch (error) {
              status.textContent = error.message
            } finally { item.disabled = false }
          })
          const status = document.createElement('span')
          status.setAttribute('role', 'status')
          item.title = Number.isFinite(row.updatedAt) ? title + '\n' + new Date(row.updatedAt).toLocaleString() : title
          results.append(item, status)
        }
        if (rows.length) load.hidden = true
      } catch (error) {
        results.textContent = error.message
      } finally { load.disabled = false }
    })
    section.append(load, results)
    return section
  }

  function mount() {
    for (const group of document.querySelectorAll('.sidebar .project-group')) {
      const project = group.querySelector('button.project-row__main')?.title
      if (!project || mounted.has(group)) continue
      mounted.add(group)
      const list = document.createElement('div')
      list.className = 'aio-history-entries'
      for (const [provider, label] of agents) list.append(historySection(project, provider, label))
      group.append(list)
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const root = document.getElementById('root')
    if (!root) return
    new MutationObserver(records => {
      if (records.some(record => Array.from(record.addedNodes).some(node =>
        node.nodeType === 1 && (node.matches('.sidebar, .project-group') || node.querySelector('.sidebar, .project-group'))))) mount()
    }).observe(root, { childList: true, subtree: true })
    mount()
  }, { once: true })
}
