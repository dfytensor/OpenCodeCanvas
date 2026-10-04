// Real-project performance probe: copies a real repo (default F:/llama.cpp minus
// build artifacts), runs a full native pipeline end-to-end, measures each phase.
// Env: OCC_REAL_SRC, OCC_REAL_GOAL, OCC_TEST_MODEL
import { mkdirSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { openProjectWithGraph } from 'F:/OpenCodeCanvas/src/main/project/lifecycle'
import { setActiveProject, updatePolicy } from 'F:/OpenCodeCanvas/src/main/project/registry'
import { createChat, chatSend, chatLog } from 'F:/OpenCodeCanvas/src/main/chat'
import { getGraph } from 'F:/OpenCodeCanvas/src/main/graph/store'
import { hashDirFast } from 'F:/OpenCodeCanvas/src/main/workspace/hash'

const SRC = process.env.OCC_REAL_SRC ?? 'F:/llama.cpp'
const ARTIFACT = process.env.OCC_REAL_ARTIFACT ?? 'size-report.mjs'
const GOAL =
  process.env.OCC_REAL_GOAL ??
  '在项目根目录创建 size-report.mjs：递归统计当前目录下 .cpp/.h/.cu 文件的个数与总行数，输出最大的10个文件（相对路径+行数）。用 node size-report.mjs 实际运行验证，报告前3名的结果。'

const t0 = Date.now()
const mark = (label: string, from: number): void =>
  console.log(`[perf] ${label}: ${(Math.round((Date.now() - from) / 100) / 10).toFixed(1)}s (total ${Math.round((Date.now() - t0) / 1000)}s)`)

async function main(): Promise<void> {
  const root = join(tmpdir(), 'occ-realproj')
  const projDir = join(root, 'app')
  try { execFileSync('cmd', ['/c', `rmdir /s /q "${root}"`], { stdio: 'ignore' }) } catch { /* fresh */ }
  mkdirSync(projDir, { recursive: true })

  let tc = Date.now()
  try {
    execFileSync('robocopy', [SRC, projDir, '/E',
      '/XD', '.git', 'build', 'build-cuda', 'build-debug', 'build-release', 'models', '.occ', 'node_modules', '.cache',
      '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { stdio: 'ignore' })
  } catch (e) {
    const code = (e as { status?: number }).status
    if (code === undefined || code > 7) throw e
  }
  mark('robocopy', tc)

  tc = Date.now()
  const h = await hashDirFast(projDir)
  mark(`hashDirFast (${h.slice(0, 8)}…)`, tc)

  tc = Date.now()
  await openProjectWithGraph(projDir)
  mark('openProject', tc)

  const { project } = await import('F:/OpenCodeCanvas/src/main/project/registry').then(async (m) => ({
    project: await m.updatePolicy(projDir, {
      engine: 'native',
      toolPermission: 'auto',
      ...(process.env.OCC_TEST_MODEL ? { defaultModel: process.env.OCC_TEST_MODEL } : {})
    })
  }))
  setActiveProject(project)

  const chatId = (await createChat(projDir)) as string
  tc = Date.now()
  await chatSend(projDir, chatId, GOAL)

  const deadline = Date.now() + 11 * 60_000
  let finalText = ''
  while (Date.now() < deadline) {
    const log = await chatLog(projDir, chatId)
    const finals = log.filter((e) => e.role === 'final')
    if (finals.length > 0) { finalText = finals[finals.length - 1].text; break }
    await new Promise((r) => setTimeout(r, 3000))
  }
  mark('pipeline', tc)
  console.log('final:', finalText.slice(0, 220).replace(/\n/g, ' | '))

  const g = await getGraph(projDir)
  const nodes = Object.values(g.nodes)
  const workers = nodes.filter((n) => n.kind === 'fork')
  const tokens = nodes.reduce((a, n) => a + (n.tokenUsage?.input ?? 0) + (n.tokenUsage?.output ?? 0), 0)
  console.log(`[perf] workers: ${workers.length}, nodes: ${nodes.length}, tokens: ${Math.round(tokens / 1000)}k`)
  for (const n of nodes) {
    if (n.kind === 'fork' || n.kind === 'merge') {
      console.log(`  - [${n.kind}] ${n.title} status=${n.status} tok=${Math.round(((n.tokenUsage?.input ?? 0) + (n.tokenUsage?.output ?? 0)) / 1000)}k`)
    }
  }

  const p = join(projDir, ARTIFACT)
  if (!existsSync(p)) {
    console.log('FAIL - artifact missing')
    process.exitCode = 1
    return
  }
  try {
    const out = execFileSync('node', [p], { cwd: projDir, encoding: 'utf8' })
    console.log('  ok - artifact runs, first lines:', out.split('\n').slice(0, 3).join(' | ').slice(0, 160))
  } catch (e) {
    console.log('FAIL - artifact does not run:', String(e).slice(0, 120))
    process.exitCode = 1
    return
  }
  console.log('REALPROJ PASS')
}

void main()
