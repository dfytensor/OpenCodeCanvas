// Native agent sessions bound to graph nodes. Session ids are prefixed
// 'agt_' so routing (send/abort/diff) can distinguish them from opencode
// server sessions. Transcripts persist as JSONL under the node dir (append-only).
import { appendFile, writeFile, mkdir } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { nanoid } from '../ids'
import type { NodeID } from '../../shared/types'
import { getActiveProject } from '../project/registry'
import { getGraph, transitionNode, patchNode } from '../graph/store'
import { emitOccEvent } from '../graph/events'
import { GraphError } from '../graph/stateMachine'
import { listAgentProviders, resolveAgentModel, type AgentProviderConfig } from './providers'
import { buildTools, systemPrompt, type Tool } from './tools'
import { jevEnabled, jevToolSafe } from './jev'
import { runAgentLoop, type AgentMessage } from './loop'

interface AgentSession {
  id: string
  nodeId: NodeID
  rootDir: string
  title: string
  workDir: string
  providerRef: string
  provider: AgentProviderConfig
  model: string
  messages: AgentMessage[]
  tools: Tool[]
  busy: boolean
  aborted: boolean
  chatId?: NodeID
  allowedTools: Set<string>
}

const sessions = new Map<string, AgentSession>()

// ── permission gate: sensitive tools ask the user via the chat (§ 权限询问) ──

const SENSITIVE_TOOLS = new Set(['bash', 'write_file', 'edit_file'])
type PermDecision = 'allow' | 'allow_all' | 'deny'
interface PendingPerm {
  resolve: (d: PermDecision) => void
  workerTitle: string
  tool: string
  detail: string
}
// one pending ask per chat (queued), resolved by the user's next chat message
const pendingPerms = new Map<string, PendingPerm[]>()
const permQueues = new Map<string, Promise<unknown>>()
// 'allow all' memory per chat: tool names pre-approved for the rest of the chat
const chatToolAllowAll = new Map<string, Set<string>>()

function enqueuePerm(key: string, ask: () => Promise<PermDecision>): Promise<PermDecision> {
  const prev = permQueues.get(key) ?? Promise.resolve()
  const p = prev.then(ask, ask)
  permQueues.set(key, p.catch(() => 'deny' as PermDecision))
  return p
}

export function pendingPermFor(chatId: NodeID): boolean {
  return (pendingPerms.get(chatId)?.length ?? 0) > 0
}

/** The user's next chat message decides the OLDEST pending permission. */
export function resolvePendingPerm(
  chatId: NodeID,
  text: string
): 'allow' | 'allow_all' | 'deny' | null {
  const queue = pendingPerms.get(chatId)
  if (!queue || queue.length === 0) return null
  const p = queue.shift() as PendingPerm
  if (queue.length === 0) pendingPerms.delete(chatId)
  if (/全部允许|允许所有|allow all/i.test(text)) { p.resolve('allow_all'); return 'allow_all' }
  if (/允许|^y(es)?$/i.test(text)) { p.resolve('allow'); return 'allow' }
  p.resolve('deny')
  return 'deny'
}

function requestPerm(
  rootDir: string,
  chatId: NodeID | undefined,
  nodeId: NodeID,
  workerTitle: string,
  tool: string,
  detail: string
): Promise<PermDecision> {
  if (!chatId) return Promise.resolve('allow') // no chat surface — cannot ask
  return enqueuePerm(chatId, async () => {
    return new Promise<PermDecision>((resolve) => {
      const entry: PendingPerm = { resolve, workerTitle, tool, detail }
      const queue = pendingPerms.get(chatId) ?? []
      queue.push(entry)
      pendingPerms.set(chatId, queue)
      chat(
        'worker',
        `🔐 权限请求 [${workerTitle}] ${tool}\n  ${detail.slice(0, 200)}\n回复「允许」执行 /「全部允许」本聊天免问 / 「拒绝」`,
        nodeId,
        chatId
      )
      // the CHAT node flips to awaiting_input — that is where the user looks
      void transitionNode(rootDir, chatId, 'awaiting_input').catch(() => undefined)
      void (async () => {
        // restore when this chat has no more pending asks
        await new Promise((r) => setTimeout(r, 100))
        if ((pendingPerms.get(chatId)?.length ?? 0) === 0) {
          await transitionNode(rootDir, chatId, 'running').catch(() => undefined)
        }
      })()
    })
  })
}

/** Memory of chat-level 'allow all' decisions. */
function chatAllows(chatId: NodeID | undefined, tool: string): boolean {
  if (!chatId) return false
  return chatToolAllowAll.get(chatId)?.has(tool) ?? false
}

function rememberAllowAll(chatId: NodeID | undefined, tool: string): void {
  if (!chatId) return
  const set = chatToolAllowAll.get(chatId) ?? new Set<string>()
  set.add(tool)
  chatToolAllowAll.set(chatId, set)
}

function chat(role: 'manager' | 'worker', text: string, nodeId?: NodeID, chatId?: NodeID): void {
  emitOccEvent({ type: 'pipeline.chat', role, text, nodeId, chatId })
}

async function persist(session: AgentSession): Promise<void> {
  try {
    const dir = join(session.rootDir, '.occ', 'nodes', session.nodeId)
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'agent.jsonl')
    await writeFile(file, session.messages.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8')
  } catch {
    // best-effort
  }
}

async function runTurn(session: AgentSession, rootDir: string): Promise<void> {
  session.busy = true
  await transitionNode(rootDir, session.nodeId, 'running').catch(() => undefined)
  try {
    const result = await runAgentLoop({
      provider: session.provider,
      model: session.model,
      messages: session.messages,
      tools: {
        defs: session.tools.map((t) => t.def),
        call: async (name, argsJson) => {
          const tool = session.tools.find((t) => t.def.function.name === name)
          if (!tool) return `error: unknown tool ${name}`
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(argsJson || '{}') as Record<string, unknown>
          } catch {
            return 'error: malformed tool arguments'
          }
          // ── permission gate: sensitive tools ask the user first. Jev cascade:
          // high-confidence safe classification auto-approves (logged); any
          // doubt falls through to the user.
          const policy = getActiveProject()?.policy
          const mode = policy?.toolPermission ?? 'ask'
          const needsAsk = mode !== 'auto' && SENSITIVE_TOOLS.has(name) && !session.allowedTools.has(name) && !chatAllows(session.chatId, name)
          if (process.env.OCC_DEBUG) {
            console.error(`[gate] ${name} mode=${mode} needsAsk=${needsAsk} sessionAllowed=${session.allowedTools.has(name)} chatAllows=${chatAllows(session.chatId, name)} chatId=${session.chatId ?? 'none'}`)
          }
          if (needsAsk && jevEnabled()) {
            try {
              const detail = name === 'bash' ? `$ ${String(args.command ?? '')}` : String(args.path ?? '')
              const jv = await jevToolSafe(name, detail)
              if (jv.safe && jv.probability >= 0.9) {
                session.allowedTools.add(name)
                chat('worker', `🔐 Jev 自动放行 [${session.title}] ${name} (conf=${jv.probability.toFixed(2)})`, session.nodeId, session.chatId)
                return tool.run(args)
              }
            } catch {
              // jev down — fall through to user ask
            }
          }
          if (needsAsk) {
            const detail = name === 'bash' ? `$ ${String(args.command ?? '')}` : `${String(args.path ?? '')}`
            const d = await requestPerm(rootDir, session.chatId, session.nodeId, session.title, name, detail)
            if (d === 'deny') {
              return '用户已明确否决该操作及该目标相关的一切尝试 — 请立即放弃对此文件的任何创建/写入（包括用其它工具变通），直接进入最终汇报并说明该文件未创建。'
            }
            if (d === 'allow_all') {
              session.allowedTools.add(name)
              rememberAllowAll(session.chatId, name)
            }
          }
          return tool.run(args)
        }
      },
      maxSteps: 32,
      callbacks: {
        onUsage: (u) => {
          // meter per-step so costs are visible even if the turn times out
          void (async () => {
            try {
              const g = await getGraph(rootDir)
              const prev = g.nodes[session.nodeId]?.tokenUsage ?? { input: 0, output: 0, cached: 0 }
              await patchNode(rootDir, session.nodeId, {
                tokenUsage: { input: prev.input + u.promptTokens, output: prev.output + u.completionTokens, cached: prev.cached }
              })
            } catch {
              // best-effort
            }
          })()
        },
        onEvent: (e) => {
          if (e.type === 'text' && e.text) {
            chat('worker', `▪ ${session.title}: ${e.text.slice(0, 600)}`, session.nodeId, session.chatId)
          } else if (e.type === 'tool') {
            chat('worker', `⚙ ${session.title} → ${e.tool}()`, session.nodeId, session.chatId)
          } else if (e.type === 'error') {
            chat('worker', `✗ ${session.title}: ${e.text?.slice(0, 300)}`, session.nodeId, session.chatId)
          }
        },
        shouldAbort: () => session.aborted
      }
    })
    session.messages = result.messages
    await persist(session)

    if (result.aborted) {
      await transitionNode(rootDir, session.nodeId, 'aborted').catch(() => undefined)
      chat('manager', `${session.title} aborted`, session.nodeId, session.chatId)
    } else {
      // accumulate real provider usage onto the node (cost visibility)
      const g = await getGraph(rootDir)
      const prev = g.nodes[session.nodeId]?.tokenUsage ?? { input: 0, output: 0, cached: 0 }
      await transitionNode(rootDir, session.nodeId, 'completed', {
        tokenUsage: {
          input: prev.input + result.usage.promptTokens,
          output: prev.output + result.usage.completionTokens,
          cached: prev.cached
        }
      }).catch(() => undefined)
      chat('worker', `✓ ${session.title} done (${result.steps} steps, ${result.usage.completionTokens} out-tokens)`, session.nodeId, session.chatId)
    }
  } catch (e) {
    await patchNode(rootDir, session.nodeId, {
      status: 'failed',
      error: String(e).slice(0, 300)
    }).catch(() => undefined)
    chat('worker', `✗ ${session.title} failed: ${String(e).slice(0, 300)}`, session.nodeId, session.chatId)
  } finally {
    session.busy = false
  }
}

export async function startAgentSession(
  rootDir: string,
  node: { id: NodeID; title: string; workDir?: string },
  opts: { kickoff?: string; providerRef?: string; seed?: AgentMessage[]; chatId?: NodeID; noTools?: boolean; allowAllTools?: boolean }
): Promise<string> {
  const project = getActiveProject()
  if (!project) throw new GraphError('NOT_FOUND', 'no project open')
  const resolved = resolveAgentModel(opts.providerRef ?? project.policy.defaultModel)
  if (!resolved) {
    throw new GraphError(
      'INELIGIBLE_SOURCE',
      `no usable provider for '${opts.providerRef ?? project.policy.defaultModel}' — check opencode.json / auth.json credentials`
    )
  }
  const workDir = node.workDir ?? rootDir
  const session: AgentSession = {
    id: `agt_${nanoid(16)}`,
    nodeId: node.id,
    rootDir,
    title: node.title,
    workDir,
    providerRef: `${resolved.provider.id}/${resolved.model}`,
    provider: resolved.provider,
    model: resolved.model,
    messages: [],
    tools: opts.noTools ? [] : buildTools(workDir),
    busy: false,
    aborted: false,
    chatId: opts.chatId,
    allowedTools: opts.allowAllTools ? new Set<string>(['bash', 'write_file', 'edit_file']) : new Set<string>()
  }
  session.messages.push({ role: 'system', content: systemPrompt(workDir) })
  if (opts.seed?.length) session.messages.push(...opts.seed)
  session.messages.push({
    role: 'user',
    content: opts.kickoff || 'Review the workspace and make progress on the goal described above.'
  })

  sessions.set(session.id, session)
  await patchNode(rootDir, node.id, { sessionId: session.id, channel: 'brief' }).catch(() => undefined)
  chat('worker', `▸ ${node.title} [${session.providerRef}] started`, node.id, session.chatId)
  await persist(session)

  void runTurn(session, rootDir)
  return session.id
}

export function agentSessionBusy(nodeId: NodeID): boolean {
  for (const s of sessions.values()) if (s.nodeId === nodeId) return s.busy
  return false
}

export async function agentSend(rootDir: string, nodeId: NodeID, message: string): Promise<void> {
  const session = [...sessions.values()].reverse().find((s) => s.nodeId === nodeId)
  if (!session) throw new GraphError('NOT_FOUND', `no agent session for node ${nodeId}`)
  if (session.busy) throw new GraphError('ILLEGAL_TRANSITION', 'agent is still working — wait or abort first')
  if (session.aborted) throw new GraphError('ILLEGAL_TRANSITION', 'agent session was aborted')
  session.messages.push({ role: 'user', content: message })
  await persist(session)
  void runTurn(session, rootDir)
}

export function agentAbort(nodeId: NodeID): void {
  for (const s of sessions.values()) if (s.nodeId === nodeId) s.aborted = true
}

export function isAgentSession(sessionId: string | undefined): boolean {
  return !!sessionId && sessionId.startsWith('agt_')
}

/** Seed messages for a fork-style child: the parent's persisted transcript. */
export function loadAgentTranscript(rootDir: string, nodeId: NodeID): AgentMessage[] {
  try {
    const file = join(rootDir, '.occ', 'nodes', nodeId, 'agent.jsonl')
    const raw = readFileSync(file, 'utf8')
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AgentMessage)
      .filter((m) => m.role !== 'system')
  } catch {
    return []
  }
}

export function agentCatalog(): Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> {
  const providers = listAgentProviders(true)
  return providers.map((p) => ({
    id: p.id,
    name: p.name,
    models: (p.models.length ? p.models : ['default']).map((m) => ({ id: m, name: m }))
  }))
}

/** Last assistant text for an agent session (transcript file, not opencode). */
export function agentLastAssistantText(rootDir: string, nodeId: NodeID): string {
  try {
    const file = join(rootDir, '.occ', 'nodes', nodeId, 'agent.jsonl')
    if (!existsSync(file)) return ''
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = JSON.parse(lines[i]) as AgentMessage
      if (m.role === 'assistant' && m.content && m.content.trim()) return m.content
    }
    return ''
  } catch {
    return ''
  }
}
