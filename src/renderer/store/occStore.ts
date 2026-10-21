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
  provisioning: '⟳ 启动中',
  running: '⟳ 执行中',
  awaiting_input: '⚠ 等待输入',
  completed: '✓ 已完成',
  failed: '✗ 失败',
  aborted: '■ 已中止',
  frozen: '❄ 已冻结',
  archived: '▤ 已归档'
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
  /** live streaming partials keyed by worker nodeId (renderer-only, not persisted) */
  streams: Record<NodeID, { chatId?: NodeID; text: string }>
  wizardOpen: boolean
  /** first-run guide overlay: step 0 workspace → 1 model → 2 first task */
  onboardingOpen: boolean
  onboardingStep: number
  onboardingInfo: { hasProvider: boolean; localEngineConfigured: boolean } | null
  inspectCache: Record<NodeID, ContentManifest>
  /** one-shot signal: GraphCanvas pans to this node then clears it */
  focusNode: NodeID | null
  requestFocus: (id: NodeID) => void
  /** collapsible chat list sidebar */
  sidebarOpen: boolean
  setSidebar: (open: boolean) => void
  /** diff viewer: node whose workspace diff is on screen */
  diffNode: NodeID | null
  diffText: string
  showDiff: (nodeId: NodeID) => Promise<void>
  closeDiff: () => void

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
  openOnboarding: () => void
  setOnboardingStep: (n: number) => void
  closeOnboarding: () => Promise<void>
  subscribe: () => () => void
}

function friendly(e: unknown): string {
  const s = String(e)
  if (/429|余额不足|无可用资源|额度/.test(s)) return '模型配额不足（429）——等待重置、切换模型，或依赖自动 failover'
  if (/EPERM|EBUSY|EACCES/.test(s)) return '文件被占用或拒绝访问——关闭占用它的程序后重试'
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|AggregateError|fetch failed/i.test(s)) return '网络连接失败——系统已自动重试，请检查网络或代理'
  if (/no provider|no usable/i.test(s)) return '没有可用的模型——检查配置或启动本地决策引擎（⚙）'
  return s.slice(0, 200)
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
  streams: {},
  wizardOpen: false,
  onboardingOpen: false,
  onboardingStep: 0,
  onboardingInfo: null,
  inspectCache: {},
  focusNode: null,

  requestFocus: (id) => set({ focusNode: id }),

  sidebarOpen: false,
  setSidebar: (open) => set({ sidebarOpen: open }),

  diffNode: null,
  diffText: '',
  showDiff: async (nodeId) => {
    set({ diffNode: nodeId, diffText: 'loading…' })
    try {
      const text = await window.electronAPI.occ.nodeDiff(nodeId)
      set({ diffText: text || '(no changes in this workspace)' })
    } catch (e) {
      set({ diffText: String(e) })
    }
  },
  closeDiff: () => set({ diffNode: null, diffText: '' }),

  init: async () => {
    try {
      const status = await window.electronAPI.occ.serverStatus()
      set({ serverReady: status.ready })
    } catch {
      set({ serverReady: false })
    }
    // auto-restore the last opened project so the app resumes where it left off
    try {
      const last = await window.electronAPI.occ.getLastProject()
      if (last && !get().project) {
        await get().openProject(last)
        if (!get().project) set({ error: null })
      }
    } catch { /* first run or restore failed — empty state is fine */ }
    // first-run guide: auto-open only when the persisted flag is absent.
    // A restored project skips the workspace step (it is already satisfied).
    try {
      const ob = await window.electronAPI.occ.onboardingState()
      if (!ob.done) {
        set({
          onboardingOpen: true,
          onboardingStep: get().project ? 1 : 0,
          onboardingInfo: { hasProvider: ob.hasProvider, localEngineConfigured: ob.localEngineConfigured }
        })
      }
    } catch { /* the guide must never block startup */ }
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
      set({ error: friendly(e) })
    }
  },

  setDefaultAgent: async (agent) => {
    const s = get()
    if (!s.project) return
    try {
      const updated = await window.electronAPI.occ.updatePolicy({ defaultAgent: agent })
      set({ project: updated })
    } catch (e) {
      set({ error: friendly(e) })
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
      set({ error: friendly(e) })
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
      set({ error: friendly(e) })
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
      // pin top-bar-created chats to the first free grid slot (never stacks)
      const g = get().graph
      if (g && s.project) {
        const rootCount = Object.values(g.nodes).filter((n) => n.kind === 'root' && n.parents.length === 0).length
        const { findFreeSlot, pinPosition } = await import('../lib/layout')
        pinPosition(s.project.id, id, findFreeSlot(s.project.id, rootCount))
      }
      return id
    } catch (e) {
      set({ error: friendly(e) })
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
      set({ error: friendly(e) })
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
      set({ error: friendly(e) })
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
      set({ error: friendly(e) })
    }
  },

  abort: async (nodeId) => {
    try {
      await window.electronAPI.occ.abortNode(nodeId)
      await get().refresh()
    } catch (e) {
      set({ error: friendly(e) })
    }
  },

  freeze: async (nodeId) => {
    try {
      await window.electronAPI.occ.freezeNode(nodeId)
      await get().refresh()
    } catch (e) {
      set({ error: friendly(e) })
    }
  },

  unfreeze: async (nodeId) => {
    try {
      await window.electronAPI.occ.unfreezeNode(nodeId)
      await get().refresh()
    } catch (e) {
      set({ error: friendly(e) })
    }
  },

  archive: async (nodeId) => {
    try {
      await window.electronAPI.occ.archiveNode(nodeId)
      await get().refresh()
    } catch (e) {
      set({ error: friendly(e) })
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
      if (m) {
        set((s) => {
          const cache = { ...s.inspectCache, [nodeId]: m }
          // long-run hygiene: FIFO cap — hover caches of dead nodes are cheap to refetch
          const keys = Object.keys(cache)
          if (keys.length > 40) {
            for (const k of keys.slice(0, keys.length - 40)) delete cache[k]
          }
          return { inspectCache: cache }
        })
      }
      return m
    } catch {
      return null
    }
  },

  setWizard: (open) => set({ wizardOpen: open }),

  openOnboarding: () => {
    set({ onboardingOpen: true, onboardingStep: get().project ? 1 : 0 })
    void window.electronAPI.occ
      .onboardingState()
      .then((ob) => set({ onboardingInfo: { hasProvider: ob.hasProvider, localEngineConfigured: ob.localEngineConfigured } }))
      .catch(() => undefined)
  },

  setOnboardingStep: (n) => set({ onboardingStep: Math.max(0, Math.min(2, n)) }),

  closeOnboarding: async () => {
    set({ onboardingOpen: false })
    try {
      await window.electronAPI.occ.completeOnboarding()
    } catch { /* flag is best-effort — closing the overlay must always work */ }
  },

  subscribe: () => {
    return window.electronAPI.occ.onEvent((event) => {      if (event.type === 'pipeline.stream') {
        set((s) => {
          const streams = { ...s.streams }
          if (event.done || !event.text) delete streams[event.nodeId]
          else streams[event.nodeId] = { chatId: event.chatId, text: event.text }
          return { streams }
        })
        return
      }
      if (event.type === 'pipeline.chat') {
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
