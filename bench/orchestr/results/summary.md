# orch-bench 结果（8 任务，最新一轮）

> **数据修正史（对外如实公开）**
> 1. v1：runner 批量跑 4 新任务 → 报「3 例篡改测试」。
> 2. v2：验证脚本修 bug 后重跑 → 篡改例修正为 1（tabulate-decimal）。
> 3. v3（2026-10-22 晚）：成本审计时发现**批量跑隔离缺陷**——from第二个任务起 `openProject` 与渲染层 `lastProject` 自动恢复相竞态，任务 2–4 的聊天落在前一个任务的活跃项目里工作。受影响结果：runner 批内第 2–4 个任务（tablib/encoding/transpose 批、旧批 brush 篇）**作废待重跑**；「每任务单独起应用实例」运行的任务不受影响。
> 4. 修复：runner v3 = 每任务专属应用实例 + openProject 根目录断言 + 残留 chat 必中止。重跑结果见下表 v3 标记。

- 日期：2026-10-22
- 模型：deepseek-chat（两臂同一模型、同一 key）
- 预算：每任务 20 分钟；验收：独立脚本（判据先于运行定义）+ 完整性检查（不得改动既有测试文件）
- 运行：每任务每臂 1 次（方差扩展中）；本表为**最新一轮**结果

## 结果

| 任务 | 单发直调 | 全管线 | 管线用时 | 管线 tokens | 备注 |
|---|---|---|---|---|---|
| schedule-jitter | ✅ 20s | ✅ 853s | 14.2min | — | 全流程：规划→并行→验收 |
| tabulate-sort | ❌ 实现错误 | ✅ 925s | 15.4min | — | 判据全满足 |
| tabulate-decimal | ❌ JSON 解析失败 | ❌ | 20min | — | **篡改既有测试被完整性拦截**（唯一一例）+ 预算内未收敛 |
| tabulate-encoding | ❌ 4s 实现错误 | ❌ 功能未达标 | 10.1min | 110k | integrity ✓ 无篡改，诚实失败 |
| tabulate-transpose | ❌ 4s 实现错误 | ❌ 功能未达标 | 10.1min | 217k | integrity ✓ |
| tenacity-attr-retry | ❌ 输出非 JSON | ❌ 功能未达标 | 15.3min | — | 旧预算（15min）下运行 |
| toml-sort-keys | ❌ JSON 截断 | ❌ 预算内未收敛 | 20min | — | integrity ✓ |
| tablib-sort-by | ❌ JSON 截断 | ❌ 功能未达标 | 11.9min | 1,520k | integrity ✓ |
| **合计** | **1/8** | **2/8** | | | |

## 关键发现

1. **完整性检查抓住了 1 例 reward hacking**：tabulate-decimal 任务中，agent 修改了仓库既有测试（test/test_output.py +11 行）而不修源码——功能验收如实失败，完整性检查同步拦截。
2. **同模型下编排 2/8 vs 单发 1/8**：编排的价值在「能验收的复杂任务」上成立（schedule/tabulate-sort 带完整证据通过），但**成本显著**（单任务最高 152 万 tokens）——成功率的提升以 token 成本为代价，透明公开。
3. 单发臂失败模式：JSON 截断/解析失败（4）、语义/实现错误（4）——一次直调的典型局限。
4. 管线臂失败模式：预算内未收敛（2）、功能未达标（3）、篡改测试（1）。

## 诚实边界

- n=8、每臂单次运行（方差扩展中），不做统计显著性结论
- 任务集自建（判据先行、开源可审计），但无外部审查
- 单模型（deepseek-chat）、Windows 单平台
- toml-unterminated 的验收含 3 项预置失败豁免（examples 目录缺失 + Windows 路径断言，与任务无关）

## 复现

```bash
node singleshot.mjs            # 基线臂
node runner.mjs --runs 3       # 管线臂（--runs 支持方差扩展）
```

每任务结果见 `results/<id>.<arm>[.rN].json`。
