// Bottom-right toast stack: pings the user when a chat needs their input or
// finishes, even if the relevant chat node is off-screen. Also flashes the
// OS taskbar via the main process.
import { useEffect, useRef, useState } from 'react'
import type { NodeID } from '../../shared/types'
import { useOccStore } from '../store/occStore'

interface Toast {
  key: string
  text: string
  chatId?: NodeID
  tone: 'amber' | 'emerald'
}

export function Toasts(): React.ReactElement | null {
  const graph = useOccStore((s) => s.graph)
  const chats = useOccStore((s) => s.chats)
  const requestFocus = useOccStore((s) => s.requestFocus)
  const [items, setItems] = useState<Toast[]>([])
  const prevStatus = useRef<Record<string, string>>({})
  const finalSeen = useRef<Record<string, number>>({})
  const seq = useRef(0)

  // awaiting_input transitions → amber toast + taskbar flash
  useEffect(() => {
    if (!graph) return
    for (const n of Object.values(graph.nodes)) {
      if (n.kind !== 'root' || n.parents.length > 0) continue
      const prev = prevStatus.current[n.id]
      if (prev !== undefined && prev !== 'awaiting_input' && n.status === 'awaiting_input') {
        setItems((xs) => [
          ...xs.slice(-3),
          { key: `${n.id}-await-${++seq.current}`, text: `「${n.title}」需要你的回复`, chatId: n.id, tone: 'amber' }
        ])
        void window.electronAPI.occ.flash()
      }
      prevStatus.current[n.id] = n.status
    }
  }, [graph])

  // new final entries → green toast (skip history on first sight of a chat)
  useEffect(() => {
    for (const [chatId, entries] of Object.entries(chats)) {
      const finals = entries.filter((e) => e.role === 'final').length
      const seen = finalSeen.current[chatId]
      if (seen === undefined) {
        finalSeen.current[chatId] = finals
        continue
      }
      if (finals > seen) {
        finalSeen.current[chatId] = finals
        const title = graph?.nodes[chatId]?.title ?? '聊天'
        setItems((xs) => [
          ...xs.slice(-3),
          { key: `${chatId}-final-${++seq.current}`, text: `「${title}」已完成`, chatId, tone: 'emerald' }
        ])
        void window.electronAPI.occ.flash()
      }
    }
  }, [chats, graph])

  // auto-dismiss after 6s
  useEffect(() => {
    if (items.length === 0) return
    const t = setTimeout(() => setItems((xs) => xs.slice(1)), 6000)
    return () => clearTimeout(t)
  }, [items])

  if (items.length === 0) return null
  return (
    <div className="absolute bottom-3 right-3 z-40 flex w-64 flex-col gap-1.5">
      {items.map((t) => (
        <button
          key={t.key}
          className={`rounded-lg border px-3 py-2 text-left text-[11px] shadow-xl backdrop-blur transition-transform hover:scale-[1.02] ${
            t.tone === 'amber'
              ? 'border-amber-500/50 bg-amber-500/15 text-amber-100'
              : 'border-emerald-500/50 bg-emerald-500/15 text-emerald-100'
          }`}
          onClick={() => {
            if (t.chatId) requestFocus(t.chatId)
            setItems((xs) => xs.filter((x) => x.key !== t.key))
          }}
        >
          <span className="mr-1">{t.tone === 'amber' ? '🔑' : '✅'}</span>
          {t.text}
        </button>
      ))}
    </div>
  )
}
