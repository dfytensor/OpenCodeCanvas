# 上下文治理方案（Context Governance）

> 状态：已落地。本文是该子系统的一致性参照；改代码前先读这里。

## 一、原则

1. **世界状态落盘，对话只持引用。** 一切产出（代码/报告/验收结论）写入文件或 `.occ/` 记录；上下文里只出现路径 + 摘要。
2. **指针进上下文，全文按需取。** 工具是引用的解引用机制——agent 需要全文时自己读，读完即弃。
3. **工具结果当轮内联，跨轮必落盘。** 刚编辑的文件当步复查可内联；跨轮后只剩一行摘要。
4. **思考过程不跨轮；结论压缩跨轮。** verdict/fitness/失败原因一行一条进入 routing/decisions，作为下一轮的经验输入。
5. **三段式上下文结构**（缓存友好）：`[稳定前缀: system + CONTEXT.md] + [当前轮载荷] + [引用指针]`。避免把易变历史塞进前缀，打崩 KV 缓存。

## 二、执行规则（组件级）

| 组件 | 规则 | 实现 |
|---|---|---|
| worker 循环内 | 工具结果 ≤8k 字符，超限截断并明示；整体超阈值后压实旧步骤为「已压实」短引用 | `loop.ts compactHistory()` |
| worker 工作记忆 | 计划/中间结果/待办写 notes.md；压实发生时自动重注入（压实免疫） | `scratchpadPath` |
| 项目工作状态 | .occ/STATE.md：每次管线结束自动蒸馏一条（目标/结果/产物），滚动保留最新；下一目标 kickoff 注入 | `updateProjectState` / `projectStateHint` |
| worker↔worker | 不传过程，只传 BLACKBOARD 一行发现 + BRIEF 摘要 | `composer.ts digest-merge` |
| 轮间 | 不重放对话；新轮继承 base 快照 + routing.jsonl 一行经验 | `saveFrontier` / `historyHint` |
| 全 agent | 项目约定经 .occ/CONTEXT.md 注入（截断 2k） | `projectContextHint` |
| 验收 | 只看结论 + 独立复验，不信 worker 自述 | `EVALUATOR_FORMAT` |
| 快路径 | 单次生成 + 语法门 + 产物闭环；失败升级完整管线 | `tryFastPath` |
| 经验 | routing.jsonl 一行/次（形状/成败/tokens/是否快路径） | `recordRouting` |

## 三、参数

- 工具结果创建时上限：`TOOL_RESULT_CAP = 8000` 字符（截断带明示，agent 可用更窄范围重读）
- 循环内压实触发：转写总量 > `COMPACT_THRESHOLD_CHARS = 60000` 字符（约 20k tokens）
- 压实保留：system + 首 user + 最近 `KEEP_RECENT = 8` 条完整；更早的 tool 结果替换为 `[已压实] 首行240字符…（原文在 agent.jsonl）`
- 压实保结构：assistant(tool_calls)+tool 成对保留，仅缩短内容（API 合法性）

## 四、明确不做的事

- 不把 chat.jsonl / 上一个 goal 的对话喂给下一个 goal（多轮=激活前沿，不是对话回放）
- 不把兄弟 worker 的过程转写交给彼此（只交 BLACKBOARD 发现行）
- 不在上下文里内联整仓库（CONTEXT.md ≤2k + 工具按需）
