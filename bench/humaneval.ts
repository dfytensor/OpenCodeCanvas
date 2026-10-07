// HumanEval execution-scored benchmark — the market-standard coding eval,
// adapted to compare HARNESS value on the same model:
//   baseline = single completion call (raw model)
//   ours     = full OpenCode Canvas pipeline (planner → worker → merge → verifier)
// Scoring: canonical HumanEval tests executed with python (timeout = fail).
// Checkpointed to humaneval-progress.jsonl so long runs resume across commands.
// env: OCC_HE_N=30 OCC_HE_SEED=42 OCC_HE_CONFIG=baseline|ours|both OCC_TEST_MODEL
import { gunzipSync } from 'zlib'
import { writeFileSync, readFileSync, existsSync, appendFileSync, mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { completeChat } from 'F:/OpenCodeCanvas/src/main/agent/loop'
import { resolveAgentModel } from 'F:/OpenCodeCanvas/src/main/agent/providers'
import { openProjectWithGraph } from 'F:/OpenCodeCanvas/src/main/project/lifecycle'
import { setActiveProject, updatePolicy } from 'F:/OpenCodeCanvas/src/main/project/registry'
import { createChat, chatSend, chatLog } from 'F:/OpenCodeCanvas/src/main/chat'

interface HEProblem {
  task_id: string
  prompt: string
  test: string
  entry_point: string
}

const N = Number(process.env.OCC_HE_N ?? 30)
const SEED = Number(process.env.OCC_HE_SEED ?? 42)
const CONFIG = process.env.OCC_HE_CONFIG ?? 'both'
const CACHE = join(tmpdir(), 'occ-humaneval-data.json')
const PROGRESS = process.env.OCC_HE_PROGRESS ?? join(tmpdir(), 'humaneval-progress.jsonl')
const APP = process.env.OCC_TEST_MODEL ?? 'deepseek/deepseek-chat'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function loadProblems(): Promise<HEProblem[]> {
  if (existsSync(CACHE)) return JSON.parse(readFileSync(CACHE, 'utf8')) as HEProblem[]
  const url = 'https://raw.githubusercontent.com/openai/human-eval/master/data/HumanEval.jsonl.gz'
  const buf = Buffer.from(await fetch(url).then((r) => r.arrayBuffer()))
  const jsonl = gunzipSync(buf).toString('utf8')
  const problems = jsonl.split('\n').filter(Boolean).map((l) => JSON.parse(l) as HEProblem)
  writeFileSync(CACHE, JSON.stringify(problems))
  return problems
}

// tiny deterministic LCG shuffle — same sample every run/night
function sample<T>(items: T[], n: number, seed: number): T[] {
  const arr = [...items]
  let s = seed >>> 0
  for (let i = arr.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0
    const j = s % (i + 1)
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr.slice(0, n)
}

function promptImports(prompt: string): string {
  const lines = prompt.split('\n')
  const out: string[] = []
  for (const l of lines) {
    if (/^\s*(def |class |@)/.test(l)) break
    out.push(l)
  }
  return out.join('\n')
}

function runPython(code: string, timeoutMs = 15_000): { pass: boolean; err: string } {
  const file = join(tmpdir(), `occ-he-${Math.random().toString(36).slice(2)}.py`)
  writeFileSync(file, code, 'utf8')
  try {
    execFileSync('python', [file], { timeout: timeoutMs, stdio: 'pipe' })
    return { pass: true, err: '' }
  } catch (e) {
    const msg = String((e as { stderr?: Buffer }).stderr ?? e)
    // the real exception lives at the END of a traceback — keep the tail
    return { pass: false, err: msg.slice(-260) }
  } finally {
    try { rmSync(file) } catch { /* tmp */ }
  }
}

function scoreCompletion(problem: HEProblem, completion: string): { pass: boolean; err: string } {
  // imports from the prompt + the (complete) function + canonical tests
  const code = `${promptImports(problem.prompt)}\n${completion}\n${problem.test}\ncheck(${problem.entry_point})\n`
  return runPython(code)
}

function extractCode(reply: string, entryPoint: string): string {
  const fence = /```(?:python)?\s*([\s\S]*?)```/.exec(reply)
  const raw = fence ? fence[1] : reply
  // model may return just the body — prepend the prompt signature when missing
  return new RegExp(`def\\s+${entryPoint}\\b`).test(raw) ? raw.trim() : reply.trim()
}

async function runBaseline(p: HEProblem): Promise<{ pass: boolean; err: string }> {
  const resolved = resolveAgentModel(APP)
  if (!resolved) return { pass: false, err: 'no provider' }
  const reply = await completeChat({
    provider: resolved.provider,
    model: resolved.model,
    messages: [
      { role: 'system', content: 'You are an expert Python programmer. Complete the function. Output ONLY code, no prose, no fences.' },
      { role: 'user', content: p.prompt + `\n\n实现 ${p.entry_point} 函数体。只输出完整代码（含 def 行）。` }
    ]
  })
  return scoreCompletion(p, extractCode(reply, p.entry_point))
}

async function runOurs(p: HEProblem, work: string): Promise<{ pass: boolean; err: string }> {
  const projDir = join(work, 'app')
  mkdirSync(projDir, { recursive: true })
  writeFileSync(join(projDir, 'README.md'), '# he\n')
  await openProjectWithGraph(projDir)
  const proj = await updatePolicy(projDir, { engine: 'native', toolPermission: 'auto', defaultModel: APP })
  setActiveProject(proj)
  const chatId = (await createChat(projDir)) as string
  const goal =
    `在 solution.py 中实现以下 Python 函数（完整 def 行 + 函数体，可加必要 import）：\n\n${p.prompt}\n\n` +
    `要求：写好后用 python 读回/执行验证函数行为，然后报告完成。`
  await chatSend(projDir, chatId, goal)
  const deadline = Date.now() + 4 * 60_000
  let final = ''
  while (Date.now() < deadline) {
    const log = await chatLog(projDir, chatId)
    const finals = log.filter((e) => e.role === 'final')
    if (finals.length > 0) { final = finals[finals.length - 1].text; break }
    await sleep(2000)
  }
  const solPath = join(projDir, 'solution.py')
  if (!existsSync(solPath)) return { pass: false, err: 'no solution.py (final=' + final.slice(0, 60) + ')' }
  const code = readFileSync(solPath, 'utf8')
  if (!new RegExp(`def\\s+${p.entry_point}\\b`).test(code)) return { pass: false, err: 'entry point missing in solution.py' }
  return scoreCompletion(p, code)
}

async function main(): Promise<void> {
  const problems = await loadProblems()
  const chosen = sample(problems, N, SEED)
  console.log(`[humaneval] sample=${chosen.length}/${problems.length} seed=${SEED} config=${CONFIG} model=${APP}`)
  const done = new Set<string>()
  if (existsSync(PROGRESS)) {
    for (const l of readFileSync(PROGRESS, 'utf8').split('\n').filter(Boolean)) {
      try { const r = JSON.parse(l) as { key: string }; done.add(r.key) } catch { /* partial line */ }
    }
  }
  const work = mkdtempSync(join(tmpdir(), 'occ-he-'))
  let bPass = 0, bN = 0, oPass = 0, oN = 0
  for (const p of chosen) {
    for (const cfg of (CONFIG === 'both' ? ['baseline', 'ours'] : [CONFIG]) as Array<'baseline' | 'ours'>) {
      const key = `${p.task_id}:${cfg}`
      if (done.has(key)) {
        // recount from checkpoint for the summary
        const prev = readFileSync(PROGRESS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { key: string; pass: boolean }).find((r) => r.key === key)
        if (cfg === 'baseline') { bN++; bPass += prev?.pass ? 1 : 0 } else { oN++; oPass += prev?.pass ? 1 : 0 }
        continue
      }
      const t0 = Date.now()
      let out: { pass: boolean; err: string }
      try {
        out = cfg === 'baseline' ? await runBaseline(p) : await runOurs(p, work)
      } catch (e) {
        out = { pass: false, err: String(e).slice(0, 200) }
      }
      const secs = Math.round((Date.now() - t0) / 100) / 10
      appendFileSync(PROGRESS, JSON.stringify({ key, task_id: p.task_id, config: cfg, pass: out.pass, secs, err: out.err.slice(0, 120) }) + '\n', 'utf8')
      if (cfg === 'baseline') { bN++; bPass += out.pass ? 1 : 0 } else { oN++; oPass += out.pass ? 1 : 0 }
      console.log(`${cfg === 'baseline' ? '[base]' : '[ours]'} ${p.task_id} ${out.pass ? 'PASS' : 'FAIL'} ${secs}s ${out.err ? '· ' + out.err.slice(0, 60) : ''}`)
    }
  }
  console.log(`\n[humaneval RESULT] baseline ${bPass}/${bN} (${bN ? Math.round((bPass / bN) * 100) : 0}%)  ours ${oPass}/${oN} (${oN ? Math.round((oPass / oN) * 100) : 0}%)  model=${APP}`)
}

void main().catch((e) => { console.error('FATAL', e); process.exit(1) })
