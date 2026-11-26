'use strict'

const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const CLI_DEFINITIONS = Object.freeze({
  omp: Object.freeze({ id: 'omp', label: 'OMP', setting: 'ompPath', commands: ['omp'] }),
  claude: Object.freeze({ id: 'claude', label: 'Claude Code', setting: 'claudePath', commands: ['claude'] }),
  codex: Object.freeze({ id: 'codex', label: 'Codex', setting: 'codexPath', commands: ['codex'] }),
})

function expandConfiguredPath(value, environment = process.env, homeDirectory = os.homedir()) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  let expanded = value.trim()
  if (expanded === '~' || expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(homeDirectory, expanded.slice(2))
  }
  expanded = expanded.replace(/%([^%]+)%/g, (match, name) => environment[name] ?? match)
  return expanded
}

function searchDirectories(environment = process.env, platform = process.platform, homeDirectory = os.homedir()) {
  const directories = (environment.PATH || environment.Path || environment.path || '')
    .split(path.delimiter)
    .filter((directory) => path.isAbsolute(directory))

  if (platform === 'win32') {
    if (environment.APPDATA) directories.push(path.join(environment.APPDATA, 'npm'))
    if (environment.LOCALAPPDATA) directories.push(path.join(environment.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'))
    directories.push(path.join(homeDirectory, '.local', 'bin'))
  } else {
    directories.push(path.join(homeDirectory, '.local', 'bin'))
  }

  const seen = new Set()
  return directories.filter((directory) => {
    const key = platform === 'win32' ? directory.toLowerCase() : directory
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function executableExtensions(platform = process.platform, environment = process.env) {
  if (platform !== 'win32') return ['']
  const configured = (environment.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .filter(Boolean)
    .map((extension) => extension.toLowerCase())
  return [...new Set(['.exe', '.cmd', '.bat', ...configured])]
}

async function isExecutable(filename, platform = process.platform) {
  try {
    await fs.access(filename, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK)
    const details = await fs.stat(filename)
    return details.isFile()
  } catch {
    return false
  }
}

async function resolveCandidate(candidate, options = {}) {
  const platform = options.platform || process.platform
  const environment = options.environment || process.env
  const homeDirectory = options.homeDirectory || os.homedir()
  const expanded = expandConfiguredPath(candidate, environment, homeDirectory)
  if (!expanded) return undefined

  const containsDirectory = path.isAbsolute(expanded) || expanded.includes('/') || expanded.includes('\\')
  if (containsDirectory && !path.isAbsolute(expanded)) return undefined
  const directories = containsDirectory ? [''] : searchDirectories(environment, platform, homeDirectory)
  const extension = path.extname(expanded)
  const extensions = platform === 'win32' && !extension ? executableExtensions(platform, environment) : ['']

  for (const directory of directories) {
    for (const suffix of extensions) {
      const filename = containsDirectory ? expanded + suffix : path.join(directory, expanded + suffix)
      if (await isExecutable(filename, platform)) return path.resolve(filename)
    }
  }
  return undefined
}

async function discoverCli(id, configuration, options = {}) {
  const definition = CLI_DEFINITIONS[id]
  if (!definition) throw new TypeError(`Unknown AIO CLI: ${id}`)
  const configured = configuration?.get(definition.setting)
  if (configured) {
    const configuredPath = expandConfiguredPath(configured, options.environment, options.homeDirectory)
    if (!configuredPath || !path.isAbsolute(configuredPath)) {
      return { ...definition, executable: undefined, configured: true }
    }
  }
  const candidates = configured ? [configured] : definition.commands

  for (const candidate of candidates) {
    const executable = await resolveCandidate(candidate, options)
    if (executable) return { ...definition, executable, configured: Boolean(configured) }
  }
  return { ...definition, executable: undefined, configured: Boolean(configured) }
}

async function discoverClis(configuration, options = {}) {
  return Promise.all(Object.keys(CLI_DEFINITIONS).map((id) => discoverCli(id, configuration, options)))
}

module.exports = {
  CLI_DEFINITIONS,
  discoverCli,
  discoverClis,
  executableExtensions,
  expandConfiguredPath,
  resolveCandidate,
  searchDirectories,
}
