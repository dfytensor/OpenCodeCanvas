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
import type { TerminalNodeData, TerminalMode, NodeKind, DiffNodeData, ForkWorkspace } from '../../shared/types'

export interface CanvasDoc {
  id: string
  name: string
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

  // node ops (on active canvas)
  onNodesChange: OnNodesChange
  onEdgesChange: OnEdgesChange
  onConnect: (c: Connection) => void
  addTerminalNode: (params: AddTerminalParams) => string
  addDiffNode: (sourceNodeId: string) => string
  removeNode: (nodeId: string) => void
  updateNodeData: (nodeId: string, patch: Record<string, unknown>) => void
  forkNode: (nodeId: string) => Promise<void>
  applyFork: (nodeId: string) => Promise<{ ok: boolean; message: string }>
}

function newCanvas(name: string): CanvasDoc {
  return { id: nanoid(8), name, nodes: [], edges: [] }
}

function activeOf(state: CanvasState): CanvasDoc {
  return state.canvases.find((c) => c.id === state.activeCanvasId) ?? state.canvases[0]
}

export const useCanvasStore = create<CanvasState>()(
  persist(
    (set, get) => ({
      canvases: [newCanvas('Canvas 1')],
      activeCanvasId: '',
      defaultCwd: '',

      addCanvas: () => {
        const name = `Canvas ${get().canvases.length + 1}`
        const c = newCanvas(name)
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
          ...newCanvas(`${src.name} copy`),
          nodes: src.nodes.map((n) => ({ ...n, data: { ...n.data, ptyId: nanoid(8) } })),
          edges: src.edges.map((e) => ({ ...e }))
        }
        set((s) => ({ canvases: [...s.canvases, copy], activeCanvasId: copy.id }))
        return copy.id
      },

      setActiveCanvas: (id) => set({ activeCanvasId: id }),

      setDefaultCwd: (cwd) => set({ defaultCwd: cwd }),

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
        width = 620,
        height = 340
      }) => {
        const nodeId = id ?? nanoid(10)
        const data: TerminalNodeData = {
          sessionId: '',
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

        // file-level isolation: git worktree if available, else a self-built
        // snapshot copy. Falls back to shared cwd so session branching always works.
        let ws: ForkWorkspace | null = null
        try {
          ws = await window.electronAPI.workspace.prepare(srcData.cwd, newId)
        } catch {
          ws = null
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
          kind: 'fork'
        })
        get().updateNodeData(newId, {
          forkFrom: nodeId,
          forkParentSession: srcData.sessionId,
          ...(ws
            ? {
                workspaceType: ws.type,
                branchName: ws.branchName,
                mainRepoPath: ws.mainRepoPath,
                baseSnapshotPath: ws.baseRef
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
        if (state && state.canvases.length > 0 && !state.activeCanvasId) {
          state.activeCanvasId = state.canvases[0].id
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
