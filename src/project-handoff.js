'use strict'

const { createHash } = require('node:crypto')

const PROJECT_HANDOFF_KEY = 'aio.projectHandoff.v3.'
const HANDOFF_TTL_MS = 60_000

function normalizedPath(pathModule, value) {
  const normalized = pathModule.resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function samePath(pathModule, left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && normalizedPath(pathModule, left) === normalizedPath(pathModule, right)
}

function projectRoot(project) {
  return project?.primaryFolder || project?.path || project?.folders?.[0]
}

function registeredProject(pathModule, projects, requestedPath) {
  return projects.find((project) => samePath(pathModule, projectRoot(project), requestedPath))
}

function uniquePaths(pathModule, values) {
  const result = []
  for (const value of values) {
    if (typeof value !== 'string' || !value || result.some((item) => samePath(pathModule, item, value))) continue
    result.push(pathModule.resolve(value))
  }
  return result
}

function currentWorkspaceRoot(vscode) {
  const folders = vscode.workspace.workspaceFolders || []
  return folders.length === 1 ? folders[0].uri.fsPath : undefined
}

function currentWorkspaceMatches(vscode, pathModule, target) {
  return samePath(pathModule, currentWorkspaceRoot(vscode), target)
}

function projectFolderUri(vscode, pathModule, target) {
  const current = (vscode.workspace.workspaceFolders || [])[0]?.uri
  if (current && current.scheme !== 'file' && typeof current.with === 'function') {
    return current.with({ path: pathModule.resolve(target).split(pathModule.sep).join('/') })
  }
  return vscode.Uri.file(target)
}

function handoffStorageKey(pathModule, target) {
  const digest = createHash('sha256').update(normalizedPath(pathModule, target)).digest('hex')
  return PROJECT_HANDOFF_KEY + digest
}

async function storeProjectHandoff(context, pathModule, handoff) {
  await context.globalState.update(handoffStorageKey(pathModule, handoff.target), handoff)
}

async function clearProjectHandoff(context, pathModule, target) {
  await context.globalState.update(handoffStorageKey(pathModule, target), undefined)
}

async function resumeProjectHandoff(vscode, context, host, pathModule, now = Date.now()) {
  const target = currentWorkspaceRoot(vscode)
  if (!target) return false
  const key = handoffStorageKey(pathModule, target)
  const matched = context.globalState.get(key)
  if (!matched || typeof matched.target !== 'string' || typeof matched.expiresAt !== 'number') return false
  if (matched.expiresAt < now) {
    await context.globalState.update(key, undefined)
    return false
  }
  // Remove this destination before opening the panel so a restart cannot
  // replay it recursively. Handoffs for other windows remain intact.
  await context.globalState.update(key, undefined)
  const projects = uniquePaths(pathModule, Array.isArray(matched.projects) ? matched.projects : [])
  const ordered = [...projects.filter((item) => !samePath(pathModule, item, matched.target)), matched.target]
  await host.open()
  await host.addProjectCandidates(ordered.map((value) => ({ kind: 'path', value })), true)
  return true
}

module.exports = {
  HANDOFF_TTL_MS, PROJECT_HANDOFF_KEY, clearProjectHandoff, currentWorkspaceMatches, normalizedPath, projectRoot,
  handoffStorageKey, projectFolderUri, registeredProject, resumeProjectHandoff, samePath, storeProjectHandoff, uniquePaths,
}
