(function (root, factory) {
  const api = factory(root)
  if (typeof module === 'object' && module.exports) module.exports = api
  else api.installHistoryView()
})(typeof globalThis === 'object' ? globalThis : this, function createHistoryViewApi(root) {
  'use strict'

  const HISTORY_COPY = {
    en: { empty: 'No history sessions', loading: 'Loading…' },
    'zh-CN': { empty: '没有历史会话', loading: '正在加载…' },
  }
  const historyCopy = language => HISTORY_COPY[String(language).toLowerCase().startsWith('zh') ? 'zh-CN' : 'en']

  function installHistoryView() {
    const window = root.window || root
    const document = window.document
    if (!document) return
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
    let clicked = false
    const showRows = rows => {
      results.replaceChildren()
      if (!rows.length) {
        results.dataset.aioHistoryState = 'empty'
        results.textContent = historyCopy(document.documentElement.lang).empty
      } else delete results.dataset.aioHistoryState
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
    }
    const load = button(label, async () => {
      clicked = true
      load.disabled = true
      results.dataset.aioHistoryState = 'loading'
      results.textContent = historyCopy(document.documentElement.lang).loading
      try {
        showRows(await invoke('aio-history:list', [project, provider]))
      } catch (error) {
        delete results.dataset.aioHistoryState
        results.textContent = error.message
      } finally { load.disabled = false }
    })
    section.append(load, results)
    void invoke('aio-history:cached', [project, provider]).then(rows => {
      if (!clicked && rows.length) showRows(rows)
    }).catch(() => {})
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

  const start = () => {
    const root = document.getElementById('root')
    if (!root) return
    new MutationObserver(records => {
      if (records.some(record => Array.from(record.addedNodes).some(node =>
        node.nodeType === 1 && (node.matches('.sidebar, .project-group') || node.querySelector('.sidebar, .project-group'))))) mount()
    }).observe(root, { childList: true, subtree: true })
    new window.MutationObserver(() => {
      const copy = historyCopy(document.documentElement.lang)
      for (const results of document.querySelectorAll('.aio-history-results[data-aio-history-state]')) {
        results.textContent = copy[results.dataset.aioHistoryState]
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    mount()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
  }

  return { historyCopy, installHistoryView }
})
