import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronAPI } from '../shared/types'

const api: ElectronAPI = {
  pty: {
    spawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),
    input: (ptyId, data) => ipcRenderer.send('pty:input', ptyId, data),
    resize: (ptyId, cols, rows) => ipcRenderer.send('pty:resize', ptyId, cols, rows),
    kill: (ptyId) => ipcRenderer.send('pty:kill', ptyId),
    onOut: (cb) => {
      const handler = (_e: unknown, ptyId: string, data: string) => cb(ptyId, data)
      ipcRenderer.on('pty:out', handler)
      return () => ipcRenderer.removeListener('pty:out', handler)
    },
    onExit: (cb) => {
      const handler = (_e: unknown, ptyId: string, code: number) => cb(ptyId, code)
      ipcRenderer.on('pty:exit', handler)
      return () => ipcRenderer.removeListener('pty:exit', handler)
    }
  },
  opencode: {
    sessionList: (cwd?: string) => ipcRenderer.invoke('opencode:sessionList', cwd),
    detectSession: (cwd) => ipcRenderer.invoke('opencode:detectSession', cwd),
    run: (cwd, args) => ipcRenderer.invoke('opencode:run', cwd, args)
  },
  git: {
    worktreeAdd: (repoPath, branchName) =>
      ipcRenderer.invoke('git:worktreeAdd', repoPath, branchName),
    worktreeRemove: (path) => ipcRenderer.invoke('git:worktreeRemove', path),
    isRepo: (path) => ipcRenderer.invoke('git:isRepo', path),
    diff: (worktree, base) => ipcRenderer.invoke('git:diff', worktree, base)
  },
  workspace: {
    prepare: (projectDir, nodeId) =>
      ipcRenderer.invoke('workspace:prepare', projectDir, nodeId),
    diff: (ws) => ipcRenderer.invoke('workspace:diff', ws),
    apply: (ws) => ipcRenderer.invoke('workspace:apply', ws),
    remove: (ws) => ipcRenderer.invoke('workspace:remove', ws)
  },
  dialog: {
    pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory')
  },
  canvas: {
    onForkRequested: (cb) => {
      const handler = (_e: unknown, parentNodeId: string) => cb(parentNodeId)
      ipcRenderer.on('canvas:forkRequested', handler)
      return () => ipcRenderer.removeListener('canvas:forkRequested', handler)
    }
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)
