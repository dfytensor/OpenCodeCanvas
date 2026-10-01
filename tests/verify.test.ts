/**
 * 三耦合环验证管线 — 独立测试脚本
 * 运行: npx tsx tests/verify.test.ts
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

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

// ── GoodhartTracker 测试 ──
async function testGoodhart() {
  const { GoodhartTracker } = await import('../src/main/verify/goodhart')

  await test('正常操作不报警', () => {
    const t = new GoodhartTracker(5, 0.3)
    for (let i = 0; i < 10; i++) {
      t.record(1.0, 0.95)
      expect_true(t.check() === null)
    }
  })

  await test('gap 超阈值触发 warning', () => {
    const t = new GoodhartTracker(5, 0.3)
    for (let i = 0; i < 6; i++) {
      t.record(1.0, 0.5)
    }
    const alert = t.check()
    expect_true(alert !== null, '应有报警')
    expect_eq(alert!.level, 'warning')
  })

  await test('gap 大 + 恶化趋势触发 critical', () => {
    const t = new GoodhartTracker(5, 0.3)
    for (let i = 0; i < 10; i++) {
      const gap = 0.2 + i * 0.15
      t.record(1.0, 1.0 - gap)
    }
    const alert = t.check()
    expect_true(alert !== null)
  })

  await test('reset 清除历史', () => {
    const t = new GoodhartTracker(5, 0.3)
    for (let i = 0; i < 10; i++) {
      t.record(1.0, 0.0)
    }
    t.reset()
    expect_true(t.check() === null)
    expect_eq(t.getHistory().length, 0)
  })
}

// ── detectGoodhart 测试 ──
async function testDetect() {
  const { detectGoodhart } = await import('../src/main/verify/pipeline')

  await test('正常 (approve + pass) → 无报警', () => {
    const reading = detectGoodhart(
      { verdict: 'approve', issues: [], summary: '' },
      { passed: true, total: 10, failed: 0, output: '' },
    )
    expect_true(reading.gap <= 0.3, `gap=${reading.gap}`)
  })

  await test('approve + tests fail → 报警', () => {
    const reading = detectGoodhart(
      { verdict: 'approve', issues: [], summary: '' },
      { passed: false, total: 10, failed: 5, output: '' },
    )
    expect_true(reading.gap > 0.3, `gap=${reading.gap}`)
  })
}

// ── verifiedApply 集成测试 ──
async function testApply() {
  const { verifiedApply } = await import('../src/main/verify/verifiedApply')
  const tmp = tmpdir()
  const baseDir = mkdtempSync(join(tmp, 'snap-'))
  const copyDir = mkdtempSync(join(tmp, 'copy-'))
  const mainDir = mkdtempSync(join(tmp, 'main-'))

  // setup
  writeFileSync(join(baseDir, 'index.ts'), 'console.log("hello")')
  writeFileSync(join(baseDir, 'utils.ts'), 'export const x = 1')
  writeFileSync(join(copyDir, 'index.ts'), 'console.log("hello world v2")')
  writeFileSync(join(copyDir, 'utils.ts'), 'export const x = 1')
  writeFileSync(join(copyDir, 'new-file.ts'), 'export const added = true')
  writeFileSync(join(mainDir, 'index.ts'), 'console.log("hello")')
  writeFileSync(join(mainDir, 'utils.ts'), 'export const x = 1')

  await test('verifiedApply: 正常变更 apply 成功', () => {
    const result = verifiedApply({
      base: baseDir, copy: copyDir, destDir: mainDir,
    })
    expect_true(result.verification.accepted, 'accepted')
    expect_true(result.applied.length > 0, 'files applied')
    const content = readFileSync(join(mainDir, 'index.ts'), 'utf-8')
    expect_true(content.includes('hello world v2'), 'content updated')
  })

  await test('verifiedApply: 测试失败 → 拒绝', () => {
    // 创建一个会导致测试失败的 copy
    const failCopy = mkdtempSync(join(tmp, 'fail-'))
    writeFileSync(join(failCopy, 'index.ts'), 'console.log("broken")')
    writeFileSync(join(failCopy, 'broken.test.ts'), 'throw new Error("test")')

    const result = verifiedApply({
      base: baseDir, copy: failCopy, destDir: mainDir,
      testCommand: 'node -e "process.exit(1)"',  // 总是失败
    })
    expect_true(!result.verification.accepted, 'should be rejected')
  })

  // cleanup
  cleanup.push(() => {
    try { rmSync(baseDir, { recursive: true, force: true }) } catch {}
    try { rmSync(copyDir, { recursive: true, force: true }) } catch {}
    try { rmSync(mainDir, { recursive: true, force: true }) } catch {}
  })
  for (const fn of cleanup) fn()
}

// ── 主入口 ──
async function runAll() {
  console.log('=== 三耦合环验证管线测试 ===\n')
  const start = Date.now()
  await testGoodhart()
  await testDetect()
  await testApply()
  const elapsed = Date.now() - start
  console.log(`\n${'='.repeat(50)}`)
  console.log(`通过: ${PASS.length} | 失败: ${FAIL.length} | 耗时: ${elapsed}ms`)
  if (FAIL.length > 0) {
    console.log('\n失败的测试:')
    for (const f of FAIL) console.log(`  ✗ ${f}`)
    process.exit(1)
  }
}

runAll().catch(e => { console.error(e); process.exit(1) })
