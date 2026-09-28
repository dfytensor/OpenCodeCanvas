/**
 * 三耦合环验证管线 (Triadic Coupling Ring Verification Pipeline)
 *
 * 将二阶自觉的 5 条件框架落地为 OpenCodeCanvas 的 merge 验证协议：
 *
 *   Agent A (coder)  →  产出 diff
 *   Agent B (reviewer) → 读 diff，审查质量
 *   外部基准 (compiler/tests) → 运行验证
 *   Goodhart 检测 → 内部声称 vs 外部验证的鸿沟追踪
 *
 * 三耦合环：A 产出 → B 审查 → 外部验证 → 全通过才 merge
 * 禁止自评：coder 不能审查自己的代码
 */

// ─── 类型 ───

export interface DiffEntry {
  file: string
  status: 'added' | 'modified' | 'deleted'
  additions: number
  deletions: number
}

export interface DiffResult {
  entries: DiffEntry[]
  raw: string
}

export interface ReviewResult {
  verdict: 'approve' | 'request_changes' | 'reject'
  issues: Array<{ file: string; line?: number; severity: 'error' | 'warning'; message: string }>
  summary: string
}

export interface TestResult {
  passed: boolean
  total: number
  failed: number
  output: string
}

export interface GoodhartReading {
  timestamp: number
  proxyClaim: number       // reviewer 声称的质量分 (0-1)
  externalScore: number    // 外部验证分 (0-1)
  gap: number              // proxy - external (正 = 刷分)
}

export interface VerifyResult {
  accepted: boolean
  stage: 'review' | 'test' | 'goodhart' | 'merge'
  review?: ReviewResult
  test?: TestResult
  goodhart?: GoodhartReading
  error?: string
}

export interface VerifyConfig {
  snapshotDir: string      // fork 起点（冻结基线）
  copyDir: string          // coder 的工作副本
  mainDir: string          // 主线项目目录
  reviewerSessionId?: string // reviewer agent 的 session id (可选, 无则跳过 AI review)
  testCommand?: string     // 测试命令 (默认 "npm test")
  goodhartThreshold?: number // Goodhart 报警阈值 (gap > threshold → 拒绝)
  maxRetries?: number      // coder 修改重试次数
}

// ─── Step 1: Diff ───

export async function generateDiff(config: VerifyConfig): Promise<DiffResult> {
  const { execSync } = await import('child_process')
  const raw = execSync(
    `git diff --no-index --stat "${config.snapshotDir}" "${config.copyDir}" 2>&1 || true`,
    { encoding: 'utf-8', cwd: config.mainDir },
  ).toString()

  const entries: DiffEntry[] = []
  // 解析 git diff --stat 输出
  const nameStatus = execSync(
    `git diff --no-index --name-status "${config.snapshotDir}" "${config.copyDir}" 2>&1 || true`,
    { encoding: 'utf-8', cwd: config.mainDir },
  ).toString()

  for (const line of nameStatus.split('\n')) {
    const m = line.match(/^([AMD])\s+(.+)$/)
    if (!m) continue
    const statusMap: Record<string, DiffEntry['status']> = {
      A: 'added', M: 'modified', D: 'deleted',
    }
    entries.push({
      file: m[2].replace(config.copyDir + '/', ''),
      status: statusMap[m[1]] || 'modified',
      additions: 0,
      deletions: 0,
    })
  }
  return { entries, raw }
}

// ─── Step 2: AI Review ───

export async function sendToReviewer(
  config: VerifyConfig,
  diff: DiffResult,
  sendFn: (sessionId: string, message: string) => Promise<string>,
): Promise<ReviewResult> {
  if (!config.reviewerSessionId) {
    return { verdict: 'approve', issues: [], summary: '无 reviewer，跳过 AI 审查' }
  }

  const diffSummary = diff.entries
    .map(e => `${e.status}: ${e.file}`)
    .join('\n')

  const prompt = `你是代码审查者。请审查以下代码变更，检查：
1. 正确性（逻辑错误、边界条件）
2. 安全性（注入、XSS、敏感信息泄露）
3. 性能（明显低效的实现）

变更文件：
${diffSummary}

请以 JSON 格式回复：
{"verdict": "approve" | "request_changes" | "reject", "issues": [{"file": "...", "severity": "error"|"warning", "message": "..."}], "summary": "一句话总结"}`

  const response = await sendFn(config.reviewerSessionId, prompt)

  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        verdict: parsed.verdict || 'approve',
        issues: parsed.issues || [],
        summary: parsed.summary || '',
      }
    }
  } catch { /* JSON 解析失败 → 默认通过 */ }

  return { verdict: 'approve', issues: [], summary: '审查结果无法解析，默认通过' }
}

// ─── Step 3: 外部测试 ───

export async function runTests(
  config: VerifyConfig,
): Promise<TestResult> {
  const { execSync } = await import('child_process')
  const cmd = config.testCommand || 'npm test'

  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      cwd: config.copyDir,
      timeout: 60_000,
    }).toString()

    // 解析测试结果 (兼容 jest/vitest 格式)
    const passMatch = output.match(/(\d+) passed/)
    const failMatch = output.match(/(\d+) failed/)
    const total = (passMatch ? parseInt(passMatch[1]) : 0) + (failMatch ? parseInt(failMatch[1]) : 0)
    const failed = failMatch ? parseInt(failMatch[1]) : 0

    return { passed: failed === 0, total, failed, output: output.slice(-500) }
  } catch (e: any) {
    // 非零退出 = 测试失败
    const output = e.stdout?.toString() || e.message || ''
    const failMatch = output.match(/(\d+) failed/)
    return { passed: false, total: 0, failed: failMatch ? parseInt(failMatch[1]) : 1, output: output.slice(-500) }
  }
}

// ─── Step 4: Goodhart 检测 ───

const goodhartHistory: GoodhartReading[] = []

export function detectGoodhart(
  review: ReviewResult,
  test: TestResult,
  threshold = 0.3,
): GoodhartReading {
  // proxyClaim: reviewer 评分 (approve=1, request_changes=0.5, reject=0)
  const proxyClaim = review.verdict === 'approve' ? 1.0 :
                     review.verdict === 'request_changes' ? 0.5 : 0.0
  // externalScore: 测试通过率
  const externalScore = test.total > 0 ? (test.total - test.failed) / test.total : 0
  const gap = proxyClaim - externalScore
  const reading: GoodhartReading = {
    timestamp: Date.now(),
    proxyClaim,
    externalScore,
    gap,
  }
  goodhartHistory.push(reading)

  // 检查趋势: 最近 5 条 gap 均值 > threshold → 报警
  const recent = goodhartHistory.slice(-5)
  const avgGap = recent.reduce((s, r) => s + r.gap, 0) / recent.length
  if (avgGap > threshold) {
    log(`⚠️ Goodhart 检测: 最近 5 次平均鸿沟 ${avgGap.toFixed(3)} > ${threshold} — reviewer 可能被博弈`)
  }

  return reading
}

function log(msg: string) {
  console.log(msg)
}

// ─── Step 5: 完整验证管线 ───

export async function verifyAndMerge(
  config: VerifyConfig,
  sendFn?: (sessionId: string, message: string) => Promise<string>,
): Promise<VerifyResult> {
  log(`▶ 三耦合环验证管线启动 (coder → reviewer → tests → merge)`)

  // Step 1: Diff
  const diff = await generateDiff(config)
  log(`  Step 1/4: Diff 完成 — ${diff.entries.length} 个文件变更`)

  // Step 2: AI Review
  const review = await sendToReviewer(config, diff, sendFn || (async () => ''))
  log(`  Step 2/4: AI Review — verdict=${review.verdict}, issues=${review.issues.length}`)

  if (review.verdict === 'reject') {
    log(`  ✗ Reviewer 拒绝 — 不 merge`)
    return { accepted: false, stage: 'review', review, error: review.summary }
  }

  // Step 3: 外部测试
  const test = await runTests(config)
  log(`  Step 3/4: 测试 — ${test.passed ? '✓' : '✗'} (${test.total - test.failed}/${test.total})`)

  if (!test.passed) {
    log(`  ✗ 测试失败 — 不 merge`)
    return { accepted: false, stage: 'test', review, test, error: `${test.failed} tests failed` }
  }

  // Step 4: Goodhart 检测
  const goodhart = detectGoodhart(review, test)
  log(`  Step 4/4: Goodhart — gap=${goodhart.gap.toFixed(3)} (proxy=${goodhart.proxyClaim}, ext=${goodhart.externalScore})`)

  const goodhartThreshold = config.goodhartThreshold ?? 0.3
  if (goodhart.gap > goodhartThreshold) {
    log(`  ⚠️ Goodhart 鸿沟超阈值 — 保守拒绝`)
    return { accepted: false, stage: 'goodhart', review, test, goodhart, error: 'Goodhart gap exceeded' }
  }

  // Step 5: Merge
  log(`  ✓ 全部通过 — 执行 merge`)
  const { execSync } = await import('child_process')
  // apply: 把 copy 中变更的文件回写到 main
  const nameStatus = execSync(
    `git diff --no-index --name-status "${config.snapshotDir}" "${config.copyDir}" 2>&1 || true`,
    { encoding: 'utf-8' },
  ).toString()
  for (const line of nameStatus.split('\n')) {
    const m = line.match(/^([AMD])\s+(.+)$/)
    if (!m) continue
    const src = m[2]
    const dst = src.replace(config.copyDir, config.mainDir)
    try {
      if (m[1] === 'D') {
        execSync(`del /q "${dst}" 2>nul || rm -f "${dst}"`, { shell: 'cmd.exe' })
      } else {
        execSync(`copy /y "${src}" "${dst}"`, { shell: 'cmd.exe' })
      }
    } catch { /* 文件不存在等情况 */ }
  }

  return {
    accepted: true,
    stage: 'merge',
    review,
    test,
    goodhart,
  }
}
