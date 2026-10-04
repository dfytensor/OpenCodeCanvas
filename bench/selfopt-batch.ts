// Batch runner: env OCC_GOAL_FILE selects the goal batch; fresh project each batch.
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
// curl transport: native http.request hangs intermittently on this Windows box
process.env.OCC_HTTP = 'curl'
let fail = 0
const check = (n: string, c: boolean, x?: string): void => {
  if (c) console.log('  ok -', n)
  else { fail++; console.error('FAIL -', n, x ?? '') }
}

const GOALS: Record<string, string[]> = {
  a: ['创建 alpha.txt 内容为 A-OK', '创建 beta.txt 内容为 B-OK'],
  b: ['创建 gamma.txt 内容为 G-3', '创建 delta.txt 内容为 D-4']
}

async function waitFinal(rootDir: string, chatId: string, skip: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const log = await chatLog(rootDir, chatId)
    const finals = log.filter((e) => e.role === 'final')
    if (finals.length > skip) return finals[finals.length - 1].text
    await sleep(2500)
  }
  return ''
}

async function main() {
  const which = process.env.OCC_GOALS ?? 'a'
  const goals = GOALS[which] ?? GOALS.a
  const root = await mkdtemp(join(tmpdir(), 'occ-selfopt-'))
  const projDir = join(root, 'app')
  await mkdir(projDir, { recursive: true })
  await writeFile(join(projDir, 'README.md'), '# app\n')

  await openProjectWithGraph(projDir)
  const { project } = await import('F:/OpenCodeCanvas/src/main/project/registry').then(async (m) => ({ project: await m.updatePolicy(projDir, { engine: 'native' }) }))
  setActiveProject(project)
  // native engine manages its own status — observer not needed

  // seed painful multi-fail history so variant competition triggers
  const orchDir = join(projDir, '.occ', 'orchestrator')
  await mkdir(orchDir, { recursive: true })
  const seed = [
    { ts: new Date().toISOString(), tasks: 2, rounds: 2, outcome: 'failed', tokens: 70000, wallSec: 210 },
    { ts: new Date().toISOString(), tasks: 3, rounds: 3, outcome: 'failed', tokens: 85000, wallSec: 260 },
    { ts: new Date().toISOString(), tasks: 1, rounds: 1, outcome: 'success', tokens: 7000, wallSec: 22 }
  ]
  await writeFile(join(orchDir, 'routing.jsonl'), seed.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8')

  const chatId = (await createChat(projDir)) as string
  console.log(`[batch ${which}] goal lines: ${goals.length}`)
  await chatSend(projDir, chatId, goals.join('\n') + '\n全部创建后逐一读回验证，然后报告任务完成。')

  const t = await waitFinal(projDir, chatId, 'goal', 0, 7 * 60_000)
  check('final arrived', t.length > 0, '(timeout 7min)')
  console.log('    final:', t.slice(0, 110).replace(/\n/g, ' | '))

  const g = await getGraph(projDir)
  const workers = Object.values(g.nodes).filter((n) => n.kind === 'fork')
  console.log(`    workers: ${workers.length}, total nodes: ${Object.keys(g.nodes).length}`)
  const routing = (await readFile(join(orchDir, 'routing.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const last = routing[routing.length - 1]
  console.log(`    last routing: tasks=${last.tasks} outcome=${last.outcome} fitness=${last.fitness ?? '-'} variants=${last.variants ?? '-'}`)

  for (const line of goals) {
    const f = line.split('内容为')[1]?.trim()
    const fname = line.match(/[a-z]+\.txt/i)?.[0]
    if (f && fname) {
      const p = join(projDir, fname)
      check(`${fname} OK`, existsSync(p) && (await readFile(p, 'utf8')).includes(f), existsSync(p) ? 'wrong content' : 'missing')
    }
  }
  check('serial chain (variants or single, never 3+ workers)', workers.length <= 3)

  console.log('    kept at:', projDir)
  console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILURES'}`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
