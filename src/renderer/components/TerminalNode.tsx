import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Handle,
  Position,
  type NodeProps,
  type Node
} from '@xyflow/react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SerializeAddon } from '@xterm/addon-serialize'
import clsx from 'clsx'
import { registerTerminal, unregisterTerminal } from '../lib/terminalRegistry'
import { useCanvasStore } from '../store/canvasStore'
import { ContextMenu, type MenuEntry } from './ContextMenu'
import { EditableTitle } from './EditableTitle'
import type { TerminalNodeData } from '../../shared/types'

const TERMINAL_THEME = {
  background: '#010409',
  foreground: '#c9d1d9',
  cursor: '#58a6ff',
  selectionBackground: '#264f78',
  black: '#484f58',
  red: '#ff7b72',
  green: '#7ee787',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc'
}

interface AttachResult {
  terminal: Terminal
  dispose: () => void
  fit: () => void
}

type TermNode = Node<TerminalNodeData, 'terminal'>

export function TerminalNode({ id, data, selected }: NodeProps<TermNode>): React.ReactElement {
  const bodyRef = useRef<HTMLDivElement>(null)
  const fsRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const serializeRef = useRef<SerializeAddon | null>(null)
  const disposerRef = useRef<(() => void) | null>(null)
  const spawnedRef = useRef(false)
  const deadRef = useRef(false)
  const spawnEpochRef = useRef(0)
  const kickoffRef = useRef(false)
  const frozenRef = useRef(false)

  const [fullscreen, setFullscreen] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [status, setStatus] = useState<'starting' | 'ready' | 'dead'>('starting')
  const [forking, setForking] = useState(false)

  const removeNode = useCanvasStore((s) => s.removeNode)
  const forkNode = useCanvasStore((s) => s.forkNode)
  const applyFork = useCanvasStore((s) => s.applyFork)
  const addDiffNode = useCanvasStore((s) => s.addDiffNode)
  const updateNodeData = useCanvasStore((s) => s.updateNodeData)

  // A terminal that has been forked/merged-from is FROZEN: it can only spawn
  // more forks, it cannot continue the conversation (input is locked).
  const hasChildren = useCanvasStore((s) =>
    s.canvases.some((c) =>
      c.edges.some((e) => {
        if (e.source !== id) return false
        const k = (e.data as { kind?: string } | undefined)?.kind
        return k === 'fork' || k === 'merge'
      })
    )
  )
  const frozen = data.mode === 'opencode' && hasChildren
  useEffect(() => {
    frozenRef.current = frozen
  }, [frozen])

  function attachTo(container: HTMLElement): AttachResult {
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      theme: TERMINAL_THEME,
      allowProposedApi: true
    })
    const fit = new FitAddon()
    const links = new WebLinksAddon()
    const serialize = new SerializeAddon()
    terminal.loadAddon(fit)
    terminal.loadAddon(links)
    terminal.loadAddon(serialize)
    terminal.open(container)
    try {
      fit.fit()
    } catch {
      // container not laid out yet; will refit via observer
    }
    registerTerminal(data.ptyId, terminal)
    termRef.current = terminal
    fitRef.current = fit
    serializeRef.current = serialize

    const onDataDisp = terminal.onData((d) => {
      if (frozenRef.current) return
      window.electronAPI.pty.input(data.ptyId, d)
    })

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        const t = termRef.current
        if (t) window.electronAPI.pty.resize(data.ptyId, t.cols, t.rows)
      } catch {
        // ignore
      }
    })
    ro.observe(container)

    const dispose = (): void => {
      onDataDisp.dispose()
      ro.disconnect()
      terminal.dispose()
      if (termRef.current === terminal) termRef.current = null
      if (fitRef.current === fit) fitRef.current = null
      if (serializeRef.current === serialize) serializeRef.current = null
    }
    return { terminal, dispose, fit: () => fit.fit() }
  }

  // --- pty lifecycle: spawn once, kill on unmount ---
  useEffect(() => {
    const isOc = data.mode === 'opencode'
    const command = isOc ? 'opencode' : undefined
    let args: string[] = []
    if (isOc) {
      if (data.sessionId) {
        // resume a specific session in this terminal's cwd (forks use the
        // session that was imported into this folder; roots detect their own)
        args = ['--session', data.sessionId]
      } else if (data.forkParentSession) {
        // legacy session branch: fork the parent conversation
        args = ['--session', data.forkParentSession, '--fork']
      }
    }
    setStatus('starting')
    spawnEpochRef.current = Date.now()
    window.electronAPI.pty
      .spawn({
        ptyId: data.ptyId,
        cwd: data.cwd,
        cols: 100,
        rows: 26,
        command,
        args
      })
      .then(() => {
        setStatus('ready')
        // Merge nodes auto-kick the merge task once the agent is up. Best-effort:
        // if the TUI isn't ready yet the keystrokes are simply lost and the user
        // can resend (the full instructions live in MERGE_TASK.md).
        if (data.kind === 'merge' && !kickoffRef.current) {
          kickoffRef.current = true
          setTimeout(() => {
            window.electronAPI.pty.input(
              data.ptyId,
              'Read MERGE_TASK.md and merge all listed branches\' changes into the current directory.\r'
            )
          }, 1500)
        }
      })
      .catch((e) => {
        setStatus('dead')
        const t = termRef.current
        t?.write(`\r\n\x1b[31mFailed to spawn terminal: ${String(e)}\x1b[0m\r\n`)
      })

    const offExit = window.electronAPI.pty.onExit((ptyId, code) => {
      if (ptyId !== data.ptyId) return
      deadRef.current = true
      setStatus('dead')
      termRef.current?.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`)
    })

    // best-effort: resolve this node's own session id (enables fork). Retries
    // internally so it works whether the session is created at startup or on
    // first message.
    let cancelled = false
    if (isOc && !data.sessionId) {
      void resolveSession().then((found) => {
        if (!cancelled && found && !deadRef.current) {
          updateNodeData(id, {
            sessionId: found.id,
            ...(found.title ? { title: found.title } : {})
          })
        }
      })
    }

    return () => {
      cancelled = true
      offExit()
      unregisterTerminal(data.ptyId)
      if (!deadRef.current) window.electronAPI.pty.kill(data.ptyId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- terminal attach/dispose on mount + fullscreen toggle ---
  useEffect(() => {
    const container = fullscreen ? fsRef.current : bodyRef.current
    if (!container) return

    const snapshot = serializeRef.current?.serialize() ?? ''
    disposerRef.current?.()
    const attached = attachTo(container)
    disposerRef.current = attached.dispose
    if (snapshot) attached.terminal.write(snapshot)
    attached.terminal.focus()
    requestAnimationFrame(() => attached.fit())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen])

  const canFork = data.mode === 'opencode' && !forking

  // Locate this terminal's own OpenCode session by matching the working
  // directory + creation time. The CLI listing has no parentID, so we identify
  // the session as the newest one created at/after this node spawned in cwd.
  const resolveSession = async (): Promise<{ id: string; title?: string } | null> => {
    if (data.sessionId) return { id: data.sessionId }
    const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '')
    const target = norm(data.cwd)
    for (let i = 0; i < 8; i++) {
      if (deadRef.current) return null
      try {
        const sessions = await window.electronAPI.opencode.sessionList(data.cwd)
        const hit = sessions
          .filter((s: { directory?: unknown }) => norm(String(s.directory ?? '')) === target)
          .filter((s: { created?: unknown }) => Number(s.created ?? 0) >= spawnEpochRef.current - 3000)
          .sort(
            (a: { created?: unknown }, b: { created?: unknown }) =>
              Number(b.created ?? 0) - Number(a.created ?? 0)
          )[0]
        if (hit?.id) return { id: String(hit.id), title: hit.title ? String(hit.title) : undefined }
      } catch {
        // ignore transient failure, retry
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
    return null
  }

  const doFork = async (): Promise<void> => {
    setForking(true)
    try {
      const found = await resolveSession()
      if (found && found.id !== data.sessionId) {
        updateNodeData(id, {
          sessionId: found.id,
          ...(found.title ? { title: found.title } : {})
        })
      }
      if (!found) {
        termRef.current?.write(
          '\r\n\x1b[31mNo OpenCode session found — send a message in the terminal first, then fork.\x1b[0m\r\n'
        )
        return
      }
      await forkNode(id)
    } catch (e) {
      termRef.current?.write(`\r\n\x1b[31mFork failed: ${String(e)}\x1b[0m\r\n`)
    } finally {
      setForking(false)
    }
  }

  const doApply = async (): Promise<void> => {
    try {
      const res = await applyFork(id)
      termRef.current?.write(
        `\r\n\x1b[${res.ok ? '32' : '31'}m[apply] ${res.message}\x1b[0m\r\n`
      )
    } catch (e) {
      termRef.current?.write(`\r\n\x1b[31mApply failed: ${String(e)}\x1b[0m\r\n`)
    }
  }

  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const menuItems: MenuEntry[] = [
    {
      id: 'fullscreen',
      label: fullscreen ? 'Exit fullscreen' : 'Fullscreen',
      icon: '⤢',
      onSelect: () => setFullscreen((v) => !v)
    },
    {
      id: 'rename',
      label: 'Rename…',
      icon: '✎',
      onSelect: () => setRenaming(true)
    },
    {
      id: 'fork',
      label: 'Fork from here',
      icon: '⑂',
      disabled: !canFork,
      onSelect: () => void doFork()
    },
    {
      id: 'restart',
      label: 'Restart terminal',
      icon: '↻',
      disabled: status === 'dead' ? false : true,
      onSelect: () => {
        deadRef.current = false
        spawnedRef.current = false
        const isOc = data.mode === 'opencode'
        let args: string[] = []
        if (isOc) {
          if (data.sessionId) args = ['--session', data.sessionId]
          else if (data.forkParentSession) args = ['--session', data.forkParentSession, '--fork']
        }
        window.electronAPI.pty
          .spawn({ ptyId: data.ptyId, cwd: data.cwd, cols: 100, rows: 26, command: isOc ? 'opencode' : undefined, args })
          .then(() => setStatus('ready'))
        setStatus('starting')
      }
    },
    { id: 'sep', separator: true },
    {
      id: 'close',
      label: 'Delete node',
      icon: '✕',
      danger: true,
      onSelect: () => removeNode(id)
    }
  ]

  return (
    <>
      <div
        className={clsx(
          'terminal-node',
          selected && 'ring-2 ring-canvas-accent',
          data.kind === 'fork' && 'ring-1 ring-canvas-fork/50',
          data.kind === 'merge' && 'ring-1 ring-green-500/50'
        )}
        style={{ width: '100%', height: '100%' }}
        onContextMenu={onContextMenu}
      >
        <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-canvas-fork/70" />
        <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-canvas-accent/70" />

        <div className="terminal-node__header flex select-none items-center gap-2 border-b border-canvas-border bg-canvas-node px-2.5 py-1.5">
          <EditableTitle
            value={data.title}
            editing={renaming}
            onEditingChange={setRenaming}
            onCommit={(t) => updateNodeData(id, { title: t })}
            className="text-sm font-medium text-gray-100"
          />
          {data.mode === 'opencode' && (
            <span className="rounded bg-canvas-accent/20 px-1.5 py-0.5 text-[10px] font-semibold text-canvas-accent">
              opencode
            </span>
          )}
          {data.kind === 'fork' && (
            <span className="rounded bg-canvas-fork/20 px-1.5 py-0.5 text-[10px] font-semibold text-canvas-fork">
              fork
            </span>
          )}
          {data.kind === 'merge' && (
            <span className="rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-green-400">
              merge
            </span>
          )}
          {frozen && (
            <span
              className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400"
              title="This branch has been forked — input locked. You can still fork from it."
            >
              frozen
            </span>
          )}
          <span
            className={clsx(
              'ml-0.5 inline-block h-1.5 w-1.5 rounded-full',
              status === 'ready' ? 'bg-green-500' : status === 'starting' ? 'bg-amber-400' : 'bg-red-500'
            )}
            title={status}
          />
          <div className="flex-1" />
          {data.mode === 'opencode' && (
            <button
              onClick={() => void doFork()}
              disabled={!canFork}
              title="Fork this session"
              className="rounded px-1.5 text-xs text-canvas-fork hover:bg-canvas-fork/20 disabled:opacity-30"
            >
              {forking ? '…' : '⑂'}
            </button>
          )}
          {(data.kind === 'fork' || data.kind === 'merge') && data.workspaceType && (
            <>
              <button
                onClick={() => addDiffNode(id)}
                title="Show diff (changes in this branch)"
                className="rounded px-1.5 text-xs text-canvas-accent hover:bg-canvas-accent/20"
              >
                ⌗
              </button>
              <button
                onClick={() => void doApply()}
                title="Apply this branch's changes back to main"
                className="rounded px-1.5 text-xs text-green-400 hover:bg-green-500/20"
              >
                ⬇
              </button>
            </>
          )}
          <button
            onClick={() => setFullscreen((v) => !v)}
            title="Fullscreen"
            className="rounded px-1.5 text-xs text-gray-400 hover:bg-canvas-border hover:text-white"
          >
            ⤢
          </button>
          <button
            onClick={() => removeNode(id)}
            title="Close"
            className="rounded px-1.5 text-xs text-gray-400 hover:bg-red-500/20 hover:text-red-400"
          >
            ✕
          </button>
        </div>

        <div className="terminal-node__body">
          {fullscreen ? (
            <div className="flex h-full items-center justify-center text-xs text-gray-600">fullscreen active →</div>
          ) : (
            <div ref={bodyRef} className="h-full w-full" />
          )}
        </div>
      </div>

      {fullscreen &&
        createPortal(
          <div className="terminal-fullscreen flex flex-col">
            <div className="flex items-center gap-2 border-b border-canvas-border bg-canvas-node px-3 py-2">
              <span className="text-sm font-medium text-gray-100">{data.title}</span>
              {data.kind === 'fork' && (
                <span className="rounded bg-canvas-fork/20 px-1.5 py-0.5 text-[10px] text-canvas-fork">fork</span>
              )}
              {data.kind === 'merge' && (
                <span className="rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] text-green-400">merge</span>
              )}
              <div className="flex-1" />
              <button
                onClick={() => setFullscreen(false)}
                className="rounded-md border border-canvas-border px-2 py-1 text-xs text-gray-200 hover:bg-canvas-border"
              >
                Exit fullscreen (Esc)
              </button>
            </div>
            <div ref={fsRef} className="flex-1" />
          </div>,
          document.body
        )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
    </>
  )
}
