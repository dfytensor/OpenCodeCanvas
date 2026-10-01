// Bisect: which stage hangs? A=bare chain, B=+experienceAdjust path, C=+blackboard, D=+roundPlan shared snapshot (full bench path)
import { mkdtemp, mkdir, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync } from 'fs'
import { openProjectWithGraph } from 'F:/OpenCodeCanvas/src/main/project/lifecycle'
import { setActiveProject, updatePolicy } from 'F:/OpenCodeCanvas/src/main/project/registry'
import { ensureObserver, createInheritNode } from 'F:/OpenCodeCanvas/src/main/inherit/executor'
import { createChat, chatSend, chatLog } from 'F:/OpenCodeCanvas/src/main/chat'
import { getGraph, newSessionNode, upsertNode } from 'F:/OpenCodeCanvas/src/main/graph/store'
import { hashDirFast } from 'F:/OpenCodeCanvas/src/main/workspace/hash'
import { copyTree } from 'F:/OpenCodeCanvas/src/main/workspace/copy'
import { completeChat } from 'F:/OpenCodeCanvas/src/main/agent/loop'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const stage = process.env.OCC_STAGE ?? 'D'
const stamp = (): string => `${((Date.now() - t0) / 1000).toFixed(0)}s`
let t0 = Date.now()

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'occ-bisect-'))
  const projDir = join(root, 'app')
  await mkdir(projDir, { recursive: true })
  await writeFile(join(projDir, 'README.md'), '# app\n')
  await openProjectWithGraph(projDir)
  const { project } = await import('F:/OpenCodeCanvas/src/main/project/registry').then(async (m) => ({ project: await m.updatePolicy(projDir, { engine: 'native' }) }))
  setActiveProject(project)
  if (stage !== 'A') ensureObserver(projDir)

  const goal = '创建 bfile.txt，内容为 B-1。写回验证后报告任务完成。'
  const chatId = (await createChat(projDir)) as string
  console.log(`[${stamp()}] stage=${stage} chat created, sending goal`)

  // direct pipeline invocation (bypass chat.ts), reproducing runAdaptive internals
  const graph = await getGraph(projDir)
  let node = newSessionNode(graph, {
    projectId: project.id,
    title: 'bisect-worker',
    kind: 'fork',
    parents: [],
    status: 'provisioning',
    workDir: projDir
  })
  node = await upsertNode(projDir, node)
  console.log(`[${stamp()}] worker node upserted`)

  // B+: experience path (self-policy read — the file experienceAdjust reads)
  if (stage !== 'A') {
    const polFile = join(projDir, '.occ', 'orchestrator', 'self-policy.json')
    const pol = existsSync(polFile) ? JSON.parse(readFileSync(polFile, 'utf8')) : { version: 0, rules: [] }
    console.log(`[${stamp()}] self-policy v${pol.version} rules=${pol.rules.length}`)
  }

  // D: shared round snapshot
  if (stage === 'D') {
    const roundSnapDir = join(projDir, '.occ', 'snapshots', `round-x`)
    await copyTree(projDir, roundSnapDir)
    await hashDirFast(roundSnapDir)
    console.log(`[${stamp()}] round snapshot done`)
  }

  // C+: blackboard file creation (what ensureBlackboard does)
  if (stage !== 'A' && stage !== 'B') {
    await writeFile(join(projDir, 'BLACKBOARD.md'), '# BLACKBOARD\n', 'utf8')
    console.log(`[${stamp()}] blackboard ensured`)
  }

  // the LLM call — same in all stages
  console.log(`[${stamp()}] chatCompletion calling…`)
  const text = await completeChatDirect(projDir, goal)
  console.log(`[${stamp()}] COMPLETE: ${JSON.stringify(text.slice(0, 60))}`)

  async function completeChatDirect(p: string, g: string): Promise<string> {
    const { resolveAgentModel } = await import('F:/OpenCodeCanvas/src/main/agent/providers')
    const { completeChat } = await import('F:/OpenCodeCanvas/src/main/agent/loop')
    const { jevEnabled, jevRoute } = await import('F:/OpenCodeCanvas/src/main/agent/jev')
    if (stage === 'D' && jevEnabled()) {
      console.log(`[${stamp()}] jevRoute…`)
      const j = await jevRoute(g)
      console.log(`[${stamp()}] jevRoute done: ${j.mode}`)
    }
    const resolved = resolveAgentModel(undefined)
    return completeChat({
      provider: resolved!.provider,
      model: resolved!.model,
      messages: [{ role: 'user', content: g }],
      signal: AbortSignal.timeout(120_000)
    })
  }
  process.exit(0)
}
main().catch((e) => { console.error('FATAL', String(e).slice(0, 200)); process.exit(1) })
