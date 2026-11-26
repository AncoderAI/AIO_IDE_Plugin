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

function requireFile(path, description) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${description} was not found at ${path}`)
  }
  return path
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
          if (!id.replaceAll('\\', '/').endsWith('/src/components/TerminalDrawer.tsx')) return
          const constructor = 'const terminal = new Terminal({'
          if (!source.includes(constructor)) throw new Error('AIO TerminalDrawer constructor changed')
          return source.replace(constructor, constructor + '\n      minimumContrastRatio: 4.5,')
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
    nodeTarget: '24',
    platform: process.platform,
    architecture: process.arch,
    generated: [
      'ui/index.html',
      'service/workbench-service.cjs',
      'service/omp-metadata-worker.cjs',
      ...(process.platform === 'win32' ? ['service/aio-terminal-host.exe'] : []),
    ],
    dependencies,
  }
  require('node:fs').writeFileSync(join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

async function main() {
  requireFile(join(sourceRoot, 'package.json'), 'AIO package')
  mkdirSync(outputRoot, { recursive: true })
  rmSync(licenseOutput, { recursive: true, force: true })
  rmSync(join(outputRoot, 'resources'), { recursive: true, force: true })
  await buildUi()
  await buildService()
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
