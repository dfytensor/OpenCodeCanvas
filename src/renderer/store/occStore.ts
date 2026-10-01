import { create } from 'zustand'
import type {
  ChatEntry,
  ContentManifest,
  CreateNodeResult,
  GraphDoc,
  InheritPlan,
  NodeID,
  OcModelCatalog,
  Project,
  SessionNode
} from '../../shared/types'

export type { ChatEntry }

export interface OccLogEntry {
  id: number
  time: string
  kind: 'node' | 'edge' | 'server' | 'error'
  text: string
}

const STATUS_VERB: Record<string, string> = {
  provisioning: '⟳ provisioning',
  running: '⟳ running',
  awaiting_input: '⚠ awaiting input',
  completed: '✓ completed',
  failed: '✗ failed',
  aborted: '■ aborted',
  frozen: '❄ frozen',
  archived: '▤ archived'
}

let logSeq = 0
let chatSeq = 0

interface OccState {
  serverReady: boolean
  project: Project | null
  graph: GraphDoc | null
  busy: boolean
  error: string | null
  models: OcModelCatalog | null
  eventLog: OccLogEntry[]
  chats: Record<NodeID, ChatEntry[]>
  wizardOpen: boolean
  inspectCache: Record<NodeID, ContentManifest>

  init: () => Promise<void>
  refresh: () => Promise<void>
  loadModels: () => Promise<void>
  setDefaultModel: (model: string) => Promise<void>
  setDefaultAgent: (agent: string) => Promise<void>
  setEngine: (engine: 'opencode' | 'native') => Promise<void>

  openProject: (dir: string) => Promise<void>
  closeProject: () => Promise<void>

  createChat: () => Promise<string | null>
  sendChat: (chatId: NodeID, text: string) => Promise<void>
  loadChatLog: (chatId: NodeID) => Promise<void>

  createFromPlan: (plan: InheritPlan, opts: { parents: NodeID[]; kind: SessionNode['kind']; title?: string; kickoff?: string }) => Promise<void>
  send: (nodeId: NodeID, message: string) => Promise<void>
  abort: (nodeId: NodeID) => Promise<void>
  freeze: (nodeId: NodeID) => Promise<void>
  unfreeze: (nodeId: NodeID) => Promise<void>
  archive: (nodeId: NodeID) => Promise<void>
  apply: (nodeId: NodeID) => Promise<string>
  inspect: (nodeId: NodeID) => Promise<ContentManifest | null>
  setWizard: (open: boolean) => void
  subscribe: () => () => void
}

function pushLog(log: OccLogEntry[], kind: OccLogEntry['kind'], text: string): OccLogEntry[] {
  const entry: OccLogEntry = {
    id: ++logSeq,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    kind,
    text
  }
  const next = [...log, entry]
  return next.length > 200 ? next.slice(next.length - 200) : next
}

export const useOccStore = create<OccState>()((set, get) => ({
  serverReady: false,
  project: null,
  graph: null,
  busy: false,
  error: null,
  models: null,
  eventLog: [],
  chats: {},
  wizardOpen: false,
  inspectCache: {},

  init: async () => {
    try {
      const status = await window.electronAPI.occ.serverStatus()
      set({ serverReady: status.ready })
    } catch {
      set({ serverReady: false })
    }
  },

  refresh: async () => {
    const graph = await window.electronAPI.occ.getGraph()
    if (graph) set({ graph })
  },

  loadModels: async () => {
    try {
      const catalog = await window.electronAPI.occ.models()
      set({ models: catalog })
    } catch {
      // engine may still be booting
    }
  },

  setDefaultModel: async (model) => {
    const s = get()
    if (!s.project) return
    try {
      const updated = await window.electronAPI.occ.updatePolicy({ defaultModel: model })
      set({ project: updated })
    } catch (e) {
      set({ error: String(e) })
    }
  },

  setDefaultAgent: async (agent) => {
    const s = get()
    if (!s.project) return
    try {
      const updated = await window.electronAPI.occ.updatePolicy({ defaultAgent: agent })
      set({ project: updated })
    } catch (e) {
      set({ error: String(e) })
    }
  },

  setEngine: async (engine) => {
    const s = get()
    if (!s.project) return
    try {
      const updated = await window.electronAPI.occ.setEngine(engine)
      set({ project: updated })
      await s.loadModels()
    } catch (e) {
      set({ error: String(e) })
    }
  },

  openProject: async (dir) => {
    set({ busy: true, error: null })
    try {
      const res = await window.electronAPI.occ.openProject(dir)
      if (!res) throw new Error('openProject returned nothing')
      set({ project: res.project, graph: res.graph, chats: {} })
      const status = await window.electronAPI.occ.serverStatus()
      set({ serverReady: status.ready })
      const s = get()
      await s.loadModels()
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ busy: false })
    }
  },

  closeProject: async () => {
    await window.electronAPI.occ.closeProject()
    set({ project: null, graph: null, chats: {} })
  },

  createChat: async () => {
    const s = get()
    if (!s.project) return null
    try {
      const id = await window.electronAPI.occ.createChat()
      await s.refresh()
      return id
    } catch (e) {
      set({ error: String(e) })
      return null
    }
  },

  sendChat: async (chatId, text) => {
    const s = get()
    set((st) => ({
      chats: {
        ...st.chats,
        [chatId]: [
          ...(st.chats[chatId] ?? []),
          {
            id: `local-${++chatSeq}`,
            role: 'user',
            text,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          }
        ]
      }
    }))
    try {
      await window.electronAPI.occ.chatSend(chatId, text)
    } catch (e) {
      set({ error: String(e) })
    }
  },

  loadChatLog: async (chatId) => {
    const s = get()
    if (s.chats[chatId]?.length) return
    try {
      const log = await window.electronAPI.occ.chatLog(chatId)
      if (log.length) set((st) => ({ chats: { ...st.chats, [chatId]: log } }))
    } catch {
      // ignore
    }
  },

  createFromPlan: async (plan, opts) => {
    const s = get()
    if (!s.project) return
    set({ busy: true, error: null })
    try {
      await window.electronAPI.occ.createNode(plan, opts)
      await s.refresh()
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ busy: false })
    }
  },

  send: async (nodeId, message) => {
    set({ error: null })
    try {
      await window.electronAPI.occ.sendToNode(nodeId, message)
      await get().refresh()
    } catch (e) {
      set({ error: String(e) })
    }
  },

  abort: async (nodeId) => {
    try {
      await window.electronAPI.occ.abortNode(nodeId)
      await get().refresh()
    } catch (e) {
      set({ error: String(e) })
    }
  },

  freeze: async (nodeId) => {
    try {
      await window.electronAPI.occ.freezeNode(nodeId)
      await get().refresh()
    } catch (e) {
      set({ error: String(e) })
    }
  },

  unfreeze: async (nodeId) => {
    try {
      await window.electronAPI.occ.unfreezeNode(nodeId)
      await get().refresh()
    } catch (e) {
      set({ error: String(e) })
    }
  },

  archive: async (nodeId) => {
    try {
      await window.electronAPI.occ.archiveNode(nodeId)
      await get().refresh()
    } catch (e) {
      set({ error: String(e) })
    }
  },

  apply: async (nodeId) => {
    try {
      const r = await window.electronAPI.occ.applyNode(nodeId)
      return r.message
    } catch (e) {
      return String(e)
    }
  },

  inspect: async (nodeId) => {
    const cached = get().inspectCache[nodeId]
    if (cached) return cached
    try {
      const m = await window.electronAPI.occ.inspectNode(nodeId)
      if (m) set((s) => ({ inspectCache: { ...s.inspectCache, [nodeId]: m } }))
      return m
    } catch {
      return null
    }
  },

  setWizard: (open) => set({ wizardOpen: open }),

  subscribe: () => {
    return window.electronAPI.occ.onEvent((event) => {      if (event.type === 'pipeline.chat') {
        if (event.chatId) {
          set((s) => ({
            chats: {
              ...s.chats,
              [event.chatId as NodeID]: [
                ...(s.chats[event.chatId as NodeID] ?? []),
                {
                  id: `srv-${++chatSeq}`,
                  role: event.role,
                  text: event.text,
                  nodeId: event.nodeId,
                  time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                }
              ]
            }
          }))
        }
        set((s) => ({
          eventLog: pushLog(s.eventLog, event.role === 'final' ? 'node' : 'edge', event.text.slice(0, 120))
        }))
        return
      }
      if (event.type === 'node.changed') {
        set((s) => ({
          graph: s.graph
            ? { ...s.graph, nodes: { ...s.graph.nodes, [event.node.id]: event.node } }
            : s.graph,
          eventLog: pushLog(s.eventLog, 'node', `${event.node.title} · ${STATUS_VERB[event.node.status] ?? event.node.status}`)
        }))
      } else if (event.type === 'edge.added') {
        set((s) => {
          if (!s.graph) return s
          if (s.graph.edges.some((e) => e.id === event.edge.id)) return s
          return { graph: { ...s.graph, edges: [...s.graph.edges, event.edge] } }
        })
        set((s) => ({ eventLog: pushLog(s.eventLog, 'edge', `⎇ new ${event.edge.kind} edge → ${event.edge.target}`) }))
      } else if (event.type === 'server.status') {
        set({ serverReady: event.status === 'ready' })
        set((s) => ({ eventLog: pushLog(s.eventLog, 'server', `opencode server ${event.status}`) }))
      }
    })
  }
}))


// GUI-automation hook: lets the CDP driver reach the store in the live page
if (typeof window !== 'undefined') {
  ;(window as unknown as { __occStore: unknown }).__occStore = useOccStore
}
