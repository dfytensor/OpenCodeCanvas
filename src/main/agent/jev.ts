// Jev/AnyJev adapter — typed decisions with calibrated confidence.
// Backend cascade: OpenRouter Decisions API (typesafe/jev-1.13, best quality)
// → LOCAL small model on any OpenAI-compatible endpoint (zero cost, offline,
// privacy — set OCC_JEV_LOCAL / OCC_JEV_LOCAL_MODEL, auto-probes :11434)
// → throw (callers fall back to GLM).
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

// ── local backend (small model, zero cost, offline) ──

const LOCAL_BASE = (process.env.OCC_JEV_LOCAL ?? 'http://127.0.0.1:11434/v1').replace(/\/$/, '')
const LOCAL_MODEL = process.env.OCC_JEV_LOCAL_MODEL ?? 'local'
let localProbe: { at: number; ok: boolean } | null = null
let localFails = 0

async function refreshLocalProbe(): Promise<boolean> {
  let ok = false
  try {
    const ctrl = new AbortController()
    const kill = setTimeout(() => ctrl.abort(), 2000)
    const r = await fetch(`${LOCAL_BASE}/models`, { signal: ctrl.signal })
    clearTimeout(kill)
    ok = r.ok
  } catch {
    ok = false
  }
  localProbe = { at: Date.now(), ok }
  return ok
}
void refreshLocalProbe() // prime at module load — jevEnabled() is sync

function localCached(): boolean {
  return !!localProbe?.ok
}

async function localReady(): Promise<boolean> {
  if (process.env.OCC_JEV_LOCAL === '0') return false
  if (!localProbe || Date.now() - localProbe.at > 60_000) return refreshLocalProbe()
  return localProbe.ok
}

/** one local decision: prompt for JSON, parse the first {...} block */
async function localDecision<T>(system: string, user: string, fallback: T, cap?: number): Promise<{ parsed: T; latencyMs: number }> {
  const t0 = Date.now()
  const ctrl = new AbortController()
  const kill = setTimeout(() => ctrl.abort(new Error('local jev timeout (20s)')), 20_000)
  try {
    const res = await fetch(`${LOCAL_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LOCAL_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        temperature: 0,
        max_tokens: 700
      }),
      signal: ctrl.signal
    })
    clearTimeout(kill)
    if (!res.ok) throw new Error(`local HTTP ${res.status}`)
    const json: any = await res.json()
    const text: string = (json.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    // small models sometimes wrap JSON in prose/fences — take the outermost braces
    const s = text.indexOf('{')
    const e = text.lastIndexOf('}')
    if (s < 0 || e <= s) throw new Error(`local no JSON in reply: ${text.slice(0, 80)}`)
    const parsed = { ...fallback, ...JSON.parse(text.slice(s, e + 1)) } as T
    if (cap !== undefined) {
      const rec = parsed as Record<string, unknown>
      for (const k of Object.keys(rec)) {
        if (/prob|confidence/i.test(k) && typeof rec[k] === 'number' && rec[k] > cap) rec[k] = cap
      }
    }
    localFails = 0
    return { parsed, latencyMs: Date.now() - t0 }
  } catch (e) {
    clearTimeout(kill)
    // transient inference hiccups must not poison the 60s availability cache —
    // only consecutive failures mark the endpoint down
    localFails++
    if (localFails >= 2) void refreshLocalProbe()
    if (process.env.OCC_DEBUG) console.error('[jev-local]', String(e).slice(0, 140))
    throw new Error(`local jev: ${String(e).slice(0, 120)}`)
  }
}

export function jevKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY
}

/** sync gate for call sites — cloud key OR a cached-visible local endpoint */
export function jevEnabled(): boolean {
  return !!jevKey() || localCached()
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
  backend?: 'openrouter' | 'local'
}> {
  if (await localReady()) {
    try {
      const { parsed, latencyMs } = await localDecision(
        'You are a routing decision engine for a coding agent pipeline. Reply with ONLY a JSON object — no prose, no markdown.',
        `规则：\n- mode="answer"：纯解释/观点题，不需要改动任何文件\n- mode="build"：要创建/修改文件，或在项目里运行东西\n- parallel=true 仅当目标含多个互不依赖的交付物\n\n示例：\nGoal: "解释一下什么是事件循环" → {"mode":"answer","parallel":false,"confidence":0.9}\nGoal: "在 src 创建 debounce.ts 实现防抖" → {"mode":"build","parallel":false,"confidence":0.9}\nGoal: "创建 a.txt 和 b.txt" → {"mode":"build","parallel":true,"confidence":0.8}\nGoal: "把 README.md 的安装步骤改成 pnpm" → {"mode":"build","parallel":false,"confidence":0.9}\n\nGoal: ${goal}\n\n只输出 JSON：`,
        { mode: 'build', parallel: false, confidence: 0.5 }
      )
      return {
        mode: parsed.mode === 'answer' ? 'answer' : 'build',
        parallel: !!parsed.parallel,
        confidence: Math.min(0.8, Number(parsed.confidence) || 0.6),
        latencyMs,
        backend: 'local'
      }
    } catch { /* local down — fall to OpenRouter */ }
  }
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
  return { mode, parallel, confidence: r.answers.route?.confidence ?? 0, latencyMs: r.latencyMs, backend: 'openrouter' }
}

export async function jevGoalMet(
  goal: string,
  workerReports: string
): Promise<{ met: boolean; probability: number; backend?: 'openrouter' | 'local' }> {
  if (await localReady()) {
    try {
      const { parsed, latencyMs } = await localDecision(
        'You are an acceptance judge for a coding agent pipeline. Reply with ONLY a JSON object — no prose.',
        `判断 worker 报告是否证明目标已完成。只输出 JSON。\n\n示例：\n报告："已创建 alpha.txt 并读回验证，内容字节级一致" → {"met": true, "probability": 0.9}\n报告："文件已创建（未验证内容）" → {"met": false, "probability": 0.3}\n报告："创建失败，权限被拒" → {"met": false, "probability": 0.05}\n\nGoal: ${goal}\n\nWorker 报告：${workerReports.slice(0, 4000)}\n\n只输出 JSON：`,
        { met: false, probability: 0 },
        0.85
      )
      const p = Math.min(0.85, Number(parsed.probability) || (parsed.met ? 0.7 : 0.1))
      return { met: !!parsed.met && p >= 0.5, probability: p, backend: 'local' }
    } catch (e) { if (process.env.OCC_DEBUG) console.error('[jev-local]', String(e).slice(0, 120)) }
  }
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
  return { met: (r.answers.goal_met?.noul ?? 0) >= 0.5, probability: r.answers.goal_met?.noul ?? 0, backend: 'openrouter' }
}

export async function jevToolSafe(tool: string, detail: string): Promise<{ safe: boolean; probability: number; backend?: 'openrouter' | 'local' }> {
  // policy: the LOCAL small model never auto-approves — its probability is
  // capped below the 0.9 auto-approval bar, so the user always decides.
  // A 2B model must not be a security authority.
  if (await localReady()) {
    try {
      const { parsed, latencyMs } = await localDecision(
        'You classify agent tool calls for safety. Reply with ONLY a JSON object — no prose.',
        `判断 agent 工具调用是否安全。只输出 JSON。\n\n示例：\nbash "rm -rf /" → {"safe": false, "probability": 0.05}\nwrite_file "solution.py（项目工作区内）" → {"safe": true, "probability": 0.9}\nbash "git push origin main" → {"safe": false, "probability": 0.1}\nread_file "README.md" → {"safe": true, "probability": 0.95}\n\nTool: ${tool}\nDetail: ${detail.slice(0, 500)}\n\n只输出 JSON：`,
        { safe: false, probability: 0 },
        0.85
      )
      const p = Math.min(0.85, Number(parsed.probability) || (parsed.safe ? 0.7 : 0.1))
      return { safe: !!parsed.safe && p >= 0.5, probability: p, backend: 'local' }
    } catch (e) { if (process.env.OCC_DEBUG) console.error('[jev-local]', String(e).slice(0, 120)) }
  }
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
  return { safe: p >= 0.5, probability: p, backend: 'openrouter' }
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
