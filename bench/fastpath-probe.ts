// single-task fast-path probe: HumanEval/24 goal through the full chatSend path
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openProjectWithGraph } from 'F:/OpenCodeCanvas/src/main/project/lifecycle'
import { setActiveProject, updatePolicy } from 'F:/OpenCodeCanvas/src/main/project/registry'
import { createChat, chatSend, chatLog } from 'F:/OpenCodeCanvas/src/main/chat'

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'occ-fp-'))
  const projDir = join(root, 'app')
  mkdirSync(projDir)
  writeFileSync(join(projDir, 'README.md'), '# x\n')
  await openProjectWithGraph(projDir)
  const proj = await updatePolicy(projDir, { engine: 'native', toolPermission: 'auto', defaultModel: 'deepseek/deepseek-chat' })
  setActiveProject(proj)
  const chatId = (await createChat(projDir)) as string
  const problems = readFileSyncEnv()
  function readFileSyncEnv(): string[] {
    // eslint-disable-next-line
    return JSON.parse(require('fs').readFileSync(join(process.env.TEMP ?? '', 'occ-humaneval-data.json'), 'utf8'))
  }
  const p = problems.find((x: { task_id: string }) => x.task_id === 'HumanEval/24')
  const goal = `在 solution.py 中实现以下 Python 函数（完整 def 行 + 函数体，可加必要 import）：\n\n${p.prompt}\n\n要求：写好后用 python 读回/执行验证函数行为，然后报告完成。`
  await chatSend(projDir, chatId, goal)
  const deadline = Date.now() + 3 * 60_000
  while (Date.now() < deadline) {
    const log = await chatLog(projDir, chatId)
    if (log.some((e) => e.role === 'final')) {
      console.log('=== chat log ===')
      for (const e of log) console.log(`[${e.role}]`, e.text.slice(0, 90).replace(/\n/g, ' | '))
      return
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  console.log('TIMEOUT')
}
void main()
