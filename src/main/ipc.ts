import { ipcMain, dialog, BrowserWindow } from 'electron'
import { join } from 'path'
import type {
  InheritPlan,
  NodeID,
  NodeKind,
  InheritChannel,
  AgentEngine,
  ProjectPolicy
} from '../shared/types'
// ── engine & graph services ──
import { ensureServer, getServer } from './opencode/server'
import { probeCapabilities } from './opencode/probe'
import { ocApi } from './opencode/api'
import { openProjectWithGraph } from './project/lifecycle'
import { getActiveProject, setActiveProject, updatePolicy } from './project/registry'
import { getGraph, propagateTaint, summarizeNodes } from './graph/store'
import { onOccEvent } from './graph/events'
import {
  createInheritNode,
  inspectNodeManifest,
  freezeNode,
  unfreezeNode,
  archiveNode,
  sendToNode,
  abortNode,
  applyNodeToMainline,
  ensureObserver
} from './inherit/executor'
import { diffDirs } from './workspace/diff'
// ── chat ──
import { createChat, chatSend, chatLog } from './chat'
import { readSettings, writeSettings } from './settings'

function requireProject(): string {
  const p = getActiveProject()
  if (!p) throw new Error('no project open')
  return p.rootDir
}

export function registerIpc(): void {
  // ---- project ----
  ipcMain.handle('dialog:pickDirectory', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle('occ:serverStatus', async () => {
    const h = await getServer()
    if (h) return { ready: true, port: h.port, managed: h.managed }
    const caps = await probeCapabilities().catch(() => null)
    return { ready: false, version: caps?.version, managed: false }
  })

  ipcMain.handle('occ:setJevKey', async (_e, key: string) => {
    process.env.OPENROUTER_API_KEY = key
    writeSettings({ openrouterKey: key })
    return { ok: true }
  })

  ipcMain.handle('occ:lastProject', async () => {
    return readSettings().lastProject ?? null
  })

  ipcMain.handle('occ:capabilities', async () => {
    return probeCapabilities()
  })

  ipcMain.handle('occ:openProject', async (_e, rootDir: string) => {
    // the opencode server is only needed by the opencode engine; native runs
    // without it. A missing/broken CLI must never block opening a project.
    try {
      await ensureServer(rootDir)
    } catch (e) {
      console.error('[occ] opencode serve unavailable (native engine unaffected):', String(e).slice(0, 140))
    }
    await openProjectWithGraph(rootDir)
    try {
      ensureObserver(rootDir)
    } catch { /* observer only matters for server-managed sessions */ }
    writeSettings({ lastProject: rootDir })
    const project = getActiveProject()
    const graph = await getGraph(rootDir)
    return { project, graph }
  })

  ipcMain.handle('occ:closeProject', async () => {
    setActiveProject(null)
  })

  ipcMain.handle('occ:getGraph', async () => {
    const p = getActiveProject()
    return p ? getGraph(p.rootDir) : null
  })

  ipcMain.handle('occ:nodeSummaries', async () => {
    const p = getActiveProject()
    if (!p) return []
    const g = await getGraph(p.rootDir)
    return summarizeNodes(g)
  })

  // ---- policy ----
  ipcMain.handle('occ:models', async () => {
    const p = getActiveProject()
    const native = p?.policy.engine === 'native'
    const [serverProv, agents] = await Promise.all([
      native ? Promise.resolve([]) : ocApi.listProviders().catch(() => []),
      native ? Promise.resolve([]) : ocApi.listAgents().catch(() => [])
    ])
    const { agentCatalog } = await import('./agent/session')
    const own = agentCatalog()
    const providers = native
      ? own
      : [...own, ...serverProv.filter((s) => !own.some((a) => a.id === s.id))]
    return { providers, agents }
  })

  ipcMain.handle('occ:updatePolicy', async (_e, patch: Partial<ProjectPolicy>) => {
    return updatePolicy(requireProject(), patch)
  })

  ipcMain.handle('occ:setEngine', async (_e, engine: AgentEngine) => {
    return updatePolicy(requireProject(), { engine })
  })

  // ---- nodes ----
  ipcMain.handle(
    'occ:createNode',
    async (
      _e,
      plan: InheritPlan | null,
      opts: { parents: NodeID[]; kind: NodeKind; title?: string; kickoff?: string; channel?: InheritChannel }
    ) => {
      return createInheritNode(requireProject(), plan, opts)
    }
  )

  ipcMain.handle('occ:inspectNode', async (_e, nodeId: NodeID) => {
    return inspectNodeManifest(requireProject(), nodeId)
  })

  ipcMain.handle('occ:freezeNode', async (_e, nodeId: NodeID) => {
    return freezeNode(requireProject(), nodeId)
  })

  ipcMain.handle('occ:unfreezeNode', async (_e, nodeId: NodeID) => {
    return unfreezeNode(requireProject(), nodeId)
  })

  ipcMain.handle('occ:archiveNode', async (_e, nodeId: NodeID) => {
    return archiveNode(requireProject(), nodeId)
  })

  ipcMain.handle('occ:taintNode', async (_e, nodeId: NodeID, level: 'suspicious' | 'confirmed') => {
    return propagateTaint(requireProject(), nodeId, level)
  })

  ipcMain.handle('occ:sendToNode', async (_e, nodeId: NodeID, message: string) => {
    await sendToNode(requireProject(), nodeId, message)
  })

  ipcMain.handle('occ:abortNode', async (_e, nodeId: NodeID) => {
    await abortNode(requireProject(), nodeId)
  })

  ipcMain.handle('occ:nodeDiff', async (_e, nodeId: NodeID) => {
    const rootDir = requireProject()
    const g = await getGraph(rootDir)
    const node = g.nodes[nodeId]
    if (!node?.workDir || !node?.snapshotDir) return ''
    return diffDirs(node.snapshotDir, node.workDir)
  })

  ipcMain.handle('occ:applyNode', async (_e, nodeId: NodeID) => {
    return applyNodeToMainline(requireProject(), nodeId)
  })

  ipcMain.handle(
    'occ:runPipeline',
    async (
      _e,
      opts: { parentId: NodeID; tasks: string[]; title?: string; kickoff?: string; channel?: 'fork' | 'brief'; timeoutMs?: number }
    ) => {
      const { runParallelPipeline } = await import('./inherit/executor')
      return runParallelPipeline(requireProject(), opts)
    }
  )

  ipcMain.handle(
    'occ:runAdaptive',
    async (_e, opts: { parentId: NodeID; goal: string; maxRounds?: number; channel?: 'fork' | 'brief' }) => {
      const { startAdaptivePipeline } = await import('./inherit/executor')
      startAdaptivePipeline(requireProject(), opts)
      return { started: true }
    }
  )

  // ---- chat nodes ----
  ipcMain.handle('occ:createChat', async () => {
    return createChat(requireProject())
  })

  ipcMain.handle('occ:chatSend', async (_e, chatId: NodeID, text: string) => {
    await chatSend(requireProject(), chatId, text)
  })

  ipcMain.handle('occ:chatLog', async (_e, chatId: NodeID) => {
    return chatLog(requireProject(), chatId)
  })

  // push internal occ events to every renderer window
  onOccEvent((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('occ:event', event)
    }
  })
}
