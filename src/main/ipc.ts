import { ipcMain, dialog, BrowserWindow } from 'electron'
import { spawnPty, writePty, resizePty, killPty } from './pty'
import { sessionList, detectSession, runRaw } from './opencode'
import { worktreeAdd, worktreeRemove, isRepo, gitDiff } from './worktree'
import type { PtySpawnOptions } from '../shared/types'

export function registerIpc(): void {
  // ---- pty ----
  ipcMain.handle('pty:spawn', (_e, opts: PtySpawnOptions) => {
    spawnPty(opts)
  })

  ipcMain.on('pty:input', (_e, ptyId: string, data: string) => {
    writePty(ptyId, data)
  })

  ipcMain.on('pty:resize', (_e, ptyId: string, cols: number, rows: number) => {
    resizePty(ptyId, cols, rows)
  })

  ipcMain.on('pty:kill', (_e, ptyId: string) => {
    killPty(ptyId)
  })

  // ---- opencode ----
  // Note: session forking is handled natively by spawning the terminal with
  // `opencode --session <id> --fork` (see TerminalNode). No server-side fork step needed.

  ipcMain.handle('opencode:sessionList', async (_e, cwd?: string) => {
    return sessionList(cwd)
  })

  ipcMain.handle('opencode:detectSession', async (_e, cwd: string) => {
    return detectSession(cwd)
  })

  ipcMain.handle('opencode:run', async (_e, cwd: string, args: string[]) => {
    return runRaw(cwd, args)
  })

  // ---- git ----
  ipcMain.handle('git:worktreeAdd', async (_e, repoPath: string, branchName: string) => {
    return worktreeAdd(repoPath, branchName)
  })

  ipcMain.handle('git:worktreeRemove', async (_e, path: string) => {
    await worktreeRemove(path)
  })

  ipcMain.handle('git:isRepo', async (_e, path: string) => {
    return isRepo(path)
  })

  ipcMain.handle('git:diff', async (_e, worktree: string, base?: string) => {
    return gitDiff(worktree, base)
  })

  // ---- dialog ----
  ipcMain.handle('dialog:pickDirectory', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })
}
