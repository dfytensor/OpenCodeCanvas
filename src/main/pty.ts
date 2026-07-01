import { spawn, IPty } from 'node-pty'
import { BrowserWindow } from 'electron'
import type { PtySpawnOptions } from '../shared/types'

const ptys = new Map<string, IPty>()

function activeWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

export function spawnPty(opts: PtySpawnOptions): void {
  if (ptys.has(opts.ptyId)) {
    killPty(opts.ptyId)
  }

  let file: string
  let args: string[]
  if (opts.command) {
    if (process.platform === 'win32') {
      // Global tools (npm shims, etc.) are .cmd/.bat/.ps1, not .exe.
      // CreateProcess ignores PATHEXT, so route through cmd.exe which resolves
      // PATH + PATHEXT and finds the shim.
      file = process.env.COMSPEC ?? 'cmd.exe'
      args = ['/c', opts.command, ...(opts.args ?? [])]
    } else {
      file = opts.command
      args = opts.args ?? []
    }
  } else {
    file = process.env.COMSPEC ?? (process.platform === 'win32' ? 'powershell.exe' : 'bash')
    args = []
  }

  const ptyProc = spawn(file, args, {
    name: 'xterm-color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd && opts.cwd.length > 0 ? opts.cwd : process.cwd(),
    env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>
  })

  ptys.set(opts.ptyId, ptyProc)

  ptyProc.onData((data) => {
    const win = activeWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('pty:out', opts.ptyId, data)
    }
  })

  ptyProc.onExit(({ exitCode }) => {
    const win = activeWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('pty:exit', opts.ptyId, exitCode)
    }
    ptys.delete(opts.ptyId)
  })
}

export function writePty(ptyId: string, data: string): void {
  ptys.get(ptyId)?.write(data)
}

export function resizePty(ptyId: string, cols: number, rows: number): void {
  ptys.get(ptyId)?.resize(Math.max(1, cols), Math.max(1, rows))
}

export function killPty(ptyId: string): void {
  const proc = ptys.get(ptyId)
  if (proc) {
    try {
      proc.kill()
    } catch {
      // already dead
    }
    ptys.delete(ptyId)
  }
}

export function killAll(): void {
  for (const id of ptys.keys()) killPty(id)
}
