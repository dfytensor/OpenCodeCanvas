// Collapsible left panel listing every chat in the project — status, tokens,
// one-click focus. Solves "I have five chats somewhere on this canvas".
import { useState } from 'react'
import { useOccStore } from '../store/occStore'

const DOT: Record<string, string> = {
  running: 'bg-canvas-accent occ-breathe',
  awaiting_input: 'bg-amber-400 occ-blink',
  completed: 'bg-emerald-500',
  failed: 'bg-red-500',
  aborted: 'bg-orange-500',
  draft: 'bg-gray-500',
  provisioning: 'bg-blue-400 occ-breathe',
  frozen: 'bg-slate-400',
  archived: 'bg-slate-600'
}

export function ChatSidebar(): React.ReactElement | null {
  const open = useOccStore((s) => s.sidebarOpen)
  const graph = useOccStore((s) => s.graph)
  const requestFocus = useOccStore((s) => s.requestFocus)
  const createChat = useOccStore((s) => s.createChat)
  const freeze = useOccStore((s) => s.freeze)
  const focusNode = useOccStore((s) => s.focusNode)
  const [query, setQuery] = useState('')
  if (!open || !graph) return null

  const chats = Object.values(graph.nodes)
    .filter((n) => n.kind === 'root' && n.parents.length === 0)
    .filter((n) => !query || n.title.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))

  return (
    <div data-occ="chat-sidebar" className="absolute left-3 top-14 z-20 flex max-h-[70%] w-60 flex-col overflow-hidden rounded-lg border border-canvas-border bg-canvas-node/95 shadow-xl backdrop-blur">
      <div className="flex items-center gap-2 border-b border-canvas-border px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">聊天 · {chats.length}</span>
        <div className="flex-1" />
        <button
          className="rounded px-1.5 text-[11px] text-gray-400 transition-colors hover:text-canvas-accent"
          onClick={() => void createChat()}
          title="新建聊天"
        >
          ＋
        </button>
      </div>
      <div className="border-b border-canvas-border px-2 py-1.5">
        <input
          className="w-full rounded-md border border-canvas-border bg-canvas-bg px-2 py-1 text-[10px] text-gray-300 outline-none focus:border-canvas-accent"
          placeholder="搜索聊天…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {chats.length === 0 && (
          <p className="px-2 py-3 text-center text-[10px] text-gray-600">{query ? '无匹配' : '还没有聊天 — 点 ＋ 开始'}</p>
        )}
        {chats.map((c) => {
          const active = focusNode === c.id
          const freezable = c.status === 'completed' || c.status === 'running' || c.status === 'aborted'
          return (
            <div
              key={c.id}
              data-occ="chat-list-item"
              className={`group mb-1 flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-canvas-border ${
                active ? 'bg-canvas-accent/15' : ''
              }`}
              onClick={() => requestFocus(c.id)}
            >
              <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${DOT[c.status] ?? 'bg-gray-500'}`} />
              <span className="min-w-0 flex-1 truncate text-[11px] text-gray-300">{c.title}</span>
              {c.tokenUsage && c.tokenUsage.input + c.tokenUsage.output > 0 ? (
                <span className="shrink-0 text-[9px] text-gray-600">
                  {((c.tokenUsage.input + c.tokenUsage.output) / 1000).toFixed(1)}k
                </span>
              ) : null}
              <button
                className="shrink-0 text-[9px] text-gray-600 opacity-0 transition-opacity hover:text-slate-300 group-hover:opacity-100"
                title="冻结（归档前置步骤，从活跃列表移出）"
                onClick={(e) => {
                  e.stopPropagation()
                  if (freezable) void freeze(c.id)
                }}
              >
                ❄
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
