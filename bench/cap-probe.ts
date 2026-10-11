// cap verification: a 600KB file forces read_file past the 8k tool-result cap
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openProjectWithGraph } from 'F:/OpenCodeCanvas/src/main/project/lifecycle'
import { setActiveProject, updatePolicy } from 'F:/OpenCodeCanvas/src/main/project/registry'
import { createChat, chatSend, chatLog } from 'F:/OpenCodeCanvas/src/main/chat'

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'occ-cap-'))
  const projDir = join(root, 'app')
  mkdirSync(projDir, { recursive: true })
  writeFileSync(join(projDir, 'README.md'), '# cap\n')
  // ~600KB, ALPHA appears exactly 137 times
  const chunks: string[] = []
  let alpha = 0
  for (let i = 0; i < 60_000; i++) {
    const w = i % 37 === 0 ? (alpha++, 'ALPHA') : ['beta', 'gamma', 'delta', 'epsilon'][i % 4]
    chunks.push(w)
  }
  console.log('ALPHA count planted:', alpha)
  writeFileSync(join(projDir, 'big.txt'), chunks.join(' '), 'utf8')
  await openProjectWithGraph(projDir)
  const proj = await updatePolicy(projDir, { engine: 'native', toolPermission: 'auto', defaultModel: 'deepseek/deepseek-chat' })
  setActiveProject(proj)
  const chatId = (await createChat(projDir)) as string
  await chatSend(projDir, chatId, '必须使用 read_file 工具读取 big.txt，然后把其完整内容原样复制写入 copy.txt（一字不差）。完成后报告 copy.txt 的大小。')
  const deadline = Date.now() + 4 * 60_000
  while (Date.now() < deadline) {
    const log = await chatLog(projDir, chatId)
    if (log.some((e) => e.role === 'final')) {
      for (const e of log) console.log(`[${e.role}]`, e.text.slice(0, 100).replace(/\n/g, ' | '))
      return
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  console.log('TIMEOUT')
}
void main()
