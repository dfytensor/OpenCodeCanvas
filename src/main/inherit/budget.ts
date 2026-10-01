// §3.3 budget: token estimation + the escalate-summary degrade chain.
// full → compact → digest → patch → file-list
import type { BudgetSpec, ContentView } from '../../shared/types'

// ~4 chars per token is the usual rough English estimate; CJK runs ~1.5-2 chars.
// Blend both heuristics: count CJK chars separately.
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) as number
    if (c > 0x2e80) cjk++
  }
  const other = text.length - cjk
  return Math.ceil(cjk / 1.5 + other / 4)
}

export const VIEW_ORDER: ContentView[] = ['full', 'compact', 'digest', 'patch', 'files']

export function nextDegradeView(view: ContentView | undefined): ContentView | null {
  const idx = VIEW_ORDER.indexOf(view ?? 'full')
  if (idx < 0 || idx >= VIEW_ORDER.length - 1) return null
  return VIEW_ORDER[idx + 1]
}

export interface BudgetCheck {
  within: boolean
  tokens: number
  limit: number
}

export function checkBudget(text: string, spec: BudgetSpec): BudgetCheck {
  const tokens = estimateTokens(text)
  return { within: tokens <= spec.maxTokens, tokens, limit: spec.maxTokens }
}

/**
 * Truncate tail-first (§3.3 truncate-tail): keep the head, drop the tail,
 * and append a marker so the agent knows content was elided.
 */
export function truncateTail(text: string, maxTokens: number): string {
  const tokens = estimateTokens(text)
  if (tokens <= maxTokens) return text
  // binary-search a char cut that fits
  let lo = 0
  let hi = text.length
  const target = maxTokens
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (estimateTokens(text.slice(0, mid)) <= target) lo = mid + 1
    else hi = mid
  }
  return text.slice(0, Math.max(0, lo - 1)) + '\n\n[...truncated to fit token budget...]'
}
