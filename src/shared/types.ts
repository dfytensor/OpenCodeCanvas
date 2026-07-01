// Shared types between main/preload/renderer

export type TerminalMode = 'shell' | 'opencode'
export type NodeKind = 'main' | 'fork'

export interface TerminalNodeData {
  sessionId: string
  mode: TerminalMode
  kind: NodeKind
  forkFrom?: string
  forkParentSession?: string
  cwd: string
  title: string
  ptyId: string
  // file-level isolation (roadmap #4)
  workspaceType?: 'worktree' | 'copy'
  branchName?: string
  baseSnapshotPath?: string
  mainRepoPath?: string
  [key: string]: unknown
}

export interface DiffNodeData {
  sourceNodeId: string
  title: string
  diff?: string
  loading?: boolean
  error?: string
  [key: string]: unknown
}

export interface ForkWorkspace {
  path: string
  type: 'worktree' | 'copy'
  branchName?: string
  mainRepoPath: string
  baseRef?: string
}

export interface PtySpawnOptions {
  ptyId: string
  cwd: string
  cols: number
  rows: number
  command?: string
  args?: string[]
  env?: Record<string, string>
}

export interface CanvasNodeSnapshot {
  id: string
  type: string
  position: { x: number; y: number }
  data: TerminalNodeData
  width?: number
  height?: number
}

export interface CanvasSnapshot {
  id: string
  name: string
  nodes: CanvasNodeSnapshot[]
  edges: { id: string; source: string; target: string; type?: string; data?: any }[]
}

export interface ElectronAPI {
  pty: {
    spawn: (opts: PtySpawnOptions) => Promise<void>
    input: (ptyId: string, data: string) => void
    resize: (ptyId: string, cols: number, rows: number) => void
    kill: (ptyId: string) => void
    onOut: (cb: (ptyId: string, data: string) => void) => () => void
    onExit: (cb: (ptyId: string, code: number) => void) => () => void
  }
  opencode: {
    sessionList: (cwd?: string) => Promise<any[]>
    detectSession: (cwd: string) => Promise<string | null>
    run: (cwd: string, args: string[]) => Promise<string>
  }
  git: {
    worktreeAdd: (repoPath: string, branchName: string) => Promise<string>
    worktreeRemove: (path: string) => Promise<void>
    isRepo: (path: string) => Promise<boolean>
    diff: (worktree: string, base?: string) => Promise<string>
  }
  workspace: {
    prepare: (projectDir: string, nodeId: string) => Promise<ForkWorkspace>
    diff: (ws: ForkWorkspace) => Promise<string>
    apply: (ws: ForkWorkspace) => Promise<{ ok: boolean; message: string }>
    remove: (ws: ForkWorkspace) => Promise<void>
  }
  dialog: {
    pickDirectory: () => Promise<string | null>
  }
  canvas: {
    onForkRequested: (cb: (parentNodeId: string) => void) => () => void
  }
}
