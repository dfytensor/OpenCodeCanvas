import { useMemo, useState } from 'react'
import { useOccStore } from '../store/occStore'
import type { ContentDimension, InheritChannel, InheritPlan, NodeID, Selector } from '../../shared/types'

const ALL_DIMENSIONS: ContentDimension[] = [
  'transcript',
  'summary',
  'inputs',
  'outputs',
  'toolTrace',
  'diff',
  'files',
  'artifacts',
  'decisions',
  'config'
]

const DIM_HINT: Record<ContentDimension, string> = {
  transcript: '完整对话',
  summary: '摘要',
  inputs: '仅用户指令',
  outputs: '仅结论输出',
  toolTrace: '工具调用轨迹',
  diff: '文件改动 diff',
  files: '指定文件内容',
  artifacts: '产出物',
  decisions: '决策记录',
  config: '运行配置'
}

const COMPOSE_MODES: Array<{ id: InheritPlan['compose']['mode']; label: string }> = [
  { id: 'digest-merge', label: 'digest-merge（多源汇总，最省）' },
  { id: 'concat', label: 'concat（顺序拼接）' },
  { id: 'merge', label: 'merge（按维度归并）' },
  { id: 'patch-apply', label: 'patch-apply（diff 打到工作区）' }
]

const CHANNELS: Array<{ id: InheritChannel; label: string }> = [
  { id: 'auto', label: 'auto（自动选择）' },
  { id: 'fork', label: 'fork（原样分叉）' },
  { id: 'import', label: 'import（裁剪注入）' },
  { id: 'brief', label: 'brief（BRIEF.md 摘要，最稳）' }
]

// §9.14 five-step wizard, compressed into one scrollable panel
export function InheritWizard(): React.ReactElement | null {
  const graph = useOccStore((s) => s.graph)
  const project = useOccStore((s) => s.project)
  const wizardOpen = useOccStore((s) => s.wizardOpen)
  const setWizard = useOccStore((s) => s.setWizard)
  const createFromPlan = useOccStore((s) => s.createFromPlan)
  const busy = useOccStore((s) => s.busy)

  const eligible = useMemo(
    () =>
      graph
        ? Object.values(graph.nodes).filter(
            (n) => n.sessionId && n.taint === 'none' && ['completed', 'frozen', 'archived'].includes(n.status)
          )
        : [],
    [graph]
  )

  const [sources, setSources] = useState<NodeID[]>([])
  const [dimsBySource, setDimsBySource] = useState<Record<NodeID, ContentDimension[]>>({})
  const [pathsBySource, setPathsBySource] = useState<Record<NodeID, string>>({})
  const [applySources, setApplySources] = useState<NodeID[]>([])
  const [composeMode, setComposeMode] = useState<InheritPlan['compose']['mode']>('digest-merge')
  const [channel, setChannel] = useState<InheritChannel>('auto')
  const [maxTokens, setMaxTokens] = useState(120000)
  const [kickoff, setKickoff] = useState('')
  const [step, setStep] = useState(0)

  if (!wizardOpen || !project) return null

  const toggleSource = (id: NodeID): void => {
    setSources((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      if (!prev.includes(id)) {
        setDimsBySource((d) => ({ ...d, [id]: ['outputs', 'diff'] }))
        setPathsBySource((p) => ({ ...p, [id]: '' }))
      }
      return next
    })
  }

  const toggleDim = (id: NodeID, dim: ContentDimension): void => {
    setDimsBySource((d) => {
      const cur = d[id] ?? []
      return { ...d, [id]: cur.includes(dim) ? cur.filter((x) => x !== dim) : [...cur, dim] }
    })
  }

  const buildPlan = (): InheritPlan | null => {
    if (sources.length === 0) return null
    const selectors: Selector[] = sources.map((id) => {
      const paths = (pathsBySource[id] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      return {
        from: { nodeId: id },
        take: dimsBySource[id]?.length ? dimsBySource[id] : ['outputs'],
        ...(paths.length ? { filter: { paths } } : {}),
        view: 'compact'
      }
    })
    return {
      sources: selectors,
      compose: { mode: composeMode, order: 'explicit', dedupe: true, labelSources: true },
      budget: { maxTokens, onOverflow: 'truncate-tail' },
      workspace: {
        base: { kind: 'snapshot', contentHash: 'mainline', label: 'mainline@resolve' },
        apply: applySources.map((from) => {
          const paths = (pathsBySource[from] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
          return paths.length ? { from, paths } : { from }
        }),
        onConflict: 'agent'
      },
      channel
    }
  }

  const stepClass = (n: number): string =>
    `rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${step === n ? 'bg-canvas-accent text-white' : 'bg-canvas-bg text-gray-500'}`

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="flex max-h-[85vh] w-[560px] flex-col overflow-hidden rounded-xl border border-canvas-border bg-canvas-node shadow-2xl">
        <div className="flex items-center gap-2 border-b border-canvas-border px-4 py-2.5">
          <span className="text-xs font-semibold text-gray-200">Inherit Wizard</span>
          <div className="flex flex-1 justify-end gap-1">
            <span className={stepClass(0)}>1 源</span>
            <span className={stepClass(1)}>2 维度</span>
            <span className={stepClass(2)}>3 工作区</span>
            <span className={stepClass(3)}>4 确认</span>
          </div>
          <button className="ml-2 text-gray-500 hover:text-gray-300" onClick={() => setWizard(false)}>✕</button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {/* step 1 — sources */}
          <section>
            <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500">① 选择源节点（completed / frozen / archived）</h3>
            {eligible.length === 0 ? (
              <p className="text-[11px] text-gray-600">暂无可继承源 — 等节点完成后回来。</p>
            ) : (
              <div className="grid grid-cols-2 gap-1.5">
                {eligible.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => toggleSource(n.id)}
                    className={`flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-[11px] ${
                      sources.includes(n.id) ? 'border-canvas-accent bg-canvas-accent/10 text-gray-200' : 'border-canvas-border text-gray-400 hover:bg-canvas-border/40'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{n.title}</span>
                    <span className="shrink-0 text-[9px] text-gray-600">{n.status === 'frozen' ? '❄' : n.status === 'archived' ? '▤' : '✓'}</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* step 2 — dimensions per source */}
          {sources.length > 0 && (
            <section>
              <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500">② 每个源取哪些维度</h3>
              <div className="space-y-2">
                {sources.map((id) => (
                  <div key={id} className="rounded-md border border-canvas-border p-2">
                    <div className="mb-1 truncate text-[11px] text-gray-300">{graph?.nodes[id]?.title}</div>
                    <div className="flex flex-wrap gap-1">
                      {ALL_DIMENSIONS.map((d) => (
                        <button
                          key={d}
                          title={DIM_HINT[d]}
                          onClick={() => toggleDim(id, d)}
                          className={`rounded px-1.5 py-0.5 text-[9px] ${
                            (dimsBySource[id] ?? []).includes(d) ? 'bg-canvas-accent text-white' : 'bg-canvas-bg text-gray-500 hover:text-gray-300'
                          }`}
                        >
                          {d}
                        </button>
                      ))}
                    </div>
                    <input
                      className="mt-1.5 w-full rounded border border-canvas-border bg-canvas-bg px-1.5 py-0.5 text-[10px] text-gray-300 outline-none focus:border-canvas-accent"
                      placeholder="path filter, 逗号分隔, 如 src/auth/**, tests/**（可选）"
                      value={pathsBySource[id] ?? ''}
                      onChange={(e) => setPathsBySource((p) => ({ ...p, [id]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* step 3 — workspace + budget + channel */}
          {sources.length > 0 && (
            <section>
              <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500">③ 工作区与预算</h3>
              <div className="space-y-2 rounded-md border border-canvas-border p-2">
                <div className="text-[10px] text-gray-400">
                  基线：<span className="text-gray-200">mainline@resolve</span>（解析时刻拍快照并钉死 contentHash — §3.5）
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-[10px] text-gray-500">apply diff 来自：</span>
                  {sources.map((id) => (
                    <button
                      key={id}
                      onClick={() =>
                        setApplySources((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
                      }
                      className={`rounded px-1.5 py-0.5 text-[9px] ${
                        applySources.includes(id) ? 'bg-emerald-600 text-white' : 'bg-canvas-bg text-gray-500 hover:text-gray-300'
                      }`}
                    >
                      {graph?.nodes[id]?.title}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <label className="flex flex-1 items-center gap-1 text-[10px] text-gray-500">
                    compose
                    <select
                      className="flex-1 rounded border border-canvas-border bg-canvas-bg px-1 py-0.5 text-[10px] text-gray-300"
                      value={composeMode}
                      onChange={(e) => setComposeMode(e.target.value as InheritPlan['compose']['mode'])}
                    >
                      {COMPOSE_MODES.map((m) => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-1 items-center gap-1 text-[10px] text-gray-500">
                    channel
                    <select
                      className="flex-1 rounded border border-canvas-border bg-canvas-bg px-1 py-0.5 text-[10px] text-gray-300"
                      value={channel}
                      onChange={(e) => setChannel(e.target.value as InheritChannel)}
                    >
                      {CHANNELS.map((c) => (
                        <option key={c.id} value={c.id}>{c.label}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="flex items-center gap-2 text-[10px] text-gray-500">
                  maxTokens
                  <input
                    type="number"
                    className="w-28 rounded border border-canvas-border bg-canvas-bg px-1.5 py-0.5 text-[10px] text-gray-300"
                    value={maxTokens}
                    min={2000}
                    step={10000}
                    onChange={(e) => setMaxTokens(Number(e.target.value) || 120000)}
                  />
                  <input
                    type="range"
                    className="flex-1 accent-[#2f81f7]"
                    min={10000}
                    max={200000}
                    step={10000}
                    value={maxTokens}
                    onChange={(e) => setMaxTokens(Number(e.target.value))}
                  />
                </label>
              </div>
            </section>
          )}

          {/* step 4 — confirm */}
          {sources.length > 0 && (
            <section>
              <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500">④ kickoff 与确认</h3>
              <textarea
                className="h-16 w-full resize-none rounded-md border border-canvas-border bg-canvas-bg px-2 py-1 text-[11px] text-gray-300 outline-none focus:border-canvas-accent"
                placeholder="新节点的任务指令（可选 — 留空则让 agent 自行根据继承内容继续工作）"
                value={kickoff}
                onChange={(e) => setKickoff(e.target.value)}
              />
              <p className="mt-1 text-[10px] text-gray-600">
                将创建 inherit 节点：{sources.length} 源 · {composeMode} · ≤{maxTokens.toLocaleString()} tokens · channel={channel}
                {applySources.length > 0 ? ` · apply ${applySources.length} 源 diff` : ''}
              </p>
            </section>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-canvas-border px-4 py-2.5">
          <button className="rounded-md border border-canvas-border px-3 py-1 text-[11px] text-gray-300 hover:bg-canvas-border" onClick={() => setWizard(false)}>
            取消
          </button>
          <button
            className="rounded-md bg-canvas-accent px-3 py-1 text-[11px] font-medium text-white hover:brightness-110 disabled:opacity-40"
            disabled={sources.length === 0 || busy}
            onClick={() => {
              const plan = buildPlan()
              if (!plan) return
              void createFromPlan(plan, {
                parents: sources,
                kind: sources.length > 1 ? 'merge' : 'inherit',
                title: `inherit × ${sources.length}`,
                kickoff: kickoff || undefined
              }).then(() => setWizard(false))
            }}
          >
            {busy ? 'creating…' : '创建节点'}
          </button>
        </div>
      </div>
    </div>
  )
}
