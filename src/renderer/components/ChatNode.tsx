import { useEffect, useMemo, useRef, useState } from 'react'
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

const STATUS_LABEL: Record<NodeStatus, string> = {
  draft: 'ready',
  provisioning: 'starting…',
  running: 'working…',
  awaiting_input: 'needs your input',
  completed: 'done',
  failed: 'failed',
  aborted: 'stopped',
  frozen: 'frozen',
  archived: 'archived'
}

const ROLE_STYLE: Record<string, string> = {
  user: 'border-canvas-accent/50 bg-canvas-accent/10 text-gray-100 self-end ml-6',
  manager: 'border-canvas-fork/40 bg-canvas-fork/5 text-gray-300',
  worker: 'border-canvas-border bg-canvas-node/60 text-gray-400',
  final: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-100'
}

const ROLE_TAG: Record<string, string> = {
  user: 'you',
  manager: 'manager',
  worker: 'agent',
  final: '✅ result'
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

export const ChatNode = ({ id, data, selected }: NodeProps): React.ReactElement => {
  const node = (data as { node: SessionNode }).node
  const log = useOccStore((s) => s.chats[id]) ?? EMPTY_LOG
  const sendChat = useOccStore((s) => s.sendChat)
  const loadChatLog = useOccStore((s) => s.loadChatLog)
  const abort = useOccStore((s) => s.abort)
  const graph = useOccStore((s) => s.graph)
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  // only truly-working states block typing; awaiting_input MUST stay answerable
  // or the user can never reply to permission/budget gates (GUI deadlock)
  const working = node.status === 'running' || node.status === 'provisioning'
  const awaiting = node.status === 'awaiting_input'

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

  // stage label from the latest manager narration
  const stage = useMemo(() => {
    for (let i = log.length - 1; i >= 0 && i >= log.length - 5; i--) {
      const e = log[i]
      if (e.role !== 'manager') continue
      if (/plan|拆解|task|route/i.test(e.text)) return '拆解完成，agents 执行中'
      if (/merged|evaluating|验收|verdict/i.test(e.text)) return '验收中…'
      if (/round \d|worker|创建|fork/i.test(e.text)) return 'agents 执行中'
    }
    return '规划中…'
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

  return (
    <div
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
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-200">{node.title}</span>
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

      {/* gate reply bar: permission / budget asks are answered with one click */}
      {awaiting && (isPermAsk || isBudgetAsk) && (
        <div className="mx-2 mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5">
          <p className="mb-1 text-[10px] font-medium text-amber-300">
            {isPermAsk ? '🔐 agents 请求权限 — 选择回复' : '💰 预算确认 — 选择回复'}
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
              agent 会拆解任务、并行执行、验收结果
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
          <div key={c.id} className={`flex flex-col ${ROLE_ALIGN[c.role] ?? ''}`}>
            <div className={`max-w-[95%] rounded-lg border px-2.5 py-1.5 ${ROLE_STYLE[c.role] ?? ROLE_STYLE.worker}`}>
              <div className="mb-0.5 flex items-center gap-1.5">
                <span className="text-[8px] font-bold uppercase tracking-wider opacity-50">{ROLE_TAG[c.role] ?? c.role}</span>
                <span className="text-[8px] opacity-30">{c.time}</span>
              </div>
              <p className="whitespace-pre-wrap break-words text-[10.5px] leading-relaxed">{c.text}</p>
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
                ? 'agents are working… you can type a follow-up after they finish'
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
