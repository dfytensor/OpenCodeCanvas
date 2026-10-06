// §8 inherit-node executor: validate -?resolve -?compose -?provision -?// materialize -?bind -?dispatch -?observe. Also hosts the node actions
// (freeze/archive/send/abort/apply) and the SSE + polling status observer.
import { existsSync, readFileSync } from 'fs'
import { basename, join } from 'path'
import { nanoid } from '../ids'
import type {
  ContentManifest,
  CreateNodeResult,
  GraphEdge,
  InheritChannel,
  InheritPlan,
  NodeID,
  NodeStatus,
  SessionNode
} from '../../shared/types'
import { getActiveProject } from '../project/registry'
import { getGraph, newSessionNode, upsertNode, patchNode, transitionNode, addEdge, assertAcyclic, occPaths } from '../graph/store'
import { emitOccEvent } from '../graph/events'
import { GraphError, isSourceEligible } from '../graph/stateMachine'
import { ensureNodeDirs, createSnapshotForNode, nodeDirs } from '../workspace/snapshot'
import { copyTree } from '../workspace/copy'
import { jevEnabled, jevRoute, jevGoalMet } from '../agent/jev'
import { applyCopyChanges, writeConflictReport, type ApplyResult } from '../workspace/apply'
import { archiveNodeStorage, rehydrateNodeStorage } from '../workspace/archive'
import { diffNameStatus } from '../workspace/diff'
import { extractSource, applySourceBudget } from './extractor'
import { composeSources, type ComposeResult } from './composer'
import { estimateTokens } from './budget'
import { truncateTail } from './budget'
import { renderBrief, renderKickoff } from './renderer'
import { runChannel } from './channels'
import { ocApi } from '../opencode/api'
import { subscribeEvents } from '../opencode/sse'
import { isAgentSession, agentSend, agentAbort, startAgentSession } from '../agent/session'
import { hashDirFast } from '../workspace/hash'
import { completeChat } from '../agent/loop'
import { usableModelRefs } from '../agent/providers'
import { resolveAgentModel, resolveAgentModelChain } from '../agent/providers'

// ───────────────────────── round-0 planner: task + cost + topology ─────────────────────────

const PLAN_FORMAT =
  'You are the planner of an agent pipeline. Route this goal at MINIMUM cost.\n' +
  'COST RULE: if ONE agent can complete the goal in a few minutes (create a file, make a small edit, answer from the goal itself), emit exactly ONE task — never split small work.\n' +
  'Respond in EXACTLY this format:\n' +
  'First line: "PLAN: ANSWER" or "PLAN: BUILD"\n' +
  'ANSWER — no workers will be spawned. Choose this ONLY when the goal needs no file changes and no project inspection (pure explanation/opinion). The following lines are the complete answer.\n' +
  'BUILD — the following lines are first-round work tasks (max 3):\n' +
  '  - If subtasks DEPEND on each other, emit ONLY the first one; later rounds continue the chain (serial).\n' +
  '  - Batch multiple lines ONLY when they are truly independent (parallel).\n' +
  'No other prose before the first line.'

async function planGoal(
  rootDir: string,
  goal: string,
  historyHint?: string
): Promise<{ mode: 'answer' | 'build'; tasks: string[]; answer: string }> {
  const project = getActiveProject()
  // walk the provider chain: a rate-limited or broken primary must not kill
  // the pipeline before it even starts
  const chain = resolveAgentModelChain(project?.policy.defaultModel)
  if (chain.length === 0) throw new Error('no provider available for planner')
  const messages = [
    { role: 'system' as const, content: 'You are the planner of an agent pipeline. Route the goal at minimal cost.' },
    {
      role: 'user' as const,
      content:
        `Goal: ${goal}\n\n${PLAN_FORMAT}` +
        (historyHint ? `\n\n近期执行经验（本聊天真实结局，据此最小化成本）：\n${historyHint}` : '')
    }
  ]
  let lastErr: unknown
  for (const resolved of chain) {
    try {
      const text = await completeChat({ provider: resolved.provider, model: resolved.model, messages })
      const answerMode = /^\s*PLAN:\s*ANSWER/im.test(text)
      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !/^PLAN:/i.test(l))
      if (answerMode) return { mode: 'answer', tasks: [], answer: lines.join('\n').trim() }
      const tasks = lines.slice(0, 3)
      if (tasks.length === 0) return { mode: 'answer', tasks: [], answer: goal }
      return { mode: 'build', tasks, answer: '' }
    } catch (e) {
      lastErr = e
      if (chain.length > 1) {
        chat('manager', `⚠ 规划器 ${resolved.provider.id}/${resolved.model} 不可用（${String(e).slice(0, 60)}）— 尝试下一个模型`, undefined, undefined)
      }
    }
  }
  throw lastErr
}

// ───────────────────────── base resolution (§3.5) ─────────────────────────

async function resolveBase(
  rootDir: string,
  graph: ReturnType<typeof getGraph> extends Promise<infer T> ? T : never,
  nodeId: string,
  parents: NodeID[],
  plan: InheritPlan | null,
  baseFromMainline = false
): Promise<{ base: import('../../shared/types').BaseRef; pinnedNow: boolean }> {
  const provided = plan?.workspace?.base
  if (provided && provided.dir && existsSync(provided.dir) && provided.contentHash !== 'mainline') {
    return { base: provided, pinnedNow: false }
  }
  if (!baseFromMainline) {
    // reference a parent's immutable snapshot instead of copying it (frozen
    // parents are content-addressed, so sharing the dir is safe)
    for (const pid of parents) {
      const parent = graph.nodes[pid]
      if (parent?.snapshotDir && existsSync(parent.snapshotDir) && parent.baseRef && parent.baseRef.contentHash !== 'pending') {
        return { base: { ...parent.baseRef, dir: parent.snapshotDir }, pinnedNow: false }
      }
    }
  }
  // mainline@now -?snapshot and pin at this instant (the ONLY legal floating ref)
  const base = await createSnapshotForNode(rootDir, nodeId, rootDir)
  return { base, pinnedNow: true }
}

// ───────────────────────── create node (§8) ─────────────────────────

export async function createInheritNode(
  rootDir: string,
  plan: InheritPlan | null,
  opts: { parents: NodeID[]; kind: SessionNode['kind']; title?: string; kickoff?: string; channel?: InheritChannel; chatId?: NodeID; baseFromMainline?: boolean }
): Promise<CreateNodeResult> {
  const project = getActiveProject()
  if (!project || project.rootDir !== rootDir) {
    throw new GraphError('NOT_FOUND', `project not open: ${rootDir}`)
  }
  const policy = project.policy
  const graph = await getGraph(rootDir)

  // 1. validate
  const nodeId = nanoid(10)
  for (const pid of opts.parents) {
    if (!graph.nodes[pid]) throw new GraphError('NOT_FOUND', `parent node not found: ${pid}`)
  }
  assertAcyclic(graph, opts.parents, nodeId)

  const sources: SessionNode[] = []
  if (plan) {
    for (const sel of plan.sources) {
      const src = graph.nodes[sel.from.nodeId]
      if (!src) throw new GraphError('NOT_FOUND', `source node not found: ${sel.from.nodeId}`)
      if (!isSourceEligible(src.status, policy.allowPartialSources)) {
        throw new GraphError('INELIGIBLE_SOURCE', `node ${src.id} is '${src.status}' - not inheritable`)
      }
      if (src.taint !== 'none') {
        throw new GraphError('INELIGIBLE_SOURCE', `node ${src.id} is tainted (${src.taint}) - inheritance blocked (§14.1)`)
      }
      sources.push(src)
    }
  }

  const title = opts.title ?? `node-${nodeId}`
  let node = newSessionNode(graph, {
    id: nodeId,
    projectId: project.id,
    title,
    kind: opts.kind,
    parents: opts.parents,
    status: 'provisioning',
    phase: 'provision'
  })
  node = await upsertNode(rootDir, node)

  const warnings: string[] = []
  try {
    // 5. provision -?pin the base (§3.5), then copy out the working dir
    const { base, pinnedNow } = await resolveBase(rootDir, graph, node.id, opts.parents, plan, opts.baseFromMainline)
    if (pinnedNow) warnings.push('mainline base pinned at plan-resolution time (contentHash recorded)')
    const dirs = await ensureNodeDirs(rootDir, node.id)
    await copyTree(base.dir as string, dirs.copyDir)

    node = await patchNode(rootDir, node.id, {
      baseRef: base,
      workDir: dirs.copyDir,
      snapshotDir: base.dir ?? nodeDirs(rootDir, node.id).snapshotDir,
      phase: 'workspace'
    })

    // apply inherited file changes onto the fresh copy
    let applyResult: ApplyResult | null = null
    if (plan?.workspace.apply?.length) {
      applyResult = { applied: [], deleted: [], skipped: [], conflictFiles: [] }
      for (const entry of plan.workspace.apply) {
        const src = graph.nodes[entry.from]
        if (!src) continue
        let srcCopy = src.workDir
        if (src.status === 'archived') {
          const re = await rehydrateNodeStorage(rootDir, src)
          srcCopy = re.copyDir
        }
        if (!srcCopy || !src.snapshotDir) {
          warnings.push(`apply skipped: source ${entry.from} has no workspace`)
          continue
        }
        const r = await applyCopyChanges(src.snapshotDir, srcCopy, dirs.copyDir, { paths: entry.paths })
        applyResult.applied.push(...r.applied)
        applyResult.deleted.push(...r.deleted)
        applyResult.skipped.push(...r.skipped)
        applyResult.conflictFiles.push(...r.conflictFiles)
      }
      const report = await writeConflictReport(dirs.copyDir, applyResult, title)
      if (report) warnings.push(`conflicts recorded: ${basename(report)}`)
    }

    // 2-4. resolve sources -?compose -?budget (context document)
    let composed: ComposeResult = { text: '', tokens: 0, degraded: false, sources: [] }
    if (plan && plan.sources.length > 0) {
      const extracted = []
      for (let i = 0; i < plan.sources.length; i++) {
        const sel = plan.sources[i]
        const src = sources[i]
        const ex = await extractSource(sel, src)
        extracted.push(applySourceBudget(sel, ex, truncateTail))
      }
      composed = composeSources(extracted, plan)
      if (composed.degraded) warnings.push('context degraded to fit token budget')
    }
    const briefText = composed.text ? renderBrief(plan, composed, title) : ''

    // 6. materialize -?run the channel (fork / import / brief)
    node = await patchNode(rootDir, node.id, { phase: 'channel' })
    // with plan=null the channel may still need the parent node (-?fork)
    const channelSources = sources.length
      ? sources
      : opts.parents.map((pid) => graph.nodes[pid]).filter((n): n is SessionNode => !!n)
    const outcome = await runChannel(node, opts.channel ?? plan?.channel ?? 'auto', {
      rootDir,
      chatId: opts.chatId,
      plan,
      sources: channelSources,
      composed,
      briefPath: join(dirs.copyDir, 'BRIEF.md'),
      briefText,
      kickoff: opts.kickoff ?? '',
      policy
    }, dirs.copyDir)
    warnings.push(...outcome.warnings)
    if (!outcome.sessionId) throw new Error('channel produced no session id')

    // 7. bind -?explicit, never guessed
    node = await patchNode(rootDir, node.id, {
      sessionId: outcome.sessionId,
      channel: outcome.channel,
      phase: 'dispatch',
      inheritPlan: plan ?? undefined
    })

    // 8. dispatch kickoff — native agent sessions already started their turn
    // with the kickoff inside startAgentSession; only opencode sessions need it
    if (!isAgentSession(outcome.sessionId)) {
      const kickoff = renderKickoff({
        nodeTitle: title,
        kickoff: opts.kickoff,
        hasBrief: outcome.channel === 'brief',
        conflictReport: !!applyResult && applyResult.conflictFiles.length > 0
      })
      await ocApi.promptAsync(outcome.sessionId, kickoff, {
        agent: policy.defaultAgent,
        model: policy.defaultModel
      })
    }

    node = await transitionNode(rootDir, node.id, 'running', { phase: 'done' })

    // 10. index edges
    const edges: GraphEdge[] = []
    for (const pid of opts.parents) {
      const kind: GraphEdge['kind'] = opts.kind === 'merge' ? 'merge' : opts.kind === 'fork' ? 'fork' : 'inherit'
      const label =
        plan?.sources
          .filter((s) => s.from.nodeId === pid)
          .map((s) => `${s.take.join('+')}${s.filter?.paths ? ':' + s.filter.paths.join(',') : ''}`)
          .join(' · ') || undefined
      edges.push(await addEdge(rootDir, { id: `e-${pid}-${node.id}`, source: pid, target: node.id, kind, label }))
    }
    for (const src of sources) {
      if (!opts.parents.includes(src.id)) {
        edges.push(
          await addEdge(rootDir, {
            id: `e-${src.id}-${node.id}`,
            source: src.id,
            target: node.id,
            kind: 'inherit',
            label: 'context source'
          })
        )
      }
    }

    return { node, edges, channel: outcome.channel, degradedFrom: outcome.degradedFrom, warnings }
  } catch (e) {
    // keep the scene: node is never removed (append-only), mark failed
    await transitionNode(rootDir, node.id, 'failed', {
      error: String(e),
      phase: 'failed'
    }).catch(() => undefined)
    throw e
  }
}

// ───────────────────────── node actions ─────────────────────────

export async function inspectNodeManifest(rootDir: string, nodeId: NodeID): Promise<ContentManifest | null> {
  const graph = await getGraph(rootDir)
  const node = graph.nodes[nodeId]
  if (!node) return null
  const dims = {} as ContentManifest['dimensions']
  const zero = { available: false, approxTokens: 0 }
  for (const d of ['transcript', 'summary', 'inputs', 'outputs', 'toolTrace', 'diff', 'files', 'artifacts', 'decisions', 'config'] as const) {
    dims[d] = { ...zero }
  }
  dims.config.available = true
  dims.config.approxTokens = 40
  if (node.summary) {
    dims.summary.available = true
    dims.summary.approxTokens = estimateTokens(node.summary)
  }
  if (node.sessionId) {
    const msgs = await ocApi.listMessages(node.sessionId).catch(() => [])
    if (msgs.length) {
      const full = msgs.map((m) => m.parts.map((p) => (p.type === 'text' && p.text) || '').join('')).join('')
      const t = estimateTokens(full)
      dims.transcript = { available: true, approxTokens: t, detail: `messages: ${msgs.length}` }
      const inputs = msgs.filter((m) => m.info.role === 'user')
      dims.inputs = { available: inputs.length > 0, approxTokens: estimateTokens(inputs.map((m) => m.parts.map((p) => (p.type === 'text' && p.text) || '').join('')).join('')), detail: `inputs: ${inputs.length}` }
      const outs = msgs.filter((m) => m.info.role === 'assistant')
      dims.outputs = { available: outs.length > 0, approxTokens: estimateTokens(outs.map((m) => m.parts.map((p) => (p.type === 'text' && p.text) || '').join('')).join('')), detail: `outputs: ${outs.length}` }
      const toolCount = msgs.reduce((a, m) => a + m.parts.filter((p) => p.type === 'tool').length, 0)
      dims.toolTrace = { available: toolCount > 0, approxTokens: toolCount * 20, detail: `tool calls: ${toolCount}` }
    }
  }
  if (node.workDir && node.snapshotDir && existsSync(node.workDir) && existsSync(node.snapshotDir)) {
    const changes = await diffNameStatus(node.snapshotDir, node.workDir).catch(() => [])
    dims.diff = { available: changes.length > 0, approxTokens: changes.length * 350, detail: `files changed: ${changes.length}` }
    dims.files = { available: changes.length > 0, approxTokens: changes.length * 900, detail: `files: ${changes.length}` }
  }
  const artifactsDir = nodeDirs(rootDir, node.id).artifactsDir
  dims.artifacts = { ...dims.artifacts, available: existsSync(artifactsDir) }
  return { nodeId, dimensions: dims, completedAt: node.updatedAt, partial: !!node.partial, tokenUsage: node.tokenUsage }
}

export async function freezeNode(rootDir: string, nodeId: NodeID): Promise<SessionNode> {
  return transitionNode(rootDir, nodeId, 'frozen')
}

export async function unfreezeNode(rootDir: string, nodeId: NodeID): Promise<SessionNode> {
  return transitionNode(rootDir, nodeId, 'running')
}

export async function archiveNode(rootDir: string, nodeId: NodeID): Promise<SessionNode> {
  const graph = await getGraph(rootDir)
  const node = graph.nodes[nodeId]
  if (!node) throw new GraphError('NOT_FOUND', `node not found: ${nodeId}`)
  await transitionNode(rootDir, nodeId, 'frozen')
  await archiveNodeStorage(rootDir, node)
  return transitionNode(rootDir, nodeId, 'archived')
}

export async function sendToNode(rootDir: string, nodeId: NodeID, message: string): Promise<void> {
  const graph = await getGraph(rootDir)
  const node = graph.nodes[nodeId]
  if (!node) throw new GraphError('NOT_FOUND', `node not found: ${nodeId}`)
  if (node.status === 'frozen' || node.status === 'archived') {
    throw new GraphError('ILLEGAL_TRANSITION', `node ${nodeId} is ${node.status} - unfreeze first`)
  }
  const project = getActiveProject()
  if (!project) throw new GraphError('NOT_FOUND', 'no project open')

  // native agent sessions route through our own loop
  if (isAgentSession(node.sessionId)) {
    await agentSend(rootDir, nodeId, message)
    return
  }

  // auto-provision: a session-less node (e.g. the mainline root) gets a fresh
  // session bound to its own workdir on first message
  let sessionId = node.sessionId
  if (!sessionId) {
    if (project.policy.engine === 'native') {
      sessionId = await startAgentSession(rootDir, node, { kickoff: message })
      await transitionNode(rootDir, nodeId, 'running').catch(() => undefined)
      return
    }
    const { parseModel } = await import('./channels')
    const s = await ocApi.createSession({
      title: node.title,
      directory: node.workDir ?? rootDir,
      model: parseModel(project.policy)
    })
    sessionId = s.id
    await patchNode(rootDir, nodeId, { sessionId, channel: 'brief' })
  }

  await ocApi.promptAsync(sessionId, message)
  if (node.status === 'completed' || node.status === 'aborted' || node.status === 'failed') {
    await transitionNode(rootDir, nodeId, 'running')
  }
}

export async function abortNode(rootDir: string, nodeId: NodeID): Promise<void> {
  const graph = await getGraph(rootDir)
  const node = graph.nodes[nodeId]
  if (!node) return
  if (isAgentSession(node.sessionId)) {
    agentAbort(nodeId)
    return
  }
  if (node.sessionId) await ocApi.abort(node.sessionId).catch(() => undefined)
  // chat/container node: stopping it means stopping EVERY agent in its subtree —
  // a bare return here made the ■ 停止 button a silent no-op
  const { listDescendants } = await import('../graph/store')
  for (const d of listDescendants(graph, nodeId)) {
    if (isAgentSession(d.sessionId)) agentAbort(d.id)
    if (d.status === 'running' || d.status === 'awaiting_input' || d.status === 'provisioning') {
      await transitionNode(rootDir, d.id, 'aborted').catch(() => undefined)
    }
  }
  if (node.status === 'running' || node.status === 'awaiting_input') {
    await transitionNode(rootDir, nodeId, 'aborted').catch(() => undefined)
  }
}

export async function applyNodeToMainline(rootDir: string, nodeId: NodeID): Promise<{ ok: boolean; message: string }> {
  const graph = await getGraph(rootDir)
  const node = graph.nodes[nodeId]
  if (!node) return { ok: false, message: 'node not found' }
  if (!node.workDir || !node.snapshotDir) return { ok: false, message: 'node has no isolated workspace' }
  let copyDir = node.workDir
  if (node.status === 'archived') {
    copyDir = (await rehydrateNodeStorage(rootDir, node)).copyDir
  }
  // triadic coupling verification (from verify/ module): review + Goodhart
  // detection gate the merge — coder cannot self-approve
  const { verifiedApply } = await import('../verify/verifiedApply')
  const vr = await verifiedApply({
    base: node.snapshotDir,
    copy: copyDir,
    destDir: rootDir,
    planLabel: `node-${nodeId}-to-mainline`
  })
  if (vr.conflictFiles.length > 0) {
    await writeConflictReport(rootDir, vr, `apply node-${node.id} → mainline`)
  }
  const parts = [`${vr.applied.length} applied`, `${vr.deleted.length} deleted`]
  if (vr.conflictFiles.length) parts.push(`${vr.conflictFiles.length} conflicts (see CONFLICT.md)`)
  if (vr.goodhartAlert) parts.push(`⚠ Goodhart: ${vr.goodhartAlert.message.slice(0, 60)}`)
  return { ok: true, message: parts.join(', ') }
}

// ───────────────────────── parallel pipeline (§4.4 killer scenario) ─────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Spawn one child per task (concurrent — prompt_async returns immediately),
 * wait for all to reach a terminal status, then auto-create the digest-merge
 * node over their outputs. Partial failure tolerated: merge proceeds with
 * whichever nodes finished (§8.1).
 */
export async function runParallelPipeline(
  rootDir: string,
  opts: { parentId: NodeID; tasks: string[]; title?: string; kickoff?: string; channel?: 'fork' | 'brief'; timeoutMs?: number }
): Promise<{ childIds: NodeID[]; mergeNodeId: NodeID | null; timedOut: boolean }> {
  const childIds: NodeID[] = []
  for (const task of opts.tasks) {
    const res = await createInheritNode(rootDir, null, {
      parents: [opts.parentId],
      kind: 'fork',
      channel: opts.channel ?? 'fork',
      title: task.slice(0, 24) || `task-${childIds.length + 1}`,
      kickoff: task
    })
    childIds.push(res.node.id)
  }

  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60 * 1000)
  let timedOut = false
  while (true) {
    const graph = await getGraph(rootDir)
    const statuses = childIds.map((id) => graph.nodes[id]?.status)
    const allTerminal = statuses.every((s) => s === 'completed' || s === 'failed' || s === 'aborted' || s === 'frozen' || s === 'archived')
    if (allTerminal) break
    if (Date.now() > deadline) {
      timedOut = true
      break
    }
    await sleep(2500)
  }

  // merge whatever finished (completed only — failed nodes have no outputs)
  const graph = await getGraph(rootDir)
  const finished = childIds.filter((id) => {
    const n = graph.nodes[id]
    return n && (n.status === 'completed' || n.status === 'frozen' || n.status === 'archived')
  })
  let mergeNodeId: NodeID | null = null
  if (finished.length > 0) {
    const merge = await createInheritNode(
      rootDir,
      {
        sources: finished.map((id) => ({ from: { nodeId: id }, take: ['outputs', 'diff'] as const })),
        compose: { mode: 'digest-merge', order: 'explicit', dedupe: true, labelSources: true },
        budget: { maxTokens: project_tokenBudget(rootDir), onOverflow: 'truncate-tail' },
        workspace: {
          base: { kind: 'snapshot', contentHash: 'mainline', label: 'mainline@resolve' },
          apply: [],
          onConflict: 'agent'
        },
        channel: 'brief'
      },
      {
        parents: [opts.parentId, ...finished],
        kind: 'merge',
        title: opts.title ?? `pipeline merge (${finished.length}/${childIds.length})`,
        kickoff:
          opts.kickoff ??
          'You are the consolidator of a parallel exploration. The inherited blocks contain each worker node\'s conclusion. Compare them, resolve disagreements, and produce the single correct result with a short justification.'
      }
    )
    mergeNodeId = merge.node.id
  }
  return { childIds, mergeNodeId, timedOut }
}

function project_tokenBudget(rootDir: string): number {
  return getActiveProject()?.policy.maxTokensPerNode ?? 120_000
}

// ───────────────────────── adaptive pipeline (dynamic execution graph) ─────────────────────────

const TERMINAL: NodeStatus[] = ['completed', 'failed', 'aborted', 'frozen', 'archived']

function chat(role: 'manager' | 'worker' | 'final', text: string, nodeId?: NodeID, chatId?: NodeID): void {
  emitOccEvent({ type: 'pipeline.chat', role, text, nodeId, chatId })
}

// §4.6: orchestrator decisions are externalized (survive any compaction)
function decide(rootDir: string, kind: string, text: string, chatId?: NodeID): void {
  try {
    const { appendFileSync, mkdirSync } = require('fs') as typeof import('fs')
    const dir = join(rootDir, '.occ', 'orchestrator')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'decisions.jsonl'), JSON.stringify({ ts: new Date().toISOString(), chatId, kind, text: text.slice(0, 300) }) + '\n', 'utf8')
  } catch {
    // best-effort
  }
}

async function lastAssistantText(rootDir: string, node: SessionNode): Promise<string> {
  if (isAgentSession(node.sessionId)) {
    const { agentLastAssistantText } = await import('../agent/session')
    return agentLastAssistantText(rootDir, node.id)
  }
  if (!node.sessionId) return ''
  const msgs = await ocApi.listMessages(node.sessionId).catch(() => [])
  const last = [...msgs].reverse().find((m) => m.info?.role === 'assistant')
  if (!last) return ''
  return last.parts
    .filter((p) => p.type === 'text')
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('')
}

async function waitTerminal(rootDir: string, ids: NodeID[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const graph = await getGraph(rootDir)
    const statuses = ids.map((id) => graph.nodes[id]?.status)
    if (statuses.every((s) => s && TERMINAL.includes(s))) return
    if (Date.now() > deadline) return
    await sleep(2500)
  }
}

const EVALUATOR_FORMAT =
  'Verification rules: you MAY run read-only checks (run code, read files) to confirm — but never modify files; worker changes are already merged into this workspace.\n' +
  'If every requirement of the goal is demonstrably met, the verdict is DONE.\n' +
  'Respond in EXACTLY this format:\n' +
  'First line: "VERDICT: CONTINUE" or "VERDICT: DONE"\n' +
  'If CONTINUE: emit only the FIRST task when subtasks depend on each other (they run as a serial chain across rounds); batch up to 3 only when they are truly independent.\n' +
  'If DONE: the following lines are the final answer for the user (with verification evidence).\n' +
  'Last line: "FITNESS: <0.00-1.00>" — graded score of how completely the goal is met (0 = not at all, 1 = fully, with working verification).\n' +
  'No other prose before the first line.'

/** Project memory: .occ/CONTEXT.md is the user-curated ground truth (stack,
 *  conventions, landmines). Injected into every worker and verifier so the
 *  first attempt already knows the project — fewer rounds, fewer tokens. */
async function projectContextHint(rootDir: string): Promise<string> {
  try {
    const { readFile } = await import('fs/promises')
    const raw = await readFile(join(rootDir, '.occ', 'CONTEXT.md'), 'utf8')
    const trimmed = raw.slice(0, 2000).trim()
    if (!trimmed) return ''
    return `\n\n项目背景（.occ/CONTEXT.md 摘录 — 其中的约定必须遵守）：\n${trimmed}`
  } catch {
    return ''
  }
}

/** Detect quality gates present in the project (tsconfig, lint/test scripts) and
 *  emit one-line instructions for the acceptance verifier. Empty when no gates. */function qualityGatesHint(rootDir: string): string {
  try {
    const parts: string[] = []
    if (existsSync(join(rootDir, 'tsconfig.json'))) {
      parts.push('TypeScript — run `npx tsc --noEmit` (if node_modules is absent, note and skip)')
    }
    const pkgPath = join(rootDir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }
        if (pkg.scripts?.lint) parts.push('lint — run `npm run lint`')
        if (pkg.scripts?.test) parts.push('tests — run `npm test` when it completes quickly')
      } catch { /* ignore malformed package.json */ }
    }
    if (parts.length === 0) return ''
    return (
      ` QUALITY GATES detected in this project: ${parts.join('; ')}. ` +
      `Run the applicable gates as part of verification. Errors PRE-EXISTING outside ` +
      `this round's changed files are informational only; errors introduced by the ` +
      `merged changes FAIL acceptance. Include gate results in your verdict.`
    )
  } catch {
    return ''
  }
}

// ── artifact closure: files the goal names as creation targets must exist in root ──

const CREATION_VERB = /(创建|新建|写入|生成|添加|保存|create|write|add|generate|save)/i
const FILE_TOKEN = /[A-Za-z0-9_\-\u4e00-\u9fa5]+\.(json|js|ts|tsx|jsx|mjs|cjs|css|html|htm|md|txt|csv|ya?ml|py|sh|ps1)/gi

function extractTargetFiles(goal: string): string[] {
  const files = new Set<string>()
  // NOTE: '.' must NOT be a sentence separator — it would cut file names like alpha.txt in half
  for (const seg of goal.split(/[。；;!?！?\n]/)) {
    if (!CREATION_VERB.test(seg)) continue
    for (const m of seg.matchAll(FILE_TOKEN)) {
      const f = m[0].replace(/^[.\/\\]+/, '')
      if (f.length > 2) files.add(f)
    }
  }
  return [...files]
}

function missingArtifacts(rootDir: string, goal: string): string[] {
  const targets = extractTargetFiles(goal)
  return targets.filter((f) => !existsSync(join(rootDir, f)))
}

/** Remember where the conversation's graph reached, so the NEXT message in
 *  this chat grows from here instead of restarting from the chat root. */
async function saveFrontier(rootDir: string, chatId: NodeID | undefined, frontier: NodeID): Promise<void> {
  if (!chatId || !frontier) return
  await patchNode(rootDir, chatId, { frontierId: frontier }).catch(() => undefined)
}

// ───────────────────────── budget reminder (remind + confirm, never block silently) ─────────────────────────

interface BudgetPending {
  resolve: (decision: 'continue' | 'cancel') => void
  estimate: number
  spent: number
  budget: number
  round: number
  tasks: string[]
}
const budgetPending = new Map<NodeID, BudgetPending>()

export function budgetPendingFor(chatId: NodeID): boolean {
  return budgetPending.has(chatId)
}

export function resolveBudget(chatId: NodeID, decision: 'continue' | 'cancel'): boolean {
  const p = budgetPending.get(chatId)
  if (!p) return false
  budgetPending.delete(chatId)
  p.resolve(decision)
  return true
}

/**
 * Called before dispatching a round. Over budget → notify the chat, flip the
 * chat node to awaiting_input, and WAIT for the user's confirmation. The rest
 * of the system keeps running — only this pipeline pauses.
 */
async function budgetGate(
  rootDir: string,
  cid: NodeID | undefined,
  round: number,
  tasks: string[],
  _spentThisPipeline: number,
  lastPerWorker: number
): Promise<'continue' | 'cancel'> {
  if (!cid) return 'continue'
  // budget is PER CHAT, accumulated across all pipelines of this subtree —
  // a fresh pipeline must not reset the meter
  const graph = await getGraph(rootDir)
  const { listDescendants } = await import('../graph/store')
  const descendants = listDescendants(graph, cid)
  const total = descendants.reduce(
    (a, n) => a + (n.tokenUsage?.input ?? 0) + (n.tokenUsage?.output ?? 0),
    0
  )
  const project = getActiveProject()
  const budget = project?.policy.budgetTokensPerChat ?? 0
  if (!budget) return 'continue'
  const estimate = tasks.length * (lastPerWorker || 20_000)
  // first round: nothing spent yet, but a plan that already blows the whole
  // budget must still ask — otherwise tiny budgets never protect anything
  if (total + estimate <= budget) return 'continue'

  const estK = Math.round(estimate / 1000)
  const usedK = Math.round(total / 1000)
  const budgetK = Math.round(budget / 1000)
  chat(
    'manager',
    `⚠ 预算提醒：本聊天已累计约 ${usedK}k tokens（预算 ${budgetK}k），本轮 ${tasks.length} 个任务预计再花 ~${estK}k。\n` +
      `回复「继续」执行本轮；回复「取消」停止；回复其他内容视为确认并附带补充说明。`,
    undefined,
    cid
  )
  decide(rootDir, 'budget-confirm', `round ${round} est ~${estK}k, spent ~${usedK}k / ${budgetK}k — awaiting user`, cid)
  await transitionNode(rootDir, cid, 'awaiting_input').catch(() => undefined)

  const decision = await new Promise<'continue' | 'cancel'>((resolve) => {
    budgetPending.set(cid, { resolve, estimate, spent: total, budget, round, tasks })
  })

  await transitionNode(rootDir, cid, 'running').catch(() => undefined)
  chat('manager', decision === 'continue' ? '已确认 — 继续执行本轮' : '已取消本轮执行', undefined, cid)
  return decision
}

function suffixOf(applied: number): string {
  return applied > 0 ? `\n\n(${applied} worker workspace(s) merged into the project root)` : ''
}

// ───────────────────────── blackboard stigmergy (worker↔worker indirect interaction, I↑) ─────────────────────────

function blackboardPath(rootDir: string): string {
  return join(rootDir, 'BLACKBOARD.md')
}

async function ensureBlackboard(rootDir: string): Promise<void> {
  try {
    const { writeFileSync } = require('fs') as typeof import('fs')
    const p = blackboardPath(rootDir)
    if (!existsSync(p)) {
      writeFileSync(p, '# BLACKBOARD — agent 发现共享板\n\n（追加式：每个 agent 开工前先读一遍；完成关键步骤后在末尾追加一行发现，格式：- [节点标题] 发现。不要删除他人内容。）\n', 'utf8')
    }
  } catch {
    // ignore
  }
}

/** Union-merge workers' blackboard findings into the root shared board. */
async function mergeBlackboardFromWorkers(rootDir: string, workerDirs: string[]): Promise<void> {
  try {
    const { readFileSync, writeFileSync } = require('fs') as typeof import('fs')
    const p = blackboardPath(rootDir)
    if (!existsSync(p)) return
    const rootLines = readFileSync(p, 'utf8').split('\n')
    const seen = new Set(rootLines)
    const add: string[] = []
    for (const d of workerDirs) {
      const wbb = join(d, 'BLACKBOARD.md')
      if (!existsSync(wbb)) continue
      for (const line of readFileSync(wbb, 'utf8').split('\n')) {
        if (line.trim() && !seen.has(line)) {
          seen.add(line)
          add.push(line)
        }
      }
    }
    if (add.length) writeFileSync(p, rootLines.concat(add).join('\n'), 'utf8')
  } catch {
    // ignore
  }
}

// ───────────────────────── routing experience loop (L2: history improves routing) ─────────────────────────

interface RoutingRecord {
  ts: string
  chatId?: NodeID
  shape?: string
  fitness?: number
  tasks: number
  rounds: number
  outcome: 'success' | 'failed'
  tokens: number
  wallSec: number
  verified?: boolean
  verifyCaught?: boolean
  verifySkipped?: boolean
  jevAccepted?: boolean
}

function routingFile(rootDir: string): string {
  return join(rootDir, '.occ', 'orchestrator', 'routing.jsonl')
}

function recordRouting(rootDir: string, rec: RoutingRecord): void {
  try {
    const { appendFileSync, mkdirSync } = require('fs') as typeof import('fs')
    mkdirSync(join(rootDir, '.occ', 'orchestrator'), { recursive: true })
    appendFileSync(routingFile(rootDir), JSON.stringify(rec) + '\n', 'utf8')
  } catch {
    // best-effort
  }
}

function loadRouting(rootDir: string, chatId?: NodeID, limit = 10): RoutingRecord[] {
  try {
    const { readFileSync } = require('fs') as typeof import('fs')
    const file = routingFile(rootDir)
    if (!existsSync(file)) return []
    const all = readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RoutingRecord)
    const mine = chatId ? all.filter((r) => r.chatId === chatId) : []
    const pool = mine.length >= 3 ? mine : all
    return pool.slice(-limit)
  } catch {
    return []
  }
}

/** Deterministic self-tuning: when history shows multi-worker splits failing,
 *  fall back to a single-task serial chain for this goal. */

interface SelfPolicy {
  version: number
  thresholds: { multiFailRateForSerial: number; minSamples: number }
  rules: Array<{ match: { files: string }; topology: 'serial'; reason: string; updatedAt: string }>
  updatedAt?: string
  updatedBy?: string
  /** shape → last winning variant strategy tag (fit strategies reproduce first) */
  preferredStrategy?: Record<string, string>
}

const DEFAULT_SELF_POLICY: SelfPolicy = {
  version: 0,
  thresholds: { multiFailRateForSerial: 0.5, minSamples: 2 },
  rules: []
}

function selfPolicyFile(rootDir: string): string {
  return join(rootDir, '.occ', 'orchestrator', 'self-policy.json')
}

function loadSelfPolicy(rootDir: string): SelfPolicy {
  try {
    const { readFileSync } = require('fs') as typeof import('fs')
    const file = selfPolicyFile(rootDir)
    if (!existsSync(file)) return { ...DEFAULT_SELF_POLICY }
    const p = JSON.parse(readFileSync(file, 'utf8')) as SelfPolicy
    return { version: p.version ?? 0, thresholds: p.thresholds ?? DEFAULT_SELF_POLICY.thresholds, rules: p.rules ?? [] }
  } catch {
    return { ...DEFAULT_SELF_POLICY }
  }
}

function saveSelfPolicy(rootDir: string, policy: SelfPolicy, reason: string): void {
  try {
    const { writeFileSync } = require('fs') as typeof import('fs')
    policy.version += 1
    policy.updatedAt = new Date().toISOString()
    policy.updatedBy = reason
    writeFileSync(selfPolicyFile(rootDir), JSON.stringify(policy, null, 2), 'utf8')
    decide(rootDir, 'self-optim', `self-policy v${policy.version}: ${reason}`, undefined)
  } catch {
    // best-effort
  }
}

function shapeKey(goal: string): string {
  const n = extractTargetFiles(goal).length
  return n > 0 ? `files:${n}` : 'no-files'
}

function experienceAdjust(rootDir: string, cid: NodeID | undefined, tasks: string[], goal: string): string[] {
  if (!cid) return tasks
  const shape = shapeKey(goal)
  const policy = loadSelfPolicy(rootDir)

  // 1. self-written rules take priority
  const rule = policy.rules.find((r) => r.match.files === shape)
  if (rule && rule.topology === 'serial' && tasks.length > 1) {
    decide(rootDir, 'routing-rule', `self-policy v${policy.version} rule [${shape}] → serial: ${rule.reason}`, cid)
    chat('manager', `📈 自优化规则生效 [${shape}] → 串行链（v${policy.version}，依据：${rule.reason}）`, undefined, cid)
    return [tasks[0]]
  }

  // 2. evolve: measure this shape's own history; if multi-worker keeps failing,
  //    WRITE A NEW RULE for this shape into the self-policy (self-modification)
  const hist = loadRouting(rootDir, cid).filter((r) => r.tasks > 1)
  if (hist.length < policy.thresholds.minSamples) return tasks
  const failRate = hist.filter((r) => r.outcome === 'failed').length / hist.length
  const singleOk = loadRouting(rootDir, cid).some((r) => r.tasks === 1 && r.outcome === 'success')
  if (failRate >= policy.thresholds.multiFailRateForSerial && singleOk) {
    const rule = {
      match: { files: shape },
      topology: 'serial' as const,
      reason: `${hist.length} 次多拆分失败率 ${Math.round(failRate * 100)}%（实测）→ 串行`,
      updatedAt: new Date().toISOString()
    }
    const rules = policy.rules.filter((r) => r.match.files !== shape)
    rules.push(rule)
    saveSelfPolicy(rootDir, { ...policy, rules }, `evolved rule [${shape}] → serial (failRate ${Math.round(failRate * 100)}%)`)
    chat('manager', `🧬 自我优化：为本形态 [${shape}] 写入新规则 → 串行链（v${policy.version + 1}）`, undefined, cid)
    decide(rootDir, 'routing-adjust', `multi-worker fail rate ${Math.round(failRate * 100)}% (${hist.length} runs) — falling back to serial chain`, cid)
    return [tasks[0]]
  }
  return tasks
}

/** Persist this pipeline's routing outcome for future planners. */
function saveRoutingOutcome(
  rootDir: string,
  rec: Omit<RoutingRecord, 'ts'> & { chatId?: NodeID }
): void {
  recordRouting(rootDir, { ts: new Date().toISOString(), ...rec })
}

/** Fire-and-forget: the loop reports progress through pipeline.chat events. */
export function startAdaptivePipeline(
  rootDir: string,
  opts: { parentId: NodeID; goal: string; maxRounds?: number; channel?: 'fork' | 'brief'; chatId?: NodeID }
): void {
  void runAdaptive(rootDir, opts).catch((e) => chat('final', `pipeline error: ${String(e)}`, undefined, opts.chatId))
}

async function runAdaptive(
  rootDir: string,
  opts: { parentId: NodeID; goal: string; maxRounds?: number; channel?: 'fork' | 'brief'; chatId?: NodeID }
): Promise<void> {
  const maxRounds = opts.maxRounds ?? 5
  const channel = opts.channel ?? 'fork'
  const cid = opts.chatId
  let baseId = opts.parentId
  const goalLines = opts.goal.split('\n').map((s) => s.trim()).filter(Boolean)
  const goalText = goalLines.length > 1 ? goalLines.map((l, i) => `${i + 1}. ${l}`).join(' ') : goalLines[0]
  let tasks: string[] = goalLines.length > 1 ? goalLines : [opts.goal.trim()]
  const seenTaskSets = new Set<string>()
  const normTasks = (arr: string[]): string =>
    arr.map((t) => t.toLowerCase().replace(/\s+/g, ' ').replace(/[。．.！!？?，,]+$/, '')).sort().join('|')
  seenTaskSets.add(normTasks(tasks))
  let frontier = opts.parentId
  const shape = shapeKey(goalText)

  chat('manager', `goal accepted: ${goalText}`, undefined, cid)
  const pipelineStart = Date.now()
  const firstTasks = () => tasks.length
  let roundsUsed = 0
  const historyRecords = loadRouting(rootDir, cid)
  const historyHint = historyRecords.length
    ? historyRecords
        .map((r) => `- 拆分 ${r.tasks} 任务 / ${r.rounds} 轮 → ${r.outcome}（${Math.round(r.tokens / 1000)}k tokens, ${r.wallSec}s）`)
        .join('\n')
    : ''
  if (historyHint) chat('manager', `📜 载入 ${historyRecords.length} 条历史路由经验`, undefined, cid)
  tasks = experienceAdjust(rootDir, cid, tasks, opts.goal)

  // ── round-0 planner: Jev cascade (70-500ms, ~$0.0001) → GLM planner fallback ──
  try {
    let planned = false
    if (jevEnabled()) {
      try {
        const j = await jevRoute(opts.goal)
        decide(rootDir, 'plan-jev', `route=${j.mode} parallel=${j.parallel} conf=${j.confidence} (${Math.round(j.latencyMs ?? 0)}ms)`, cid)
        if (j.mode === 'answer') {
          // closure applies to every path: ANSWER is only legal when the goal
          // names no missing creation targets — a wrong ANSWER skips the work
          const missing = missingArtifacts(rootDir, opts.goal)
          if (missing.length === 0) {
            chat('manager', 'trivial goal — answering directly, no nodes needed', undefined, cid)
            chat('final', opts.goal, undefined, cid)
            return
          }
          chat('manager', `Jev said ANSWER, but missing artifacts: ${missing.join(', ')} — rerouting to BUILD`, undefined, cid)
          tasks = [opts.goal.trim()]
        } else {
          tasks = j.parallel && goalLines.length > 1 ? goalLines : [opts.goal.trim()]
        }
        planned = true
      } catch (e) {
        chat('manager', `Jev 路由不可用（${String(e).slice(0, 60)}）— 回退 GLM 规划`, undefined, cid)
      }
    }
    if (!planned) {
      if (process.env.OCC_DEBUG) console.error('[DBG] planner calling…')
      const plan = await planGoal(rootDir, opts.goal, historyHint)
      if (process.env.OCC_DEBUG) console.error('[DBG] planner →', plan.mode, JSON.stringify(plan.tasks))
      if (plan.mode === 'answer') {
        // closure applies to every path: ANSWER is only legal when the goal
        // names no missing creation targets — a wrong ANSWER skips the work
        const missing = missingArtifacts(rootDir, opts.goal)
        if (missing.length === 0) {
          chat('manager', 'trivial goal — answering directly, no nodes needed', undefined, cid)
          chat('final', plan.answer || opts.goal, undefined, cid)
          return
        }
        chat('manager', `planner suggested ANSWER, but missing artifacts: ${missing.join(', ')} — rerouting to BUILD`, undefined, cid)
        tasks = [opts.goal.trim()]
      } else {
        tasks = plan.tasks
      }
    }
    decide(rootDir, 'plan', `build: ${tasks.length} task(s)`, cid)
    chat(
      'manager',
      `plan: ${tasks.length} first-round task(s) — ${tasks.length > 1 ? 'parallel fan-out' : 'serial chain ready'}`,
      undefined,
      cid
    )
  } catch (e) {
    chat('manager', `planner unavailable (${String(e).slice(0, 80)}) — defaulting to direct build`, undefined, cid)
  }

  let spent = 0
  let lastPerWorker = 0

  for (let round = 1; round <= maxRounds; round++) {
    // budget gate: remind + wait for confirmation when over budget (§ cost planning)
    const gate = await budgetGate(rootDir, cid, round, tasks, spent, lastPerWorker)
    if (process.env.OCC_DEBUG) console.error('[DBG] round', round, 'gate →', gate)
    if (gate === 'cancel') {
      chat('final', '已按你的要求取消本轮执行。', undefined, cid)
      await saveFrontier(rootDir, cid, frontier)
      saveRoutingOutcome(rootDir, { chatId: cid, shape, tasks: firstTasks(), rounds: round, outcome: 'failed', tokens: spent, wallSec: Math.round((Date.now() - pipelineStart) / 1000) })
      return
    }

    chat('manager', `round ${round}/${maxRounds}: dispatching ${tasks.length} worker(s)`, undefined, cid)

    // ── shared round snapshot: ONE copy of mainline@now for the whole round
    // instead of one per worker (IO ×N saved on parallel fan-out)
    if (process.env.OCC_DEBUG) console.error('[DBG] round snapshot…')
    const roundSnapDir = join(rootDir, '.occ', 'snapshots', `round-${nanoid(8)}`)
    await copyTree(rootDir, roundSnapDir)
    if (process.env.OCC_DEBUG) console.error('[DBG] round snapshot done, hash…')
    const roundBase: InheritPlan['workspace']['base'] = {
      kind: 'snapshot',
      contentHash: await hashDirFast(roundSnapDir),
      label: `round${round}@${new Date().toISOString().slice(0, 16)}`,
      dir: roundSnapDir
    }
    const roundPlan: InheritPlan = {
      sources: [],
      compose: { mode: 'concat', order: 'explicit', dedupe: false, labelSources: false },
      budget: { maxTokens: 0, onOverflow: 'truncate-tail' },
      workspace: { base: roundBase, apply: [], onConflict: 'agent' },
      channel
    }

    // stigmergy: shared blackboard must exist before workers start
    await ensureBlackboard(rootDir)

    // ── variant competition (M↑ with selection): when this shape's LAST run
    // failed, retry with K=3 DIVERSE strategy variants; the acceptance
    // verifier picks the winner. Only for single-task goals.
    const shapeFailures = historyRecords.filter((r) => r.shape === shape && r.outcome === 'failed')
    const lastShapeRunFailed =
      shapeFailures.length > 0 &&
      Math.max(...shapeFailures.map((r) => Date.parse(r.ts))) >
        Math.max(...historyRecords.filter((r) => r.outcome === 'success').map((r) => Date.parse(r.ts)), 0)

    // ── concurrency cap from policy (§4.4 scheduler, minimal form)
    const cap = Math.max(1, getActiveProject()?.policy.concurrency ?? 4)
    let chunks: string[][] = []
    const isVariantRound =
      lastShapeRunFailed && tasks.length === 1
    if (isVariantRound) {
      // variant competition: three diverse strategies race on the same task.
      // TRUE diversity: each variant round-robins a different usable model.
      const strategies = [
        { tag: 'A', hint: '策略A·最小改动：用最直接、最少代码的方式完成任务，不做额外发挥。' },
        { tag: 'B', hint: '策略B·稳健实现：完整实现每一步，每步都实际运行验证。' },
        { tag: 'C', hint: '策略C·测试先行：先写验证脚本/命令，再实现直到全部通过。' }
      ]
      // reproduction of fit strategies: previous winner of this shape goes first
      const preferred = loadSelfPolicy(rootDir).preferredStrategy?.[shape]
      if (preferred) strategies.sort((a, b) => (b.tag === preferred ? 1 : 0) - (a.tag === preferred ? 1 : 0))
      const lines = strategies.map((s) => `${s.hint}\n任务：${tasks[0]}\n（你是变体 ${s.tag}）`)
      for (let i = 0; i < lines.length; i += cap) chunks.push(lines.slice(i, i + cap))
      chat('manager', `🧬 变体竞争：上轮同形态失败 — 派 ${lines.length} 个异构变体并行（跨模型）`, undefined, cid)
      decide(rootDir, 'variants', `${lines.length} strategy variants (A/B/C) on failed shape`, cid)
    } else {
      for (let i = 0; i < tasks.length; i += cap) chunks.push(tasks.slice(i, i + cap))
    }

    // TRUE model diversity: variant rounds round-robin every usable
    // (provider, model) pair — genuine model-family diversity, not prompts
    const usableModels = isVariantRound ? usableModelRefs() : []

    // workers run concurrently within a chunk; chunks run as sequential waves.
    // base = mainline@now (shared snapshot) so every worker sees ALL prior
    // rounds' merged work; conversation context comes from the fork transcript
    const BB_HINT =
      '\n\n协作约定：工作区根目录有 BLACKBOARD.md（兄弟 agent 的发现共享板）——开工前先读一遍；完成关键步骤后把你的发现追加一行到末尾（格式：- [发现] 说明）。不要删除他人内容。'
    const childIds: NodeID[] = []
    for (const chunk of chunks) {
      for (const task of chunk) {
        const vi = childIds.length
        const variantPlan =
          isVariantRound && usableModels.length > 0
            ? { ...roundPlan, providerRef: usableModels[vi % usableModels.length].ref }
            : roundPlan
        const res = await createInheritNode(rootDir, variantPlan, {
          parents: [baseId],
          kind: 'fork',
          channel,
          title: task.slice(0, 24) || `worker-r${round}`,
          kickoff: task + BB_HINT + '\n\n完成标准（必须遵守）：改动后必须实际运行/读回验证（运行脚本或读取文件），最终回复中给出验证证据，再声明任务完成。' + await projectContextHint(rootDir),
          chatId: cid
        })
        childIds.push(res.node.id)
        chat('worker', `▸ spawned: ${task}`, res.node.id, cid)
      }
      if (chunks.length > 1) await waitTerminal(rootDir, childIds, 10 * 60 * 1000)
    }

    await waitTerminal(rootDir, childIds, 10 * 60 * 1000)

    const graph = await getGraph(rootDir)
    const finished: NodeID[] = []
    const tails = new Map<NodeID, string>()
    let roundTokens = 0
    for (const id of childIds) {
      const n = graph.nodes[id]
      if (!n) continue
      roundTokens += (n.tokenUsage?.input ?? 0) + (n.tokenUsage?.output ?? 0)
      if (n.status === 'completed' || n.status === 'frozen' || n.status === 'archived') finished.push(id)
      const tail = (await lastAssistantText(rootDir, n)).slice(0, 500)
      tails.set(id, tail)
      chat('worker', `▪ ${n.title} [${n.status}] ${tail ? '→ ' + tail : '(no output)'}`, id, cid)
    }
    spent += roundTokens
    if (finished.length > 0) lastPerWorker = Math.round(roundTokens / finished.length)
    if (finished.length === 0) {
      const rateLimited = childIds.some((id) => {
        const n = graph.nodes[id]
        return !!n?.error && /429|上限|quota|rate.?limit/i.test(n.error)
      })
      chat(
        'final',
        rateLimited
          ? '⚠️ provider 限流/配额已用尽（429）——额度恢复后重试即可，无需改代码'
          : 'all workers failed — pipeline stopped',
        undefined,
        cid
      )
      saveRoutingOutcome(rootDir, {
        chatId: cid,
        shape,
        tasks: firstTasks(),
        rounds: round,
        outcome: 'failed',
        tokens: spent,
        wallSec: Math.round((Date.now() - pipelineStart) / 1000)
      })
      roundsUsed = round
      return
    }

    // ── merge-back: land finished workers into the project root so closure
    // and the verifier both see the merged reality.
    // VARIANT ROUNDS are the exception: competing implementations must NOT be
    // merged together (franken-merge) — only the verified winner lands, after
    // the verifier's verdict.
    const variantRound = lastShapeRunFailed && tasks.length === 1
    let applied = 0
    if (!variantRound) {
      for (const id of finished) {
        const r = await applyNodeToMainline(rootDir, id).catch(() => ({ ok: false, message: '' }))
        if (r.ok && !r.message.startsWith('0 applied, 0 deleted')) applied++
      }
      if (applied > 0) {
        decide(rootDir, 'merge-back', `${applied} workspace(s) applied to mainline`, cid)
        chat('manager', `⇩ ${applied} 个工作区已合并进项目根`, undefined, cid)
      }
    } else {
      chat('manager', `🧬 变体轮：${finished.length} 个实现待验收选优（暂不合并）`, undefined, cid)
    }
    // stigmergy: union workers' blackboard findings into the shared board
    await mergeBlackboardFromWorkers(
      rootDir,
      finished.map((id) => graph.nodes[id]?.workDir).filter((d): d is string => !!d && existsSync(join(d, 'BLACKBOARD.md')))
    )

    // artifact closure on the merged root
    const missing = missingArtifacts(rootDir, goalText)
    if (missing.length > 0 && round < maxRounds) {
      decide(rootDir, 'closure', `merged but missing: ${missing.join(', ')}`, cid)
      chat('manager', `round ${round} merged, but missing artifacts: ${missing.join(', ')} — extending`, undefined, cid)
      tasks = missing.map((f) => `原目标：${goalText}。创建缺失的文件 ${f}（已有内容保持不变）。写入后验证存在，然后报告任务完成。`)
      baseId = frontier
      continue
    }

    // ── verifier value learning (self-decided QA depth): if the acceptance
    // verifier has run ≥3 times for this goal shape and NEVER caught a real
    // problem (always DONE first pass), it is pure overhead for this shape —
    // skip it and accept worker self-reports + artifact closure.
    const shapeHist = loadRouting(rootDir, cid).filter((r) => r.shape === shape && r.verified !== undefined)
    const verifiedRuns = shapeHist.filter((r) => r.verified === true)
    const caught = shapeHist.filter((r) => r.verifyCaught === true).length
    const skipVerifier = verifiedRuns.length >= 3 && caught === 0
    if (skipVerifier) {
      const wallSec = Math.round((Date.now() - pipelineStart) / 1000)
      chat(
        'manager',
        `📉 验收价值学习：[${shape}] 近 ${verifiedRuns.length} 次验收从未发现问题 — 本轮跳过验收员（省 ~5-8k tokens），闭环校验照常`,
        undefined,
        cid
      )
      decide(rootDir, 'verify-skip', `shape ${shape}: ${verifiedRuns.length} verified runs, 0 caught — verifier skipped`, cid)
      const answer = tails.size
        ? [...tails.values()].map((t) => `• ${t.replace(/\s+$/, '')}`).join('\n')
        : '(workers self-reported complete)'
      chat('final', answer + '（轻任务通道：跳过验收）', finished[0] ?? frontier, cid)
      await saveFrontier(rootDir, cid, frontier)
      saveRoutingOutcome(rootDir, {
        chatId: cid,
        shape,
        tasks: firstTasks(),
        rounds: round,
        outcome: 'success',
        tokens: spent,
        wallSec,
        verified: false,
        verifySkipped: true
      })
      return
    }

    // ── acceptance verifier: tools ON, workspace = merged root, judges
    // ── acceptance cascade, stage 1: Jev fast judge (~$0.0001, <1s) on the
    // merged evidence. High-confidence "goal met" accepts WITHOUT spawning the
    // GLM verifier node (saves ~5-20k tokens/run). Any doubt escalates.
    if (jevEnabled() && finished.length > 0) {
      try {
        const evidence = [...tails.values()].join('\n').slice(0, 4000)
        const jv = await jevGoalMet(goalText, evidence)
        decide(rootDir, 'verify-jev', `goal_met probability=${jv.probability.toFixed(2)}`, cid)
        if (jv.met && jv.probability >= 0.85) {
          const wallSec = Math.round((Date.now() - pipelineStart) / 1000)
          const prevVerified = loadRouting(rootDir, cid).filter((r) => r.chatId === cid && r.verified)
          const prevTok = prevVerified.length
            ? Math.round(prevVerified.reduce((a, r) => a + r.tokens, 0) / prevVerified.length)
            : 0
          let delta = ''
          if (prevTok > 0) {
            const nowK = Math.round(spent / 1000)
            const pct = Math.round(((prevTok - spent) / prevTok) * 100)
            delta = `\n\n(自我评估：本轮 ${wallSec}s / ${nowK}k tokens | 本聊天历史均值 ${Math.round(prevTok / 1000)}k — ${pct >= 0 ? '省 ' + pct + '%' : '多花 ' + -pct + '%'}；Jev 验收通过 conf=${jv.probability.toFixed(2)})`
          }
          chat('final', `✅ 验收通过（Jev 级联 conf=${jv.probability.toFixed(2)}）。` + suffixOf(applied) + delta, finished[0], cid)
          await saveFrontier(rootDir, cid, frontier)
          saveRoutingOutcome(rootDir, {
            chatId: cid,
            shape,
            tasks: firstTasks(),
            rounds: round,
            outcome: 'success',
            tokens: spent,
            wallSec,
            verified: true,
            jevAccepted: true
          })
          return
        }
        chat('manager', `Jev 快筛不确定（p=${jv.probability.toFixed(2)}）— 升级 GLM 验收员`, undefined, cid)
      } catch (e) {
        chat('manager', `Jev 验收不可用（${String(e).slice(0, 60)}）— 直接 GLM 验收`, undefined, cid)
      }
    }

    // FUNCTIONALLY (runs code / reads files). The pipeline does not trust
    // worker self-reports alone — it verifies and decides for itself.
    const evaluation = await createInheritNode(
      rootDir,
      {
        sources: finished.map((id) => ({ from: { nodeId: id }, take: ['outputs' as const] })),
        compose: { mode: 'digest-merge', order: 'explicit', dedupe: true, labelSources: true },
        budget: { maxTokens: project_tokenBudget(rootDir), onOverflow: 'truncate-tail' },
        verify: true,
        workspace: {
          base: {
            kind: 'snapshot',
            contentHash: await hashDirFast(rootDir),
            label: `verify@${new Date().toISOString().slice(0, 16)}`,
            dir: rootDir
          },
          apply: [],
          onConflict: 'agent'
        },
        channel: 'brief'
      },
      {
        parents: [baseId, ...finished],
        kind: 'merge',
        title: `verify r${round}`,
        kickoff:
          `You are the ACCEPTANCE VERIFIER. Original goal: "${goalText}". ` +
          `The inherited blocks summarize what workers claim, and this workspace IS ` +
          `the merged project root. Verify FUNCTIONALLY: run the code, read the named ` +
          `files, check every requirement (tools are for verification only — do not modify files). ` +
          `${EVALUATOR_FORMAT}` + qualityGatesHint(rootDir) + await projectContextHint(rootDir),
        chatId: cid
      }
    )
    chat('manager', `round ${round} results merged → evaluating`, evaluation.node.id, cid)
    frontier = evaluation.node.id

    await waitTerminal(rootDir, [evaluation.node.id], 8 * 60 * 1000)
    const eg = await getGraph(rootDir)
    const en = eg.nodes[evaluation.node.id]
    const text = en ? await lastAssistantText(rootDir, en) : ''
    roundsUsed = round
    if (!text) {
      chat('final', 'evaluator produced no verdict (provider issue?) — stopping', undefined, cid)
      return
    }
    chat('manager', text.slice(0, 800), evaluation.node.id, cid)
    decide(rootDir, 'verdict', text.slice(0, 300), cid)

    const verdictDone = /VERDICT:\s*DONE/i.test(text)
    const fitnessMatch = /FITNESS:\s*([0-9.]+)/i.exec(text)
    const fitness = fitnessMatch ? Math.max(0, Math.min(1, Number(fitnessMatch[1]))) : verdictDone ? 1 : 0

    // variant competition: the verifier picks the winning variant; ONLY the
    // winner's workspace lands in the project root (no franken-merge)
    let winnerId: NodeID | null = null
    if (variantRound && finished.length > 0) {
      const winMatch = /WINNER:\s*v?([0-9]+)/i.exec(text)
      const winIdx = winMatch ? Math.min(finished.length, Math.max(1, Number(winMatch[1]))) - 1 : 0
      winnerId = finished[winIdx] ?? finished[0]
      const wr = await applyNodeToMainline(rootDir, winnerId).catch(() => ({ ok: false, message: '' }))
      chat('manager', `🧬 冠军判定：变体 ${winIdx + 1}/${finished.length}${wr.ok ? ' — 已合并进项目根' : '（合并失败）'}`, winnerId, cid)
      decide(rootDir, 'variant-winner', `variant ${winIdx + 1} of ${finished.length} applied`, cid)
    }
    const closureMissing = verdictDone ? missingArtifacts(rootDir, goalText) : []

    // evaluator says DONE but the goal's named artifacts never landed →
    // extend instead of declaring victory
    if (verdictDone && closureMissing.length > 0 && round < maxRounds) {
      decide(rootDir, 'closure', `DONE but missing: ${closureMissing.join(', ')} — extending`, cid)
      chat('manager', `evaluator says DONE, but missing artifacts: ${closureMissing.join(', ')} — extending`, undefined, cid)
      tasks = closureMissing.map((f) => `原目标：${goalText}。创建缺失的文件 ${f}（已有内容保持不变）。写入后验证存在，然后报告任务完成。`)
      baseId = evaluation.node.id
      continue
    }

    if (verdictDone || round === maxRounds) {
      const answer = text.replace(/VERDICT:\s*\w+/i, '').trim()
      const wallSec = Math.round((Date.now() - pipelineStart) / 1000)

      // reproduction (C↑): if this was a variant round, record the winning
      // strategy so future same-shape bursts reproduce it first
      if (variantRound && finished.length >= 2) {
        const winMatch = /WINNER:\s*v?([0-9]+)/i.exec(text)
        if (winMatch) {
          const winIdx = Math.min(finished.length, Math.max(1, Number(winMatch[1]))) - 1
          const tag = ['A', 'B', 'C'][winIdx]
          if (tag) {
            const pol = loadSelfPolicy(rootDir)
            pol.preferredStrategy = { ...pol.preferredStrategy, [shape]: tag }
            saveSelfPolicy(rootDir, pol, `reproducing strategy ${tag} for [${shape}] (verifier-picked winner)`)
            chat('manager', `🧬 策略 ${tag} 入选为本形态优选（下次失败重试优先繁殖）`, undefined, cid)
          }
        }
      }

      // improvement delta vs this chat's previous verified pipelines
      // improvement delta vs this chat's previous verified pipelines
      const prevVerified = loadRouting(rootDir, cid).filter((r) => r.chatId === cid && r.verified)
      const prevTok = prevVerified.length
        ? Math.round(prevVerified.reduce((a, r) => a + r.tokens, 0) / prevVerified.length)
        : 0
      let delta = ''
      if (prevTok > 0) {
        const nowK = Math.round(spent / 1000)
        const pct = Math.round(((prevTok - spent) / prevTok) * 100)
        delta = `\n\n(自我评估：本轮 ${wallSec}s / ${nowK}k tokens | 本聊天历史均值 ${Math.round(prevTok / 1000)}k tokens — ${pct >= 0 ? '省 ' + pct + '%' : '多花 ' + -pct + '%'}；验收${verdictDone ? '通过' : '达轮次上限'})`
      }
      chat('final', (answer || '(done — no final text)') + suffixOf(applied) + delta, evaluation.node.id, cid)
      decide(rootDir, 'merge-back', `${applied} workspace(s) applied to mainline`, cid)
      await saveFrontier(rootDir, cid, frontier)
      saveRoutingOutcome(rootDir, {
        chatId: cid,
        shape,
        tasks: firstTasks(),
        rounds: round,
        outcome: verdictDone ? 'success' : 'failed',
        tokens: spent,
        wallSec,
        verified: verdictDone,
        verifyCaught: !verdictDone,
        fitness
      })
      return
    }

    // dynamic extension: next subtasks come from the evaluator's lines.
    // If the evaluator just re-issues a task set we already ran, converge.
    const next = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^VERDICT:/i.test(l) && !l.startsWith('#'))
      .slice(0, 3)
    if (next.length && seenTaskSets.has(normTasks(next))) {
      const answer = text.replace(/VERDICT:\s*\w+/i, '').trim()
      chat('final', (answer || 'workers report the goal is complete.') + ' (repeated tasks — converged)', evaluation.node.id, cid)
      return
    }
    tasks = next.length ? next : [goalText]
    seenTaskSets.add(normTasks(tasks))
    baseId = evaluation.node.id // inheritance chain grows through the review node
  }
}

// ───────────────────────── observer (§8.1) ─────────────────────────

const observers = new Set<string>()
// sessionId -?first time we saw the session stuck in provider retry
const retrySince = new Map<string, number>()
const RETRY_TIMEOUT_MS = 5 * 60 * 1000

export function ensureObserver(rootDir: string): void {
  if (observers.has(rootDir)) return
  observers.add(rootDir)

  const applyStatus = async (sessionId: string, type: string | undefined) => {
    // native agent sessions manage their own status transitions
    if (isAgentSession(sessionId)) return
    const graph = await getGraph(rootDir)
    for (const node of Object.values(graph.nodes)) {
      if (node.sessionId !== sessionId) continue
      if (type === 'idle' && node.status === 'running') {
        await transitionNode(rootDir, node.id, 'completed').catch(() => undefined)
      } else if (type === 'busy' && (node.status === 'completed' || node.status === 'awaiting_input')) {
        await transitionNode(rootDir, node.id, 'running').catch(() => undefined)
      } else if (type === 'awaiting' && node.status === 'running') {
        await transitionNode(rootDir, node.id, 'awaiting_input').catch(() => undefined)
      }
      return
    }
  }

  subscribeEvents({
    onEvent: (e) => {
      const props = (e.properties ?? {}) as Record<string, unknown>
      const sid = (props.sessionID ?? props.sessionId) as string | undefined
      const info = props.info as { id?: string } | undefined
      const type = String(e.type ?? '')
      if (sid) {
        if (type.includes('idle')) void applyStatus(sid, 'idle')
        else if (type.includes('busy')) void applyStatus(sid, 'busy')
        else if (type.toLowerCase().includes('permission')) void applyStatus(sid, 'awaiting')
        else if (type.includes('error')) void applyStatus(sid, 'error')
      } else if (info?.id && type.includes('idle')) {
        void applyStatus(info.id, 'idle')
      }
    }
  })

  // reconciliation poll -?events can drop, status must converge (§8.1).
  // GET /session/status only lists ACTIVE sessions: a running node whose
  // session is absent from the map has gone idle -?completed.
  setInterval(() => {
    void (async () => {
      try {
        const graph = await getGraph(rootDir)
        const statuses = await ocApi.getStatus().catch(() => null)
        if (!statuses) return
        for (const node of Object.values(graph.nodes)) {
          if (!node.sessionId) continue
          if (isAgentSession(node.sessionId)) continue // native sessions self-manage
          if (node.status !== 'running' && node.status !== 'awaiting_input' && node.status !== 'provisioning') continue
          const s = statuses[node.sessionId]
          const type = s?.type
          if (type === 'busy') {
            await applyStatus(node.sessionId, 'busy')
          } else if (type === 'awaiting') {
            await applyStatus(node.sessionId, 'awaiting')
          } else if (type === 'retry') {
            // model call failing -?opencode retries on its own; if it never
            // recovers (e.g. provider 403), fail the node instead of ghosting
            const since = retrySince.get(node.sessionId) ?? Date.now()
            retrySince.set(node.sessionId, since)
            if (Date.now() - since > RETRY_TIMEOUT_MS) {
              retrySince.delete(node.sessionId)
              await patchNode(rootDir, node.id, {
                status: 'failed',
                error: 'provider retry timeout -?model call keeps failing (check provider credentials/region)'
              }).catch(() => undefined)
            }
            continue
          } else {
            retrySince.delete(node.sessionId)
            // a stuck session can be ABSENT from the status map (no active
            // turn registered). Only complete when a real assistant turn
            // exists -?otherwise the model never ran (provider failure).
            const msgs = await ocApi.listMessages(node.sessionId).catch(() => [])
            const hasAssistant = msgs.some((m) => m.info?.role === 'assistant')
            if (hasAssistant) {
              await applyStatus(node.sessionId, 'idle')
            } else {
              const key = `${node.sessionId}:noout`
              const since = retrySince.get(key) ?? Date.now()
              retrySince.set(key, since)
              if (Date.now() - since > RETRY_TIMEOUT_MS) {
                retrySince.delete(key)
                await patchNode(rootDir, node.id, {
                  status: 'failed',
                  error: 'no model output -?provider call never produced a turn (check provider credentials/region)'
                }).catch(() => undefined)
              }
            }
          }
        }
      } catch {
        // server down -?ignore this tick
      }
    })()
  }, 8000)
}

export function observerPaths(rootDir: string): ReturnType<typeof occPaths> {
  return occPaths(rootDir)
}
