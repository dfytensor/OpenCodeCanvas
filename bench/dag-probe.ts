// DAG planner verification: a dependent two-step goal must produce
// levels → wave merge → level-2 worker seeing level-1 output.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openProjectWithGraph } from 'F:/OpenCodeCanvas/src/main/project/lifecycle'
import { setActiveProject, updatePolicy } from 'F:/OpenCodeCanvas/src/main/project/registry'
import { createChat, chatSend, chatLog } from 'F:/OpenCodeCanvas/src/main/chat'

const GOAL =
  '第一步：在项目根目录创建 data.txt，内容为正好三行：alpha、beta、gamma（每行一个词）。' +
  '第二步：读取 data.txt，然后创建 report.txt，内容为「data.txt 共 N 行」（N 用实际行数替代）。两个文件都要读回验证后再报告完成。'

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'occ-dag-'))
  const projDir = join(root, 'app')
  mkdirSync(projDir, { recursive: true })
  writeFileSync(join(projDir, 'README.md'), '# dag\n')
  await openProjectWithGraph(projDir)
  const proj = await updatePolicy(projDir, { engine: 'native', toolPermission: 'auto', defaultModel: 'deepseek/deepseek-chat' })
  setActiveProject(proj)
  const chatId = (await createChat(projDir)) as string
  await chatSend(projDir, chatId, GOAL)
  const deadline = Date.now() + 8 * 60_000
  let final = ''
  while (Date.now() < deadline) {
    const log = await chatLog(projDir, chatId)
    const finals = log.filter((e) => e.role === 'final')
    if (finals.length > 0) { final = finals[finals.length - 1].text; break }
    await new Promise((r) => setTimeout(r, 2000))
  }
  console.log('final:', final.slice(0, 140).replace(/\n/g, ' | '))
  const rp = join(projDir, 'report.txt')
  if (!existsSync(rp)) { console.log('FAIL - report.txt missing'); process.exit(1) }
  const rc = readFileSync(rp, 'utf8')
  console.log('report.txt:', rc.trim().slice(0, 80))
  if (/共\s*3\s*行/.test(rc)) console.log('DAG PASS — level-2 saw level-1 output (wave merge works)')
  else { console.log('DAG FAIL — report does not reflect 3 lines'); process.exit(1) }
}
void main()
