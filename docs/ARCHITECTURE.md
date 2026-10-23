# 架构图解 (ARCHITECTURE)

> 配套图：[`architecture.svg`](./architecture.svg)。以下用 mermaid 画四张图：分层总览、一次对话的时序、验收级联、评测回路。所有名称均来自真实代码（2026-10 版）。

## 1. 分层总览

```mermaid
flowchart TB
  subgraph R["渲染层 Renderer · React Flow + zustand"]
    CV["GraphCanvas 画布<br/>ChatNode · OccNode · 布局/镜头策略"]
    ST["occStore 会话状态<br/>chats · graph · policy · streams"]
    AU["automation.ts ?auto=1<br/>GUI 套件 T1–T20 · 暴露 __occStore"]
  end
  IPC[("ipc.ts · occ:* 约45通道<br/>＋ occ:event 单向推送")]
  subgraph M["主进程 Main"]
    EX["编排核心 inherit/executor.ts<br/>快路径 → Jev 路由 → 规划DAG<br/>轮次循环（预算/快照/变异体/黑板/合并）"]
    CH["聊天网关 chat.ts<br/>权限/预算拦截 · chat.jsonl"]
    SS["会话双引擎 channels.ts|agent/*<br/>opencode serve · native agt_"]
    PV["providers.ts + jev.ts<br/>deepseek·zhipu·failover链·决策级联"]
    VF["verify/ + goodhart.ts<br/>coder 不能自批 · Goodhart 检测"]
  end
  W[("&lt;root&gt;/.occ/<br/>graph.json · nodes/copy·snapshot<br/>BLACKBOARD.md · routing.jsonl · STATE.md")]
  KEY["~ 密钥层<br/>auth.json · opencode.json · ~/.occ-settings.json"]
  CV <--> ST
  AU -.驱动.-> ST
  R <-->|IPC + 事件| M
  CH --> EX
  EX -->|"spawn/调度"| SS
  SS -->|"HTTP(net.fetch)"| KEY
  PV -->|"HTTP"| KEY
  EX -.验收门.-> VF
  EX -->|"原子写"| W
```

要点：`ipc.ts` 是唯一 IPC 面；`events.ts` 的 `occ:event` 是全局事件主干（共用同一份数据流给 UI、聊天日志与路由学习）；每项目一份 `.occ/` 是唯一事实源（graph.json 追加写 + 原子落盘，能带着图谱续作重启）。

## 2. 一次对话的时序

```mermaid
sequenceDiagram
  participant U as 用户
  participant S as occStore(渲染层)
  participant C as chat.ts 网关
  participant E as executor.runAdaptive
  participant N as 引擎会话(native agt_ / opencode)
  U->>S: sendChat(text)
  S->>C: occ:chatSend
  C->>C: 权限问询/预算确认拦截 → busy 守卫
  C->>E: startAdaptivePipeline(goal, chatId)
  E->>E: 快路径? → Jev路由 → planGoal(DAG+判据)
  loop 每个波次
    E->>N: createInheritNode(fork)+kickoff(判据+黑板)
    N-->>E: 终态 → 波次合并 applyNode
  end
  E->>E: 验收级联: Jev p≥0.85 → GLM 验收员 → 跨模型复核
  E-->>C: occ:event pipeline.chat(role=final)
  C-->>S: chat.jsonl 持久化 + store 更新 + 节点 completed
```

## 3. 验收级联（便宜的检查先跑）

```mermaid
flowchart TB
  A["工作完成(波次合并)"] --> B["Jev 判定 jevGoalMet()<br/>p ≥ 0.85 → 直接放行($0)"]
  B -->|置信不足| C["独立验收员<br/>kind=merge · verify=true<br/>VERDICT / FITNESS / 逐条 PASS|FAIL"]
  C -->|"DONE 且 fitness<0.6"| D["跨模型复核<br/>换 failover 链下一家"]
  C -->|"FAIL"| E["未过项回炉<br/>(同形状失败→变异体竞争 K=3)"]
  D --> F["落盘: routing.jsonl(判据/fitness/成本)<br/>verifier-skip 学习(≥3 全对→跳验收)"]
  B --> F
  C --> F
```

设计动机：coder 不能自批（`verifiedApply` 强制走外部测试+审查），Goodhart 检测防刷分；无篡改史累积若干次后才允许跳过验收（`skipVerifier`），省钱但可回退。

## 4. 评测回路（orch-bench）

```mermaid
flowchart LR
  subgraph BENCH["bench/orchestr"]
    R["runner.mjs 管线臂<br/>CDP:9335 驱动真实应用<br/>updatePolicy(disableFastPath)"]
    S["singleshot.mjs 基线臂<br/>一次直调同模型"]
    V["verify.py 独立验收<br/>(agent 工作区之外)"]
    I["完整性检查<br/>git diff 既有测试"]
  end
  APP[("OpenCodeCanvas 实例<br/>CDP 9335 · __occStore")]
  WS[("F:/occ-bench/workspaces/<br/>每轮复位/重建")]
  R <--> APP
  R --> WS
  S --> WS
  WS --> V
  V --> I
  I --> O[("results/*.json 全量公开<br/>1/8 vs 2/8 · tokens 成本")]
```

评测纪律：判据先于运行定义；bugfix 任务采用 SWE-bench 式「修复前源码 + 金补丁测试」筛选 FAIL_TO_PASS（10 个候选只留 1 个可度量的，其余诚实剔除并记录原因）。
