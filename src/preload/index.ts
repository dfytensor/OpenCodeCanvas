import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronAPI, OccEvent } from '../shared/types'

const api: ElectronAPI = {
  dialog: {
    pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory')
  },
  occ: {
    serverStatus: () => ipcRenderer.invoke('occ:serverStatus'),
    models: () => ipcRenderer.invoke('occ:models'),
    updatePolicy: (patch) => ipcRenderer.invoke('occ:updatePolicy', patch),
    setEngine: (engine) => ipcRenderer.invoke('occ:setEngine', engine),
    openProject: (rootDir) => ipcRenderer.invoke('occ:openProject', rootDir),
    closeProject: () => ipcRenderer.invoke('occ:closeProject'),
    getGraph: () => ipcRenderer.invoke('occ:getGraph'),
    createNode: (plan, opts) => ipcRenderer.invoke('occ:createNode', plan, opts),
    inspectNode: (nodeId) => ipcRenderer.invoke('occ:inspectNode', nodeId),
    freezeNode: (nodeId) => ipcRenderer.invoke('occ:freezeNode', nodeId),
    unfreezeNode: (nodeId) => ipcRenderer.invoke('occ:unfreezeNode', nodeId),
    archiveNode: (nodeId) => ipcRenderer.invoke('occ:archiveNode', nodeId),
    sendToNode: (nodeId, message) => ipcRenderer.invoke('occ:sendToNode', nodeId, message),
    abortNode: (nodeId) => ipcRenderer.invoke('occ:abortNode', nodeId),
    nodeDiff: (nodeId) => ipcRenderer.invoke('occ:nodeDiff', nodeId),
    applyNode: (nodeId) => ipcRenderer.invoke('occ:applyNode', nodeId),
    runPipeline: (opts) => ipcRenderer.invoke('occ:runPipeline', opts),
    runAdaptive: (opts) => ipcRenderer.invoke('occ:runAdaptive', opts),
    createChat: () => ipcRenderer.invoke('occ:createChat'),
    chatSend: (chatId, text) => ipcRenderer.invoke('occ:chatSend', chatId, text),
    chatLog: (chatId) => ipcRenderer.invoke('occ:chatLog', chatId),
    onEvent: (cb) => {
      const handler = (_e: unknown, event: OccEvent) => cb(event)
      ipcRenderer.on('occ:event', handler)
      return () => ipcRenderer.removeListener('occ:event', handler)
    }
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)
