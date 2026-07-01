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
  [key: string]: unknown
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
  dialog: {
    pickDirectory: () => Promise<string | null>
  }
  canvas: {
    onForkRequested: (cb: (parentNodeId: string) => void) => () => void
  }
}
