// §3.4 three inheritance channels over the dual-track execution layer.
// A fork  : native history copy into the node's own directory (SQLite path-copy,
//           the proven 1.0 mechanism — POST /session/:id/fork pins the parent's
//           directory, which is wrong for isolated copies)
// B import: export → prune → import (best-effort; auto-degrades to C on failure)
// C brief : fresh session bound to the node's directory + BRIEF.md + prompt_async
import { writeFile } from 'fs/promises'
import { join } from 'path'
import type { InheritChannel, InheritPlan, ProjectPolicy, SessionID, SessionNode } from '../../shared/types'
import { ocApi } from '../opencode/api'
import { forkSessionIntoDir } from '../opencode/cli'
import { importTranscript, exportSession } from '../opencode/cli'
import { normalizeTranscript } from '../opencode/schema'
import { startAgentSession, loadAgentTranscript, isAgentSession as isAgentSid } from '../agent/session'
import type { ComposeResult } from './composer'
import { renderBrief, renderPrunedTranscript } from './renderer'

export interface ChannelContext {
  rootDir: string
  chatId?: string
  plan: InheritPlan | null
  sources: SessionNode[]
  composed: ComposeResult
  briefPath: string
  briefText: string
  kickoff: string
  policy: ProjectPolicy
}

export interface ChannelOutcome {
  sessionId: SessionID | null
  channel: Exclude<InheritChannel, 'auto'>
  degradedFrom?: Exclude<InheritChannel, 'auto'>
  warnings: string[]
}

/** §3.4 scheduling policy for channel: 'auto' */
export function pickChannel(plan: InheritPlan | null, sources: SessionNode[]): Exclude<InheritChannel, 'auto'> {
  if (!plan || plan.sources.length === 0) return 'brief'
  if (
    plan.sources.length === 1 &&
    sources[0]?.sessionId &&
    plan.sources[0].take.length === 1 &&
    plan.sources[0].take[0] === 'transcript' &&
    !plan.sources[0].range &&
    !plan.sources[0].filter &&
    (plan.workspace.apply?.length ?? 0) === 0
  ) {
    return 'fork'
  }
  return 'import'
}

/** 'providerID/modelID' → { providerID, id }; null when unset/malformed */
export function parseModel(policy: ProjectPolicy): { id: string; providerID: string } | undefined {
  const raw = policy.defaultModel
  if (!raw) return undefined
  const idx = raw.indexOf('/')
  if (idx <= 0) return undefined
  return { providerID: raw.slice(0, idx), id: raw.slice(idx + 1) }
}

export async function runChannel(
  node: SessionNode,
  requested: InheritChannel,
  ctx: ChannelContext,
  workDir: string
): Promise<ChannelOutcome> {
  const warnings: string[] = []
  let degradedFrom: Exclude<InheritChannel, 'auto'> | undefined

  // ── native engine: our own agent loop, zero opencode dependency ──
  if (ctx.policy.engine === 'native') {
    let channelN: 'fork' | 'brief' = requested === 'fork' ? 'fork' : 'brief'
    const seed: ReturnType<typeof loadAgentTranscript> = []
    if (channelN === 'fork') {
      const src = ctx.sources.find((s) => isAgentSid(s.sessionId))
      if (src?.sessionId) {
        const full = loadAgentTranscript(ctx.rootDir, src.id)
        // cap: long chats must not blow the child's context — keep the head
        // (original goal) and the most recent exchanges
        if (full.length > 40) seed.push(...full.slice(0, 2), ...full.slice(-38))
        else seed.push(...full)
      } else if (requested === 'fork') {
        channelN = 'brief'
        degradedFrom = 'fork'
        warnings.push('native fork unavailable (parent has no agent transcript); started fresh')
      }
    }
    // inject the composed inherited context (e.g. reviewer receiving worker outputs)
    if (ctx.briefText) seed.push({ role: 'user', content: ctx.briefText })
    const sid = await startAgentSession(ctx.rootDir, node, {
      kickoff: ctx.kickoff || (ctx.briefText ? 'Read BRIEF.md in the workspace for your inherited context, then proceed.' : undefined),
      seed,
      chatId: ctx.chatId,
      providerRef: ctx.plan?.providerRef,
      // merge/review nodes are text judges — tools only tempt them into
      // re-verifying files their fresh workspace does not contain.
      // ACCEPTANCE verifiers (plan.verify) keep tools for functional checks
      // and run permission-free: they are the system's own acceptance step,
      // and their prompt confines them to read-only verification.
      noTools: node.kind === 'merge' && ctx.plan?.compose?.mode === 'digest-merge' && ctx.plan?.verify !== true,
      allowAllTools: node.kind === 'merge' && ctx.plan?.verify === true
    })
    if (ctx.briefText) await writeBrief(ctx, workDir)
    return { sessionId: sid, channel: channelN, degradedFrom, warnings }
  }

  // ── opencode engine ──
  let channel = requested === 'auto' ? pickChannel(ctx.plan, ctx.sources) : requested

  if (channel === 'fork') {
    const src = ctx.sources[0]
    if (!src?.sessionId || !src.workDir) {
      warnings.push('fork channel unavailable: source has no session yet; falling back')
      channel = 'brief'
      degradedFrom = 'fork'
    } else {
      try {
        const sid = await forkSessionIntoDir(src.sessionId, src.workDir, workDir)
        return { sessionId: sid, channel: 'fork', warnings }
      } catch (e) {
        warnings.push(`fork failed (${String(e)}); falling back to brief`)
        channel = 'brief'
        degradedFrom = 'fork'
      }
    }
  }

  if (channel === 'import') {
    const src = ctx.sources[0]
    try {
      if (!src?.sessionId) throw new Error('source has no session')
      const raw = await exportSession(src.sessionId)
      const transcript = raw ? normalizeTranscript(raw) : null
      if (!transcript || transcript.length === 0) throw new Error('export unreadable')
      // single-session brief-style import: opencode import remains unreliable
      // (1.0 finding: it drops messages), so verify before trusting — §3.4 B
      const sid = await ocApi.createSession({ title: node.title, directory: workDir }).then((s) => s.id)
      const payload = renderPrunedTranscript(sid, ctx.composed)
      const imported = await importTranscript(payload, workDir)
      let verified = false
      if (imported) {
        const msgs = await ocApi.listMessages(imported).catch(() => [])
        verified = msgs.length > 0
        if (verified) return { sessionId: imported, channel: 'import', warnings }
      } else if (sid) {
        // import produced nothing usable — the fresh session still exists; push
        // the context through the brief path on top of it
        await writeBrief(ctx, workDir)
        const kickoff = ctx.kickoff
        await ocApi.promptAsync(sid, kickoff).catch(() => undefined)
        warnings.push('import not verified; context delivered as brief on a fresh session')
        return { sessionId: sid, channel: 'brief', degradedFrom: 'import', warnings }
      }
      if (!verified) throw new Error('import could not be verified')
    } catch (e) {
      warnings.push(`import channel failed (${String(e)}); degrading to brief`)
      channel = 'brief'
      degradedFrom = 'import'
    }
  }

  // channel C — brief (final fallback, zero schema dependency)
  await writeBrief(ctx, workDir)
  const sid = await ocApi.createSession({ title: node.title, directory: workDir, model: parseModel(ctx.policy) })
  return { sessionId: sid.id, channel: 'brief', degradedFrom, warnings }
}

async function writeBrief(ctx: ChannelContext, workDir: string): Promise<void> {
  const text = ctx.briefText || renderBrief(ctx.plan, ctx.composed, ctx.plan ? 'inherit' : 'session')
  await writeFile(join(workDir, 'BRIEF.md'), text, 'utf8')
}
