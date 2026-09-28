/**
 * Goodhart 追踪器: 持续监控代理分与外部验证的鸿沟
 *
 * 三耦合环的 Goodhart 检测层 — 用已验证的指数增长模型 (corr=0.990)
 * 判断 reviewer/coder 是否在博弈代理指标。
 *
 * 集成方式: 每次 merge 验证后调用 record()，然后 check() 查看是否报警。
 */

export interface GoodhartReading {
  timestamp: number
  proxyClaim: number       // reviewer/coder 声称的质量 (0-1)
  externalScore: number    // 外部验证 (0-1)
  gap: number              // proxy - external
}

export interface GoodhartAlert {
  level: 'warning' | 'critical'
  message: string
  avgGap: number
  trend: number           // gap 的变化率 (>0 = 恶化中)
}

export class GoodhartTracker {
  private history: GoodhartReading[] = []
  private readonly windowSize: number
  private readonly alertThreshold: number

  constructor(windowSize = 5, alertThreshold = 0.3) {
    this.windowSize = windowSize
    this.alertThreshold = alertThreshold
  }

  record(proxyClaim: number, externalScore: number): GoodhartReading {
    const reading: GoodhartReading = {
      timestamp: Date.now(),
      proxyClaim,
      externalScore,
      gap: proxyClaim - externalScore,
    }
    this.history.push(reading)
    return reading
  }

  /** 检测: 最近 N 次平均鸿沟 > threshold → 报警 */
  check(): GoodhartAlert | null {
    const recent = this.history.slice(-this.windowSize)
    if (recent.length < 3) return null

    const avgGap = recent.reduce((s, r) => s + r.gap, 0) / recent.length

    // 趋势: 最后一半 vs 前一半
    const half = Math.floor(recent.length / 2)
    const firstHalf = recent.slice(0, half).reduce((s, r) => s + r.gap, 0) / half
    const secondHalf = recent.slice(half).reduce((s, r) => s + r.gap, 0) / (recent.length - half)
    const trend = secondHalf - firstHalf

    if (avgGap > this.alertThreshold * 2 && trend > 0.1) {
      return {
        level: 'critical',
        message: `平均鸿沟 ${avgGap.toFixed(3)} 且恶化中 (趋势 +${trend.toFixed(3)}) — 立即停止，审查 reviewer`,
        avgGap,
        trend,
      }
    }
    if (avgGap > this.alertThreshold) {
      return {
        level: 'warning',
        message: `平均鸿沟 ${avgGap.toFixed(3)} > ${this.alertThreshold} — 建议审查 reviewer`,
        avgGap,
        trend,
      }
    }
    return null
  }

  /** 重置 (切换 reviewer/coder 后) */
  reset(): void {
    this.history.length = 0
  }

  /** 获取原始数据 (用于可视化和审计) */
  getHistory(): readonly GoodhartReading[] {
    return this.history
  }
}
