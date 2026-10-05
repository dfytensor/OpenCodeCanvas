// Collapsible left panel listing every chat in the project — status, tokens,
// one-click focus. Solves "I have five chats somewhere on this canvas".
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
  const focusNode = useOccStore((s) => s.focusNode)
  if (!open || !graph) return null

  const chats = Object.values(graph.nodes)
    .filter((n) => n.kind === 'root' && n.parents.length === 0)
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))

  return (
    <div className="absolute left-3 top-14 z-20 flex max-h-[70%] w-60 flex-col overflow-hidden rounded-lg border border-canvas-border bg-canvas-node/95 shadow-xl backdrop-blur">
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
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {chats.length === 0 && (
          <p className="px-2 py-3 text-center text-[10px] text-gray-600">还没有聊天 — 点 ＋ 开始</p>
        )}
        {chats.map((c) => {
          const active = focusNode === c.id
          return (
            <button
              key={c.id}
              className={`mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-canvas-border ${
                active ? 'bg-canvas-accent/15' : ''
              }`}
              onClick={() => requestFocus(c.id)}
            >
              <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${DOT[c.status] ?? 'bg-gray-500'}`} />
              <span className="min-w-0 flex-1 truncate text-[11px] text-gray-300">{c.title}</span>
              {c.tokenUsage && c.tokenUsage.input + c.tokenUsage.output > 0 && (
                <span className="shrink-0 text-[9px] text-gray-600">
                  {((c.tokenUsage.input + c.tokenUsage.output) / 1000).toFixed(1)}k
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
