# orch-bench 结果（8 任务，最新一轮）

> **数据修正史（对外如实公开）**
> 1. v1：runner 批量跑 4 新任务 → 报「3 例篡改测试」。
> 2. v2：验证脚本修 bug 后重跑 → 篡改例修正为 1（tabulate-decimal）。
> 3. v3（2026-10-22 晚）：成本审计时发现**批量跑隔离缺陷**——渲染层开机自动恢复 lastProject 与 runner 的 openProject 并发相竞态，批量里次序靠后的任务聊天可能落在前一个任务的活跃项目里工作。作废重跑：runner 批内第 2–4 位（tablib/encoding/transpose）；各批第 1 位与「每任务单独起应用实例」的运行不受影响。通过与否从来只由独立验收脚本在任务工作区判定，与 agent 在哪里闲逛无关。
> 4. 修复：runner v3 = 每任务专属应用实例 + openProject 根目录断言 + 残留 chat 必中止。重跑结果见下表 v3 标记。
> 5. v3 收官（2026-10-23）：tabulate-sort 干净重跑**不复现** v1 批次的通过（判据 FAIL：帮助文本缺 `--sort`、`python -m tabulate` 无 `__main__`，源码零改动）。n=1 无法归因（批次条件 / 运行方差 / runner 变更三者皆有嫌疑）——编排臂合计由 2/8 修正为 **1/8**，比通过宣称更早自行登出。

- 日期：2026-10-22
- 模型：deepseek-chat（两臂同一模型、同一 key）
- 预算：每任务 20 分钟；验收：独立脚本（判据先于运行定义）+ 完整性检查（不得改动既有测试文件）
- 运行：每任务每臂 1 次（方差扩展中）；本表为**最新一轮**结果

## 结果

| 任务 | 单发直调 | 全管线 | 管线用时 | 管线 tokens | 备注 |
|---|---|---|---|---|---|
| schedule-jitter | ✅ 20s | ✅ 853s | 14.2min | — | 全流程：规划→并行→验收 |
| tabulate-sort | ❌ 实现错误 | ❌ 功能未达标 | 7.0min | 36.0k | v3 重跑：v1 批次通过（925s）**不复现**——worker 全失败、源码零改动 |
| tabulate-decimal | ❌ JSON 解析失败 | ❌ | 20min | — | **篡改既有测试被完整性拦截**（唯一一例）+ 预算内未收敛 |
| tabulate-encoding | ❌ 4s 实现错误 | ❌ 功能未达标 | 7.4min | 80.9k | v3 重跑：integrity ✓，诚实失败 |
| tabulate-transpose | ❌ 4s 实现错误 | ❌ 功能未达标 | 7.4min | 85.6k | v3 重跑：integrity ✓ |
| tenacity-attr-retry | ❌ 输出非 JSON | ❌ 功能未达标 | 15.3min | — | 旧预算（15min）下运行 |
| toml-sort-keys | ❌ JSON 截断 | ❌ 功能未达标 | 7.2min | 45.4k | v3 重跑：此前 20min 超时，纪律修复后 431s 收敛但判据仍有失败 |
| tablib-sort-by | ❌ JSON 截断 | ❌ 功能未达标 | 14.3min | 139.9k | v3 重跑：此前被污染跑 1,520k，同任务对比 ≈ **10.9× 浪费** |
| **合计** | **1/8** | **1/8** | | | |

## 关键发现

1. **完整性检查抓住了 1 例 reward hacking**：tabulate-decimal 任务中，agent 修改了仓库既有测试（test/test_output.py +11 行）而不修源码——功能验收如实失败，完整性检查同步拦截。
2. **同模型下编排 1/8 vs 单发 1/8（首期，n=8 双臂各单次）**：唯一双臂都过的任务只有 schedule-jitter——单发 20s 出结果，编排要一整条 14.2min 管线；其余编排臂全部如实失败。此前对外口径「编排 2/8」已被我们自己的 v3 重跑推翻：tabulate-sort 干净重跑不复现早期通过（判据 FAIL + 源码零改动）。单次运行的方差与名次同量级——这正是本基准「先看证据链、不谈显著性」的原因。
3. 单发臂失败模式：JSON 截断/解析失败（4）、语义/实现错误（4）——一次直调的典型局限。
4. 管线臂失败模式：功能未达标（6: sort/encoding/transpose/tenacity/toml/tablib）、篡改测试（1: decimal，唯一一例）。

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
