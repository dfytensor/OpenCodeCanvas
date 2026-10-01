// §3.3 Composer: merge extracted sources into one context document.
// Modes: concat / merge / patch-apply(handled at workspace level) / digest-merge
import type { InheritPlan } from '../../shared/types'
import { truncateTail } from './budget'
import type { ExtractedBlock, ExtractedSource } from './extractor'

export interface ComposeResult {
  text: string
  tokens: number
  degraded: boolean
  sources: Array<{ nodeId: string; blocks: number; chars: number }>
}

function labelHeader(nodeId: string, label: string, partial: boolean): string {
  const flag = partial ? ' · PARTIAL' : ''
  return `\n\n===== [from: node-${nodeId}] ${label}${flag} =====\n\n`
}

export function composeSources(
  sources: ExtractedSource[],
  plan: InheritPlan
): ComposeResult {
  const label = plan.compose.labelSources
  const perSource = sources.map((s) => ({
    nodeId: s.nodeId,
    blocks: s.blocks.length,
    chars: s.blocks.reduce((a, b) => a + b.text.length, 0)
  }))

  let body: string
  if (plan.compose.mode === 'digest-merge' || plan.compose.mode === 'merge') {
    // group blocks by dimension across sources; same-dimension blocks are
    // listed side by side so the agent can arbitrate (§3.3 merge semantics)
    const byDim = new Map<string, string[]>()
    for (const s of sources) {
      for (const b of s.blocks) {
        const arr = byDim.get(b.dimension) ?? []
        arr.push(`${label ? labelHeader(s.nodeId, b.label, s.partial) : '\n\n'}${b.text}`)
        byDim.set(b.dimension, arr)
      }
    }
    body = [...byDim.entries()]
      .map(([dim, chunks]) => `\n\n##### dimension: ${dim} #####\n${chunks.join('\n\n----\n')}`)
      .join('\n')
  } else {
    // concat (and patch-apply context doc): ordered blocks with source markers
    body = sources
      .map((s) =>
        s.blocks
          .map((b: ExtractedBlock) => `${label ? labelHeader(s.nodeId, b.label, s.partial) : '\n\n'}${b.text}`)
          .join('\n')
      )
      .join('\n')
  }

  if (!body.trim()) {
    return { text: '', tokens: 0, degraded: false, sources: perSource }
  }

  // budget: escalate by truncating the tail (digest escalation happens at the
  // renderer level where a summarizer model is reachable — §3.3 degrade chain)
  let text = body
  let degraded = false
  if (plan.budget.maxTokens > 0) {
    const capped = truncateTail(body, plan.budget.maxTokens)
    degraded = capped !== body
    text = capped
  }

  return { text, tokens: Math.ceil(text.length / 4), degraded, sources: perSource }
}
