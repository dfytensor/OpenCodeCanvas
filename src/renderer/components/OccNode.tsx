import { memo, useEffect, useState } from 'react'
import { Handle, Position, useStore, type NodeProps } from '@xyflow/react'
import type { NodeStatus, SessionNode } from '../../shared/types'
import { useOccStore } from '../store/occStore'

const STATUS_STYLE: Record<NodeStatus, { dot: string; ring: string; text: string; label: string }> = {
  draft: { dot: 'bg-gray-500', ring: 'border-gray-600', text: 'text-gray-400', label: 'draft' },
  provisioning: { dot: 'bg-blue-400 occ-breathe', ring: 'border-blue-500/50', text: 'text-blue-300', label: 'provisioning' },
  running: { dot: 'bg-canvas-accent occ-breathe', ring: 'border-canvas-accent/60', text: 'text-canvas-accent', label: 'running' },
  awaiting_input: { dot: 'bg-amber-400 occ-blink', ring: 'border-amber-400/70', text: 'text-amber-300', label: 'awaiting input' },
  completed: { dot: 'bg-emerald-500', ring: 'border-emerald-500/40', text: 'text-emerald-400', label: 'completed' },
  failed: { dot: 'bg-red-500', ring: 'border-red-500/50', text: 'text-red-400', label: 'failed' },
  aborted: { dot: 'bg-orange-500', ring: 'border-orange-500/40', text: 'text-orange-400', label: 'aborted' },
  frozen: { dot: 'bg-slate-400', ring: 'border-slate-400/40', text: 'text-slate-300', label: 'frozen' },
  archived: { dot: 'bg-slate-600', ring: 'border-slate-600/40', text: 'text-slate-500', label: 'archived' }
}

const KIND_BADGE: Record<string, string> = {
  root: '⌂',
  fork: '⑂',
  inherit: '⎇',
  merge: 'Ⓜ',
  ephemeral: '◇'
}

// §9.4 LOD tiers by viewport zoom (distance from the frontier is not yet
// wired; zoom is the primary factor — V1 will combine both)
function tierOf(zoom: number): 4 | 3 | 2 | 1 | 0 {
  if (zoom >= 0.85) return 4
  if (zoom >= 0.6) return 3
  if (zoom >= 0.4) return 2
  if (zoom >= 0.25) return 1
  return 0
}

export const OccNode = memo(function OccNode({ id, data, selected }: NodeProps): React.ReactElement {
  const node = (data as { node: SessionNode }).node
  const zoom = useStore((s) => s.transform[2])
  const tier = tierOf(zoom)
  const st = STATUS_STYLE[node.status]
  const inspect = useOccStore((s) => s.inspect)
  const manifest = useOccStore((s) => s.inspectCache[node.id])
  const freeze = useOccStore((s) => s.freeze)
  const unfreeze = useOccStore((s) => s.unfreeze)
  const archive = useOccStore((s) => s.archive)
  const apply = useOccStore((s) => s.apply)
  const abort = useOccStore((s) => s.abort)
  const send = useOccStore((s) => s.send)
  const setWizard = useOccStore((s) => s.setWizard)
  const [hover, setHover] = useState(false)

  useEffect(() => {
    if ((hover || selected) && !manifest && node.sessionId) void inspect(node.id)
  }, [hover, selected, manifest, node.id, node.sessionId, inspect])

  // L0 star-dust: a bare glowing dot
  if (tier === 0) {
    return (
      <div className={`h-2.5 w-2.5 rounded-full ${st.dot} shadow`} />
    )
  }

  // L1 badge: dot + tiny label
  if (tier === 1) {
    return (
      <div className={`flex items-center gap-1 rounded-full border bg-canvas-node px-1.5 py-0.5 ${st.ring}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
        <span className="max-w-[90px] truncate text-[9px] text-gray-400">{node.title}</span>
      </div>
    )
  }

  const frozenFrost = node.status === 'frozen' || node.status === 'archived'
  const dims = manifest
    ? (Object.entries(manifest.dimensions) as Array<[string, { available: boolean; approxTokens: number }]>)
        .filter(([, v]) => v.available)
        .map(([k]) => k)
    : []

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`occ-born relative rounded-lg border bg-canvas-node/95 backdrop-blur transition-shadow ${
        selected ? 'border-canvas-accent shadow-[0_0_14px_rgba(47,129,247,0.35)]' : st.ring
      } ${frozenFrost ? 'occ-frost' : ''} ${tier >= 3 ? 'w-60' : 'w-44'}`}
    >
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-none !bg-gray-600" />
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-none !bg-gray-600" />

      <div className="flex items-center gap-1.5 px-2 pt-1.5">
        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${st.dot}`} />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-gray-200">{node.title}</span>
        <span className="shrink-0 text-[9px] text-gray-600">{KIND_BADGE[node.kind] ?? ''}{node.kind === 'merge' ? '' : ` G${node.gen}`}</span>
      </div>

      {tier >= 3 && (
        <div className="px-2 pb-1 pt-0.5">
          {node.summary ? (
            <p className="line-clamp-2 text-[10px] leading-snug text-gray-500">{node.summary}</p>
          ) : (
            <p className={`text-[10px] ${st.text}`}>{st.label}{node.partial ? ' · partial' : ''}</p>
          )}
        </div>
      )}

      {tier >= 3 && dims.length > 0 && (
        <div className="flex flex-wrap gap-1 px-2 pb-1.5">
          {dims.slice(0, 6).map((d) => (
            <span key={d} className="rounded-sm bg-canvas-bg px-1 py-px text-[8px] text-gray-500">{d}</span>
          ))}
        </div>
      )}

      {/* diff heat bar placeholder: status-colored strip */}
      <div className={`h-[3px] rounded-b-lg ${
        node.status === 'running' ? 'bg-canvas-accent/70' :
        node.status === 'completed' ? 'bg-emerald-600/50' :
        node.status === 'failed' ? 'bg-red-600/60' :
        node.status === 'awaiting_input' ? 'bg-amber-500/70' :
        'bg-canvas-border'
      }`} />

      {hover && tier >= 2 && (
        <div className="absolute left-full top-0 z-50 ml-2 w-60 rounded-md border border-canvas-border bg-canvas-bg/95 p-2 text-[10px] text-gray-400 shadow-xl">
          <div className="mb-1 font-semibold text-gray-300">{node.title}</div>
          <div>id: {node.id}</div>
          <div>status: {node.status}{node.partial ? ' (partial)' : ''}</div>
          {node.sessionId && <div className="truncate">session: {node.sessionId}</div>}
          {node.baseRef && <div className="truncate">base: {node.baseRef.label}</div>}
          {node.channel && <div>channel: {node.channel}</div>}
          {node.tokenUsage && (node.tokenUsage.input > 0 || node.tokenUsage.output > 0) && (
            <div>tokens: ↑{node.tokenUsage.input.toLocaleString()} ↓{node.tokenUsage.output.toLocaleString()}</div>
          )}
          {manifest && (
            <div className="mt-1 border-t border-canvas-border pt-1">
              {dims.length > 0 ? (
                dims.map((d) => (
                  <div key={d} className="flex justify-between">
                    <span>{d}</span>
                    <span className="text-gray-600">~{manifest.dimensions[d as keyof typeof manifest.dimensions]?.approxTokens ?? 0} tok</span>
                  </div>
                ))
              ) : (
                <span>no content indexed yet</span>
              )}
            </div>
          )}
          <div className="mt-1.5 flex flex-wrap gap-1 border-t border-canvas-border pt-1.5">
            {[
              { label: '⎇ inherit', fn: () => setWizard(true), disabled: false },
              { label: node.status === 'frozen' ? '♨ unfreeze' : '❄ freeze', disabled: node.status !== 'frozen' && node.status !== 'completed', fn: () => void (node.status === 'frozen' ? unfreeze(node.id) : freeze(node.id)) },
              { label: '▤ archive', disabled: node.status !== 'frozen', fn: () => void archive(node.id) },
              { label: '⬇ apply', disabled: !node.workDir, fn: () => void apply(node.id).then((m) => window.alert(m)) },
              { label: '■ abort', disabled: node.status !== 'running' && node.status !== 'awaiting_input', fn: () => void abort(node.id) },
              { label: '💬 message', disabled: node.status === 'frozen' || node.status === 'archived', fn: () => { const t = window.prompt('message for this node:'); if (t) void send(node.id, t) } }
            ].map((b) => (
              <button
                key={b.label}
                disabled={b.disabled}
                className="rounded border border-canvas-border px-1.5 py-0.5 text-[9px] text-gray-300 hover:bg-canvas-border disabled:opacity-30"
                onClick={(e) => {
                  e.stopPropagation()
                  b.fn()
                }}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
})
