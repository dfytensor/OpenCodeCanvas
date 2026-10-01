/* eslint-disable */
// Bench harness: controlled A/B — same kernel+model+tools, topology is the only variable.
//   baseline : single agent session working directly in the project (no orchestration)
//   ours     : chat → planner → adaptive pipeline (the full system)
// Deterministic graders only. Results: bench-results.json + console table.
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { openProjectWithGraph } from '../src/main/project/lifecycle'
import { setActiveProject, updatePolicy } from '../src/main/project/registry'
import { ensureObserver } from '../src/main/inherit/executor'
import { getGraph, newSessionNode, upsertNode } from '../src/main/graph/store'
import { startAgentSession } from '../src/main/agent/session'
import { createChat, chatSend, chatLog } from '../src/main/chat'

const run = promisify(execFile)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface TaskDef {
  id: string
  goal: string
  setup: (projDir: string) => Promise<void>
  grade: (projDir: string) => Promise<{ pass: boolean; detail: string }>
}

async function nodeEval(projDir: string, code: string): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await run('node', ['-e', code], { cwd: projDir, timeout: 30_000, windowsHide: true })
    return { ok: true, out: r.stdout }
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`.slice(0, 300) }
  }
}

export const TASKS: TaskDef[] = [  {
    id: 'T1-json-config',
    goal: '创建 settings.json，内容为合法 JSON：{"app":"bench","port":8080,"debug":false}。写回并用 JSON 解析验证，然后报告任务完成。',
    setup: async () => {},
    grade: async (p) => {
      if (!existsSync(join(p, 'settings.json'))) return { pass: false, detail: 'missing settings.json' }
      try {
        const j = JSON.parse(readFileSync(join(p, 'settings.json'), 'utf8'))
        return { pass: j.app === 'bench' && j.port === 8080 && j.debug === false, detail: JSON.stringify(j) }
      } catch (e) { return { pass: false, detail: String(e).slice(0, 120) } }
    }
  },
  {
    id: 'T2-implement-fib',
    goal: '创建 fib.js，导出函数 fib(n)（n≥0 的斐波那契，fib(0)=0, fib(1)=1）。用 node 实际运行验证 fib(10)=55 后报告任务完成。',
    setup: async () => {},
    grade: async (p) => {
      const r = await nodeEval(p, `const m=require('./fib.js');const fib=m.fib??m.default??m; console.log(JSON.stringify([fib(0),fib(1),fib(10)]))`)
      return { pass: r.ok && r.out.includes('[0,1,55]'), detail: r.out.trim().slice(0, 120) }
    }
  },
  {
    id: 'T3-fix-syntax',
    goal: 'broken.js 有语法错误导致无法运行。修复它，使 node broken.js 输出 ok（不要改动输出语义），然后报告任务完成。',
    setup: async (p) => { await writeFile(join(p, 'broken.js'), 'console.log("ok"\n') },
    grade: async (p) => {
      const r = await nodeEval(p, `require('./broken.js')`)
      return { pass: r.ok && r.out.includes('ok'), detail: r.out.trim().slice(0, 120) }
    }
  },
  {
    id: 'T4-text-stats',
    goal: '读取 data.txt，统计每个单词出现次数，创建 stats.txt，每行格式为 "单词:次数"（按次数降序）。完成后读回验证并报告任务完成。',
    setup: async (p) => {
      await writeFile(join(p, 'data.txt'), 'alpha beta alpha\ngamma alpha beta\ngamma\n')
    },
    grade: async (p) => {
      if (!existsSync(join(p, 'stats.txt'))) return { pass: false, detail: 'missing stats.txt' }
      const c = readFileSync(join(p, 'stats.txt'), 'utf8').replace(/\s+/g, '')
      const ok = c.includes('alpha:3') && c.includes('beta:2') && c.includes('gamma:2')
      return { pass: ok, detail: c.slice(0, 100) }
    }
  },
  {
    id: 'T5-two-files',
    goal: '创建 index.html（内含 class="theme-dark" 的 div）和 style.css（内含 .theme-dark 规则，设置 background:#111）。完成后报告任务完成。',
    setup: async () => {},
    grade: async (p) => {
      const h = existsSync(join(p, 'index.html')) ? readFileSync(join(p, 'index.html'), 'utf8') : ''
      const c = existsSync(join(p, 'style.css')) ? readFileSync(join(p, 'style.css'), 'utf8') : ''
      return { pass: h.includes('theme-dark') && c.includes('.theme-dark') && c.includes('#111'), detail: `html:${h.length}ch css:${c.length}ch` }
    }
  },
  {
    id: 'T6-rename',
    goal: 'util.js 里的函数 calcOld 要重命名为 calculate，并同步更新 caller.js 里的调用。重命名后用 node 验证 caller.js 仍输出正确结果（caller 会打印 calculate(2,3) 的结果 5）。完成后报告任务完成。',
    setup: async (p) => {
      await writeFile(join(p, 'util.js'), 'function calcOld(a, b) { return a + b }\nmodule.exports = { calcOld }\n')
      await writeFile(join(p, 'caller.js'), "const { calcOld } = require('./util.js')\nconsole.log(calcOld(2, 3))\n")
    },
    grade: async (p) => {
      const r = await nodeEval(p, `require('./caller.js')`)
      const util = existsSync(join(p, 'util.js')) ? readFileSync(join(p, 'util.js'), 'utf8') : ''
      const noOld = !util.includes('calcOld')
      return { pass: r.ok && r.out.includes('5') && noOld, detail: `out=${r.out.trim().slice(0, 40)} noOldRef=${noOld}` }
    }
  },
  {
    id: 'T7-json-transform',
    goal: '读取 input.json（含 items 数组，每项有 n 字段），创建 total.json，内容为 {"total": 所有 n 之和}。完成后报告任务完成。',
    setup: async (p) => {
      await writeFile(join(p, 'input.json'), '{"items":[{"n":1},{"n":2},{"n":3}]}')
    },
    grade: async (p) => {
      if (!existsSync(join(p, 'total.json'))) return { pass: false, detail: 'missing total.json' }
      try {
        const j = JSON.parse(readFileSync(join(p, 'total.json'), 'utf8'))
        return { pass: j.total === 6, detail: JSON.stringify(j) }
      } catch (e) { return { pass: false, detail: String(e).slice(0, 100) } }
    }
  },
  {
    id: 'T8-fix-logic',
    goal: 'math.js 的 add(a,b) 实现有误（当前做的是减法）。修复为正确的加法，并用 node 验证 add(2,3)===5、add(-1,1)===0，然后报告任务完成。',
    setup: async (p) => {
      await writeFile(join(p, 'math.js'), 'function add(a, b) { return a - b }\nmodule.exports = { add }\n')
    },
    grade: async (p) => {
      const r = await nodeEval(p, `const {add}=require('./math.js'); console.log(JSON.stringify([add(2,3),add(-1,1)]))`)
      return { pass: r.ok && r.out.includes('[5,0]'), detail: r.out.trim().slice(0, 80) }
    }
  }
]

// ── runner ──

interface Result {
  task: string
  config: 'baseline' | 'ours'
  pass: boolean
  detail: string
  wallSec: number
  nodes: number
  tokensIn: number
  tokensOut: number
}

async function waitNodeDone(rootDir: string, nodeId: string, timeoutMs: number): Promise<{ ok: boolean; doneSec: number | null }> {
  const start = Date.now()
  const deadline = start + timeoutMs
  while (Date.now() < deadline) {
    const g = await getGraph(rootDir)
    const st = g.nodes[nodeId]?.status
    if (st === 'completed') return { ok: true, doneSec: Math.round((Date.now() - start) / 1000) }
    if (st === 'failed' || st === 'aborted') return { ok: false, doneSec: null }
    await sleep(2500)
  }
  return { ok: false, doneSec: null }
}

async function waitChatFinal(rootDir: string, chatId: string, skip: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const log = await chatLog(rootDir, chatId)
    if (log.filter((e) => e.role === 'final').length > skip) return true
    await sleep(2500)
  }
  return false
}

function tally(rootDir: string, excludeRoot?: string): { nodes: number; tokensIn: number; tokensOut: number } {
  const g = require('../src/main/graph/store') as typeof import('../src/main/graph/store')
  void g
  return { nodes: 0, tokensIn: 0, tokensOut: 0 }
}

export async function runBench(configs: Array<'baseline' | 'ours'> = ['baseline', 'ours']): Promise<void> {
  const suite = process.env.OCC_BENCH_SUITE === 'sweet' ? TASKS_SWEET : TASKS
  console.error('[DBG] runBench enter, TASKS =', suite.length, 'configs =', configs.join(','))
  const only = process.env.OCC_BENCH_ONLY
  // batch slicing for foreground runs: OCC_BENCH_CFG / OCC_BENCH_FROM / OCC_BENCH_TO
  const cfgEnv = process.env.OCC_BENCH_CFG as 'baseline' | 'ours' | undefined
  const from = Number(process.env.OCC_BENCH_FROM ?? 0)
  const to = Number(process.env.OCC_BENCH_TO ?? suite.length) // exclusive
  if (cfgEnv) configs = [cfgEnv]
  const results: Result[] = []
  const realDone = new Map<string, number | null>()
  const jobs: Array<() => Promise<void>> = []
  const push = (task: TaskDef, config: 'baseline' | 'ours'): void => {
    if (process.env.OCC_DEBUG) console.error('[DBG] push?', task.id, config, 'only=', process.env.OCC_BENCH_ONLY, 'from=', from, 'to=', to)
    if (only && task.id !== only) return
    const tIdx = suite.indexOf(task)
    if (tIdx < from || tIdx >= to) return
    jobs.push(async () => {
      const root = await mkdtemp(join(tmpdir(), 'occ-bench-'))
      const projDir = join(root, task.id)
      await mkdir(projDir, { recursive: true })
      await task.setup(projDir)

      await openProjectWithGraph(projDir)
      const { project } = await import('../src/main/project/registry').then(async (m) => ({
        project: await m.updatePolicy(projDir, { engine: 'native', toolPermission: 'auto', budgetTokensPerChat: 0 })
      }))
      setActiveProject(project)
      ensureObserver(projDir)

      const t0 = Date.now()
      let pass = false
      let detail = ''
      let nodes = 0
      try {
        if (config === 'baseline') {
          const graph = await getGraph(projDir)
          let node = newSessionNode(graph, {
            projectId: project.id,
            title: `bench-${task.id}`,
            kind: 'ephemeral',
            parents: [],
            status: 'draft',
            workDir: projDir
          })
          node = await upsertNode(projDir, node)
          await startAgentSession(projDir, { id: node.id, title: node.title, workDir: projDir }, { kickoff: task.goal })
          const wd = await waitNodeDone(projDir, node.id, 12 * 60_000)
          const ok = wd.ok
          realDone.set(task.id + ':' + config, wd.doneSec)
          const g = await getGraph(projDir)
          const n = g.nodes[node.id]
          detail = ok ? 'completed' : `status=${n?.status} err=${n?.error?.slice(0, 100) ?? ''}`
          nodes = 1
        } else {
          console.error('[stage] OCC_DEBUG on, starting…')
          console.error('[stage] createChat…')
          const chatId = (await createChat(projDir)) as string
          console.error('[stage] chat created ' + chatId)
          await chatSend(projDir, chatId, task.goal)
          console.error('[stage] goal sent, waiting final (12min box)…')
          const ok = await waitChatFinal(projDir, chatId, 0, 15 * 60_000)
          const g = await getGraph(projDir)
          nodes = Object.keys(g.nodes).length
          const log = await chatLog(projDir, chatId)
          const final = [...log].reverse().find((e) => e.role === 'final')
          detail = ok ? (final?.text.slice(0, 80) ?? '') : `no final (timeout) nodes=${nodes} log=${log.map((e) => e.role).join(',')} err=${(await import('../src/main/project/registry')).getActiveProject() ? '' : ''}`
        }
        const gr = await task.grade(projDir)
        pass = gr.pass
        detail = gr.detail || detail
      } catch (e) {
        detail = `EXC: ${String(e).slice(0, 120)}`
      }
      const wallRaw = Math.round((Date.now() - t0) / 1000)
      const doneSec = realDone.get(task.id + ':' + config) ?? null
      const wallSec = doneSec ?? wallRaw
      const g = await getGraph(projDir)
      let tokensIn = 0
      let tokensOut = 0
      for (const n of Object.values(g.nodes)) {
        tokensIn += n.tokenUsage?.input ?? 0
        tokensOut += n.tokenUsage?.output ?? 0
      }
      results.push({ task: task.id, config, pass, detail: detail.slice(0, 100), wallSec, wallTruncated: doneSec === null, nodes, tokensIn, tokensOut })
      console.log(`[${config}] ${task.id}: ${pass ? 'PASS' : 'FAIL'} ${wallSec}s nodes=${nodes} tok=${tokensIn}/${tokensOut} :: ${detail.slice(0, 60)}`)
      await rm(root, { recursive: true, force: true }).catch(() => {})
    })
  }
  for (const task of suite) for (const config of configs) push(task, config)

  // SERIAL by design: registry keeps one global active-project handle, and
  // concurrent jobs would cross-contaminate createChat/send policy reads.
  for (const job of jobs) await job()

  // summary
  const sum = (c: string) => {
    const rs = results.filter((r) => r.config === c)
    const p = rs.filter((r) => r.pass).length
    const wall = Math.round(rs.reduce((a, r) => a + r.wallSec, 0) / Math.max(1, rs.length))
    const tok = rs.reduce((a, r) => a + r.tokensIn + r.tokensOut, 0)
    return { pass: p, total: rs.length, avgWall: wall, tokens: tok }
  }
  console.log('\n===== SUMMARY =====')
  for (const c of configs) {
    const s = sum(c)
    console.log(`${c.padEnd(9)} pass ${s.pass}/${s.total}  avgWall ${s.avgWall}s  tokens(total metered) ${s.tokens}`)
  }
  const out = process.env.OCC_BENCH_OUT ?? join(process.cwd(), 'bench-results.json')
  writeFileSync(out, JSON.stringify(results, null, 2), 'utf8')
  console.log('results written to', out)
  const totalPass = results.filter((r) => r.pass).length
  console.log(`BATCH DONE: ${totalPass}/${results.length} pass`)
}

// ── sweet-spot suite: N independent file-creation subtasks (parallel fan-out) ──

export const TASKS_SWEET: TaskDef[] = [
  {
    id: 'S1-trio-files',
    goal: '创建 a.txt 内容为 A1\n创建 b.txt 内容为 B2\n创建 c.txt 内容为 C3\n全部创建后逐一读回验证，然后报告任务完成。',
    setup: async () => {},
    grade: async (p) => {
      const want: Array<[string, string]> = [['a.txt', 'A1'], ['b.txt', 'B2'], ['c.txt', 'C3']]
      for (const [f, v] of want) {
        if (!existsSync(join(p, f))) return { pass: false, detail: `missing ${f}` }
        if (!readFileSync(join(p, f), 'utf8').includes(v)) return { pass: false, detail: `wrong ${f}` }
      }
      return { pass: true, detail: 'all 3 correct' }
    }
  },
  {
    id: 'S2-quad-configs',
    goal: '创建 config-alpha.json 内容 {"env":"alpha"}\n创建 config-beta.json 内容 {"env":"beta"}\n创建 config-gamma.json 内容 {"env":"gamma"}\n创建 config-delta.json 内容 {"env":"delta"}\n逐一解析验证后报告任务完成。',
    setup: async () => {},
    grade: async (p) => {
      const want: Array<[string, string]> = [['config-alpha.json', 'alpha'], ['config-beta.json', 'beta'], ['config-gamma.json', 'gamma'], ['config-delta.json', 'delta']]
      for (const [f, v] of want) {
        if (!existsSync(join(p, f))) return { pass: false, detail: `missing ${f}` }
        try {
          const j = JSON.parse(readFileSync(join(p, f), 'utf8'))
          if (j.env !== v) return { pass: false, detail: `wrong ${f}` }
        } catch (e) { return { pass: false, detail: `bad json ${f}` } }
      }
      return { pass: true, detail: 'all 4 correct' }
    }
  },
  {
    id: 'S3-pair-modules',
    goal: '创建 mod1.js 导出 double(n) 返回 n*2\n创建 mod2.js 导出 square(n) 返回 n*n\n用 node 分别验证 double(4)=8、square(5)=25 后报告任务完成。',
    setup: async () => {},
    grade: async (p) => {
      const r = await nodeEval(p, `const m1=require('./mod1.js');const m2=require('./mod2.js');console.log(JSON.stringify([m1.double(4),m2.square(5)]))`)
      return { pass: r.ok && r.out.includes('[8,25]'), detail: r.out.trim().slice(0, 80) }
    }
  }
]