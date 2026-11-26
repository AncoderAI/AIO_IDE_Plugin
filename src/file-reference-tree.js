'use strict'

const MIME_TYPES = ['text/uri-list', 'application/vnd.code.uri-list', 'resourceurls', 'codefiles']
const MAX_REFERENCE_ITEMS = 16

async function readDropCandidates(dataTransfer) {
  const values = Object.create(null)
  for (const type of MIME_TYPES) {
    const item = dataTransfer.get(type)
    if (!item || typeof item.asString !== 'function') continue
    try { values[type] = await item.asString() } catch {}
  }
  const { extractDropCandidates } = require('./file-drop')
  return extractDropCandidates({ getData: (type) => values[type] || '' })
}

function resourceCandidates(values) {
  const candidates = []
  const seen = new Set()
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit)
    if (!value || typeof value !== 'object' || typeof value.scheme !== 'string' || typeof value.toString !== 'function') return
    const uri = value.toString()
    if (!seen.has(uri)) {
      seen.add(uri)
      if (candidates.length >= MAX_REFERENCE_ITEMS) throw new RangeError(`AIO 一次最多引用 ${MAX_REFERENCE_ITEMS} 个文件或文件夹`)
      candidates.push({ kind: 'uri', value: uri })
    }
  }
  values.forEach(visit)
  return candidates
}

function registerFileReferenceTree(vscode, context, workbenchHost, entries) {
  const emitter = new vscode.EventEmitter()
  const dropTarget = new vscode.TreeItem('拖到此处引用到工作台')
  dropTarget.id = 'aio.referenceDropTarget'
  dropTarget.description = '文件或文件夹路径'
  dropTarget.iconPath = new vscode.ThemeIcon('references')
  dropTarget.contextValue = 'aioReferenceDropTarget'
  const projectTarget = new vscode.TreeItem('拖入文件夹以添加项目')
  projectTarget.id = 'aio.projectImportDropTarget'
  projectTarget.description = '不会更改 VS Code 工作区'
  projectTarget.iconPath = new vscode.ThemeIcon('folder-library')
  projectTarget.contextValue = 'aioProjectImportDropTarget'

  const provider = {
    onDidChangeTreeData: emitter.event,
    getChildren: (parent) => parent ? [] : [...entries, ...(workbenchHost.isOpen() ? [projectTarget, dropTarget] : [])],
    getTreeItem: (item) => item,
  }
  const insert = async (candidates) => {
    try { return await workbenchHost.insertDroppedCandidates(candidates) }
    catch (error) {
      await vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error))
      return false
    }
  }
  const addProjects = async (candidates) => {
    try { return await workbenchHost.addProjectCandidates(candidates, true) }
    catch (error) {
      await vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error))
      return 0
    }
  }
  const controller = {
    dropMimeTypes: MIME_TYPES,
    dragMimeTypes: [],
    async handleDrop(target, dataTransfer) {
      if (target !== dropTarget && target !== projectTarget) return
      let candidates
      try { candidates = await readDropCandidates(dataTransfer) }
      catch (error) {
        await vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error))
        return
      }
      if (!candidates.length) {
        await vscode.window.showWarningMessage(target === projectTarget ? '没有可添加的文件夹路径。' : '没有可引用的文件或文件夹路径。')
        return
      }
      if (target === projectTarget) await addProjects(candidates)
      else await insert(candidates)
    },
  }

  for (const view of ['aio.launchers', 'aio.sidebarLaunchers']) {
    context.subscriptions.push(vscode.window.createTreeView(view, { treeDataProvider: provider, dragAndDropController: controller }))
  }
  context.subscriptions.push(
    emitter,
    workbenchHost.onDidChangePanel(() => emitter.fire(undefined)),
    vscode.commands.registerCommand('aio.referenceInWorkbench', async (...resources) => {
      let candidates
      try { candidates = resourceCandidates(resources) }
      catch (error) {
        await vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error))
        return false
      }
      if (!candidates.length) {
        await vscode.window.showWarningMessage('请在 Explorer 中选择要引用的文件或文件夹。')
        return false
      }
      return insert(candidates)
    }),
    vscode.commands.registerCommand('aio.importProjectInWorkbench', async (...resources) => {
      let candidates
      try { candidates = resourceCandidates(resources) }
      catch (error) {
        await vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error))
        return 0
      }
      if (!candidates.length) {
        await vscode.window.showWarningMessage('请在 Explorer 中选择要添加的文件夹。')
        return 0
      }
      return addProjects(candidates)
    }),
  )
}

module.exports = { MIME_TYPES, readDropCandidates, registerFileReferenceTree, resourceCandidates }
