// Agent Benchmark Runner v2 — 10 tasks × 2 configs, foreground batches.
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { openProjectWithGraph } from 'F:/OpenCodeCanvas/src/main/project/lifecycle'
import { setActiveProject, updatePolicy } from 'F:/OpenCodeCanvas/src/main/project/registry'
import { getGraph, newSessionNode, upsertNode } from 'F:/OpenCodeCanvas/src/main/graph/store'
import { startAgentSession } from 'F:/OpenCodeCanvas/src/main/agent/session'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Task {
  id: string
  difficulty: number
  goal: string
  setup?: (p: string) => Promise<void>
  grade: (p: string) => { pass: boolean; detail: string }
}

function nodeEval(projDir: string, code: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync('node', ['-e', code], { cwd: projDir, timeout: 15000, encoding: 'utf8', windowsHide: true })
    return { ok: true, out }
  } catch (e: any) {
    return { ok: false, out: String(e.stderr || e.stdout || e.message || '').slice(0, 200) }
  }
}

const TASKS: Task[] = JSON.parse(require('fs').readFileSync('F:/OpenCodeCanvas/bench/tasks.json', 'utf8'))

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
  const cfg = process.env.OCC_BENCH_CONFIG ?? 'both'
  const configs: Array<'baseline' | 'ours'> = cfg === 'both' ? ['baseline', 'ours'] : [cfg as any]
  const tasks = TASKS
  const results: Array<any> = []

  for (const task of tasks) {
    for (const config of configs) {
      const root = await mkdtemp(join(tmpdir(), 'occ-ab2-'))
      const projDir = join(root, task.id)
      await mkdir(projDir, { recursive: true })

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
        ? task.goal + '\n\n完成标准（必须遵守）：改动后必须实际运行/读回验证，最终回复中给出验证证据，再声明任务完成。'
        : task.goal

      await startAgentSession(projDir, { id: node.id, title: node.title, workDir: projDir }, { kickoff })

      const t0 = Date.now()
      const wd = await waitDone(projDir, node.id, 8 * 60_000)
      const wall = Math.round((Date.now() - t0) / 1000)

      const gr = task.grade(projDir)
      const g = await getGraph(projDir)
      const n = g.nodes[node.id]
      const tok = (n?.tokenUsage?.input ?? 0) + (n?.tokenUsage?.output ?? 0)

      results.push({ task: task.id, config, pass: gr.pass, wall, nodes: 1, tokens: tok, detail: gr.detail })
      console.log(`[${config}] ${task.id}: ${gr.pass ? 'PASS' : 'FAIL'} ${wall}s tok=${tok} :: ${gr.detail.slice(0, 60)}`)
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  }

  console.log('\n===== FULL BENCH SUMMARY =====')
  for (const c of configs) {
    const rs = results.filter((r) => r.config === c)
    const p = rs.filter((r) => r.pass).length
    console.log(`${c.padEnd(9)}: ${p}/${rs.length} pass, avg ${Math.round(rs.reduce((a, r) => a + r.wall, 0) / Math.max(1, rs.length))}s, avg tok ${Math.round(rs.reduce((a, r) => a + r.tokens, 0) / Math.max(1, rs.length))}`)
  }
  require('fs').writeFileSync('F:/OpenCodeCanvas/bench-v2-results.json', JSON.stringify(results, null, 2))
  console.log('written to bench-v2-results.json')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
