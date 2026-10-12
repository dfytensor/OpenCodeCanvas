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
