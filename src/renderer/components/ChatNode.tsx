import { useEffect, useRef, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { ChatEntry, NodeStatus, SessionNode } from '../../shared/types'
import { useOccStore } from '../store/occStore'

const STATUS_DOT: Record<NodeStatus, string> = {
  draft: 'bg-gray-500',
  provisioning: 'bg-blue-400 occ-breathe',
  running: 'bg-canvas-accent occ-breathe',
  awaiting_input: 'bg-amber-400 occ-blink',
  completed: 'bg-emerald-500',
  failed: 'bg-red-500',
  aborted: 'bg-orange-500',
  frozen: 'bg-slate-400',
  archived: 'bg-slate-600'
}

const ROLE_STYLE: Record<string, string> = {
  user: 'border-canvas-accent/50 bg-canvas-accent/10 text-gray-100',
  manager: 'border-canvas-fork/40 bg-canvas-fork/5 text-gray-300',
  worker: 'border-canvas-border bg-canvas-node/60 text-gray-400',
  final: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-100'
}

const ROLE_TAG: Record<string, string> = {
  user: 'you',
  manager: 'manager',
  worker: 'agent',
  final: 'result'
}

// stable empty ref — a fresh [] in the selector would re-render forever
const EMPTY_LOG: ChatEntry[] = []

// A chat window that lives ON the canvas. Typing a goal here grows the
// execution graph to the right of this node until the task completes.
export const ChatNode = ({ id, data, selected }: NodeProps): React.ReactElement => {
  const node = (data as { node: SessionNode }).node
  const log = useOccStore((s) => s.chats[id]) ?? EMPTY_LOG
  const sendChat = useOccStore((s) => s.sendChat)
  const loadChatLog = useOccStore((s) => s.loadChatLog)
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const busy = node.status === 'running'

  useEffect(() => {
    void loadChatLog(id)
  }, [id, loadChatLog])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [log.length])

  const send = (): void => {
    const text = input.trim()
    if (!text || busy) return
    void sendChat(id, text)
    setInput('')
  }

  return (
    <div
      className={`occ-born flex w-[360px] flex-col overflow-hidden rounded-xl border bg-canvas-node/95 shadow-lg backdrop-blur ${
        selected ? 'border-canvas-accent shadow-[0_0_18px_rgba(47,129,247,0.35)]' : 'border-canvas-border'
      }`}
    >
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-none !bg-gray-500" />

      <div className="flex items-center gap-2 border-b border-canvas-border px-3 py-2">
        <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[node.status]}`} />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-200">{node.title}</span>
        {busy && <span className="text-[9px] text-canvas-accent">growing…</span>}
      </div>

      <div ref={scrollRef} className="flex h-[260px] flex-col gap-1.5 overflow-y-auto p-2">
        {log.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <p className="text-[11px] text-gray-400">Describe a goal —</p>
            <p className="mt-1 text-[10px] leading-relaxed text-gray-600">
              the manager decomposes it into opencode workers; the graph grows to the right until done.
            </p>
          </div>
        )}
        {log.map((c) => (
          <div key={c.id} className={`rounded-lg border px-2 py-1 ${ROLE_STYLE[c.role] ?? ROLE_STYLE.worker}`}>
            <div className="mb-0.5 flex items-center gap-1.5">
              <span className="text-[8px] font-bold uppercase tracking-wider opacity-60">{ROLE_TAG[c.role] ?? c.role}</span>
              <span className="text-[8px] opacity-40">{c.time}</span>
            </div>
            <p className="whitespace-pre-wrap break-words text-[10px] leading-relaxed">{c.text}</p>
          </div>
        ))}
      </div>

      <div className="flex items-end gap-1 border-t border-canvas-border p-2">
        <textarea
          className="h-11 min-w-0 flex-1 resize-none rounded-lg border border-canvas-border bg-canvas-bg px-2 py-1.5 text-[11px] text-gray-200 outline-none focus:border-canvas-accent"
          placeholder={busy ? 'working…' : 'describe the goal…'}
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button
          className="shrink-0 rounded-lg bg-canvas-accent px-3 py-2 text-[11px] font-medium text-white hover:brightness-110 disabled:opacity-40"
          disabled={busy || !input.trim()}
          onClick={send}
        >
          send
        </button>
      </div>
    </div>
  )
}
