// Agent Benchmark: HumanEval-style coding tasks with deterministic graders.
// Measures: baseline (single call) vs ours (agent loop + self-correction).
import { mkdtemp, mkdir, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { openProjectWithGraph } from 'F:/OpenCodeCanvas/src/main/project/lifecycle'
import { setActiveProject, updatePolicy } from 'F:/OpenCodeCanvas/src/main/project/registry'
import { getGraph, newSessionNode, upsertNode, patchNode } from 'F:/OpenCodeCanvas/src/main/graph/store'
import { startAgentSession } from 'F:/OpenCodeCanvas/src/main/agent/session'
import { resolveAgentModel } from 'F:/OpenCodeCanvas/src/main/agent/providers'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
let fail = 0

// ── Tasks: each has files to create, a test script, and expected output ──

interface BenchTask {
  id: string
  prompt: string
  files: Record<string, string>           // initial files
  test: string                             // node -e code to verify
  expectContains: string                   // expected substring in stdout
}

const TASKS: BenchTask[] = [
  {
    id: 'H1-fib',
    prompt: '创建 fib.js，导出函数 fib(n)（斐波那契，fib(0)=0, fib(1)=1）。用 node 运行验证 fib(10)=55 后报告任务完成。',
    files: {},
    test: `const m=require('./fib.js');const f=m.fib??m.default??m;console.log(JSON.stringify([f(0),f(1),f(10)]))`,
    expectContains: '[0,1,55]'
  },
  {
    id: 'H2-is-palindrome',
    prompt: '创建 palindrome.js，导出函数 isPalindrome(s) 判断字符串是否为回文（忽略大小写和空格）。验证 isPalindrome("A man a plan")===false 且 isPalindrome("racecar")===true 后报告任务完成。',
    files: {},
    test: `const m=require('./palindrome.js');const f=m.isPalindrome??m.default??m;console.log(JSON.stringify([f("racecar"),f("hello"),f("A man a plan")]))`,
    expectContains: '[true,false,false]'
  },
  {
    id: 'H3-word-count',
    prompt: '创建 counter.js，导出函数 wordCount(text) 返回一个对象，key 是单词（小写），value 是出现次数。例如 wordCount("the cat and the hat") 应返回 {"the":2,"cat":1,"and":1,"hat":1}。验证后报告任务完成。',
    files: {},
    test: `const m=require('./counter.js');const f=m.wordCount??m.default??m;const r=f("the cat and the hat");console.log(JSON.stringify([r.the,r.cat,r.and]))`,
    expectContains: '[2,1,1]'
  },
  {
    id: 'H4-bubble-sort',
    prompt: '创建 sorter.js，导出函数 bubbleSort(arr) 实现冒泡排序（返回新数组，不修改原数组）。验证 bubbleSort([3,1,2]) 返回 [1,2,3] 且 bubbleSort([]) 返回 [] 后报告任务完成。',
    files: {},
    test: `const m=require('./sorter.js');const f=m.bubbleSort??m.default??m;console.log(JSON.stringify([f([3,1,2]),f([])]))`,
    expectContains: '[[1,2,3],[]]'
  },
  {
    id: 'H5-fizzbuzz',
    prompt: '创建 fizzbuzz.js，导出函数 fizzbuzz(n) 返回数组：1 到 n，3 的倍数替换为 "Fizz"，5 的倍数替换为 "Buzz"，两者都是替换为 "FizzBuzz"。验证 fizzbuzz(15) 的最后三个元素是 ["Fizz","Buzz"] 和 14 后面是 "FizzBuzz"。报告任务完成。',
    files: {},
    test: `const m=require('./fizzbuzz.js');const f=m.fizzbuzz??m.default??m;const r=f(15);console.log(JSON.stringify([r[2],r[4],r[14],r.length]))`,
    expectContains: '["Fizz","Buzz","FizzBuzz",15]'
  }
]

// ── runner ──

function runNodeTest(projDir: string, testCode: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync('node', ['-e', testCode], { cwd: projDir, timeout: 15000, encoding: 'utf8', windowsHide: true })
    return { ok: true, out }
  } catch (e: any) {
    return { ok: false, out: String(e.stderr || e.stdout || e.message || '').slice(0, 200) }
  }
}

interface BenchResult {
  task: string
  config: string
  pass: boolean
  wallSec: number
  tokens: number
  detail: string
}

async function waitDone(rootDir: string, nodeId: string, timeoutMs: number): Promise<{ done: boolean; tokens: number }> {
  const deadline = Date.now() + timeoutMs
  let tokens = 0
  while (Date.now() < deadline) {
    const g = await getGraph(rootDir)
    const n = g.nodes[nodeId]
    if (!n) break
    tokens = (n.tokenUsage?.input ?? 0) + (n.tokenUsage?.output ?? 0)
    if (n.status === 'completed') return { done: true, tokens }
    if (n.status === 'failed' || n.status === 'aborted') return { done: false, tokens }
    await sleep(3000)
  }
  return { done: false, tokens }
}

async function main() {
  const results: BenchResult[] = []
  const configs: Array<'baseline' | 'ours'> = ['baseline', 'ours']

  for (const task of TASKS) {
    for (const config of configs) {
      const root = await mkdtemp(join(tmpdir(), 'occ-bench-'))
      const projDir = join(root, task.id)
      await mkdir(projDir, { recursive: true })
      for (const [fn, content] of Object.entries(task.files)) {
        await writeFile(join(projDir, fn), content, 'utf8')
      }

      await openProjectWithGraph(projDir)
      const { project } = await import('F:/OpenCodeCanvas/src/main/project/registry').then(async (m) => ({ project: await m.updatePolicy(projDir, { engine: 'native' }) }))
      setActiveProject(project)

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

      const kickoff = config === 'ours'
        ? task.prompt + '\n\n完成标准（必须遵守）：改动后必须实际运行/读回验证（运行脚本或读取文件），最终回复中给出验证证据，再声明任务完成。'
        : task.prompt

      await startAgentSession(projDir, { id: node.id, title: node.title, workDir: projDir }, { kickoff })

      const t0 = Date.now()
      const wd = await waitDone(projDir, node.id, 6 * 60_000)
      const wall = Math.round((Date.now() - t0) / 1000)

      const gr = runNodeTest(projDir, task.test)
      const g = await getGraph(projDir)
      const n = g.nodes[node.id]
      const tok = (n?.tokenUsage?.input ?? 0) + (n?.tokenUsage?.output ?? 0)

      results.push({ task: task.id, config, pass: gr.ok && gr.out.includes(task.expectContains), wall, tokens: tok, detail: gr.out.slice(0, 80) })
      console.log(`[${config}] ${task.id}: ${gr.ok && gr.out.includes(task.expectContains) ? 'PASS' : 'FAIL'} ${wall}s tok=${tok} :: ${gr.out.slice(0, 60)}`)
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  }

  console.log('\n===== BENCH SUMMARY =====')
  for (const c of configs) {
    const rs = results.filter((r) => r.config === c)
    const p = rs.filter((r) => r.pass).length
    const wall = Math.round(rs.reduce((a, r) => a + r.wall, 0) / Math.max(1, rs.length))
    const tok = Math.round(rs.reduce((a, r) => a + r.tokens, 0) / Math.max(1, rs.length))
    console.log(`${c.padEnd(9)}: ${p}/${rs.length} pass, avg ${wall}s, avg ${tok} tokens`)
  }
  const fails = results.filter(r => !r.pass)
  if (fails.length) {
    console.log('\nFAILURES:')
    for (const f of fails) console.log(`  [${f.config}] ${f.task}: ${f.detail}`)
  }
  require('fs').writeFileSync('F:/OpenCodeCanvas/agent-bench-results.json', JSON.stringify(results, null, 2))
  console.log('written to agent-bench-results.json')
  process.exit(0)
}

const fs = require('fs')
const rm = require('fs').promises.rm
main().catch((e) => { console.error(e); process.exit(1) })
