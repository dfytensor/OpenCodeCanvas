// Full-screen overlay viewer for a node's workspace diff (snapshot → copy).
import { useOccStore } from '../store/occStore'

export function DiffModal(): React.ReactElement | null {
  const diffNode = useOccStore((s) => s.diffNode)
  const diffText = useOccStore((s) => s.diffText)
  const graph = useOccStore((s) => s.graph)
  const closeDiff = useOccStore((s) => s.closeDiff)
  if (!diffNode) return null
  const title = graph?.nodes[diffNode]?.title ?? diffNode

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
      onClick={closeDiff}
    >
      <div
        className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-canvas-border bg-canvas-node shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-canvas-border px-4 py-2">
          <span className="text-xs font-semibold text-gray-200">⇄ 工作区改动 — {title}</span>
          <div className="flex-1" />
          <button className="text-sm text-gray-500 transition-colors hover:text-gray-300" onClick={closeDiff}>✕</button>
        </div>
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 text-[10.5px] leading-relaxed text-gray-300">
          {diffText}
        </pre>
      </div>
    </div>
  )
}
