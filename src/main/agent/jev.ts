// Jev/AnyJev adapter — typed decisions with calibrated confidence.
// Uses OpenRouter Decisions API (typesafe/jev-1.13) when OPENROUTER_API_KEY
// is available; falls back to GLM when not.
//
// The observe() pattern (AnyJev L0→L1→L2): every pipeline outcome feeds back
// into calibration.jsonl. As entries accumulate, confidence thresholds become
// self-calibrating per goal shape — this is the critical mass for
// macro-emergence: the system learns WHERE its decisions are reliable.
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

export interface JevQuestion {
  type: 'noul' | 'choice' | 'score'
  instructions: string
  criteria?: Record<string, string> | string[]
}

export interface JevAnswer {
  type: 'noul' | 'choice' | 'score'
  noul?: number
  choice?: string
  confidence?: number
  probabilities?: Record<string, number>
  score?: number
  legend?: Record<string, string>
}

export interface JevResult {
  answers: Record<string, JevAnswer>
  cost: number
  latencyMs: number
  inputTokens: number
}

const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'
const MODEL = 'typesafe/jev-1.13'

export function jevKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY
}

export function jevEnabled(): boolean {
  return !!jevKey()
}

export async function jevAsk(
  state: Record<string, unknown>,
  questions: Record<string, JevQuestion>
): Promise<JevResult> {
  const key = jevKey()
  if (!key) throw new Error('jev unavailable: no OPENROUTER_API_KEY')
  const t0 = Date.now()
  const ctrl = new AbortController()
  const kill = setTimeout(() => ctrl.abort(new Error('jev timeout (12s)')), 12_000)
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, state, questions }),
      signal: ctrl.signal
    })
    clearTimeout(kill)
    const text = await res.text()
    let json: any
    try { json = JSON.parse(text) } catch { throw new Error(`jev non-JSON HTTP ${res.status}`) }
    if (!res.ok || !json.answers) throw new Error(`jev HTTP ${res.status}: ${text.slice(0, 150)}`)
    return {
      answers: json.answers,
      cost: json.usage?.cost ?? 0,
      latencyMs: Date.now() - t0,
      inputTokens: json.usage?.input_tokens ?? 0
    }
  } catch (e) {
    clearTimeout(kill)
    throw new Error(`jev unavailable: ${String(e).slice(0, 150)}`)
  }
}

// ── typed helpers ──

export async function jevRoute(goal: string): Promise<{
  mode: 'answer' | 'build'
  parallel: boolean
  confidence: number
  latencyMs: number
}> {
  const r = await jevAsk(
    { goal },
    {
      route: {
        type: 'choice',
        instructions: 'How should the agent pipeline execute this goal?',
        criteria: {
          answer: 'Needs no file changes and no project inspection — pure explanation or opinion.',
          build: 'Requires creating or modifying files, or running things in the project workspace.'
        }
      },
      parallel: {
        type: 'noul',
        instructions: 'Does this goal contain MULTIPLE INDEPENDENT deliverables that parallel workers could build separately?',
        criteria: {
          true: 'Several separate files or unrelated deliverables, each simple and self-contained.',
          false: 'One coherent piece of work, or subtasks that depend on each other.'
        }
      }
    }
  )
  const mode = r.answers.route?.choice === 'answer' ? 'answer' : 'build'
  const parallel = (r.answers.parallel?.noul ?? 0) > 0.5
  return { mode, parallel, confidence: r.answers.route?.confidence ?? 0, latencyMs: r.latencyMs }
}

export async function jevGoalMet(
  goal: string,
  workerReports: string
): Promise<{ met: boolean; probability: number }> {
  const r = await jevAsk(
    { goal, worker_reports: workerReports.slice(0, 4000) },
    {
      goal_met: {
        type: 'noul',
        instructions: 'Based ONLY on these worker reports, has the goal demonstrably been achieved?',
        criteria: {
          true: 'Every requirement reported as completed with verification evidence.',
          false: 'Reports indicate failure, partial completion, or missing verification.'
        }
      }
    }
  )
  return { met: (r.answers.goal_met?.noul ?? 0) >= 0.5, probability: r.answers.goal_met?.noul ?? 0 }
}

export async function jevToolSafe(tool: string, detail: string): Promise<{ safe: boolean; probability: number }> {
  const r = await jevAsk(
    { tool, detail: detail.slice(0, 500) },
    {
      safe: {
        type: 'noul',
        instructions: 'Is this agent tool call SAFE to auto-approve? Unsafe = deletes data, installs software, pushes to remotes, touches files outside the project, or destructive/irreversible.',
        criteria: {
          true: 'Read-only, or writes within the project workspace with no destructive effect.',
          false: 'Destructive, irreversible, installs software, pushes to remotes, or escapes the project.'
        }
      }
    }
  )
  const p = r.answers.safe?.noul ?? 0
  return { safe: p >= 0.5, probability: p }
}

// ── calibration (AnyJev observe() pattern — outcomes feed back to self-calibrate) ──

export interface CalibrationEntry {
  ts: string
  shape: string
  decision: string
  probability: number
  outcome: 'correct' | 'incorrect' | 'pending'
}

export function calibrationFile(rootDir: string): string {
  return join(rootDir, '.occ', 'orchestrator', 'calibration.jsonl')
}

export function recordCalibration(rootDir: string, entry: CalibrationEntry): void {
  try {
    const dir = join(rootDir, '.occ', 'orchestrator')
    mkdirSync(dir, { recursive: true })
    appendFileSync(calibrationFile(rootDir), JSON.stringify(entry) + '\n', 'utf8')
  } catch { /* best-effort */ }
}

/** Read calibration stats for a shape: how often has this confidence level been correct? */
export function calibrationStats(rootDir: string, shape: string): {
  total: number
  correct: number
  accuracy: number
} {
  try {
    const file = calibrationFile(rootDir)
    if (!existsSync(file)) return { total: 0, correct: 0, accuracy: 0 }
    const entries = readFileSync(file, 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as CalibrationEntry)
      .filter((e) => e.shape === shape && e.outcome !== 'pending')
    const correct = entries.filter((e) => e.outcome === 'correct').length
    return { total: entries.length, correct, accuracy: entries.length ? correct / entries.length : 0 }
  } catch {
    return { total: 0, correct: 0, accuracy: 0 }
  }
}
