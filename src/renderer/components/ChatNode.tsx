import { useEffect, useMemo, useRef, useState } from 'react'
import { Handle, Position, useStore, type NodeProps } from '@xyflow/react'
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

const STATUS_LABEL: Record<NodeStatus, string> = {
  draft: '就绪',
  provisioning: '启动中…',
  running: '执行中…',
  awaiting_input: '等待你回复',
  completed: '已完成',
  failed: '失败',
  aborted: '已停止',
  frozen: '已冻结',
  archived: '已归档'
}

const ROLE_STYLE: Record<string, string> = {
  user: 'border-canvas-accent/50 bg-canvas-accent/10 text-gray-100 self-end ml-6',
  manager: 'border-canvas-fork/40 bg-canvas-fork/5 text-gray-300',
  worker: 'border-canvas-border bg-canvas-node/60 text-gray-400',
  final: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-100'
}

const ROLE_TAG: Record<string, string> = {
  user: '你',
  manager: '调度',
  worker: 'worker',
  final: '✅ 结果'
}

const ROLE_ALIGN: Record<string, string> = {
  user: 'items-end',
  final: 'items-end'
}

// stable empty ref — a fresh [] in the selector would re-render forever
const EMPTY_LOG: ChatEntry[] = []

const QUICK_ACTIONS = [
  { icon: '🐛', label: '修复所有 bug' },
  { icon: '🧪', label: '写单元测试' },
  { icon: '📖', label: '解释这段代码' },
  { icon: '⚡', label: '优化性能' }
]

// compact duration: 12s / 3m05s / 1h12m
function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's'
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm'
}

// ChatEntry.time is ISO going forward; legacy entries stored local "HH:MM"
function fmtClock(t?: string): string {
  if (!t) return ''
  if (/^\d{1,2}:\d{2}$/.test(t)) return t
  const ms = Date.parse(t)
  if (!Number.isFinite(ms)) return t
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

export const ChatNode = ({ id, data, selected }: NodeProps): React.ReactElement => {
  const node = (data as { node: SessionNode }).node
  const log = useOccStore((s) => s.chats[id]) ?? EMPTY_LOG
  const sendChat = useOccStore((s) => s.sendChat)
  const loadChatLog = useOccStore((s) => s.loadChatLog)
  const abort = useOccStore((s) => s.abort)
  const graph = useOccStore((s) => s.graph)
  const streams = useOccStore((s) => s.streams)
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  // only truly-working states block typing; awaiting_input MUST stay answerable
  // or the user can never reply to permission/budget gates (GUI deadlock)
  const working = node.status === 'running' || node.status === 'provisioning'
  const awaiting = node.status === 'awaiting_input'
  // selector returns a boolean → re-render only when crossing the threshold,
  // not on every zoom frame; below it, cards collapse to a compact header
  const compact = useStore((s) => s.transform[2] < 0.45)

  useEffect(() => {
    void loadChatLog(id)
  }, [id, loadChatLog])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [log.length])

  // total tokens spent in this chat's whole subtree (workers + verifiers)
  const tokens = useMemo(() => {
    if (!graph) return 0
    const out = new Map<string, string[]>()
    for (const e of graph.edges) {
      const arr = out.get(e.source) ?? []
      arr.push(e.target)
      out.set(e.source, arr)
    }
    let total = 0
    const seen = new Set<string>([id])
    const stack = [id]
    while (stack.length > 0) {
      const cur = stack.pop() as string
      const n = graph.nodes[cur]
      if (n?.tokenUsage) total += n.tokenUsage.input + n.tokenUsage.output
      for (const t of out.get(cur) ?? []) if (!seen.has(t)) { seen.add(t); stack.push(t) }
    }
    return total
  }, [graph, id])

  // stage from the latest narration — Chinese-first (main-process copy is
  // localized); English tokens stay in the matcher so old logs still classify.
  // Scan the WHOLE log: worker detail lines can push manager narration far back.
  const stage = useMemo(() => {
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i]
      if (e.role !== 'manager') continue
      if (/验收|verdict|evaluat/i.test(e.text)) return '验收中…'
      if (/合并|merged/i.test(e.text)) return '合并中…'
      if (/快路径/.test(e.text)) return '快路径执行中…'
      if (/规划|目标|plan|goal/i.test(e.text)) return '规划中…'
      if (/轮|派发|worker|spawn|启动|执行|round/i.test(e.text)) return '执行中…'
    }
    return '规划中…'
  }, [log])

  // provider failovers since the last verdict — during 4xx storms this says
  // "it is retrying, not hung"
  const failovers = useMemo(() => {
    let lastFinal = -1
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i].role === 'final') {
        lastFinal = i
        break
      }
    }
    let n = 0
    for (let i = lastFinal + 1; i < log.length; i++) if (/failover|不可用/.test(log[i].text)) n++
    return n
  }, [log])

  const send = (text?: string): void => {
    const msg = (text ?? input).trim()
    if (!msg || working) return
    void sendChat(id, msg)
    setInput('')
  }

  const lastEntry = log[log.length - 1]
  const showTyping = working && lastEntry?.role !== 'final'
  const lastText = lastEntry?.text ?? ''
  const isPermAsk = awaiting && /权限请求/.test(lastText)
  const isBudgetAsk = awaiting && /预算/.test(lastText)
  const gateReplies = isBudgetAsk ? ['继续', '取消'] : ['允许', '全部允许', '拒绝']

  // live clock: elapsed run time + freshness of the last event. Ticks only
  // while the chat is busy, so idle cards stay quiet.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!working && !awaiting) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [working, awaiting])
  // anchor = the FIRST user message after the last final (a run may append
  // more user entries mid-flight when the fast path escalates; those must not
  // reset the clock). Legacy HH:MM entries fail Date.parse → fall back to the
  // moment this card first saw the chat become busy.
  const runAnchor = useMemo(() => {
    let lastFinal = -1
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i].role === 'final') {
        lastFinal = i
        break
      }
    }
    for (let i = lastFinal + 1; i < log.length; i++) if (log[i].role === 'user') return log[i]
    return undefined
  }, [log])
  const [busySince, setBusySince] = useState<number | null>(null)
  useEffect(() => {
    if (working) setBusySince((p) => p ?? Date.now())
    else setBusySince(null)
  }, [working])
  const parsedRun = runAnchor?.time ? Date.parse(runAnchor.time) : NaN
  const runStart = Number.isFinite(parsedRun) ? parsedRun : busySince ?? now
  const elapsed = working ? Math.max(0, now - runStart) : 0
  const parsedEvent = lastEntry?.time ? Date.parse(lastEntry.time) : NaN
  const sinceEvent = Number.isFinite(parsedEvent) ? Math.max(0, now - parsedEvent) : 0

  // acceptance report card: structured outcome once the pipeline concluded
  const hasFinal = log.some((e) => e.role === 'final')
  const [stats, setStats] = useState<Record<string, unknown> | null>(null)
  const [statsFetched, setStatsFetched] = useState(false)
  useEffect(() => {
    if (!hasFinal || statsFetched || working) return
    setStatsFetched(true)
    void window.electronAPI.occ.chatStats(id).then(setStats).catch(() => setStatsFetched(true))
  }, [hasFinal, statsFetched, working, id])
  const showReport = hasFinal && !working && !!stats && Object.keys(stats).length > 0
  // evaluation-first surfaced in the UI: planned criteria + per-criterion
  // PASS/FAIL parsed from the verdict text ("标准1: PASS — …")
  const rawCriteria = stats ? stats['criteria'] : undefined
  const criteriaList: string[] = Array.isArray(rawCriteria) ? rawCriteria.slice(0, 4).map((x) => String(x)) : []
  const finalText = (() => {
    for (let i = log.length - 1; i >= 0; i--) if (log[i].role === 'final') return log[i].text
    return ''
  })()
  const critStatus = (idx: number): 'pass' | 'fail' | 'unknown' => {
    if (!finalText) return 'unknown'
    const re = new RegExp('标准\\s*' + (idx + 1) + '\\s*[:：][^\\n]{0,80}?(PASS|FAIL|未通过|通过)', 'i')
    const m = re.exec(finalText)
    if (!m) return 'unknown'
    return /PASS/i.test(m[1]) || m[1] === '通过' ? 'pass' : 'fail'
  }

  // low zoom: a compact header card keeps a 0.35 view readable instead of
  // showing fragments of shrunken full cards
  if (compact) {
    return (
      <div
        data-node-id={id}
        className={`occ-born flex w-[300px] items-center gap-1.5 rounded-lg border bg-canvas-node/95 px-2.5 py-1.5 shadow-md backdrop-blur ${
          selected ? 'border-canvas-accent' : awaiting ? 'border-amber-500/70' : 'border-canvas-border'
        }`}
      >
        <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-none !bg-gray-500" />
        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[node.status]}`} />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-gray-200">{node.title}</span>
        {working && <span className="shrink-0 text-[9px] tabular-nums text-canvas-accent">⏱ {fmtDur(elapsed)}</span>}
        <span className="shrink-0 text-[9px] text-gray-500">{STATUS_LABEL[node.status]}</span>
      </div>
    )
  }

  return (
    <div
      data-node-id={id}
      className={`occ-born flex w-[380px] flex-col overflow-hidden rounded-xl border bg-canvas-node/95 shadow-lg backdrop-blur ${
        selected
          ? 'border-canvas-accent shadow-[0_0_18px_rgba(47,129,247,0.35)]'
          : awaiting
            ? 'border-amber-500/70 shadow-[0_0_14px_rgba(251,191,36,0.25)]'
            : 'border-canvas-border'
      }`}
    >
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-none !bg-gray-500" />

      {/* header */}
      <div className="flex items-center gap-2 border-b border-canvas-border px-3 py-2">
        <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[node.status]}`} />
        <span
          className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-200"
          onDoubleClick={() => {
            const t = window.prompt('重命名聊天', node.title)
            if (t && t.trim() && t.trim() !== node.title) {
              void window.electronAPI.occ.renameNode(id, t.trim()).then(() => useOccStore.getState().refresh())
            }
          }}
          title="双击重命名"
        >
          {node.title}
        </span>
        {tokens > 0 && (
          <span className="shrink-0 rounded-sm bg-canvas-bg px-1 py-px text-[8px] text-gray-500" title="本聊天累计 token（含 worker 与验收员）">
            {(tokens / 1000).toFixed(1)}k tok
          </span>
        )}
        <span className="text-[9px] text-gray-500">{STATUS_LABEL[node.status]}</span>
        {working && (
          <button
            className="shrink-0 rounded border border-red-500/40 px-1.5 py-px text-[9px] text-red-400 transition-colors hover:bg-red-500/20"
            onClick={() => void abort(id)}
            title="中止本聊天的所有工作"
          >
            ■ 停止
          </button>
        )}
      </div>

      {/* live run bar: stage + elapsed + freshness, only while busy */}
      {working && (
        <div
          data-occ="run-stage"
          className="mx-2 mt-2 flex items-center gap-2 rounded-md border border-canvas-accent/25 bg-canvas-accent/5 px-2 py-1"
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-canvas-accent" />
          <span className="text-[10px] font-medium text-canvas-accent">{stage}</span>
          <span className="text-[10px] tabular-nums text-gray-400" title="本次运行已用时">⏱ {fmtDur(elapsed)}</span>
          {failovers > 0 && (
            <span className="text-[9px] text-amber-400" title="模型调用失败后已自动切换备用模型">
              模型重试 {failovers} 次
            </span>
          )}
          <div className="flex-1" />
          <span className={`text-[9px] ${sinceEvent > 90_000 ? 'text-amber-400' : 'text-gray-500'}`}>
            {sinceEvent > 3000 ? `最近事件 ${fmtDur(sinceEvent)} 前` : '进行中'}
          </span>
        </div>
      )}

      {/* acceptance report card — the moat, made visible */}
      {showReport && (
        <div className={`mx-2 mb-1 rounded-lg border px-2.5 py-2 ${(stats?.outcome as string) === 'success' ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-red-500/40 bg-red-500/10'}`}>
          <div className="mb-1 flex items-center gap-1.5">
            <span className={`text-[10px] font-semibold ${(stats?.outcome as string) === 'success' ? 'text-emerald-300' : 'text-red-300'}`}>
              {(stats?.outcome as string) === 'success' ? '✅ 验收报告' : '❌ 验收报告'}
            </span>
            <div className="flex-1" />
            {typeof stats?.fitness === 'number' && (
              <span className="rounded-sm bg-canvas-bg px-1.5 py-px text-[9px] text-emerald-300">fitness {Number(stats.fitness).toFixed(2)}</span>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {stats?.fastPath ? (
              <span className="rounded-sm bg-canvas-bg px-1 py-px text-[9px] text-gray-400">⚡ 快路径 · 语法门</span>
            ) : (
              <span className="rounded-sm bg-canvas-bg px-1 py-px text-[9px] text-gray-400">⇉ {Number(stats?.rounds ?? 1)} 轮 · {Number(stats?.workers ?? 0)} worker</span>
            )}
            <span className="rounded-sm bg-canvas-bg px-1 py-px text-[9px] text-gray-400">{Math.round(Number(stats?.tokens ?? 0) / 1000)}k tok</span>
            {stats?.verified ? <span className="rounded-sm bg-canvas-bg px-1 py-px text-[9px] text-emerald-400">🔎 独立复验</span> : null}
            {stats?.jevAccepted ? <span className="rounded-sm bg-canvas-bg px-1 py-px text-[9px] text-canvas-accent">⚡ 本地快筛</span> : null}
          </div>
          {criteriaList.length > 0 && (
            <div data-occ="criteria-report" className="mt-1.5 space-y-0.5 border-t border-canvas-border/60 pt-1.5">
              <p className="text-[9px] text-gray-500">成功标准（行动前定义）</p>
              {criteriaList.map((c, i) => {
                const st = critStatus(i)
                return (
                  <div key={i} data-occ="criterion-item" className="flex items-start gap-1">
                    <span
                      className={`mt-px shrink-0 text-[9px] ${
                        st === 'pass' ? 'text-emerald-400' : st === 'fail' ? 'text-red-400' : 'text-gray-600'
                      }`}
                    >
                      {st === 'pass' ? '✓' : st === 'fail' ? '✗' : '·'}
                    </span>
                    <span className="text-[9px] leading-relaxed text-gray-400">{c}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* gate reply bar: permission / budget asks are answered with one click */}
      {awaiting && (isPermAsk || isBudgetAsk) && (
        <div className="mx-2 mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5">
          <p className="mb-1 text-[10px] font-medium text-amber-300" data-occ="awaiting-reason">
            {isPermAsk
              ? `🔐 等待你批准工具操作${sinceEvent > 3000 ? `（已等待 ${fmtDur(sinceEvent)}）` : ''}`
              : `💰 预算已到上限，等待你决定${sinceEvent > 3000 ? `（已等待 ${fmtDur(sinceEvent)}）` : ''}`}
          </p>
          <div className="flex gap-1.5">
            {gateReplies.map((r) => (
              <button
                key={r}
                className={`rounded-md px-2.5 py-0.5 text-[10px] transition-colors ${
                  r === '拒绝' || r === '取消'
                    ? 'border border-red-500/40 text-red-300 hover:bg-red-500/20'
                    : 'bg-amber-500/20 text-amber-100 hover:bg-amber-500/30'
                }`}
                onClick={() => send(r)}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* messages */}
      <div ref={scrollRef} className="flex h-[280px] flex-col gap-1.5 overflow-y-auto p-2">
        {log.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center px-3 text-center">
            <p className="text-xs font-medium text-gray-300">给一个目标</p>
            <p className="mt-1.5 text-[10px] leading-relaxed text-gray-500">
              会自动拆解任务、并行执行、验收结果
            </p>
            <div className="mt-3 flex flex-wrap justify-center gap-1.5">
              {QUICK_ACTIONS.map((q) => (
                <button
                  key={q.label}
                  onClick={() => { setInput(q.label); }}
                  className="rounded-full border border-canvas-border px-2 py-0.5 text-[9px] text-gray-400 transition-colors hover:border-canvas-accent hover:text-canvas-accent"
                >
                  {q.icon} {q.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {log.map((c) => (
          <div key={c.id} className={`group flex flex-col ${ROLE_ALIGN[c.role] ?? ''}`}>
            <div className={`max-w-[95%] rounded-lg border px-2.5 py-1.5 ${ROLE_STYLE[c.role] ?? ROLE_STYLE.worker}`}>
              <div className="mb-0.5 flex items-center gap-1.5">
                <span className="text-[8px] font-bold uppercase tracking-wider opacity-50">{ROLE_TAG[c.role] ?? c.role}</span>
                <span className="text-[8px] opacity-30">{fmtClock(c.time)}</span>
                {c.role === 'final' && (
                  <button
                    className="ml-auto text-[8px] opacity-0 transition-opacity hover:opacity-100 group-hover:opacity-60"
                    title="复制结果"
                    onClick={() => void navigator.clipboard.writeText(c.text)}
                  >
                    ⧉
                  </button>
                )}
              </div>
              <p className="whitespace-pre-wrap break-words text-[10.5px] leading-relaxed">{c.text}</p>
            </div>
          </div>
        ))}
        {/* live streaming bubbles — the model's partial output, growing */}
        {Object.entries(streams ?? {})
          .filter(([, v]) => v.chatId === id && v.text)
          .map(([nid, v]) => (
            <div key={nid} className="flex flex-col">
              <div className="max-w-[95%] rounded-lg border border-canvas-border bg-canvas-node/60 px-2.5 py-1.5 text-gray-400">
                <div className="mb-0.5 flex items-center gap-1.5">
                  <span className="text-[8px] font-bold uppercase tracking-wider opacity-50">worker · {graph?.nodes[nid]?.title ?? nid}</span>
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-canvas-accent" />
                </div>
                <p className="whitespace-pre-wrap break-words text-[10.5px] leading-relaxed">
                  {v.text.slice(-500)}
                  <span className="animate-pulse text-canvas-accent">▍</span>
                </p>
              </div>
            </div>
          ))}
        {/* typing indicator */}
        {showTyping && (
          <div className="flex items-center gap-1.5 px-2 py-1">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-canvas-accent" />
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-canvas-accent" style={{ animationDelay: '150ms' }} />
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-canvas-accent" style={{ animationDelay: '300ms' }} />
            <span className="ml-1 text-[9px] text-gray-500">{stage}</span>
          </div>
        )}
      </div>

      {/* error recovery bar — an aborted chat that already has a verdict
          concluded before the stop landed; there is nothing to retry */}
      {!working && (node.status === 'failed' || (node.status === 'aborted' && !log.some((e) => e.role === 'final'))) && log.length > 0 && (() => {
        const lastUser = [...log].reverse().find((e) => e.role === 'user')
        if (!lastUser) return null
        return (
          <div className="mx-2 mb-1 flex items-center gap-1.5 rounded-lg border border-orange-500/30 bg-orange-500/5 px-2.5 py-1.5">
            <span className="text-[10px] text-orange-300">{node.status === 'aborted' ? '已中止' : '任务失败'}</span>
            <div className="flex-1" />
            <button
              className="rounded-md bg-orange-500/20 px-2.5 py-0.5 text-[10px] text-orange-200 transition-colors hover:bg-orange-500/30"
              onClick={() => send(lastUser.text)}
            >
              ↻ 重试
            </button>
            <button
              className="rounded-md border border-canvas-border px-2 py-0.5 text-[10px] text-gray-400 transition-colors hover:bg-canvas-border"
              onClick={() => useOccStore.setState({ error: null })}
            >
              忽略
            </button>
          </div>
        )
      })()}

      {/* input */}
      <div className="flex items-end gap-1.5 border-t border-canvas-border p-2">
        <textarea
          className="h-[42px] min-w-0 flex-1 resize-none rounded-lg border border-canvas-border bg-canvas-bg px-2.5 py-2 text-[11px] text-gray-200 outline-none transition-colors placeholder:text-gray-600 focus:border-canvas-accent"
          placeholder={
            awaiting
              ? isPermAsk || isBudgetAsk
                ? '或直接输入：允许 / 全部允许 / 拒绝'
                : '需要你的回复…'
              : working
                ? 'worker 正在执行…结束后可继续追问'
                : '描述你的目标…（支持多行 = 多个子任务）'
          }
          value={input}
          disabled={working}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
          }}
        />
        <button
          className={`shrink-0 rounded-lg px-3.5 py-2 text-[11px] font-medium transition-all ${
            input.trim() && !working
              ? 'bg-canvas-accent text-white hover:brightness-110 active:scale-95'
              : 'bg-canvas-border text-gray-500'
          }`}
          disabled={working || !input.trim()}
          onClick={() => send()}
        >
          {working ? '···' : '→'}
        </button>
      </div>
    </div>
  )
}
