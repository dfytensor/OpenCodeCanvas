// Collapsible left panel listing every chat in the project — status, tokens,
// one-click focus, status filters and the long-age "收纳已完成" batch action.
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

type Filter = 'all' | 'active' | 'done' | 'dormant'

const ACTIVE = new Set(['running', 'awaiting_input', 'provisioning', 'draft'])
const DORMANT = new Set(['frozen', 'archived'])

export function ChatSidebar(): React.ReactElement | null {
  const open = useOccStore((s) => s.sidebarOpen)
  const graph = useOccStore((s) => s.graph)
  const requestFocus = useOccStore((s) => s.requestFocus)
  const createChat = useOccStore((s) => s.createChat)
  const freeze = useOccStore((s) => s.freeze)
  const unfreeze = useOccStore((s) => s.unfreeze)
  const freezeMany = useOccStore((s) => s.freezeMany)
  const focusNode = useOccStore((s) => s.focusNode)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  if (!open || !graph) return null

  const all = Object.values(graph.nodes).filter((n) => n.kind === 'root' && n.parents.length === 0)
  const counts: Record<Filter, number> = {
    all: all.length,
    active: all.filter((n) => ACTIVE.has(n.status)).length,
    done: all.filter((n) => n.status === 'completed').length,
    dormant: all.filter((n) => DORMANT.has(n.status)).length
  }
  const chats = all
    .filter((n) =>
      filter === 'all' ? true : filter === 'active' ? ACTIVE.has(n.status) : filter === 'done' ? n.status === 'completed' : DORMANT.has(n.status)
    )
    .filter((n) => !query || n.title.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))

  // batch: freeze every completed chat (reversible; leaves the canvas)
  const completedReady = all.filter((n) => n.status === 'completed')
  const batchFreeze = (): void => {
    if (completedReady.length === 0) return
    const ok = window.confirm(`冻结全部 ${completedReady.length} 个已完成的聊天？\n它们会从画布移出，随时可在「已收纳」里解冻。`)
    if (ok) void freezeMany(completedReady.map((n) => n.id))
  }

  const FILTERS: Array<[Filter, string]> = [
    ['all', '全部'],
    ['active', '活跃'],
    ['done', '已完成'],
    ['dormant', '已收纳']
  ]

  return (
    <div data-occ="chat-sidebar" className="absolute left-3 top-14 z-20 flex max-h-[70%] w-64 flex-col overflow-hidden rounded-lg border border-canvas-border bg-canvas-node/95 shadow-xl backdrop-blur">
      <div className="flex items-center gap-2 border-b border-canvas-border px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">聊天 · {counts.all}</span>
        <div className="flex-1" />
        <button
          className="rounded px-1.5 text-[11px] text-gray-400 transition-colors hover:text-canvas-accent"
          onClick={() => void createChat().then((id) => { if (id) requestFocus(id) })}
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
      <div className="flex gap-1 border-b border-canvas-border px-2 py-1.5">
        {FILTERS.map(([k, label]) => (
          <button
            key={k}
            data-occ={'sidebar-filter-' + k}
            onClick={() => setFilter(k)}
            className={`rounded-md px-1.5 py-0.5 text-[9px] transition-colors ${
              filter === k ? 'bg-canvas-accent/20 text-canvas-accent' : 'text-gray-500 hover:bg-canvas-border hover:text-gray-300'
            }`}
          >
            {label} {counts[k]}
          </button>
        ))}
      </div>
      {completedReady.length > 0 && (
        <div className="border-b border-canvas-border px-2 py-1.5">
          <button
            data-occ="freeze-completed"
            onClick={batchFreeze}
            title="冻结所有已完成的聊天（从画布移出，可解冻）"
            className="w-full rounded-md border border-canvas-border px-2 py-1 text-[10px] text-gray-400 transition-colors hover:border-slate-400 hover:text-slate-200"
          >
            ❄ 收纳已完成（{completedReady.length}）
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {chats.length === 0 && (
          <p className="px-2 py-3 text-center text-[10px] text-gray-600">
            {query ? '无匹配' : filter === 'done' ? '还没有已完成的聊天' : filter === 'dormant' ? '没有已收纳的聊天' : '还没有聊天 — 点 ＋ 开始'}
          </p>
        )}
        {chats.map((c) => {
          const active = focusNode === c.id
          const freezable = c.status === 'completed' || c.status === 'running' || c.status === 'aborted'
          const isFrozen = c.status === 'frozen'
          return (
            <div
              key={c.id}
              data-occ="chat-list-item"
              data-node-id={c.id}
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
              {(freezable || isFrozen) && (
                <button
                  data-occ={isFrozen ? 'unfreeze-chat' : 'freeze-chat'}
                  className="shrink-0 text-[9px] text-gray-600 opacity-0 transition-opacity hover:text-slate-300 group-hover:opacity-100"
                  title={isFrozen ? '解冻（重新出现在画布）' : '冻结（移出画布，可解冻）'}
                  onClick={(e) => {
                    e.stopPropagation()
                    void (isFrozen ? unfreeze(c.id) : freeze(c.id))
                  }}
                >
                  {isFrozen ? '♨' : '❄'}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
