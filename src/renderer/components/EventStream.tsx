import { useEffect, useRef } from 'react'
import { useOccStore } from '../store/occStore'

const KIND_COLOR: Record<string, string> = {
  node: 'text-gray-300',
  edge: 'text-canvas-fork',
  server: 'text-emerald-400',
  error: 'text-red-400'
}

// §9.10 the growth of the graph as a text stream
export function EventStream(): React.ReactElement {
  const log = useOccStore((s) => s.eventLog)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [log.length])

  return (
    <div className="absolute bottom-3 left-3 z-10 flex max-h-44 w-72 flex-col overflow-hidden rounded-md border border-canvas-border bg-canvas-bg/85 backdrop-blur">
      <div className="border-b border-canvas-border px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-gray-600">
        event stream
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {log.length === 0 ? (
          <p className="py-2 text-center text-[10px] text-gray-700">waiting for activity…</p>
        ) : (
          log.slice(-40).map((e) => (
            <div key={e.id} className="flex gap-1.5 py-px text-[10px] leading-relaxed">
              <span className="shrink-0 text-gray-700">{e.time}</span>
              <span className={KIND_COLOR[e.kind] ?? 'text-gray-300'}>{e.text}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
