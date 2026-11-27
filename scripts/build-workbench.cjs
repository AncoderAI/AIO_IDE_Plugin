/*
 * Builds the AIO Tauri workbench as extension-owned, distributable assets.
 * The upstream checkout is treated as read-only. Set AIO_SOURCE to build from
 * a different checkout.
 */
'use strict'

const { spawnSync } = require('node:child_process')
const { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { homedir, tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const extensionRoot = resolve(__dirname, '..')
const sourceRoot = resolve(process.env.AIO_SOURCE || 'D:/Github/Ancoder/AIO')
const spikeRoot = join(sourceRoot, 'research', 'tauri-spike')
const outputRoot = join(extensionRoot, 'workbench')
const uiOutput = join(outputRoot, 'ui')
const serviceOutput = join(outputRoot, 'service')
const licenseOutput = join(outputRoot, 'licenses')
const dependencyRoots = new Set()
const syncedUpstreamCommits = Object.freeze([
  '492adf86872f0bb05723e67a8290690c7baf506c',
  '561bc25d4aeeec8310ab279e52e997b0f3ad1988',
])
const syncedUpstreamFeatures = Object.freeze([
  'windows-claude-discovery',
  'coding-cli-executable-metadata',
  'coding-cli-configured-executable',
  'aio-bot-control',
  'codex-terminal-submission',
])
const botSourceCommit = '561bc25d4aeeec8310ab279e52e997b0f3ad1988'

function requireFile(path, description) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${description} was not found at ${path}`)
  }
  return path
}

function verifySyncedUpstreamFeatures() {
  const checks = [
    [join(spikeRoot, 'coding', 'windows-claude-discovery.ts'), ['export class WindowsClaudeDiscovery', "source: 'winget'", "source: 'npm'"]],
    [join(spikeRoot, 'cli-plugins', 'registry.ts'), ['executableVersion', 'executableIssue', 'executableSource', 'setExecutable']],
    [join(spikeRoot, 'workbench-service.ts'), ['WindowsClaudeDiscovery', "'coding-plugins:set-executable'"]],
  ]
  for (const [filename, anchors] of checks) {
    const source = readFileSync(requireFile(filename, 'Synced AIO source'), 'utf8')
    for (const anchor of anchors) {
      if (!source.includes(anchor)) throw new Error(`AIO source is missing ${anchor} from ${syncedUpstreamCommits[0]}`)
    }
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: extensionRoot,
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`)
}

function copyFile(source, destination) {
  requireFile(source, 'Required source file')
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination)
}

function copyDirectory(source, destination, filter) {
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new Error(`Required source directory was not found at ${source}`)
  }
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, { recursive: true, filter })
}

function trackDependency(path) {
  const normalized = path.replaceAll('\\', '/')
  const marker = '/node_modules/'
  const markerIndex = normalized.lastIndexOf(marker)
  if (markerIndex < 0) return
  const segments = normalized.slice(markerIndex + marker.length).split('/')
  const packageSegments = segments[0].startsWith('@') ? segments.slice(0, 2) : segments.slice(0, 1)
  const packageRoot = normalized.slice(0, markerIndex + marker.length) + packageSegments.join('/')
  if (existsSync(join(packageRoot, 'package.json'))) dependencyRoots.add(packageRoot)
}

async function importUpstreamPackage(name) {
  const upstreamRequire = createRequire(join(sourceRoot, 'package.json'))
  return import(pathToFileURL(upstreamRequire.resolve(name)).href)
}

async function buildUi() {
  const [{ build }, reactModule] = await Promise.all([
    importUpstreamPackage('vite'),
    importUpstreamPackage('@vitejs/plugin-react'),
  ])
  const react = reactModule.default
  await build({
    configFile: false,
    root: sourceRoot,
    base: './',
    plugins: [
      {
        name: 'aio-terminal-input-contrast',
        enforce: 'pre',
        transform(source, id) {
          source = source.replaceAll('\r\n', '\n')
          const normalized = id.replaceAll('\\', '/')
          if (normalized.endsWith('/src/App.tsx')) {
            const keyboard = 'if (!terminalOpen || event.defaultPrevented || event.isComposing || isOverlayOpen()) return'
            const currentKeyboard = 'if (!terminalVisible || event.defaultPrevented || event.isComposing || isOverlayOpen()) return'
            if (!source.includes(keyboard) && !source.includes(currentKeyboard)
              && !source.includes('if (!terminalVisible || !terminalOwnsKeyboard.current')) {
              throw new Error('AIO App terminal keyboard anchor changed')
            }
            let transformed = source
              .replace(keyboard,
                'if (!terminalOpen || !terminalOwnsKeyboard.current || event.defaultPrevented || event.isComposing || isOverlayOpen()) return')
              .replace(currentKeyboard,
                'if (!terminalVisible || !terminalOwnsKeyboard.current || event.defaultPrevented || event.isComposing || isOverlayOpen()) return')
            if (transformed.includes('const autoHidePanels = codingSelectorAvailable')) {
              transformed = transformed
                .replace('const autoHidePanels = codingSelectorAvailable', 'const autoHidePanels = false')
                .replace("const sidebarVisible = autoHidePanels ? sidebarPinned || sidebarVisibility !== 'hidden' : settingsState.sidebarOpen && !layout.sidebarSuppressed",
                  'const sidebarVisible = true')
                .replace("const inspectorVisible = view === 'session' && (autoHidePanels ? inspectorRevealed : settingsState.inspectorOpen && !layout.inspectorSuppressed)",
                  "const inspectorVisible = view === 'session'")
            }
            const legacyPanels = 'const sidebarVisible = settingsState.sidebarOpen && !layout.sidebarSuppressed\n  const inspectorVisible = view === \'session\' && settingsState.inspectorOpen && !layout.inspectorSuppressed'
            if (transformed.includes(legacyPanels)) {
              transformed = transformed.replace(legacyPanels,
                'const sidebarVisible = true\n  const inspectorVisible = view === \'session\'')
            }
            const legacyView = "const [view, setView] = useState<WorkspaceView>('session')"
            if (transformed.includes(legacyView)) {
              transformed = transformed.replace(legacyView, `const [pageHistory, setPageHistory] = useState<Exclude<WorkspaceView, 'session'>[]>([])
  const view: WorkspaceView = pageHistory.at(-1) ?? 'session'
  const setView = useCallback((nextView: WorkspaceView) => {
    setPageHistory((history) => {
      if (nextView === 'session') return history.length ? [] : history
      return history.at(-1) === nextView ? history : [...history, nextView]
    })
  }, [])
  const closePage = useCallback(() => setPageHistory((history) => history.slice(0, -1)), [])`)
              const toolbar = 'onToggleInspector={toggleInspector} onToggleTerminal={toggleTerminal} platform={platform}'
              if (!transformed.includes(toolbar)) throw new Error('AIO App page-close toolbar anchor changed')
              transformed = transformed.replace(toolbar,
                'onToggleInspector={toggleInspector} onToggleTerminal={toggleTerminal} onClosePage={closePage} platform={platform}')
            }
            const sessionBranch = "{view === 'session' ? <main className="
            if (transformed.includes(sessionBranch)) {
              transformed = transformed
                .replace(sessionBranch,
                  "<main hidden={view !== 'session'} inert={view !== 'session' ? true : undefined} className=")
                .replace('</main> : <div className="workbench-page"><Suspense fallback={<LoadingPanel label={view} />}>{page}</Suspense></div>}',
                  '</main>\n          {view !== \'session\' ? <div className="workbench-page"><Suspense fallback={<LoadingPanel label={view} />}>{page}</Suspense></div> : null}')
            }
            const legacyTerminal = 'const terminalOpen = Boolean(activeTerminalGroup && hiddenTerminalProject !== terminalProjectKey)\n  const compactTerminalWorkspace'
            if (transformed.includes(legacyTerminal)) {
              transformed = transformed
                .replace(legacyTerminal,
                  "const terminalOpen = Boolean(activeTerminalGroup && hiddenTerminalProject !== terminalProjectKey)\n  const terminalVisible = terminalOpen && view === 'session'\n  const compactTerminalWorkspace")
                .replace('terminalOpen, terminalCompact:', 'terminalOpen: terminalVisible, terminalCompact:')
                .replace('if (!terminalOpen || !terminalOwnsKeyboard.current', 'if (!terminalVisible || !terminalOwnsKeyboard.current')
                .replace('fallback={terminalOpen ? <TerminalLoadingPanel /> : null}', 'fallback={terminalVisible ? <TerminalLoadingPanel /> : null}')
                .replace('const visible = isCurrent && terminalOpen', 'const visible = isCurrent && terminalVisible')
                .replace('terminalOpen={terminalOpen}', 'terminalOpen={terminalVisible}')
            }
            return transformed
          }
          if (normalized.endsWith('/src/components/TitleToolbar.tsx')) {
            if (source.includes('onClosePage')) {
              return source.replace(
                "<IconButton label={t('layout.closePage')} onClick={onClosePage}>",
                "<IconButton className=\"aio-close-subpage\" label={t('layout.closePage')} onClick={onClosePage}>",
              )
            }
            const terminalImport = '  Terminal,\n}'
            const terminalProp = '  onToggleTerminal(): void\n'
            const signature = 'onToggleSidebar, onToggleInspector, onToggleTerminal, platform'
            const lastAction = '{view !== \'session\' && sidebarOpen ? <IconButton label={t(\'layout.hideSidebar\', { shortcut: sidebarShortcut })} onClick={onToggleSidebar}><PanelLeft size={16} /></IconButton> : null}'
            if (![terminalImport, terminalProp, signature, lastAction].every((anchor) => source.includes(anchor))) {
              throw new Error('AIO TitleToolbar page-close anchors changed')
            }
            return source
              .replace(terminalImport, '  Terminal,\n  X,\n}')
              .replace(terminalProp, terminalProp + '  onClosePage(): void\n')
              .replace(signature, 'onToggleSidebar, onToggleInspector, onToggleTerminal, onClosePage, platform')
              .replace(lastAction, lastAction + "\n        {view !== 'session' ? <IconButton label=\"返回上一界面\" onClick={onClosePage}><X size={17} /></IconButton> : null}")
          }
          if (!normalized.endsWith('/src/components/TerminalDrawer.tsx')) return
          const constructor = 'const terminal = new Terminal({'
          const open = 'terminal.open(container)'
          const dispose = 'terminal.dispose()'
          const delayedFocus = `try { fitRef.current?.fit() } catch { /* tab is transitioning */ }
      terminalRef.current?.focus()
      scheduleActiveContext()`
          const guardedFocus = `try { fitRef.current?.fit() } catch { /* tab is transitioning */ }
      if (document.hasFocus()) window.dispatchEvent(new CustomEvent('aio:terminal-focus-request'))
      scheduleActiveContext()`
          if (!source.includes(constructor) || !source.includes(open) || !source.includes(dispose) || !source.includes(delayedFocus)) {
            throw new Error('AIO TerminalDrawer clipboard anchors changed')
          }
          const registered = `${open}
    const terminalClipboardId = crypto.randomUUID()
    const terminalElement = terminal.element
    if (!terminalElement) throw new Error('AIO terminal element is unavailable')
    terminalElement.setAttribute('data-vscode-context', JSON.stringify({
      webviewSection: 'aioTerminal',
      preventDefaultContextMenuItems: true,
    }))
    window.dispatchEvent(new CustomEvent('aio:terminal-register', {
      detail: {
        id: terminalClipboardId,
        element: terminalElement,
        hasSelection: () => terminal.hasSelection(),
        getSelection: () => terminal.getSelection(),
        isVisible: () => visibleRef.current && !terminalElement.closest('[hidden]'),
        paste: (text: string) => terminal.paste(text),
        focus: () => terminal.focus(),
      },
    }))`
          const unregistered = `window.dispatchEvent(new CustomEvent('aio:terminal-unregister', {
        detail: { id: terminalClipboardId },
      }))
      ${dispose}`
          return source
            .replace(constructor, constructor + '\n      minimumContrastRatio: 4.5,')
            .replace(open, registered)
            .replace(delayedFocus, guardedFocus)
            .replace(dispose, unregistered)
        },
      },
      react(),
      {
        name: 'ancoder-vscode-workbench-html',
        transformIndexHtml: {
          order: 'pre',
          handler(html) {
            return html
              .replace(/<meta http-equiv="Content-Security-Policy"[^>]*\/>\s*/i, '')
              .replace('src="/src/main.tsx"', 'src="/research/tauri-spike/workbench-renderer.ts"')
          },
        },
      },
      {
        name: 'ancoder-vscode-license-inventory',
        generateBundle() {
          for (const id of this.getModuleIds()) trackDependency(id)
        },
      },
    ],
    resolve: {
      alias: {
        '@/pages/ActivityPage': join(spikeRoot, 'coding', 'ActivityPage.tsx'),
        '@': join(sourceRoot, 'src'),
      },
    },
    build: {
      outDir: uiOutput,
      emptyOutDir: true,
      rollupOptions: {
        input: join(sourceRoot, 'index.html'),
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined
            if (id.includes('/@xterm/')) return 'terminal-vendor'
            if (id.includes('/react-markdown/') || id.includes('/remark-') || id.includes('/unified/')) return 'markdown-vendor'
            if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) return 'react-vendor'
            if (id.includes('/lucide-react/')) return 'icons-vendor'
            return undefined
          },
        },
      },
    },
  })
}

function patchGeneratedTerminalClipboard() {
  const chunks = readdirSync(join(uiOutput, 'assets')).filter((name) => /^TerminalDrawer-.*\.js$/.test(name))
  if (chunks.length !== 1) throw new Error('Expected one generated TerminalDrawer chunk')
  const chunk = join(uiOutput, 'assets', chunks[0])
  const source = readFileSync(chunk, 'utf8')
  const open = 'r.open(o),y.current=r,g.current=m;const u=r.textarea;'
  const registeredV1 = 'r.open(o);const AIOClipboardId=crypto.randomUUID(),AIOClipboardElement=r.element;if(!AIOClipboardElement)throw new Error("AIO terminal element is unavailable");AIOClipboardElement.setAttribute("data-vscode-context",JSON.stringify({webviewSection:"aioTerminal",preventDefaultContextMenuItems:!0})),window.dispatchEvent(new CustomEvent("aio:terminal-register",{detail:{id:AIOClipboardId,element:AIOClipboardElement,hasSelection:()=>r.hasSelection(),getSelection:()=>r.getSelection(),paste:t=>r.paste(t),focus:()=>r.focus()}})),y.current=r,g.current=m;const u=r.textarea;'
  const registered = 'r.open(o);const AIOClipboardId=crypto.randomUUID(),AIOClipboardElement=r.element;if(!AIOClipboardElement)throw new Error("AIO terminal element is unavailable");AIOClipboardElement.setAttribute("data-vscode-context",JSON.stringify({webviewSection:"aioTerminal",preventDefaultContextMenuItems:!0})),window.dispatchEvent(new CustomEvent("aio:terminal-register",{detail:{id:AIOClipboardId,element:AIOClipboardElement,hasSelection:()=>r.hasSelection(),getSelection:()=>r.getSelection(),isVisible:()=>E.current&&!AIOClipboardElement.closest("[hidden]"),paste:t=>r.paste(t),focus:()=>r.focus()}})),y.current=r,g.current=m;const u=r.textarea;'
  const dispose = 'r.dispose(),y.current=null,g.current=null'
  const unregister = 'window.dispatchEvent(new CustomEvent("aio:terminal-unregister",{detail:{id:AIOClipboardId}})),'
  const unregistered = unregister + dispose
  const withRegistration = source.includes(open) ? source.replace(open, registered) : source.replace(registeredV1, registered)
  let withCleanup = withRegistration.includes(unregistered) ? withRegistration : withRegistration.replace(dispose, unregistered)
  while (withCleanup.includes(unregister + unregister)) withCleanup = withCleanup.replace(unregister + unregister, unregister)
  const delayedFocus = 'y.current?.focus(),k()'
  const previousGuardedFocus = 'document.hasFocus()&&y.current?.focus(),k()'
  const guardedFocus = 'document.hasFocus()&&window.dispatchEvent(new CustomEvent("aio:terminal-focus-request")),k()'
  const withFocus = withCleanup.includes(guardedFocus)
    ? withCleanup
    : withCleanup.replace(previousGuardedFocus, guardedFocus).replace(delayedFocus, guardedFocus)
  if (!withFocus.includes(registered) || !withFocus.includes(unregistered) || !withFocus.includes(guardedFocus)) {
    throw new Error('Generated TerminalDrawer clipboard anchors changed')
  }
  writeFileSync(chunk, withFocus)

  const mainChunks = readdirSync(join(uiOutput, 'assets')).filter((name) => /^main-.*\.js$/.test(name))
  if (mainChunks.length !== 1) throw new Error('Expected one generated AIO main chunk')
  const mainChunk = join(uiOutput, 'assets', mainChunks[0])
  const mainSource = readFileSync(mainChunk, 'utf8')
  const keyboard = 'Hn=rs(u=>{!Ne||u.defaultPrevented'
  const ownedKeyboard = 'Hn=rs(u=>{!Ne||!Ge.current||u.defaultPrevented'
  const ownedVisibleKeyboard = 'Hn=rs(u=>{!AIOVisibleTerminal||!Ge.current||u.defaultPrevented'
  const routed = mainSource.includes(ownedKeyboard) || mainSource.includes(ownedVisibleKeyboard)
    ? mainSource : mainSource.replace(keyboard, ownedKeyboard)
  const legacyPanels = 'bt=te.sidebarOpen&&!He.sidebarSuppressed,Rt=te.inspectorOpen&&!He.inspectorSuppressed'
  const previousFloatingPanels = 'bt=!0,Rt=te.inspectorOpen'
  const floatingPanels = 'bt=!0,Rt=Y==="session"'
  const panels = routed.includes(floatingPanels) ? routed
    : routed.includes(previousFloatingPanels) ? routed.replace(previousFloatingPanels, floatingPanels)
      : routed.replace(legacyPanels, floatingPanels)
  const legacyView = '[Y,V]=r.useState("session"),[J,ne]'
  const stackedView = '[AIOPageHistory,AIOSetPageHistory]=r.useState([]),Y=AIOPageHistory.at(-1)??"session",V=r.useCallback(u=>{AIOSetPageHistory(T=>u==="session"?T.length?[]:T:T.at(-1)===u?T:[...T,u])},[]),AIOClosePage=r.useCallback(()=>AIOSetPageHistory(u=>u.slice(0,-1)),[]),[J,ne]'
  let pages = panels.includes(stackedView) ? panels : panels.replace(legacyView, stackedView)
  if (!pages.includes(stackedView)) {
    const historyStart = pages.indexOf('[AIOPageHistory,AIOSetPageHistory]')
    const historyEnd = pages.indexOf(',[J,ne]', historyStart)
    if (historyStart >= 0 && historyEnd > historyStart) {
      pages = pages.slice(0, historyStart) + stackedView + pages.slice(historyEnd + ',[J,ne]'.length)
    }
  }
  const conditionalSession = 'Y==="session"?n.jsx("main",{className:'
  const persistentSession = 'n.jsx("main",{hidden:Y!=="session",inert:Y!=="session"?!0:void 0,className:'
  pages = pages.includes(persistentSession) ? pages : pages.replace(conditionalSession, persistentSession)
  const conditionalPage = '})}):n.jsx("div",{className:"workbench-page",children:n.jsx(r.Suspense,{fallback:n.jsx(xn,{label:Y}),children:La})})'
  const siblingPage = '})}),Y!=="session"?n.jsx("div",{className:"workbench-page",children:n.jsx(r.Suspense,{fallback:n.jsx(xn,{label:Y}),children:La})}):null'
  pages = pages.includes(siblingPage) ? pages : pages.replace(conditionalPage, siblingPage)
  const legacyToolbar = 'function Zo({project:e,view:t,productName:s="Prime Work",sidebarOpen:a,inspectorOpen:i,terminalOpen:d,onToggleSidebar:l,onToggleInspector:p,onToggleTerminal:c,platform:k="darwin"})'
  const closeToolbar = 'function Zo({project:e,view:t,productName:s="Prime Work",sidebarOpen:a,inspectorOpen:i,terminalOpen:d,onToggleSidebar:l,onToggleInspector:p,onToggleTerminal:c,onClosePage:AIOClosePageProp,platform:k="darwin"})'
  pages = pages.includes(closeToolbar) ? pages : pages.replace(legacyToolbar, closeToolbar)
  const legacyToolbarActions = 't!=="session"&&a?n.jsx(et,{label:j("layout.hideSidebar",{shortcut:y}),onClick:l,children:n.jsx(qs,{size:16})}):null]})]})'
  const closeToolbarActions = 't!=="session"&&a?n.jsx(et,{label:j("layout.hideSidebar",{shortcut:y}),onClick:l,children:n.jsx(qs,{size:16})}):null,t!=="session"?n.jsx("button",{type:"button",className:"icon-button icon-button--regular aio-close-subpage","aria-label":"返回上一界面",title:"返回上一界面",onClick:AIOClosePageProp,children:"×"}):null]})]})'
  pages = pages.includes(closeToolbarActions) ? pages : pages.replace(legacyToolbarActions, closeToolbarActions)
  const legacyToolbarCall = 'onToggleSidebar:Ct,onToggleInspector:On,onToggleTerminal:pn,platform:pt'
  const closeToolbarCall = 'onToggleSidebar:Ct,onToggleInspector:On,onToggleTerminal:pn,onClosePage:AIOClosePage,platform:pt'
  pages = pages.includes(closeToolbarCall) ? pages : pages.replace(legacyToolbarCall, closeToolbarCall)
  const legacyTerminal = 'Ne=!!(At&&tn!==Oe),Tt=Ne&&!x.loadingSession'
  const sessionTerminal = 'Ne=!!(At&&tn!==Oe),AIOVisibleTerminal=Ne&&Y==="session",Tt=Ne&&!x.loadingSession'
  pages = pages.includes(sessionTerminal) ? pages : pages.replace(legacyTerminal, sessionTerminal)
  pages = pages
    .replace('terminalOpen:Ne,terminalCompact:Tt', 'terminalOpen:AIOVisibleTerminal,terminalCompact:Tt')
    .replace('Hn=rs(u=>{!Ne||!Ge.current||u.defaultPrevented', 'Hn=rs(u=>{!AIOVisibleTerminal||!Ge.current||u.defaultPrevented')
    .replace('onPointerDownCapture:u=>{Ge.current=Ne&&', 'onPointerDownCapture:u=>{Ge.current=AIOVisibleTerminal&&')
    .replace('onFocusCapture:u=>{!Ne||', 'onFocusCapture:u=>{!AIOVisibleTerminal||')
    .replace('fallback:Ne?n.jsx(uu,{})', 'fallback:AIOVisibleTerminal?n.jsx(uu,{})')
    .replace('be=W&&Ne;return n.jsx(Vc', 'be=W&&AIOVisibleTerminal;return n.jsx(Vc')
    .replace('terminalOpen:Ne,onToggleSidebar:Ct', 'terminalOpen:AIOVisibleTerminal,onToggleSidebar:Ct')
  if (!pages.includes(ownedVisibleKeyboard) || !pages.includes(floatingPanels)
    || !pages.includes(stackedView) || !pages.includes(closeToolbar)
    || !pages.includes(closeToolbarActions) || !pages.includes(closeToolbarCall)
    || !pages.includes(sessionTerminal) || !pages.includes('be=W&&AIOVisibleTerminal')
    || !pages.includes(persistentSession) || !pages.includes(siblingPage)) {
    throw new Error('Generated AIO keyboard or panel routing anchor changed')
  }
  writeFileSync(mainChunk, pages)
}

async function buildService() {
  const upstreamRequire = createRequire(join(sourceRoot, 'package.json'))
  const esbuild = upstreamRequire('esbuild')
  const primeEntry = requireFile(
    join(sourceRoot, 'node_modules', 'prime-agent-ai', 'dist', 'index.js'),
    'prime-agent-ai entry point',
  )
  const exactRoot = mkdtempSync(join(tmpdir(), 'aio-bot-source-'))
  const archive = join(exactRoot, 'source.tar')
  run('git', ['-C', sourceRoot, 'archive', '--format=tar', `--output=${archive}`, botSourceCommit])
  run('tar', ['-xf', archive, '-C', exactRoot])
  const exactSpike = join(exactRoot, 'research', 'tauri-spike')
  const botSkill = readFileSync(requireFile(join(exactRoot, 'assets', 'omp-skills', 'skills', 'aio-bot', 'SKILL.md'), 'AIO Bot skill'), 'utf8')
    .replace(/^---[\s\S]*?---\s*/, '')
  try {
  const result = await esbuild.build({
    entryPoints: {
      'workbench-service': requireFile(join(exactSpike, 'workbench-service.ts'), 'Tauri Bot workbench service'),
      'omp-metadata-worker': requireFile(join(exactSpike, 'omp-metadata-worker.ts'), 'OMP metadata worker'),
      'aio-bot-cli': requireFile(join(exactSpike, 'bot-cli.ts'), 'AIO Bot controller CLI'),
    },
    outdir: serviceOutput,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    external: ['node-pty'],
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    nodePaths: [join(sourceRoot, 'node_modules')],
    define: { AIO_BOT_SKILL_TEXT: JSON.stringify(botSkill) },
    plugins: [{
      name: 'aio-bot-worker-codex-paste-mode',
      setup(build) {
        build.onLoad({ filter: /research[\\/]tauri-spike[\\/]workbench-service\.ts$/ }, (args) => {
          let source = readFileSync(args.path, 'utf8')
          const contextAnchor = 'async function createContext(appDataPath: string, resourceRoot: string, smoke: boolean, liveCli: boolean): Promise<ServiceContext> {'
          const sharedPluginStorage = String.raw`async function migrateSharedCodingPluginStorage(appDataPath: string): Promise<string> {
  const configured = process.env.AIO_PLUGIN_STORAGE
  if (configured && !isAbsolute(configured)) throw new TypeError('AIO_PLUGIN_STORAGE must be an absolute path')
  const targetRoot = configured ? resolve(configured) : appDataPath
  const target = resolve(targetRoot, 'coding-cli-plugins.json')
  if (!configured) return target

  const fs = await import('node:fs/promises')
  const paths = await import('node:path')
  await fs.mkdir(targetRoot, { recursive: true })
  const lock = target + '.lock'
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { flag: 'wx', mode: 0o600 })
      break
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 1600) throw error
      const info = await fs.stat(lock).catch(() => undefined)
      let deadOwner = false
      let ownerKnown = false
      try {
        const owner = JSON.parse(await fs.readFile(lock, 'utf8'))
        if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
          ownerKnown = true
          try { process.kill(owner.pid, 0) } catch (probe) { deadOwner = (probe as NodeJS.ErrnoException).code === 'ESRCH' }
        }
      } catch { /* legacy directory lock or incomplete owner data */ }
      if (info && (deadOwner || (!ownerKnown && Date.now() - info.mtimeMs > 30_000))) {
        await fs.unlink(lock).catch(() => fs.rmdir(lock).catch(() => undefined))
      }
      await new Promise((done) => setTimeout(done, 25))
    }
  }
  try {
    if ((await fs.stat(target).catch(() => undefined))?.isFile()) return target
    const userRoot = paths.dirname(paths.dirname(paths.dirname(targetRoot)))
    const workspaceStorage = paths.resolve(userRoot, 'workspaceStorage')
    const roots = new Set<string>([appDataPath, paths.resolve(paths.dirname(targetRoot), 'workbench')])
    for (const entry of await fs.readdir(workspaceStorage, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) roots.add(paths.resolve(workspaceStorage, entry.name, 'ancoder.aio-ide', 'workbench'))
    }
    type Candidate = { mtimeMs: number; state: { installed: boolean; enabled: boolean; executablePath?: string }; manifest?: string }
    const selected = new Map<string, Candidate>()
    for (const root of roots) {
      const statePath = paths.resolve(root, 'coding-cli-plugins.json')
      try {
        const info = await fs.stat(statePath)
        if (!info.isFile() || info.size > 64 * 1024) continue
        const state = JSON.parse(await fs.readFile(statePath, 'utf8'))
        if (state?.version !== 1 || !state.plugins || typeof state.plugins !== 'object') continue
        for (const id of ['omp', 'claude', 'codex']) {
          const row = state.plugins[id]
          if (!row || typeof row.installed !== 'boolean' || typeof row.enabled !== 'boolean') continue
          const current = selected.get(id)
          if (current && current.mtimeMs > info.mtimeMs) continue
          let manifest: string | undefined
          if (row.installed) {
            const filename = paths.resolve(root, 'coding-cli-plugins', id, 'manifest.json')
            const manifestInfo = await fs.stat(filename).catch(() => undefined)
            if (!manifestInfo?.isFile() || manifestInfo.size > 64 * 1024) continue
            manifest = await fs.readFile(filename, 'utf8')
            const parsed = JSON.parse(manifest)
            if (parsed?.id !== id || parsed?.adapter !== id || parsed?.kind !== 'coding-cli') continue
          }
          selected.set(id, {
            mtimeMs: info.mtimeMs,
            state: {
              installed: row.installed,
              enabled: row.installed && row.enabled,
              ...(typeof row.executablePath === 'string' && row.executablePath.length <= 4096 ? { executablePath: row.executablePath } : {}),
            },
            manifest,
          })
        }
      } catch { /* malformed and inaccessible legacy profiles are ignored */ }
    }
    if (!selected.size) return target
    const plugins = Object.fromEntries([...selected].map(([id, candidate]) => [id, candidate.state]))
    for (const [id, candidate] of selected) {
      if (!candidate.manifest) continue
      const directory = paths.resolve(targetRoot, 'coding-cli-plugins', id)
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      await fs.writeFile(paths.resolve(directory, 'manifest.json'), candidate.manifest, { mode: 0o600 })
    }
    const temporary = target + '.' + randomUUID() + '.tmp'
    await fs.writeFile(temporary, JSON.stringify({ version: 1, plugins }), { flag: 'wx', mode: 0o600, flush: true })
    await fs.rename(temporary, target)
    return target
  } finally {
    await fs.unlink(lock).catch(() => fs.rmdir(lock).catch(() => undefined))
  }
}

`
          if (!source.includes(contextAnchor)) throw new Error('AIO shared coding plugin context anchor changed')
          source = source.replace(contextAnchor, sharedPluginStorage + contextAnchor)

          const registryAnchor = /  const codingPlugins = new CodingCliPluginRegistry\(\r?\n    resolve\(appDataPath, 'coding-cli-plugins\.json'\),/
          const sharedRegistry = "  const codingPluginStatePath = await migrateSharedCodingPluginStorage(appDataPath)\n  const codingPlugins = new CodingCliPluginRegistry(\n    codingPluginStatePath,"
          if (!registryAnchor.test(source)) throw new Error('AIO shared coding plugin registry anchor changed')
          source = source.replace(registryAnchor, sharedRegistry)
          const codexState = "codex: { ready: ['Ask Codex to do anything', 'esc to edit previous message'], busy: ['esc to interrupt'] }"
          const currentCodexState = "codex: { ready: ['Ask Codex', 'Worked for ', 'esc to edit previous message'], busy: ['Working(', 'esc to interrupt'] }"
          if (!source.includes(codexState)) throw new Error('AIO Bot Codex editor state anchor changed')
          source = source.replace(codexState, currentCodexState)
          const worker = 'launch.env = environment as Record<string, string>'
          const configured = `// Bot-driven Codex tasks use explicit submission channels rather than
        // Codex's paste-burst heuristic. Warm multiline tasks use the external editor.
        if (agent === 'codex' && launch.args[0] === '-c' && launch.args[1] === 'disable_paste_burst=true') launch.args.splice(0, 2)
        launch.env = { ...launch.env, ...environment as Record<string, string> }`
          if (!source.includes(worker)) throw new Error('AIO Bot worker launch anchor changed')
          source = source.replace(worker, configured)

          const resolver = 'async function resolveTerminalAgent(context: ServiceContext, agent: unknown, fresh: unknown, entry?: SavedTerminalRestore, restoring = false): Promise<TerminalProgram> {'
          const editorSupport = `function quoteCodexEditorArgument(value: string): string {
  return '"' + value.replaceAll('"', '\\\"') + '"'
}

function splitWindowsEditorCommand(value: string): string[] {
  const result: string[] = []
  let current = ''
  let quoted = false
  let started = false
  for (let index = 0; index < value.length;) {
    const character = value[index]
    if (/\\s/.test(character) && !quoted) {
      if (started) { result.push(current); current = ''; started = false }
      index += 1
      continue
    }
    if (character !== '\\\\' && character !== '"') {
      current += character
      started = true
      index += 1
      continue
    }
    if (character === '"') {
      quoted = !quoted
      started = true
      index += 1
      continue
    }
    let slashes = 0
    while (value[index + slashes] === '\\\\') slashes += 1
    if (value[index + slashes] === '"') {
      current += '\\\\'.repeat(Math.floor(slashes / 2))
      if (slashes % 2) current += '"'
      else quoted = !quoted
      started = true
      index += slashes + 1
    } else {
      current += '\\\\'.repeat(slashes)
      started = true
      index += slashes
    }
  }
  if (quoted) throw new Error('Configured Codex editor command has an unmatched quote')
  if (started) result.push(current)
  return result
}

async function configureCodexEditor(context: ServiceContext, program: TerminalProgram): Promise<TerminalProgram> {
  if (program.agent !== 'codex' || process.platform !== 'win32' || (context.smoke && !context.liveCli)) return program
  const spool = resolve(context.terminalRestoreRoot, 'codex-editor', randomUUID())
  await mkdir(spool, { recursive: true })
  const helper = resolve(__dirname, 'aio-codex-editor.cjs')
  const editor = quoteCodexEditorArgument(process.execPath) + ' ' + quoteCodexEditorArgument(helper)
  const fallback = process.env.VISUAL ?? process.env.EDITOR
  const fallbackArgv = fallback ? splitWindowsEditorCommand(fallback) : []
  program.env = {
    ...program.env,
    AIO_CODEX_EDITOR_SPOOL: spool,
    ...(fallbackArgv.length ? { AIO_CODEX_EDITOR_FALLBACK_ARGV: JSON.stringify(fallbackArgv) } : {}),
    VISUAL: editor,
    EDITOR: editor,
  }
  return program
}

${resolver}`
          if (!source.includes(resolver)) throw new Error('AIO Codex terminal resolver anchor changed')
          source = source.replace(resolver, editorSupport)
          const entryReturn = 'return { executable, args: terminalInteractiveArgs(agent, terminalSessionArgs(entry, directory, restoring)), label, agent, bracketedPasteExpected: true, editorReadyTexts: terminalEditorState[agent]?.ready, editorBusyTexts: terminalEditorState[agent]?.busy }'
          const configuredEntryReturn = 'return configureCodexEditor(context, { executable, args: terminalInteractiveArgs(agent, terminalSessionArgs(entry, directory, restoring)), label, agent, bracketedPasteExpected: true, editorReadyTexts: terminalEditorState[agent]?.ready, editorBusyTexts: terminalEditorState[agent]?.busy })'
          if (!source.includes(entryReturn)) throw new Error('AIO Codex restored terminal editor anchor changed')
          source = source.replace(entryReturn, configuredEntryReturn)
          const finalReturn = 'return { executable, args: terminalInteractiveArgs(agent, []), label, agent, bracketedPasteExpected: true, editorReadyTexts: terminalEditorState[agent]?.ready, editorBusyTexts: terminalEditorState[agent]?.busy }'
          const configuredFinalReturn = 'return configureCodexEditor(context, { executable, args: terminalInteractiveArgs(agent, []), label, agent, bracketedPasteExpected: true, editorReadyTexts: terminalEditorState[agent]?.ready, editorBusyTexts: terminalEditorState[agent]?.busy })'
          if (!source.includes(finalReturn)) throw new Error('AIO Codex fresh terminal editor anchor changed')
          source = source.replace(finalReturn, configuredFinalReturn)
          return { contents: source, loader: 'ts' }
        })
        build.onLoad({ filter: /research[\\/]tauri-spike[\\/]cli-plugins[\\/]registry\.ts$/ }, (args) => {
          let source = readFileSync(args.path, 'utf8').replaceAll('\r\n', '\n')
          const serialAnchor = `  private serial<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      if (!this.loaded) await this.load()
      return task()
    })
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }`
          const lockedSerial = `  private async acquireStateLock(): Promise<() => Promise<void>> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 })
    const lock = this.statePath + '.lock'
    for (let attempt = 0; ; attempt += 1) {
      try {
        await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { flag: 'wx', mode: 0o600 })
        return () => unlink(lock).catch(() => rmdir(lock).catch(() => undefined))
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 1600) throw error
        const info = await lstat(lock).catch(() => undefined)
        let deadOwner = false
        let ownerKnown = false
        try {
          const owner = JSON.parse(await readFile(lock, 'utf8'))
          if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
            ownerKnown = true
            try { process.kill(owner.pid, 0) } catch (probe) { deadOwner = (probe as NodeJS.ErrnoException).code === 'ESRCH' }
          }
        } catch { /* legacy directory lock or incomplete owner data */ }
        if (info && (deadOwner || (!ownerKnown && Date.now() - info.mtimeMs > 30_000))) {
          await unlink(lock).catch(() => rmdir(lock).catch(() => undefined))
        }
        await new Promise((done) => setTimeout(done, 25))
      }
    }
  }

  private serial<T>(task: () => Promise<T>, mutate = false): Promise<T> {
    const operation = this.queue.then(async () => {
      if (!mutate) {
        // Atomic writers do not require readers to take the cross-process lock.
        // Reloading here lets every open VS Code window see changes immediately.
        this.state = emptyState()
        this.stateExists = false
        this.loaded = false
        await this.load()
        return task()
      }
      const release = await this.acquireStateLock()
      try {
        // Every process reloads while holding the cross-process lock, so a
        // provider change cannot overwrite a newer update from another window.
        this.state = emptyState()
        this.stateExists = false
        this.loaded = false
        await this.load()
        return await task()
      } finally { await release() }
    })
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }`
          if (!source.includes(serialAnchor)) throw new Error('AIO coding plugin registry serialization anchor changed')
          source = source.replace(serialAnchor, lockedSerial)
          for (const method of ['initialize', 'setExecutable', 'set']) {
            const start = source.indexOf('  async ' + method + '(')
            if (start < 0) throw new Error('AIO coding plugin mutation anchor changed: ' + method)
            const serial = source.indexOf('return this.serial(async () => {', start)
            if (serial < 0) throw new Error('AIO coding plugin serialization call changed: ' + method)
            source = source.slice(0, serial) + source.slice(serial).replace('return this.serial(async () => {', 'return this.serial(async () => {', 1)
            const close = source.indexOf('\n    })', serial)
            if (close < 0) throw new Error('AIO coding plugin mutation close changed: ' + method)
            source = source.slice(0, close) + '\n    }, true)' + source.slice(close + '\n    })'.length)
          }
          return { contents: source, loader: 'ts' }
        })
        build.onLoad({ filter: /electron[\\/]main[\\/]terminal\.ts$/ }, (args) => {
          let source = readFileSync(args.path, 'utf8')
          const submissionField = 'taskSubmission?: Promise<void>'
          const editorFields = `${submissionField}
  codexEditorSpool?: string
  outputGeneration: number
  bracketedPasteDisabledGeneration: number
  bracketedPasteEnabledGeneration: number`
          if (!source.includes(submissionField)) throw new Error('AIO Codex owned terminal field anchor changed')
          source = source.replace(submissionField, editorFields)

          const ownedState = "pendingOutput: '', pendingOutputBytes: 0, bracketedPasteExpected:"
          const editorOwnedState = "pendingOutput: '', pendingOutputBytes: 0, codexEditorSpool: program?.env?.AIO_CODEX_EDITOR_SPOOL, outputGeneration: 0, bracketedPasteDisabledGeneration: 0, bracketedPasteEnabledGeneration: 0, bracketedPasteExpected:"
          if (!source.includes(ownedState)) throw new Error('AIO Codex owned terminal state anchor changed')
          source = source.replace(ownedState, editorOwnedState)

          const outputAnchor = "if (retryMessage) recentOutput = (recentOutput + data).slice(-4096)"
          const countedOutput = `${outputAnchor}
        owned.outputGeneration += 1`
          if (!source.includes(outputAnchor)) throw new Error('AIO Codex output generation anchor changed')
          source = source.replace(outputAnchor, countedOutput)

          const pasteModeAnchor = 'if (enabledAt >= 0 || disabledAt >= 0) owned.bracketedPasteMode = enabledAt > disabledAt'
          const trackedPasteMode = `if (enabledAt >= 0 || disabledAt >= 0) {
          const nextBracketedPasteMode = enabledAt > disabledAt
          if (nextBracketedPasteMode !== owned.bracketedPasteMode) {
            owned.bracketedPasteMode = nextBracketedPasteMode
            if (nextBracketedPasteMode) owned.bracketedPasteEnabledGeneration += 1
            else owned.bracketedPasteDisabledGeneration += 1
          }
        }`
          if (!source.includes(pasteModeAnchor)) throw new Error('AIO Codex bracketed paste transition anchor changed')
          source = source.replace(pasteModeAnchor, trackedPasteMode)

          const finishAnchor = "owned.taskSummary = undefined"
          const cleanupSpool = `${finishAnchor}
      if (owned.codexEditorSpool) void import('node:fs/promises').then(({ rm }) => rm(owned.codexEditorSpool!, { recursive: true, force: true })).catch(() => undefined)`
          if (!source.includes(finishAnchor)) throw new Error('AIO Codex spool cleanup anchor changed')
          source = source.replace(finishAnchor, cleanupSpool)

          const submitStart = source.indexOf('  submitTask(owner: TerminalOwner, idValue: unknown, textValue: unknown): Promise<void> {')
          const submitEnd = source.indexOf('  private async waitForTerminalReady(', submitStart)
          if (submitStart < 0 || submitEnd < 0) throw new Error('AIO Codex terminal submission method anchor changed')
          const editorSubmission = `  submitTask(owner: TerminalOwner, idValue: unknown, textValue: unknown): Promise<void> {
    const terminal = this.owned(owner, idValue)
    const text = requireString(textValue, 'terminal task', { min: 1, max: 64 * 1024 })
    const editorText = text.replace(/\\r\\n?/g, '\\n')
    const normalized = editorText.replaceAll('\\n', '\\r')
    for (const character of editorText) {
      const code = character.charCodeAt(0)
      if ((code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159)) {
        throw new TypeError('terminal task contains control characters')
      }
    }
    const summary = summarizeCodingTask(editorText)
    const deadline = Date.now() + 8_000
    const previous = terminal.taskSubmission ?? Promise.resolve()
    const submission = previous.catch(() => undefined).then(async () => {
      if (terminal.terminating || terminal.exited) throw new Error('Terminal is not running')
      await this.waitForTerminalReady(terminal, deadline)
      if (terminal.agent === 'codex' && editorText.includes('\\n')) {
        await this.submitCodexEditorTask(terminal, editorText, summary, deadline)
        return
      }
      if (!terminal.bracketedPasteMode && /[\\r\\t]/.test(normalized)) {
        throw new TypeError('terminal task requires bracketed paste mode for multiline input')
      }
      if (terminal.terminating || terminal.exited) throw new Error('Terminal is not running')
      terminal.terminal.write(terminal.bracketedPasteMode
        ? \`\\x1b[200~\${normalized}\\x1b[201~\\x1b[C\\r\`
        : \`\${normalized}\\r\`)
      terminal.taskSummary = summary || undefined
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    })
    const queued = submission.finally(() => {
      if (terminal.taskSubmission === queued) terminal.taskSubmission = undefined
    })
    terminal.taskSubmission = queued
    return queued
  }

  private async submitCodexEditorTask(terminal: OwnedTerminal, text: string, summary: string, deadline: number): Promise<void> {
    if (!terminal.codexEditorSpool) throw new Error('This Codex terminal does not support reliable multiline follow-up tasks')
    const { createHash, randomUUID } = await import('node:crypto')
    const { readFile, rename, rm, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const nonce = randomUUID()
    const bytes = Buffer.byteLength(text)
    const sha256 = createHash('sha256').update(text).digest('hex')
    const requestPath = join(terminal.codexEditorSpool, 'request.json')
    const ackPath = join(terminal.codexEditorSpool, 'ack.json')
    const temporaryPath = join(terminal.codexEditorSpool, \`request.\${nonce}.tmp\`)
    const consumedPath = join(terminal.codexEditorSpool, \`\${nonce}.request.json\`)
    await Promise.all([requestPath, ackPath, temporaryPath, consumedPath].map((path) => rm(path, { force: true })))
    try {
      await writeFile(temporaryPath, JSON.stringify({ v: 1, nonce, text, bytes, sha256 }), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporaryPath, requestPath)
      terminal.editorReady = false
      terminal.editorOutputWindow = ''
      const outputGeneration = terminal.outputGeneration
      const disabledGeneration = terminal.bracketedPasteDisabledGeneration
      const enabledGeneration = terminal.bracketedPasteEnabledGeneration
      terminal.terminal.write('\\x07')

      let acknowledgment: Record<string, unknown> | undefined
      while (!terminal.terminating && !terminal.exited && Date.now() < deadline) {
        try {
          const candidate = JSON.parse(await readFile(ackPath, 'utf8')) as Record<string, unknown>
          if (candidate.nonce === nonce) { acknowledgment = candidate; break }
        } catch { /* helper has not atomically acknowledged this nonce yet */ }
        await new Promise<void>((resolve) => setTimeout(resolve, 20))
      }
      if (terminal.terminating || terminal.exited) throw new Error('Terminal is not running')
      if (!acknowledgment) throw new Error('Codex external editor did not acknowledge the multiline task')
      if (acknowledgment.status === 'draft-not-empty') {
        throw new Error('Codex already has a draft; multiline task was not injected or submitted')
      }
      if (acknowledgment.status !== 'consumed' || acknowledgment.bytes !== bytes || acknowledgment.sha256 !== sha256) {
        throw new Error(typeof acknowledgment.error === 'string' ? acknowledgment.error : 'Codex external editor acknowledgment failed integrity validation')
      }
      const acknowledgedAt = Date.now()
      while ((!terminal.editorReady || !terminal.bracketedPasteMode || terminal.outputGeneration <= outputGeneration
        || terminal.bracketedPasteDisabledGeneration <= disabledGeneration
        || terminal.bracketedPasteEnabledGeneration <= enabledGeneration)
        && !terminal.terminating && !terminal.exited && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20))
      }
      if (terminal.terminating || terminal.exited) throw new Error('Terminal is not running')
      if (!terminal.editorReady || !terminal.bracketedPasteMode || terminal.outputGeneration <= outputGeneration
        || terminal.bracketedPasteDisabledGeneration <= disabledGeneration
        || terminal.bracketedPasteEnabledGeneration <= enabledGeneration) {
        throw new Error('Codex did not suspend and reload the multiline draft after the external editor exited')
      }
      const reloadSettleMs = acknowledgedAt + 300 - Date.now()
      if (reloadSettleMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, reloadSettleMs))
      if (terminal.terminating || terminal.exited) throw new Error('Terminal is not running')
      // A trailing @, $, or slash may open Codex completion UI. Escape closes
      // that popup before Home moves to a neutral cursor position. Neither key
      // changes the externally loaded draft; only the final Enter submits it.
      terminal.terminal.write('\\x1b')
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
      terminal.terminal.write('\\x1b[H')
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      if (terminal.terminating || terminal.exited) throw new Error('Terminal is not running')
      terminal.terminal.write('\\r')
      terminal.taskSummary = summary || undefined
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    } finally {
      await Promise.all([requestPath, ackPath, temporaryPath, consumedPath].map((path) => rm(path, { force: true }).catch(() => undefined)))
    }
  }

`
          source = source.slice(0, submitStart) + editorSubmission + source.slice(submitEnd)
          return { contents: source, loader: 'ts' }
        })
      },
    }, {
      name: 'omp-model-metadata',
      setup(build) {
        build.onResolve({ filter: /^prime-agent-ai$/ }, ({ importer }) => {
          if (!importer.endsWith('model-catalog-cli.ts')) return undefined
          return { path: join(dirname(primeEntry), 'models.js') }
        })
      },
    }],
    metafile: true,
    logLevel: 'info',
  })
  for (const path of Object.keys(result.metafile.inputs)) trackDependency(resolve(path))
  copyFile(join(extensionRoot, 'scripts', 'aio-codex-editor.cjs'), join(serviceOutput, 'aio-codex-editor.cjs'))
  } finally {
    rmSync(exactRoot, { recursive: true, force: true })
  }
}

function disableOmpComposerPredictions() {
  const service = join(serviceOutput, 'workbench-service.cjs')
  let source = readFileSync(service, 'utf8')
  const restored = 'if (entry.agent === "omp") return ["--session-dir", sessionDirectory, ...restoring ? ["--continue"] : []];'
  const configuredRestore = 'if (entry.agent === "omp") return ["--config", require("node:path").resolve(__dirname, "aio-omp-config.yml"), "--session-dir", sessionDirectory, ...restoring ? ["--continue"] : []];'
  if (source.includes(restored)) source = source.replace(restored, configuredRestore)
  const claude = 'if (agent === "claude" && !fresh) {'
  const configuredFresh = 'if (agent === "omp") {\n    return { executable, args: ["--config", require("node:path").resolve(__dirname, "aio-omp-config.yml")], label, agent };\n  }\n  '
  if (!source.includes(configuredFresh)) source = source.replace(claude, configuredFresh + claude)
  if (!source.includes(configuredRestore) || !source.includes(configuredFresh)) {
    throw new Error('AIO workbench OMP prediction overlay anchors changed')
  }
  writeFileSync(service, source)
  writeFileSync(join(serviceOutput, 'aio-omp-config.yml'), 'composer:\n  predictions: false\n')
}

function buildTerminalHost() {
  if (process.platform !== 'win32') return
  const manifest = requireFile(join(spikeRoot, 'terminal-host', 'Cargo.toml'), 'AIO terminal host manifest')
  const cargoTarget = mkdtempSync(join(tmpdir(), 'aio-vscode-terminal-host-'))
  try {
    run('cargo', ['build', '--release', '--locked', '--manifest-path', manifest, '--target-dir', cargoTarget])
    copyFile(join(cargoTarget, 'release', 'aio-terminal-host.exe'), join(serviceOutput, 'aio-terminal-host.exe'))
  } finally {
    rmSync(cargoTarget, { recursive: true, force: true })
  }
}

function copyNodePty() {
  const nodePtyRoot = join(sourceRoot, 'node_modules', 'node-pty')
  dependencyRoots.add(nodePtyRoot.replaceAll('\\', '/'))
  const targetRoot = join(serviceOutput, 'node_modules', 'node-pty')
  copyFile(join(nodePtyRoot, 'package.json'), join(targetRoot, 'package.json'))
  copyFile(join(nodePtyRoot, 'LICENSE'), join(targetRoot, 'LICENSE'))
  copyDirectory(join(nodePtyRoot, 'lib'), join(targetRoot, 'lib'), (path) => {
    return statSync(path).isDirectory() || path.endsWith('.js')
  })

  const prebuild = join(nodePtyRoot, 'prebuilds', `${process.platform}-${process.arch}`)
  copyDirectory(prebuild, join(targetRoot, 'prebuilds', `${process.platform}-${process.arch}`), (path, destination) => {
    return statSync(path).isDirectory() || (!path.toLowerCase().endsWith('.pdb') && !existsSync(destination))
  })
}

function licenseFiles(root) {
  return readdirSync(root).filter((name) => /^(licen[cs]e|notice|copying)([._-].*)?$/i.test(name))
}

function copyNpmLicenses() {
  const packages = []
  for (const root of [...dependencyRoots].sort()) {
    const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const packageName = String(metadata.name || root.split('/').at(-1))
    const directory = packageName.replace(/^@/, '').replaceAll('/', '__')
    const files = licenseFiles(root)
    for (const filename of files) copyFile(join(root, filename), join(licenseOutput, 'npm', directory, filename))
    packages.push({ name: packageName, version: metadata.version, license: metadata.license, files })
  }
  writeFileSync(join(licenseOutput, 'npm-packages.json'), `${JSON.stringify(packages, null, 2)}\n`)
  return packages.map(({ name, version }) => `${name}@${version}`)
}

function cargoPackageRoots() {
  const registryRoot = join(process.env.CARGO_HOME || join(homedir(), '.cargo'), 'registry', 'src')
  if (!existsSync(registryRoot)) return []
  const roots = []
  for (const registry of readdirSync(registryRoot)) {
    for (const spec of ['windows-link-0.2.1', 'windows-sys-0.61.2']) {
      const root = join(registryRoot, registry, spec)
      if (existsSync(join(root, 'Cargo.toml'))) roots.push(root)
    }
  }
  return roots
}

function copyCargoLicenses() {
  const packages = []
  for (const root of cargoPackageRoots()) {
    const manifest = readFileSync(join(root, 'Cargo.toml'), 'utf8')
    const name = /\nname\s*=\s*"([^"]+)"/.exec(manifest)?.[1]
    const version = /\nversion\s*=\s*"([^"]+)"/.exec(manifest)?.[1]
    const license = /\nlicense\s*=\s*"([^"]+)"/.exec(manifest)?.[1]
    if (!name || !version) continue
    if (packages.some((entry) => entry.name === name && entry.version === version)) continue
    const files = licenseFiles(root)
    for (const filename of files) copyFile(join(root, filename), join(licenseOutput, 'cargo', `${name}-${version}`, filename))
    packages.push({ name, version, license, files })
  }
  writeFileSync(join(licenseOutput, 'cargo-packages.json'), `${JSON.stringify(packages, null, 2)}\n`)
  return packages.map(({ name, version }) => `${name}@${version}`)
}

function copyLicenses() {
  mkdirSync(licenseOutput, { recursive: true })
  copyFile(join(sourceRoot, 'LICENSE'), join(licenseOutput, 'AIO-LICENSE.txt'))
  copyFile(join(sourceRoot, 'NOTICE.md'), join(licenseOutput, 'AIO-NOTICE.md'))
  copyFile(join(sourceRoot, 'vendor', 'prime-agent-ai-0.7.0-gooeypi.1.md'), join(licenseOutput, 'prime-agent-ai-NOTICE.md'))
  return { npm: copyNpmLicenses(), cargo: copyCargoLicenses() }
}

function sourceHead() {
  const gitRoot = join(sourceRoot, '.git')
  const head = readFileSync(join(gitRoot, 'HEAD'), 'utf8').trim()
  if (!head.startsWith('ref: ')) return head
  const ref = head.slice(5)
  const looseRef = join(gitRoot, ...ref.split('/'))
  if (existsSync(looseRef)) return readFileSync(looseRef, 'utf8').trim()
  const packed = readFileSync(join(gitRoot, 'packed-refs'), 'utf8')
  return packed.split(/\r?\n/).find((line) => line.endsWith(` ${ref}`))?.split(' ')[0] || 'unknown'
}

function writeManifest(dependencies) {
  const sourcePackage = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8'))
  const manifest = {
    source: 'Ancoder/AIO',
    sourceVersion: sourcePackage.version,
    sourceHead: sourceHead(),
    syncedUpstreamCommits,
    syncedUpstreamFeatures,
    nodeTarget: '24',
    platform: process.platform,
    architecture: process.arch,
    generated: [
      'ui/index.html',
      'service/workbench-service.cjs',
      'service/omp-metadata-worker.cjs',
      'service/aio-bot-cli.cjs',
      'service/aio-codex-editor.cjs',
      'service/aio-omp-config.yml',
      ...(process.platform === 'win32' ? ['service/aio-terminal-host.exe'] : []),
    ],
    dependencies,
  }
  require('node:fs').writeFileSync(join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function setDefaultTheme(uiOnly = false) {
  const assets = join(uiOutput, 'assets')
  const main = readdirSync(assets).find(name => /^main-.*\.js$/.test(name))
  const files = [
    [join(uiOutput, 'index.html'), /<html lang="en"(?: data-theme="[^"]*")?>/, '<html lang="en" data-theme="dark">'],
    [join(assets, main), /theme:"(?:dark|system|light)",locale:"zh-CN"/, 'theme:"dark",locale:"zh-CN"'],
  ]
  const labels = [
    ['Launch at login', 'Open AIO Workbench when VS Code starts'],
    ['Start the app in the background when you sign in to this computer.', 'Automatically open the workbench in trusted VS Code windows.'],
    ['登录时启动', '启动 VS Code 时打开 AIO 工作台'],
    ['登录此电脑时在后台启动应用。', '在受信任的 VS Code 窗口中自动打开工作台。'],
  ]
  const mainPath = join(assets, main)
  let renderer = readFileSync(mainPath, 'utf8')
  for (const [desktop, extension] of labels) {
    if (!renderer.includes(extension) && !renderer.includes(desktop)) throw new Error('Missing startup label: ' + desktop)
    renderer = renderer.replace(desktop, extension)
  }
  writeFileSync(mainPath, renderer)
  if (!uiOnly) files.push([
    join(serviceOutput, 'workbench-service.cjs'), /theme: "(?:system|dark|light)",(\s+locale: "zh-CN")/, 'theme: "dark",$1',
  ])
  for (const [filename, pattern, replacement] of files) {
    const source = readFileSync(filename, 'utf8')
    if (!pattern.test(source)) throw new Error('Missing default theme declaration in ' + filename)
    writeFileSync(filename, source.replace(pattern, replacement))
  }
}

function updateBotManifest() {
  const filename = join(outputRoot, 'manifest.json')
  const manifest = JSON.parse(readFileSync(filename, 'utf8'))
  manifest.syncedUpstreamCommits = [...new Set([...(manifest.syncedUpstreamCommits || []), botSourceCommit])]
  manifest.syncedUpstreamFeatures = [...new Set([...(manifest.syncedUpstreamFeatures || []), 'aio-bot-control', 'codex-terminal-submission'])]
  manifest.generated = [...new Set([...(manifest.generated || []), 'service/aio-bot-cli.cjs', 'service/aio-codex-editor.cjs'])]
  writeFileSync(filename, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function main() {
  requireFile(join(sourceRoot, 'package.json'), 'AIO package')
  verifySyncedUpstreamFeatures()
  if (process.argv.includes('--verify-synced-upstream')) return
  if (process.argv.includes('--ui-only')) {
    mkdirSync(outputRoot, { recursive: true })
    await buildUi()
    setDefaultTheme(true)
    console.log(`AIO workbench UI assets built in ${uiOutput}`)
    return
  }
  if (process.argv.includes('--set-default-theme')) return setDefaultTheme()
  if (process.argv.includes('--bot-service-only')) {
    await buildService()
    disableOmpComposerPredictions()
    setDefaultTheme()
    updateBotManifest()
    return
  }
  if (process.argv.includes('--patch-terminal-clipboard')) {
    patchGeneratedTerminalClipboard()
    return
  }
  mkdirSync(outputRoot, { recursive: true })
  rmSync(licenseOutput, { recursive: true, force: true })
  rmSync(join(outputRoot, 'resources'), { recursive: true, force: true })
  await buildUi()
  await buildService()
  disableOmpComposerPredictions()
  setDefaultTheme()
  buildTerminalHost()
  copyNodePty()
  const dependencies = copyLicenses()
  writeManifest(dependencies)
  console.log(`AIO workbench assets built in ${outputRoot}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
