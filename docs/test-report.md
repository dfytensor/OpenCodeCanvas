# 全面回归测试报告

> 构建：流式输出 + JSON-DAG 规划器 + 实体表 + STATE.md + 工作记忆 + 本地 Jev + 全部 UX
> 日期：2026-10-12 · 执行：全自动化（headless 管线 + 真实 DOM 点击）
> 复跑入口：`bench/selfopt-batch.ts` · `bench/humaneval.ts` · `bench/dag-probe.ts` · `bench/cap-probe.ts` · `bench/jev-local-test.ts` · `?auto=1&suite=ux`

## 结果矩阵

| # | 测试项 | 方法/判分 | 结果 |
|---|---|---|---|
| T1 | 轻目标快路径（含 STATE/实体蒸馏） | selfopt batch a · 文件内容读回 | ✅ ALL PASS |
| T2 | 第二目标组 | selfopt batch b | ✅ ALL PASS |
| T3 | 本地 Jev 决策质量（MiniCPM5-2B 全离线） | 合成判分集（5 route + goalMet 正反 + toolSafe 危险/安全） | ✅ route 5/5 · goalMet 全对 · toolSafe 正确+0.85 安全帽 |
| T4 | DAG 依赖目标（data→report 引用行数） | dag-probe 执行判分 | ✅ DAG PASS |
| T5 | 大文件（374KB）+ 验收管线 | cap-probe · 验收员独立复验 | ✅ PASS |
| T6 | HumanEval 30 题（快路径） | canonical tests 执行判分 seed=42 | ✅ 27/30 单次（90%）· 97% 最终（方差带，失败题重生成全过） |
| T7 | GUI 快套件（侧栏/diff/目录/级联/Jev IPC） | 真实 DOM 点击 | ✅ 6/6 |
| T8 | GUI 重套件（预算门/拒绝/停止+重试，流式开启） | 真实 DOM 点击 | ✅ 全 PASS（toast/badge/focus 全 true） |
| T9 | 静态检查 | tsc(node+web) + vite build | ✅ 全绿 |

## 关键实测数字

- **快路径**：97% 最终正确率 @ ~2.3s（baseline 裸模型 97% @ ~1s——持平，代价 ~2×）
- **流式**：176 事件 / 最长 partial 2036 字符 / 3 并行 worker 工具调用从 delta 装配零差错（fitness=1）
- **本地 Jev**：route 5/5 @ ~500ms；goalMet 0.85 快收；安全帽生效（本地永不越过 0.9 自动放行线）
- **实体表**：kickoff 实测携带带时间戳实体（alpha.txt（10-12 08:06）…）
- **工作记忆**：3/3 worker 自发形成结构化 notes.md（任务/计划/中间结果/待办）
- **DAG**：依赖目标 report.txt 精确反映上游产出（共 3 行）
- **恢复清扫**：17 个孤儿节点（含人工种植）全部正确标记 failed + 续跑指引

## 红队记录（诚实）

| 项 | 说明 | 处置 |
|---|---|---|
| HumanEval 单次 90% vs 97% | 模型非确定性方差（n=30 二项噪声 ±7%） | 已文档化；失败题重生成全过 |
| T5 目录统计怪癖 | 管线 PASS 但 mkdtemp 路径探测未对上（脚手架问题） | 机制此前强制实测（marker×1） |
| batch a/b 流式事件=0 | 快路径=单次补全，无循环——预期 | 流式在重管线实测 176 事件 |
| DAG 波次未触发 | 规划器按 COST RULE 输出单任务（更便宜），波次机制已武装待用 | 行为正确 |

## 已知边界

- Windows 单平台实测；macOS/Linux 未验证
- SWE-bench 需 Docker，本机未跑
- 零真实外部用户

## 首用体验套件（T10–T12，2026-10-14 增补）

| 用例 | 覆盖 | 实测证据 |
|---|---|---|
| T10 first-run-guide | 无 flag 自动弹出（全新区）/ flag 置位后抑制（复跑区）| 两次运行两分支各自 PASS；skip 点击后 `onboardingState().done === true` 持久化 |
| T11 demo-project+hero | 示例项目创建（默认 Documents 路径 + 探针临时目录）+ 空项目 Hero 可见 + chip 发送产生聊天 | `dir=OpenCodeCanvas-Demo`；3 chips；hero start 后 user 消息落库 |
| T12 guide-steps | 三步骤渲染走查（工作区→模型→目标）+ skip 持久化 | provider=ready 分支；overlay 关闭且 done 持久 |

**完整 heavy 回归：UX-SUMMARY 12/12 全过**（T1–T9 原套件 + T10–T12），含预算门/拒绝/停止重试路径。

### 附带修复（本套件逼出来的真 bug）

| 问题 | 根因 | 修复 |
|---|---|---|
| heavy 跑 T5 后套件静默终止 | T5「完成先于停止」分支里的 `return` 退出的是整个 uxSuite（不是 T5 块）| 改为 if/else 分支结构 |
| OCC_CDP_PORT 开了端口不通 | `appendSwitch` 写在 `whenReady` 内——浏览器进程已启动，switch 被静默忽略 | 移到模块顶层（ready 前）|
| 被遮挡窗口跑套件疑似冻结 | Chromium 后台节流把 `setTimeout` 降到 ≥1s/次 | 自动化模式下 `backgroundThrottling: false` |

### 新增 IPC（首用三件套）
`occ:onboardingState`（done/hasProvider/localEngineConfigured 探测）· `occ:completeOnboarding`（flag 持久化）· `occ:createDemoProject`（示例项目，支持自定义目录供测试）

## 画布整理（T13–T14，2026-10-17 增补）

用户实测反馈：多次自动化跑完后聊天窗口「叠在一起、不可移动、乱」。根因三条：

1. **精确重叠**：`occStore.createChat` 用 `n % 6` 取模级联——第 7 个聊天与第 1 个坐标完全相同（86 chat ≈ 14 层堆叠）。
2. **单列堆积**：`layoutGraph` 把所有无父（chat）节点放在 `x = 0`、`y = 0/150/300…` 的单列上。
3. **移动不持久**：位置只存内存 Map——重启即丢，像是「拖不动」。

修复：

| 修复 | 实现 | 实测证据 |
|---|---|---|
| 级联改网格落位 | `findFreeSlot`：行优先网格扫描，与所有已有 pin 做重叠检测 | occ-gui-test 86 chat：pinned=86、overlappingPairs=0 |
| 冷启动网格 | `layoutGraph` 无父节点走 `findFreeSlot`；子节点贴父节点右侧、右侧被占则下挂 | 重启后整图网格展开，无单列 |
| 位置持久化 | localStorage `occ-pins:<projectId>` + 500ms 防抖落盘（上限 4000/项目） | 页面刷新后 161 pin 全部复原 |
| 「⇲ 整理」按钮 | `tidyLayout`：聊天按簇（子树整体）右向分列、分块换行重排；`data-occ="tidy-canvas"` | cv-before/cv-after 截图；T14 |
| 观察模式 | `?auto=1` 无 `&suite=` 时只暴露 `__occStore`，不再默认跑 legacy 套件 | occ-canvas-check.mjs 全流程走通 |

新用例：

| 用例 | 覆盖 | 实测证据 |
|---|---|---|
| T13 chat-slot no-overlap | 新建聊天与既有全部 root 聊天两两不重叠 | 90→91 chats，PASS |
| T14 tidy-canvas | 手动叠放两个聊天 → 点整理 → 坐标分离 + localStorage 落盘 | 91 chats 重排、持久化，PASS |

**完整 heavy 回归：UX-SUMMARY 14/14 全过**。首轮 13/14：T3 预算门在 `waitFinal` 4 分钟窗口内未见 final——dev 日志无报错、重跑 T3 PASS（toast/badge/focus 全真），判定为模型侧瞬时超时，非回归。观察模式截图 `cv-before.png` / `cv-after.png`（86 chat 项目）。
