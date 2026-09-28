/**
 * 三耦合环验证管线 — 独立测试 (无框架依赖)
 * 运行: npx tsx tests/verify_simple.ts
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const PASS: string[] = []
const FAIL: string[] = []

function assert_eq(actual: unknown, expected: unknown, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expect ${JSON.stringify(expected)} got ${JSON.stringify(actual)} — ${msg}`)
  }
}

function assert_true(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg || 'expected true')
}

async function runAll() {
  console.log('=== 三耦合环验证管线测试 ===\n')
  const start = Date.now()

  // ═══ GoodhartTracker ═══
  const { GoodhartTracker } = await import('../src/main/verify/goodhart')

  console.log('── GoodhartTracker ──')

  // Test 1
  try {
    const t = new GoodhartTracker(5, 0.3)
    for (let i = 0; i < 10; i++) {
      t.record(1.0, 0.95)
      t.check()
    }
    assert_true(t.check() === null, 'should not alert')
    PASS.push('GoodhartTracker: 正常不报警')
    console.log('  ✓ 正常操作不报警')
  } catch (e: any) {
    FAIL.push(`GoodhartTracker 正常: ${e.message}`)
    console.error(`  ✗ 正常操作: ${e.message}`)
  }

  // Test 2
  try {
    const t = new GoodhartTracker(5, 0.3)
    for (let i = 0; i < 6; i++) t.record(1.0, 0.5)
    const alert = t.check()
    assert_true(alert !== null, 'should alert')
    assert_eq(alert!.level, 'warning', 'level')
    PASS.push('GoodhartTracker: warning 触发')
    console.log('  ✓ warning 触发')
  } catch (e: any) {
    FAIL.push(`GoodhartTracker warning: ${e.message}`)
    console.error(`  ✗ warning: ${e.message}`)
  }

  // Test 3
  try {
    const t = new GoodhartTracker(5, 0.3)
    for (let i = 0; i < 10; i++) {
      const gap = 0.2 + i * 0.15
      t.record(1.0, 1.0 - gap)
    }
    const alert = t.check()
    assert_true(alert !== null, 'should alert with worsening trend')
    PASS.push('GoodhartTracker: critical 触发')
    console.log('  ✓ critical 触发')
  } catch (e: any) {
    FAIL.push(`GoodhartTracker critical: ${e.message}`)
    console.error(`  ✗ critical: ${e.message}`)
  }

  // Test 4
  try {
    const t = new GoodhartTracker(5, 0.3)
    for (let i = 0; i < 10; i++) t.record(1.0, 0.0)
    t.reset()
    assert_true(t.check() === null)
    assert_eq(t.getHistory().length, 0)
    PASS.push('GoodhartTracker: reset')
    console.log('  ✓ reset')
  } catch (e: any) {
    FAIL.push(`GoodhartTracker reset: ${e.message}`)
    console.error(`  ✗ reset: ${e.message}`)
  }

  // ═══ detectGoodhart ═══
  const { detectGoodhart } = await import('../src/main/verify/pipeline')

  console.log('\n── detectGoodhart ──')

  // Test 5
  try {
    const r = detectGoodhart(
      { verdict: 'approve', issues: [], summary: '' },
      { passed: true, total: 10, failed: 0, output: '' },
    )
    assert_true(r.gap <= 0.3, `gap=${r.gap}`)
    PASS.push('detectGoodhart: 正常无报警')
    console.log('  ✓ 正常无报警')
  } catch (e: any) {
    FAIL.push(`detectGoodhart 正常: ${e.message}`)
    console.error(`  ✗ 正常: ${e.message}`)
  }

  // Test 6
  try {
    const r = detectGoodhart(
      { verdict: 'approve', issues: [], summary: '' },
      { passed: false, total: 10, failed: 5, output: '' },
    )
    assert_true(r.gap > 0.3, `gap=${r.gap}`)
    PASS.push('detectGoodhart: approve+fail 触发')
    console.log('  ✓ approve+fail 触发')
  } catch (e: any) {
    FAIL.push(`detectGoodhart approve+fail: ${e.message}`)
    console.error(`  ✗ approve+fail: ${e.message}`)
  }

  // ═══ verifiedApply 集成 ═══
  const { verifiedApply } = await import('../src/main/verify/verifiedApply')

  console.log('\n── verifiedApply 集成 ──')
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

  // Test 7: 正常 apply
  try {
    const result = await verifiedApply({
      base: baseDir, copy: copyDir, destDir: mainDir,
    })
    assert_true(result.verification.accepted, 'accepted')
    assert_true(result.applied.length > 0, 'files applied')
    const content = readFileSync(join(mainDir, 'index.ts'), 'utf-8')
    assert_true(content.includes('hello world v2'), 'content updated')
    PASS.push('verifiedApply: 正常 apply')
    console.log('  ✓ 正常 apply, applied=' + result.applied.length)
  } catch (e: any) {
    FAIL.push(`verifiedApply 正常: ${e.message}`)
    console.error(`  ✗ 正常 apply: ${e.message}`)
  }

  // Test 8: 测试失败 → 拒绝
  try {
    const failCopy = mkdtempSync(join(tmp, 'fail-'))
    writeFileSync(join(failCopy, 'index.ts'), 'console.log("broken")')

    const result = await verifiedApply({
      base: baseDir, copy: failCopy, destDir: mainDir,
      testCommand: 'node -e "process.exit(1)"',
    })
    assert_true(!result.verification.accepted, 'should be rejected')
    PASS.push('verifiedApply: 测试失败拒绝')
    console.log('  ✓ 测试失败正确拒绝')
  } catch (e: any) {
    FAIL.push(`verifiedApply 拒绝: ${e.message}`)
    console.error(`  ✗ 测试失败: ${e.message}`)
  }

  // cleanup
  for (const dir of [baseDir, copyDir, mainDir]) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }

  // ═══ 汇总 ═══
  const elapsed = Date.now() - start
  console.log(`\n${'='.repeat(50)}`)
  console.log(`通过: ${PASS.length} | 失败: ${FAIL.length} | 耗时: ${elapsed}ms`)
  if (PASS.length > 0) {
    console.log('\n通过的测试:')
    for (const p of PASS) console.log(`  ✓ ${p}`)
  }
  if (FAIL.length > 0) {
    console.log('\n失败的测试:')
    for (const f of FAIL) console.log(`  ✗ ${f}`)
    process.exit(1)
  }
}

runAll().then(() => {
  console.log('\nDONE')
}).catch(e => {
  console.error('FATAL:', e)
  process.exit(1)
})
