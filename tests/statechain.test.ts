/**
 * 状态链整合测试 — append-only 事件日志 + 投影压实 + 事件商店
 * 运行: npx tsx tests/statechain.test.ts
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const PASS: string[] = []
const FAIL: string[] = []

function test(name: string, fn: () => void | Promise<void>) {
  const p = fn()
  if (p instanceof Promise) {
    return p.then(() => { PASS.push(name); console.log(`  ✓ ${name}`) })
      .catch(e => { FAIL.push(`${name}: ${e.message}`); console.error(`  ✗ ${name}: ${e.message}`) })
  }
  PASS.push(name); console.log(`  ✓ ${name}`)
  return Promise.resolve()
}

function expect_eq(actual: unknown, expected: unknown, msg = '') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expect ${JSON.stringify(expected)} got ${JSON.stringify(actual)} ${msg}`)
  }
}

function expect_true(cond: boolean, msg = '') {
  if (!cond) throw new Error(`expect true ${msg}`)
}

async function main() {
  const { projectForProvider } = await import('../src/main/agent/loop')
  const { appendAgentEvent, readAgentEvents, eventLogPath } = await import('../src/main/agent/events')

  const mkAssistant = (content: string, ids: string[]) => ({
    role: 'assistant' as const,
    content,
    tool_calls: ids.map((id) => ({ id, type: 'function' as const, function: { name: 'bash', arguments: '{}' } }))
  })

  await test('投影是纯函数：canonical 原件零改写（状态=投影，历史不可变）', () => {
    const canon: any[] = []
    canon.push({ role: 'system', content: 's' })
    canon.push({ role: 'user', content: 'goal' })
    canon.push(mkAssistant('a1', ['t1', 't2']))
    canon.push({ role: 'tool', tool_call_id: 't1', content: 'x'.repeat(3200) })
    canon.push({ role: 'tool', tool_call_id: 't2', content: 'y'.repeat(3200) })
    canon.push(mkAssistant('a2', ['t3']))
    canon.push({ role: 'tool', tool_call_id: 't3', content: 'z'.repeat(3200) })
    canon.push({ role: 'assistant', content: 'finish' })
    const before = JSON.stringify(canon)
    // KEEP_RECENT=8 → messages.length=8 且未超阈值会直接返回原数组（不 stub）
    // 人为扩大历史直到触发阈值
    for (let i = 0; i < 12; i++) {
      canon.push(mkAssistant(`extra${i}`, [`e${i}`]))
      canon.push({ role: 'tool', tool_call_id: `e${i}`, content: ('w' + i + ' ').repeat(200) })
    }
    const bigBefore = JSON.stringify(canon)
    const c1 = JSON.parse(bigBefore)
    const p1 = projectForProvider(c1, undefined)
    expect_true(p1.compacted > 0, '长历史必须触发压实')
    expect_eq(JSON.stringify(c1), bigBefore, '投影不得改写 canonical 配对数组')
    // 第二次投影同一 canonical → 与第一次一致（幂等）
    const p2 = projectForProvider(JSON.parse(bigBefore), undefined)
    expect_eq(JSON.stringify(p2.view), JSON.stringify(p1.view), '投影必须幂等')
    expect_true(before.length > 0, 'sanity')
    void canon
  })

  await test('重注入点永远越过未闭合 tool 对（复现 deepseek HTTP 400 场景）', () => {
    const canon: any[] = []
    canon.push({ role: 'system', content: 's' })
    canon.push({ role: 'user', content: 'goal' })
    canon.push(mkAssistant('a1', ['t1', 't2']))
    canon.push({ role: 'tool', tool_call_id: 't1', content: 'x'.repeat(4000) })
    canon.push({ role: 'tool', tool_call_id: 't2', content: 'y'.repeat(4000) })
    // 用户消息在最末（模拟边界恰好在 tool 段后）
    canon.push({ role: 'user', content: 'keep working' })
    for (let i = 0; i < 12; i++) {
      canon.push(mkAssistant(`extra${i}`, [`e${i}`]))
      canon.push({ role: 'tool', tool_call_id: `e${i}`, content: ('w' + i + ' ').repeat(400) })
    }
    // 收集 notes.md 供重注入
    const dir = mkdtempSync(join(tmpdir(), 'occ-sc-'))
    const notes = join(dir, 'notes.md')
    require('fs').writeFileSync(notes, '计划：先做 A 再做 B', 'utf8')
    const p = projectForProvider(canon, notes)
    const view: any[] = p.view
    // 找到重注入的 user note
    const idx = view.findIndex((m) => String(m.content ?? '').includes('[工作记忆恢复]'))
    expect_true(idx >= 0, '重注入必须存在')
    // 断言：注入点之前，任何 assistant(tool_calls) 的每一条 tool_call 都有紧跟的 tool 回复
    for (let i = 0; i < view.length; i++) {
      const m = view[i]
      if (m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0) {
        const ids = m.tool_calls.map((c: any) => c.id)
        let j = i + 1
        const seen: string[] = []
        while (j < view.length && view[j].role === 'tool') {
          seen.push(view[j].tool_call_id)
          j++
        }
        expect_eq(seen.length >= ids.length, true, `assistant#${i} 的 tool 对必须连续闭合`)
      }
      if (i === idx) break
    }
    rmSync(dir, { recursive: true, force: true })
  })

  await test('事件商店：append-only 单行 JSONL + 读回', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'occ-ev-'))
    await appendAgentEvent(dir, 'n1', 'session', { sessionId: 'agt_x', providerRef: 'p/m' })
    await appendAgentEvent(dir, 'n1', 'msg', { role: 'user', content: '第一行\n含换行的内容' })
    await appendAgentEvent(dir, 'n1', 'msg', { role: 'assistant', content: '回', toolCalls: [{ id: 'c1' }] })
    const file = eventLogPath(dir, 'n1')
    expect_true(existsSync(file), 'events.jsonl 必须落盘')
    const raw = readFileSync(file, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    expect_eq(lines.length, 3, '三事件三行')
    expect_true(lines.every((l) => !l.includes('\n')), '每行独立（换行被转义）')
    const evs = await readAgentEvents(dir, 'n1')
    expect_eq(evs.length, 3, '读回三条')
    expect_eq(evs[1].type, 'msg')
    const asst = evs.find((e) => (e as any).toolCalls) as any
    expect_eq(asst.toolCalls[0].id, 'c1')
    rmSync(dir, { recursive: true, force: true })
  })

  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`)
  if (FAIL.length > 0) {
    for (const f of FAIL) console.error('FAIL: ' + f)
    throw new Error(`${FAIL.length} test(s) failed`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
