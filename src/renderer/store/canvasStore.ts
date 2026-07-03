import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  nanoid
} from 'nanoid'
import {
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type Connection,
  type XYPosition
} from '@xyflow/react'
import type { TerminalNodeData, TerminalMode, NodeKind, DiffNodeData, ForkWorkspace, MergeSource } from '../../shared/types'

export interface CanvasDoc {
  id: string
  name: string
  cwd: string
  folder?: string
  nodes: Node[]
  edges: Edge[]
}

interface AddTerminalParams {
  id?: string
  position: XYPosition
  mode: TerminalMode
  cwd: string
  title?: string
  kind?: NodeKind
  sessionId?: string
  width?: number
  height?: number
}

interface CanvasState {
  canvases: CanvasDoc[]
  activeCanvasId: string
  defaultCwd: string

  // canvas management
  addCanvas: () => string
  deleteCanvas: (id: string) => void
  renameCanvas: (id: string, name: string) => void
  duplicateCanvas: (id: string) => string
  setActiveCanvas: (id: string) => void
  setDefaultCwd: (cwd: string) => void
  setCanvasCwd: (id: string, cwd: string) => void

  // node ops (on active canvas)
  onNodesChange: OnNodesChange
  onEdgesChange: OnEdgesChange
  onConnect: (c: Connection) => void
  addTerminalNode: (params: AddTerminalParams) => string
  addOpencodeNode: (position: XYPosition, srcCwd: string) => Promise<string>
  addDiffNode: (sourceNodeId: string) => string
  removeNode: (nodeId: string) => void
  updateNodeData: (nodeId: string, patch: Record<string, unknown>) => void
  forkNode: (nodeId: string) => Promise<void>
  mergeNodes: (sourceIds: string[]) => Promise<void>
  applyFork: (nodeId: string) => Promise<{ ok: boolean; message: string }>
}

function newCanvas(name: string, cwd = ''): CanvasDoc {
  return { id: nanoid(8), name, cwd, nodes: [], edges: [] }
}

function activeOf(state: CanvasState): CanvasDoc {
  return state.canvases.find((c) => c.id === state.activeCanvasId) ?? state.canvases[0]
}

/** Filesystem-safe, readable, stable folder name for a canvas (name + id suffix). */
function canvasSlug(name: string, id: string): string {
  const base = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, '')
    .trim()
  const safe = base.length > 0 ? base.slice(0, 40) : 'canvas'
  const short = id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6) || 'xxxxxx'
  return `${safe}-${short}`
}

/** Next sequential working-folder name (opencode1, opencode2, ...) in a canvas. */
function nextDirName(canvas: CanvasDoc): string {
  let max = 0
  for (const n of canvas.nodes) {
    const d = n.data as TerminalNodeData
    if (d.mode !== 'opencode') continue
    const m = /^opencode(\d+)$/.exec(d.dirName ?? '')
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return `opencode${max + 1}`
}

/** Parent id of a node in the fork/merge tree (forkFrom, else first mergeFrom). */
function parentIdOf(canvas: CanvasDoc, id: string): string | undefined {
  const n = canvas.nodes.find((x) => x.id === id)
  if (!n) return undefined
  const d = n.data as TerminalNodeData
  return d.forkFrom ?? (d.mergeFrom && d.mergeFrom.length ? d.mergeFrom[0] : undefined)
}

/** Lowest common ancestor of several nodes (pairwise reduction). */
function findLCA(canvas: CanvasDoc, ids: string[]): string | null {
  if (ids.length === 0) return null
  const chainOf = (start: string): string[] => {
    const chain: string[] = []
    const seen = new Set<string>()
    let cur = start
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      chain.push(cur)
      cur = parentIdOf(canvas, cur) ?? ''
    }
    return chain
  }
  const lcaTwo = (a: string, b: string): string | null => {
    const setA = new Set(chainOf(a))
    const seen = new Set<string>()
    let cur = b
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      if (setA.has(cur)) return cur
      cur = parentIdOf(canvas, cur) ?? ''
    }
    return null
  }
  let cur = ids[0]
  for (let i = 1; i < ids.length; i++) {
    cur = lcaTwo(cur, ids[i]) ?? ''
    if (!cur) return null
  }
  return cur || null
}

export const useCanvasStore = create<CanvasState>()(
  persist(
    (set, get) => ({
      canvases: [newCanvas('Canvas 1')],
      activeCanvasId: '',
      defaultCwd: '',

      addCanvas: () => {
        const name = `Canvas ${get().canvases.length + 1}`
        const c = newCanvas(name, get().defaultCwd)
        set((s) => ({ canvases: [...s.canvases, c], activeCanvasId: c.id }))
        return c.id
      },

      deleteCanvas: (id) => {
        const s = get()
        if (s.canvases.length <= 1) return
        // cleanup ptys + workspaces for this canvas' nodes
        for (const n of activeOf(s).nodes) {
          cleanupNode(n.data as TerminalNodeData)
        }
        const remaining = s.canvases.filter((c) => c.id !== id)
        set({
          canvases: remaining,
          activeCanvasId: remaining[0].id
        })
      },

      renameCanvas: (id, name) =>
        set((s) => ({
          canvases: s.canvases.map((c) => (c.id === id ? { ...c, name } : c))
        })),

      duplicateCanvas: (id) => {
        const src = get().canvases.find((c) => c.id === id)
        if (!src) return id
        const copy: CanvasDoc = {
          ...newCanvas(`${src.name} copy`, src.cwd),
          nodes: src.nodes.map((n) => ({ ...n, data: { ...n.data, ptyId: nanoid(8) } })),
          edges: src.edges.map((e) => ({ ...e }))
        }
        set((s) => ({ canvases: [...s.canvases, copy], activeCanvasId: copy.id }))
        return copy.id
      },

      setActiveCanvas: (id) => set({ activeCanvasId: id }),

      setDefaultCwd: (cwd) => set({ defaultCwd: cwd }),

      setCanvasCwd: (id, cwd) =>
        set((s) => ({
          defaultCwd: cwd,
          canvases: s.canvases.map((c) => (c.id === id ? { ...c, cwd } : c))
        })),

      onNodesChange: (changes) =>
        set((s) => ({
          canvases: s.canvases.map((c) =>
            c.id === s.activeCanvasId ? { ...c, nodes: applyNodeChanges(changes, c.nodes) } : c
          )
        })),

      onEdgesChange: (changes) =>
        set((s) => ({
          canvases: s.canvases.map((c) =>
            c.id === s.activeCanvasId ? { ...c, edges: applyEdgeChanges(changes, c.edges) } : c
          )
        })),

      onConnect: (conn) =>
        set((s) => ({
          canvases: s.canvases.map((c) =>
            c.id === s.activeCanvasId
              ? { ...c, edges: addEdge({ ...conn, animated: false }, c.edges) }
              : c
          )
        })),

      addTerminalNode: ({
        id,
        position,
        mode,
        cwd,
        title,
        kind = 'main',
        sessionId = '',
        width = 620,
        height = 340
      }) => {
        const nodeId = id ?? nanoid(10)
        const data: TerminalNodeData = {
          sessionId,
          mode,
          kind,
          cwd,
          title: title ?? (mode === 'opencode' ? 'OpenCode' : 'Terminal'),
          ptyId: nanoid(8)
        }
        const node: Node = {
          id: nodeId,
          type: 'terminal',
          position,
          width,
          height,
          dragHandle: '.terminal-node__header',
          data
        }
        set((s) => ({
          canvases: s.canvases.map((c) =>
            c.id === s.activeCanvasId ? { ...c, nodes: [...c.nodes, node] } : c
          )
        }))
        return nodeId
      },

      addOpencodeNode: async (position, srcCwd) => {
        // A root opencode node gets its OWN isolated working folder: a fresh copy
        // of the project at <store>/<canvas-folder>/opencode<N>. opencode runs in
        // it. Forks later copy THIS folder.
        const newId = nanoid(10)
        const canvas = activeOf(get())
        const folder = canvas.folder ?? canvasSlug(canvas.name, canvas.id)
        if (!canvas.folder) {
          const f = folder
          set((s) => ({
            canvases: s.canvases.map((c) => (c.id === canvas.id ? { ...c, folder: f } : c))
          }))
        }
        const dirName = nextDirName(canvas)
        let ws: ForkWorkspace | null = null
        if (srcCwd) {
          try {
            ws = await window.electronAPI.workspace.prepare({
              srcDir: srcCwd,
              mainRepoPath: srcCwd,
              folder,
              dirName
            })
          } catch {
            ws = null
          }
        }
        get().addTerminalNode({
          id: newId,
          position,
          mode: 'opencode',
          cwd: ws?.path ?? srcCwd,
          kind: 'main'
        })
        if (ws) {
          get().updateNodeData(newId, {
            workspaceType: ws.type,
            branchName: ws.branchName,
            mainRepoPath: ws.mainRepoPath,
            baseSnapshotPath: ws.baseRef,
            dirName
          })
        }
        return newId
      },

      addDiffNode: (sourceNodeId) => {
        const src = activeOf(get()).nodes.find((n) => n.id === sourceNodeId)
        const data: DiffNodeData = {
          sourceNodeId,
          title: `diff · ${(src?.data as { title?: string })?.title ?? sourceNodeId}`,
          loading: true
        }
        const node: Node = {
          id: nanoid(10),
          type: 'diff',
          position: {
            x: (src?.position.x ?? 0) + 360,
            y: (src?.position.y ?? 0) + 260
          },
          width: 560,
          height: 360,
          data
        }
        const diffId = node.id
        set((s) => ({
          canvases: s.canvases.map((c) =>
            c.id === s.activeCanvasId
              ? {
                  ...c,
                  nodes: [...c.nodes, node],
                  edges: [
                    ...c.edges,
                    {
                      id: `diff-${sourceNodeId}-${diffId}`,
                      source: sourceNodeId,
                      target: diffId,
                      type: 'fork-edge',
                      data: { kind: 'diff' }
                    }
                  ]
                }
              : c
          )
        }))
        return diffId
      },

      removeNode: (nodeId) => {
        const s = get()
        const node = activeOf(s).nodes.find((n) => n.id === nodeId)
        if (node) cleanupNode(node.data as TerminalNodeData)
        set((st) => ({
          canvases: st.canvases.map((c) =>
            c.id === st.activeCanvasId
              ? {
                  ...c,
                  nodes: c.nodes.filter((n) => n.id !== nodeId),
                  edges: c.edges.filter((e) => e.source !== nodeId && e.target !== nodeId)
                }
              : c
          )
        }))
      },

      updateNodeData: (nodeId, patch) =>
        set((s) => ({
          canvases: s.canvases.map((c) =>
            c.id === s.activeCanvasId
              ? {
                  ...c,
                  nodes: c.nodes.map((n) =>
                    n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n
                  )
                }
              : c
          )
        })),

      forkNode: async (nodeId) => {
        const s = get()
        const src = activeOf(s).nodes.find((n) => n.id === nodeId)
        if (!src) return
        const srcData = src.data as TerminalNodeData
        if (!srcData.sessionId) {
          throw new Error('Source node has no session yet — wait for OpenCode to start before forking.')
        }
        const newId = nanoid(10)
        const canvas = activeOf(s)
        const folder = canvas.folder ?? canvasSlug(canvas.name, canvas.id)
        if (!canvas.folder) {
          const f = folder
          set((st) => ({
            canvases: st.canvases.map((c) => (c.id === canvas.id ? { ...c, folder: f } : c))
          }))
        }
        const dirName = nextDirName(canvas)

        // copy the PARENT's working folder as the fork's working folder. baseline
        // (baseRef) = the parent folder, which is frozen once this fork exists, so
        // it doubles as a stable diff baseline. Falls back to shared cwd on error.
        let ws: ForkWorkspace | null = null
        try {
          ws = await window.electronAPI.workspace.prepare({
            srcDir: srcData.cwd,
            mainRepoPath: srcData.mainRepoPath ?? srcData.cwd,
            folder,
            dirName
          })
        } catch {
          ws = null
        }

        // Copy the parent's CONVERSATION into the new folder. opencode's
        // --session --fork ties the session to the parent's directory (cwd is
        // ignored), so we export → rewrite id → import from destDir, which binds
        // a fresh session (with full history) to the new folder. Best-effort: on
        // failure the fork still gets file isolation, just without the history.
        let forkedSessionId = ''
        if (ws) {
          try {
            forkedSessionId = await window.electronAPI.opencode.forkIntoDir(
              srcData.sessionId,
              srcData.cwd,
              ws.path
            )
          } catch {
            forkedSessionId = ''
          }
        }

        const newPos = {
          x: src.position.x + 360,
          y: src.position.y + 90
        }
        get().addTerminalNode({
          id: newId,
          position: newPos,
          mode: 'opencode',
          cwd: ws?.path ?? srcData.cwd,
          title: 'fork',
          kind: 'fork',
          sessionId: forkedSessionId
        })
        get().updateNodeData(newId, {
          forkFrom: nodeId,
          ...(ws
            ? {
                workspaceType: ws.type,
                branchName: ws.branchName,
                mainRepoPath: ws.mainRepoPath,
                baseSnapshotPath: ws.baseRef,
                dirName
              }
            : {})
        })
        set((st) => ({
          canvases: st.canvases.map((c) =>
            c.id === st.activeCanvasId
              ? {
                  ...c,
                  edges: [
                    ...c.edges,
                    {
                      id: `fork-${nodeId}-${newId}`,
                      source: nodeId,
                      target: newId,
                      type: 'fork-edge',
                      data: { kind: 'fork' }
                    }
                  ]
                }
              : c
          )
        }))
      },

      mergeNodes: async (sourceIds) => {
        const s = get()
        const active = activeOf(s)
        const eligible: { node: Node; ws: ForkWorkspace }[] = []
        for (const sid of sourceIds) {
          const n = active.nodes.find((x) => x.id === sid)
          if (!n) continue
          const d = n.data as TerminalNodeData
          if (!d.workspaceType || !d.cwd) continue
          eligible.push({
            node: n,
            ws: {
              path: d.cwd,
              type: d.workspaceType,
              branchName: d.branchName,
              mainRepoPath: d.mainRepoPath ?? d.cwd,
              baseRef: d.baseSnapshotPath
            }
          })
        }
        if (eligible.length < 2) {
          throw new Error('Select at least 2 branch nodes (with isolated workspaces) to merge.')
        }

        const newId = nanoid(10)
        const folder = active.folder ?? canvasSlug(active.name, active.id)
        if (!active.folder) {
          const f = folder
          set((st) => ({
            canvases: st.canvases.map((c) => (c.id === active.id ? { ...c, folder: f } : c))
          }))
        }
        const dirName = nextDirName(active)
        const mainRepoPath = eligible[0].ws.mainRepoPath

        // common ancestor (LCA) of the sources: its folder becomes the merge
        // base (the merge folder root starts as a copy of it), and its session
        // history is copied into the merge session.
        const lcaId = findLCA(active, eligible.map((e) => e.node.id))
        const ancestorNode = lcaId ? active.nodes.find((n) => n.id === lcaId) : undefined
        const ancestorData = ancestorNode?.data as TerminalNodeData | undefined
        const ancestorWs: ForkWorkspace | undefined =
          ancestorData && ancestorData.cwd && ancestorData.workspaceType
            ? {
                path: ancestorData.cwd,
                type: ancestorData.workspaceType,
                branchName: ancestorData.branchName,
                mainRepoPath: ancestorData.mainRepoPath ?? ancestorData.cwd,
                baseRef: ancestorData.baseSnapshotPath
              }
            : undefined

        const sources: MergeSource[] = eligible.map((e) => ({
          ws: e.ws,
          dirName: (e.node.data as TerminalNodeData).dirName ?? e.node.id
        }))

        const ws = await window.electronAPI.workspace.prepareMerge(sources, {
          mainRepoPath,
          folder,
          dirName,
          ancestor: ancestorWs
        })

        // copy the ancestor's CONVERSATION history into the merge folder, so the
        // merge session carries the shared context the branches forked from.
        let mergeSessionId = ''
        if (ancestorData && ancestorData.sessionId && ancestorWs) {
          try {
            mergeSessionId = await window.electronAPI.opencode.forkIntoDir(
              ancestorData.sessionId,
              ancestorWs.path,
              ws.path
            )
          } catch {
            mergeSessionId = ''
          }
        }

        const ax = eligible.reduce((a, e) => a + e.node.position.x, 0) / eligible.length
        const ay = eligible.reduce((a, e) => a + e.node.position.y, 0) / eligible.length
        get().addTerminalNode({
          id: newId,
          position: { x: ax + 360, y: ay + 180 },
          mode: 'opencode',
          cwd: ws.path,
          title: 'merge',
          kind: 'merge',
          sessionId: mergeSessionId
        })
        get().updateNodeData(newId, {
          mergeFrom: eligible.map((e) => e.node.id),
          workspaceType: ws.type,
          branchName: ws.branchName,
          mainRepoPath: ws.mainRepoPath,
          baseSnapshotPath: ws.baseRef,
          dirName
        })
        const srcIds = eligible.map((e) => e.node.id)
        set((st) => ({
          canvases: st.canvases.map((c) =>
            c.id === st.activeCanvasId
              ? {
                  ...c,
                  edges: [
                    ...c.edges,
                    ...srcIds.map((sid) => ({
                      id: `merge-${sid}-${newId}`,
                      source: sid,
                      target: newId,
                      type: 'fork-edge',
                      data: { kind: 'merge' }
                    }))
                  ]
                }
              : c
          )
        }))
      },

      applyFork: async (nodeId) => {
        const node = activeOf(get()).nodes.find((n) => n.id === nodeId)
        if (!node) return { ok: false, message: 'node not found' }
        const d = node.data as TerminalNodeData
        if (!d.workspaceType || !d.cwd) {
          return { ok: false, message: 'this branch has no isolated workspace' }
        }
        const ws: ForkWorkspace = {
          path: d.cwd,
          type: d.workspaceType,
          branchName: d.branchName,
          mainRepoPath: d.mainRepoPath ?? d.cwd,
          baseRef: d.baseSnapshotPath
        }
        return window.electronAPI.workspace.apply(ws)
      }
    }),
    {
      name: 'opencode-canvas',
      partialize: (s) => ({
        canvases: s.canvases,
        activeCanvasId: s.activeCanvasId,
        defaultCwd: s.defaultCwd
      }),
      onRehydrateStorage: () => (state) => {
        if (!state || state.canvases.length === 0) return
        if (!state.activeCanvasId) state.activeCanvasId = state.canvases[0].id
        // migrate older persisted canvases that predate per-canvas cwd
        for (const c of state.canvases) {
          if (c.cwd === undefined || c.cwd === null) c.cwd = state.defaultCwd ?? ''
        }
      }
    }
  )
)

function cleanupNode(data: TerminalNodeData): void {
  try {
    window.electronAPI?.pty.kill(data.ptyId)
  } catch {
    // ignore
  }
  if (data.workspaceType && data.cwd) {
    try {
      void window.electronAPI?.workspace.remove({
        path: data.cwd,
        type: data.workspaceType,
        branchName: data.branchName,
        mainRepoPath: data.mainRepoPath ?? data.cwd,
        baseRef: data.baseSnapshotPath
      })
    } catch {
      // ignore
    }
  }
}
