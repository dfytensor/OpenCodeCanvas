// §3.2 Extractor: resolve a Selector against a source node into text blocks.
// Sources of truth: opencode transcript via HTTP API (with CLI export fallback),
// workspace diff via git diff --no-index, files from the node's copy.
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import type {
  ContentDimension,
  FilterSpec,
  OcMessageDTO,
  RangeSpec,
  Selector,
  SessionNode
} from '../../shared/types'
import { ocApi } from '../opencode/api'
import { exportSession } from '../opencode/cli'
import { normalizeTranscript } from '../opencode/schema'
import { diffDirs, diffNameStatus } from '../workspace/diff'

export interface ExtractedBlock {
  dimension: ContentDimension
  label: string
  text: string
}

export interface ExtractedSource {
  nodeId: string
  blocks: ExtractedBlock[]
  partial: boolean
}

function messageText(m: OcMessageDTO): string {
  return m.parts
    .map((p) => (p.type === 'text' && p.text ? p.text : ''))
    .filter(Boolean)
    .join('\n')
}

function toolLines(m: OcMessageDTO): string[] {
  return m.parts
    .filter((p) => p.type === 'tool')
    .map((p) => {
      const tool = (p.tool as string) ?? 'tool'
      const state = (p.state as { status?: string } | undefined)?.status ?? ''
      return `- ${tool} ${state}`.trim()
    })
}

function turnsOf(messages: OcMessageDTO[]): OcMessageDTO[][] {
  const turns: OcMessageDTO[][] = []
  for (const m of messages) {
    if (m.info.role === 'user') turns.push([m])
    else if (turns.length > 0) turns[turns.length - 1].push(m)
    else turns.push([m])
  }
  return turns
}

function applyRange(messages: OcMessageDTO[], range: RangeSpec | undefined): OcMessageDTO[] {
  if (!range) return messages
  if ('atMessage' in range) {
    const idx = messages.findIndex((m) => m.info.id === range.atMessage)
    return idx >= 0 ? messages.slice(0, idx + 1) : messages
  }
  const turns = turnsOf(messages)
  let picked: OcMessageDTO[][]
  if ('last' in range) picked = turns.slice(-Math.max(1, range.last))
  else if ('afterTurn' in range) picked = turns.slice(range.afterTurn + 1)
  else if ('turns' in range) picked = turns.slice(range.turns[0], range.turns[1] + 1)
  else if ('timeRange' in range) {
    const from = Date.parse(range.timeRange[0])
    const to = Date.parse(range.timeRange[1])
    picked = turns.filter((t) => {
      const ts = t[0]?.info.time?.created ?? 0
      return ts >= from && ts <= to
    })
  } else picked = turns
  return picked.flat()
}

function applyFilters(messages: OcMessageDTO[], filter: FilterSpec | undefined): OcMessageDTO[] {
  if (!filter) return messages
  let out = messages
  if (filter.roles?.length) out = out.filter((m) => filter.roles!.includes(m.info.role))
  if (filter.keywords?.length) {
    out = out.filter((m) => {
      const text = messageText(m).toLowerCase()
      return filter.keywords!.some((k) => text.includes(k.toLowerCase()))
    })
  }
  return out
}

function filterToolTrace(messages: OcMessageDTO[], filter: FilterSpec | undefined): string[] {
  const lines: string[] = []
  for (const m of messages) lines.push(...toolLines(m))
  if (!filter?.tools?.length) return lines
  return lines.filter((l) => filter.tools!.some((t) => l.toLowerCase().includes(t.toLowerCase())))
}

async function loadTranscript(node: SessionNode): Promise<OcMessageDTO[]> {
  if (node.sessionId) {
    try {
      const msgs = await ocApi.listMessages(node.sessionId)
      if (msgs.length > 0) return msgs
    } catch {
      // fall through to CLI export
    }
    const raw = await exportSession(node.sessionId)
    const normalized = raw ? normalizeTranscript(raw) : null
    if (normalized && normalized.length > 0) return normalized
  }
  return []
}

export async function extractSource(
  sel: Selector,
  node: SessionNode
): Promise<ExtractedSource> {
  const blocks: ExtractedBlock[] = []
  const partial = node.status === 'running'
  const wantsTranscript = sel.take.some((d) =>
    (['transcript', 'inputs', 'outputs', 'toolTrace'] as ContentDimension[]).includes(d)
  )
  const messages = wantsTranscript
    ? applyFilters(applyRange(await loadTranscript(node), sel.range), sel.filter)
    : []

  for (const dim of sel.take) {
    switch (dim) {
      case 'transcript': {
        const text = messages
          .map((m) => `[${m.info.role}] ${messageText(m)}`.trim())
          .filter((l) => l.length > 10)
          .join('\n\n')
        if (text) blocks.push({ dimension: dim, label: 'transcript', text })
        break
      }
      case 'inputs': {
        const text = messages
          .filter((m) => m.info.role === 'user')
          .map((m) => messageText(m))
          .filter(Boolean)
          .join('\n\n')
        if (text) blocks.push({ dimension: dim, label: 'user inputs', text })
        break
      }
      case 'outputs': {
        const text = messages
          .filter((m) => m.info.role === 'assistant')
          .map((m) => messageText(m))
          .filter(Boolean)
          .join('\n\n---\n\n')
        if (text) blocks.push({ dimension: dim, label: 'assistant outputs', text })
        break
      }
      case 'toolTrace': {
        const lines = filterToolTrace(messages, sel.filter)
        if (lines.length) {
          blocks.push({ dimension: dim, label: 'tool trace', text: lines.join('\n') })
        }
        break
      }
      case 'summary': {
        if (node.summary) blocks.push({ dimension: dim, label: 'summary', text: node.summary })
        break
      }
      case 'diff': {
        const base = node.snapshotDir
        const copy = node.workDir
        if (base && copy && existsSync(base) && existsSync(copy)) {
          const text = await diffDirs(base, copy, sel.filter?.paths)
          if (text.trim()) {
            blocks.push({
              dimension: dim,
              label: `diff:${(sel.filter?.paths ?? []).join(',') || '**'}`,
              text
            })
          }
        }
        break
      }
      case 'files': {
        const globs = sel.filter?.paths
        if (globs?.length && node.workDir && existsSync(node.workDir)) {
          const baseDir = node.snapshotDir && existsSync(node.snapshotDir) ? node.snapshotDir : node.workDir
          const changed = await diffNameStatus(baseDir, node.workDir, globs).catch(() => [])
          const chunks: string[] = []
          for (const ch of changed) {
            try {
              const content = await readFile(join(node.workDir, ch.rel), 'utf8')
              chunks.push(`### ${ch.rel}\n\`\`\`\n${content}\n\`\`\``)
            } catch {
              chunks.push(`### ${ch.rel}\n(binary or unreadable)`)
            }
          }
          if (chunks.length) {
            blocks.push({ dimension: dim, label: `files:${changed.length}`, text: chunks.join('\n\n') })
          }
        }
        break
      }
      case 'artifacts': {
        blocks.push({
          dimension: dim,
          label: 'artifacts index',
          text: `artifacts directory: .occ/nodes/${node.id}/artifacts/`
        })
        break
      }
      case 'decisions': {
        try {
          const p = join(node.workDir ?? '', '.occ-decisions.jsonl')
          if (existsSync(p)) {
            const text = await readFile(p, 'utf8')
            if (text.trim()) blocks.push({ dimension: dim, label: 'decisions', text })
          }
        } catch {
          // ignore
        }
        break
      }
      case 'config': {
        blocks.push({
          dimension: dim,
          label: 'run config',
          text: `node: ${node.id}\nkind: ${node.kind}\nchannel: ${node.channel ?? '-'}\nstatus: ${node.status}`
        })
        break
      }
    }
  }

  return { nodeId: node.id, blocks, partial }
}

/** Respect per-source budgetTokens (§3.2 budgetTokens). */
export function applySourceBudget(
  sel: Selector,
  extracted: ExtractedSource,
  truncate: (t: string, max: number) => string
): ExtractedSource {
  if (!sel.budgetTokens) return extracted
  const total = extracted.blocks.reduce((a, b) => a + b.text.length, 0)
  const maxChars = sel.budgetTokens * 4
  if (total <= maxChars) return extracted
  const blocks = extracted.blocks.map((b) => {
    const share = Math.max(200, Math.floor((b.text.length / total) * maxChars))
    if (b.text.length <= share) return b
    return { ...b, text: truncate(b.text, Math.floor(share / 4)) }
  })
  return { ...extracted, blocks }
}
