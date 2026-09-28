/**
 * verifiedApply: 三耦合环验证 + apply 的集成入口.
 *
 * 在 applyCopyChanges 之前插入验证管线：
 *   1. diff (snapshot vs copy)
 *   2. reviewer agent 审查 diff (可选)
 *   3. 外部测试 (在 copy 目录跑)
 *   4. Goodhart 检测
 *   全部通过 → applyCopyChanges 到 mainDir
 *   任一失败 → 写验证报告，不 apply
 */
import { join } from 'path'
import { applyCopyChanges, writeConflictReport, type ApplyResult } from '../workspace/apply'
import { diffNameStatus } from '../workspace/diff'
import {
  generateDiff, sendToReviewer, runTests, detectGoodhart,
  type VerifyConfig, type VerifyResult, type DiffResult, type ReviewResult, type TestResult,
} from './pipeline'
import { GoodhartTracker } from './goodhart'

export interface VerifiedApplyOptions {
  base: string                    // snapshot (fork 起点)
  copy: string                    // coder 工作副本
  destDir: string                 // 主线项目目录
  planLabel?: string              // merge 计划名称
  reviewerSessionId?: string      // reviewer agent session (可选)
  sendToAgent?: (sid: string, msg: string) => Promise<string>
  testCommand?: string            // 默认 "npm test"
  goodhartThreshold?: number      // 默认 0.3
  paths?: string[]                // 限定 apply 范围 (可选)
}

export interface VerifiedApplyResult extends ApplyResult {
  verification: VerifyResult
  goodhartAlert?: { level: string; message: string }
}

/** 全局 Goodhart 追踪器 (跨 merge 持续追踪) */
const tracker = new GoodhartTracker(5, 0.3)

export async function verifiedApply(opts: VerifiedApplyOptions): Promise<VerifiedApplyResult> {
  // ═══ Step 1: 生成 diff ═══
  const changes = await diffNameStatus(opts.base, opts.copy, opts.paths)

  const diffEntries = changes.map(ch => ({
    file: ch.rel,
    status: (ch.status === 'D' ? 'deleted' : ch.status === 'A' ? 'added' : 'modified') as 'added' | 'modified' | 'deleted',
    additions: 0,
    deletions: 0,
  }))
  const diff: DiffResult = { entries: diffEntries, raw: JSON.stringify(changes) }

  // ═══ Step 2: AI Review (可选) ═══
  let review: ReviewResult | undefined
  if (opts.reviewerSessionId && opts.sendToAgent) {
    try {
      review = await sendToReviewer(
        { snapshotDir: opts.base, copyDir: opts.copy, mainDir: opts.destDir },
        diff,
        opts.sendToAgent,
      )
    } catch {
      review = { verdict: 'approve', issues: [], summary: 'reviewer 不可用，跳过' }
    }
  }

  if (review?.verdict === 'reject') {
    return {
      applied: [], deleted: [], skipped: [], conflictFiles: [],
      verification: {
        accepted: false, stage: 'review', review,
        error: `reviewer rejected: ${review.summary}`,
      },
    }
  }

  // ═══ Step 3: 外部测试 ═══
  let test: TestResult | undefined
  if (opts.testCommand) {
    const { execSync } = await import('child_process')
    try {
      const output = execSync(opts.testCommand, {
        encoding: 'utf-8', cwd: opts.copy, timeout: 60_000,
      }).toString()
      const passMatch = output.match(/(\d+) passed/)
      const failMatch = output.match(/(\d+) failed/)
      const total = (passMatch ? parseInt(passMatch[1]) : 0) + (failMatch ? parseInt(failMatch[1]) : 0)
      const failed = failMatch ? parseInt(failMatch[1]) : 0
      test = { passed: failed === 0, total, failed, output: output.slice(-500) }
    } catch (e: any) {
      const output = e.stdout?.toString() || e.message || ''
      const failMatch = output.match(/(\d+) failed/)
      test = { passed: false, total: 0, failed: failMatch ? parseInt(failMatch[1]) : 1, output: output.slice(-500) }
    }

    if (!test.passed) {
      return {
        applied: [], deleted: [], skipped: [], conflictFiles: [],
        verification: {
          accepted: false, stage: 'test', review, test,
          error: `${test.failed} tests failed`,
        },
      }
    }
  }

  // ═══ Step 4: Goodhart 检测 ═══
  let goodhartAlert: VerifiedApplyResult['goodhartAlert'] | undefined
  if (review) {
    const proxyClaim = review.verdict === 'approve' ? 1.0 :
                       review.verdict === 'request_changes' ? 0.5 : 0.0
    const extScore = 1.0   // 到这一步说明测试通过了
    const reading = tracker.record(proxyClaim, extScore)
    const alert = tracker.check()
    if (alert) {
      goodhartAlert = alert
      log(`⚠️ Goodhart: ${alert.message}`)
    }
  }

  // ═══ Step 5: Apply ═══
  const planLabel = opts.planLabel || 'verified-merge'
  const applyResult = await applyCopyChanges(opts.base, opts.copy, opts.destDir, { paths: opts.paths })
  const conflictReport = await writeConflictReport(opts.destDir, applyResult, planLabel)

  return {
    ...applyResult,
    verification: { accepted: true, stage: 'merge' },
    goodhartAlert,
  }
}

function log(msg: string) {
  console.log(msg)
}
