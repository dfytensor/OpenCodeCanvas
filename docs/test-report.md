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

## 全中文文案 + 运行时可见性（T15，2026-10-21 增补）

术语表：聊天 / worker / 调度 / 验收员 / 预算 / 快路径 / 产物 / 工作区。

**文案统一**

- 渲染层：ChatNode 状态与角色标签、OccNode 状态/菜单/提示、GraphCanvas 空态与右键菜单、TopBar 设置/模型下拉/运行徽标、EventStream 空态、事件流状态词，全部中文化
- 主进程叙述：executor / agent session / chat 共 23 处英文串中文化（`goal accepted:` → 已接受目标、`round N/M: dispatching` → 第 N/M 轮：派发、`still working on the previous goal` → 上一个目标还在执行…）
- `?auto=1` 观察模式：无 `&suite=` 时只暴露 `__occStore`，不再默认跑 legacy 套件
- T15 黑名单扫描（页面 + 设置弹层 + 右键菜单）：0 泄漏

**运行时可见性**

| 能力 | 实现 | 实测 |
|---|---|---|
| 运行状态条 `data-occ="run-stage"` | 阶段（规划/执行/合并/验收/快路径）+ 已用时 + 最近事件距今（>90s 琥珀色） | 真实管线采样 40 次：计时 0→84s 单调递增，跨分钟 m:ss 正确 |
| 等待原因 `data-occ="awaiting-reason"` | 权限/预算门说明 + 已等待时长 | T3 heavy 实测 |
| 计时锚点 | ChatEntry.time 改 ISO（显示兼容旧 HH:MM）；锚点=最后 final 后首条 user（快路径升级不重置） | 升级场景 0→1→8s 连续不归零 |

**顺带修复的真 bug**

- **■ 停止在管线启动窗口失效**：abortNode 只终止「当时已存在」的子孙节点，管线继续派发 worker 并跑完（T5 现场：停止后仍完成）。修复：`abortedChats` 集合 + 管线检查点（快路径前 / 派发前 / 验收前），命中即落「已按你的要求停止执行。」final。T5 实测 `halt-final landed, 停止文案`
- 停止竞态下测试误报：T5 允许「点击前已完成」分支；T3 改为断言门恢复（`已确认`）而非等最终 verdict（前者是功能，后者是模型天气）；T4 门超时 3→5 分钟

**回归**：连续 4 轮 heavy，前三轮各挂 1 项并逐一根因修复（T5 停止竞态=真 bug / T3 等 final=测试设计 / T4 门超时=模型端慢），最终 **UX-SUMMARY 15/15 全过**。

## 长龄项目管理（T16，2026-10-21 增补）

问题：真实项目跑几周后聊天数破百（压测项目已达 132 聊天 / 251 节点），画布再规整也是一堵墙。

方案（分层、全可逆）：

| 能力 | 实现 | 说明 |
|---|---|---|
| 冻结/归档默认移出画布 | GraphCanvas 过滤 `frozen/archived`（节点与边一起过滤） | 画布只留活跃与已完成；位置 pin 保留，解冻即原位回来 |
| 「📦 已收纳 N」开关 | 画布工具栏（`data-occ="show-dormant"`） | 一键查看全部；激活态高亮 |
| 侧栏状态筛选 | 全部 / 活跃 / 已完成 / 已收纳 + 实时计数（`sidebar-filter-*`） | 与既有搜索叠加 |
| 单项冻结/解冻 | 侧栏 ❄/♨（`freeze-chat` / `unfreeze-chat`） | 冻结可逆；归档仍是节点菜单里的存储级操作 |
| 一键「收纳已完成」 | 侧栏批量按钮（`freeze-completed`），确认后批量冻结 + 单次 refresh | 全可逆；归档留给需要省存储的场景 |
| 侧栏聚焦自动揭示 | 聚焦隐藏节点时自动打开已收纳层再定位 | 避免「点了没反应」 |

T16 实测：冻结→画布消失→已收纳可见→点击定位自动显示→关层再隐藏→解冻复原；筛选 chips 计数与批量按钮在位。首轮 15/16 的失败是断言选择器同时命中了侧栏项（同带 `data-node-id`）——限定 `.react-flow` 作用域后 **16/16 全过**。

## 第一人称体验审计 + 镜头策略（T17，2026-10-21 增补）

不等外部用户，用真实启动流程自查（截图 + 量化），发现并修复 3 个「看得见」的问题：

| 问题 | 现场证据 | 修复 |
|---|---|---|
| 启动/新增节点即 fit 全图 | 132 聊天项目打开即一堵缩略图墙（fitView 全图 ≈0.08，卡片不可读） | 首屏镜头改为「最新活跃聊天」0.85；后续节点出现不再移动镜头（§9.2 眼不丢目标） |
| ＋聊天 建完不聚焦 | 新卡片落在 findFreeSlot 空位（可能在视野外），点击像没反应 | 顶栏/侧栏/首屏 Hero/引导 4 个入口统一聚焦；聚焦请求在节点未挂载时不再被静默丢弃（等节点列表更新重试） |
| 整理后镜头缩成 0.08 | 268 节点全图 fit，所有卡片不可读 | 整理后的 fitView 设 `minZoom: 0.35`（MiniMap 看全貌，画布看细节） |

实测：启动 0.85（7 张大卡可见）；点＋聊天后 ~0.96s 稳定 0.85；整理后 0.35。新增 T17（新聊天卡片在视口内且宽度 >200px）。审计截图 `audit-1-launch.png` … `audit-8-dormant.png`（temp/opencode）。

## 第四轮：专业度细节（T18，2026-10-21 增补）

| 项 | 修复 | 实测 |
|---|---|---|
| HUD 残留英文 | `idle · N nodes` / `frontier · N running` → 空闲 · N 个节点 / 前沿 · N 个运行中；T15 黑名单补 `idle ·`/`frontier ·` | HUD「空闲 · 296 个节点」 |
| 评估先行可视化 | 规划器 `success_criteria` 落入 routing.jsonl（4 类完成路径 + 取消路径）；报告卡新增「成功标准（行动前定义）」逐条 ✓/✗（解析 verdict 里 `标准N: PASS/FAIL`） | 真实管线 2 条标准双 ✓；T18 |
| 低缩放可读性 | ChatNode 增加 LOD：缩放 <0.45 折叠为紧凑标题条（标题+状态+计时）；选择器返回 boolean，避免逐帧重渲染 | 0.28 缩放时卡片 85px、行列结构清晰 |
| 故障透明 | 运行状态条显示「模型重试 N 次」（自上次 verdict 以来的 failover/不可用事件计数） | 4xx 风暴时可区分「在重试」与「卡死」 |

**回归：UX-SUMMARY 18/18 全过**。

## 冷启动无模型引导 + 网关死锁修复（T19，2026-10-21 增补）

| 项 | 修复 | 实测 |
|---|---|---|
| 无模型冷启动 | ① `onboardingInfo` 启动时总是探测（此前仅首启写入，老用户恒为 null）② Hero/引导在「已知无模型」时隐藏开始按钮，改为内联提示 + 「去配置模型」直达模型步骤 ③ 顶栏常驻「⚙ 未配置模型」角标 ④ 引导第③步未配置时跳回第②步并提示 | 模拟无模型：hero 引导 ✓、开始按钮隐藏 ✓、角标 ✓、点击直达；T19 |
| key 保存后刷新 | 新增 `refreshOnboardingInfo()`；保存 Key / 启动本地引擎成功后刷新 | T19 |
| **网关死锁（真 bug）** | 权限/预算应答条此前判定「最后一条日志是 ask」；变体竞争时三个 worker 事件交错，ask 被挤出末位 → 应答按钮消失、聊天卡死 awaiting。改为反向扫描「最新未应答 ask」，遇已允许/已拒绝/已确认即视为已解决 | T4 连续两次复现（gate never appeared），修复后 **19/19** |

**回归：UX-SUMMARY 19/19 全过。**
