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
])
const syncedUpstreamFeatures = Object.freeze([
  'windows-claude-discovery',
  'coding-cli-executable-metadata',
  'coding-cli-configured-executable',
])

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
          const normalized = id.replaceAll('\\', '/')
          if (normalized.endsWith('/src/App.tsx')) {
            const keyboard = 'if (!terminalOpen || event.defaultPrevented || event.isComposing || isOverlayOpen()) return'
            if (!source.includes(keyboard)) throw new Error('AIO App terminal keyboard anchor changed')
            let transformed = source.replace(keyboard,
              'if (!terminalOpen || !terminalOwnsKeyboard.current || event.defaultPrevented || event.isComposing || isOverlayOpen()) return')
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
            if (source.includes('onClosePage')) return source
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
  const result = await esbuild.build({
    entryPoints: [
      requireFile(join(spikeRoot, 'workbench-service.ts'), 'Tauri workbench service'),
      requireFile(join(spikeRoot, 'omp-metadata-worker.ts'), 'OMP metadata worker'),
    ],
    outdir: serviceOutput,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    external: ['node-pty'],
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    plugins: [{
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
      'service/aio-omp-config.yml',
      ...(process.platform === 'win32' ? ['service/aio-terminal-host.exe'] : []),
    ],
    dependencies,
  }
  require('node:fs').writeFileSync(join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function setDefaultTheme() {
  const assets = join(uiOutput, 'assets')
  const main = readdirSync(assets).find(name => /^main-.*\.js$/.test(name))
  const files = [
    [join(uiOutput, 'index.html'), /<html lang="en"(?: data-theme="[^"]*")?>/, '<html lang="en" data-theme="dark">'],
    [join(assets, main), /theme:"(?:dark|system|light)",locale:"zh-CN"/, 'theme:"dark",locale:"zh-CN"'],
    [join(serviceOutput, 'workbench-service.cjs'), /theme: "(?:system|dark|light)",(\s+locale: "zh-CN")/, 'theme: "dark",$1'],
  ]
  for (const [filename, pattern, replacement] of files) {
    const source = readFileSync(filename, 'utf8')
    if (!pattern.test(source)) throw new Error('Missing default theme declaration in ' + filename)
    writeFileSync(filename, source.replace(pattern, replacement))
  }
}

async function main() {
  requireFile(join(sourceRoot, 'package.json'), 'AIO package')
  verifySyncedUpstreamFeatures()
  if (process.argv.includes('--verify-synced-upstream')) return
  if (process.argv.includes('--set-default-theme')) return setDefaultTheme()
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
