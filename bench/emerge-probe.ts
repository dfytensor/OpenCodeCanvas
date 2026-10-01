// Emergence probe: 3 tasks with single-pass traps.
import { execFileSync } from 'child_process'
import { mkdtemp, mkdir, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync } from 'fs'
import { openProjectWithGraph } from 'F:/OpenCodeCanvas/src/main/project/lifecycle'
import { setActiveProject, updatePolicy } from 'F:/OpenCodeCanvas/src/main/project/registry'
import { ensureObserver } from 'F:/OpenCodeCanvas/src/main/inherit/executor'
import { createChat, chatSend, chatLog } from 'F:/OpenCodeCanvas/src/main/chat'
import { getGraph } from 'F:/OpenCodeCanvas/src/main/graph/store'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
let fail = 0
const check = (n: string, c: boolean, x?: string): void => {
  if (c) console.log('  ok -', n)
  else { fail++; console.error('FAIL -', n, x ?? '') }
}

function nodeEval(projDir: string, code: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync('node', ['-e', code], { cwd: projDir, timeout: 15000, encoding: 'utf8', windowsHide: true })
    return { ok: true, out }
  } catch (e: any) {
    return { ok: false, out: String(e.stderr || e.stdout || e.message || '').slice(0, 200) }
  }
}

interface ProbeTask {
  id: string
  goal: string
  grade: (p: string) => { pass: boolean; detail: string }
}

const TASKS: ProbeTask[] = [
  {
    id: 'P1-reverse-unicode',
    goal: '创建 reverse.js（CommonJS），导出函数 reverseString(s) 正确反转字符串——必须正确处理 Unicode 代理对（如 emoji 😀），不能用简单的 split("") 反转。用 node 运行验证 reverseString("hello")==="olleh" 且 reverseString("😀测试")==="试测😀" 后报告任务完成。',
    grade: (p) => {
      const f = join(p, 'reverse.js')
      if (!existsSync(f)) return { pass: false, detail: 'missing reverse.js' }
      const r = nodeEval(p, `const m=require('./reverse.js');const rev=m.reverseString??m.default??m;const a=rev("hello");const b=rev("\\u{1F600}\\u6D4B\\u8BD5");console.log(JSON.stringify({a,b}))`)
      return { pass: r.ok && r.out.includes('"a":"olleh"') && r.out.includes('试测'), detail: r.out.slice(0, 120) }
    }
  },
  {
    id: 'P2-exact-json',
    goal: '创建 config.json，内容恰好为 {"name":"emergence","ver":"3.0"}。写回后用 JSON.parse 验证字段精确匹配，然后报告任务完成。',
    grade: (p) => {
      const f = join(p, 'config.json')
      if (!existsSync(f)) return { pass: false, detail: 'missing config.json' }
      try {
        const j = JSON.parse(require('fs').readFileSync(f, 'utf8'))
        const ok = j.name === 'emergence' && j.ver === '3.0'
        return { pass: ok, detail: JSON.stringify(j).slice(0, 120) }
      } catch (e) { return { pass: false, detail: String(e).slice(0, 100) } }
    }
  },
  {
    id: 'P3-fix-slugify',
    goal: 'utils.js 的 slugify("Hello World!") 应该返回 "hello-world" 但有 bug。读取修复，用 node 运行验证后报告任务完成。',
    setup: undefined,
    grade: (p) => {
      const f = join(p, 'utils.js')
      if (!existsSync(f)) return { pass: false, detail: 'missing utils.js' }
      const r = nodeEval(p, `const {slugify}=require('./utils.js'); console.log(JSON.stringify(slugify("Hello World!")))`)
      return { pass: r.ok && r.out.includes('hello-world'), detail: r.out.slice(0, 120) }
    }
  }
]
// add setup to P3
TASKS[2].setup = async (p: string) => {
  require('fs').writeFileSync(join(p, 'utils.js'), `function slugify(s) {\n  return s.toLowerCase().replace(/\\s+/g, '-')\n}\nmodule.exports = { slugify }\n`)
}

async function main() {
  const results: Array<{ config: string; task: string; pass: boolean; wall: number; nodes: number; tok: number }> = []

  for (const task of TASKS) {
    for (const config of ['baseline', 'ours'] as const) {
      const root = await mkdtemp(join(tmpdir(), 'occ-emerge-'))
      const projDir = join(root, task.id)
      await mkdir(projDir, { recursive: true })
      if (task.setup) await task.setup(projDir)

      await openProjectWithGraph(projDir)
      const { project } = await import('F:/OpenCodeCanvas/src/main/project/registry').then(async (m) => ({ project: await m.updatePolicy(projDir, { engine: 'native' }) }))
      setActiveProject(project)
      ensureObserver(projDir)

      const chatId = (await createChat(projDir)) as string
      const t0 = Date.now()
      await chatSend(projDir, chatId, task.goal)

      const deadline = Date.now() + 8 * 60_000
      let final = ''
      while (Date.now() < deadline) {
        const log = await chatLog(projDir, chatId)
        const f = [...log].reverse().find((e) => e.role === 'final')
        if (f) { final = f.text; break }
        await sleep(3000)
      }
      const wall = Math.round((Date.now() - t0) / 1000)

      const gr = task.grade(projDir)
      const g = await getGraph(projDir)
      const nodes = Object.keys(g.nodes).length
      let tok = 0
      for (const n of Object.values(g.nodes)) tok += (n.tokenUsage?.input ?? 0) + (n.tokenUsage?.output ?? 0)

      results.push({ config, task: task.id, pass: gr.pass, wall, nodes, tok })
      console.log(`[${config}] ${task.id}: ${gr.pass ? 'PASS' : 'FAIL'} ${wall}s nodes=${nodes} tok=${tok} :: ${gr.detail.slice(0, 60)}`)
    }
  }

  console.log('\n===== EMERGENCE PROBE SUMMARY =====')
  for (const c of ['baseline', 'ours']) {
    const rs = results.filter((r) => r.config === c)
    const p = rs.filter((r) => r.pass).length
    console.log(`${c.padEnd(9)}: ${p}/${rs.length} pass, avg ${Math.round(rs.reduce((a, r) => a + r.wall, 0) / Math.max(1, rs.length))}s, avg tok ${Math.round(rs.reduce((a, r) => a + r.tok, 0) / Math.max(1, rs.length))}`)
  }
  require('fs').writeFileSync('F:/OpenCodeCanvas/emerge-probe-results.json', JSON.stringify(results, null, 2))
  console.log('written to emerge-probe-results.json')
  process.exit(0)
}

const fs = require('fs')
main().catch((e) => { console.error(e); process.exit(1) })
