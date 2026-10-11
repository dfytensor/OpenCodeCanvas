# OpenCode Canvas 2.0

一个**项目级会话编排 Agent 系统**——以项目为单位，聊天节点为根，agent 图向右生长直到任务完成。多重性 × 相互作用 × 约束 = 涌现。

> 从「画布上的终端分叉工具」升级为「自适应多 agent 管线 + 经验自进化系统」

---

## 它是什么

打开项目 → 右键新建聊天窗口 → 输入目标 → 系统自动：
1. **规划**（Jev 级联分类：零节点直答 / 单任务 / 并行扇出 / 串行链）
2. **执行**（多个 agent 并行工作，每个有独立工作副本 + 白板共笔）
3. **合并**（产物自动合并进项目根，三耦合环验证 + Goodhart 追踪）
4. **验收**（功能级验收员真运行代码，fitness 梯度评分，不通过自动延伸）
5. **学习**（routing.jsonl + self-policy.json 自进化——失败策略自动降级，成功策略优先繁殖）

## 六层自治

| 层 | 能力 | 实测 |
|---|---|---|
| 规划 | 零节点直答 / 单任务 / 扇出 / 串行链（成本拓扑） | 16 任务基准 8/8+8/8 |
| 执行 | 跨模型变体竞争 / 白板共笔 / 串行链自适应 | 5 HumanEval 5/5+5/5 |
| 合并 | 三耦合环验证（coder→reviewer→Goodhart）+ 产物闭环 | 多轮增量 ALL PASS |
| 验收 | 功能级验收员（真运行代码）+ fitness 0-1 + Jev 快筛级联 | ROOT VERIFY fib(10)=55 |
| 门控 | 预算提醒-确认 / 权限询问-Jev 安全分类 | 非阻塞 + 其他聊天不受影响 |
| 经验 | routing.jsonl → 策略自进化（self-policy vN 自写自用） | routing-adjust 实测触发 |

## 快速开始

```bash
npm install
npm run dev
```

1. 顶栏 **打开项目** 选择工作目录
2. 右键画布 → **💬 New chat window**
3. 输入目标（支持多行=多子任务），回车
4. 图向右生长直到完成

## 架构

```
src/main/
├── agent/           # 原生 agent 内核
│   ├── jev.ts       # Jev/AnyJev 级联（类型化决策 + 校准）
│   ├── loop.ts      # 工具循环（http.request，零 undici）
│   ├── providers.ts # 多 provider 目录（zhipuai/deepseek/本地）
│   ├── session.ts   # 会话注册 + 权限门 + 白板
│   └── tools.ts     # bash/read/write/edit/list（沙箱囚禁）
├── inherit/         # 自适应管线
│   ├── executor.ts  # 经验路由 + 变体竞争 + 产物闭环 + 验收级联
│   ├── channels.ts  # fork/import/brief 三通道
│   └── budget.ts    # token 预算
├── graph/           # append-only DAG 存储
├── opencode/        # opencode server 托管 + API + SSE
├── workspace/       # 快照/复制/diff/apply/归档
├── project/         # 项目注册 (.occ/project.json)
├── chat.ts          # 聊天节点管理
└── verify/          # 三耦合环验证 + Goodhart 追踪
```

## 自治层级

```
L0   规划     零节点直答 / 单任务 / 扇出 / 串行链（成本拓扑）
L1   执行     白板共笔 / 变体竞争 / 跨模型轮转 / 串行链自适应
L1   纠错     产物闭环 / 验收 CONTINUE 延伸 / 权限拒绝适应
L1   门控     预算提醒-确认 / 权限询问-Jev 安全分类
L1.5 合并验证 三耦合环（coder→reviewer→Goodhart→才准合并）
L2   经验     routing.jsonl → 经验路由自动改串行
L2.5 策略进化 self-policy.json 自写自用（vN 自审计）
```

## 基准

| | 通过率 | 平均墙钟 | tokens/任务 |
|---|---|---|---|
| baseline 单线程 | 8/8 | 23s | ~7k |
| ours 推理管线 | 8/8 | 111s | ~52k |

> ours 在轻任务上不占优（管线开销），价值在多轮长链任务（激活前沿不重做）和经验积累（失败策略自动降级）。

### HumanEval（执行判分，canonical tests）

deepseek-chat，60 题随机抽样（seed=42，`bench/humaneval.ts`，可复现），ours 跑了两轮共 120 次尝试：

| 配置 | 单次通过率 | 最终成功* | 平均耗时 |
|---|---|---|---|
| baseline 单发补全 | 58/60 (97%) | 97% | ~1s |
| **ours 轻任务快路径** | 112/120 (93%) | **58/60 (97%)** | ~2.3s |

\* 重试一次即过——快路径失败的 5 题在重新生成后全部通过（模型方差，非系统性）。

> **轻任务负收益区已收复**：单次生成 + 语法门 + 产物闭环，成本 ~2× 达到与裸模型持平的正确率，且自带 baseline 没有的东西——语法门、产物闭环、provider failover、项目记忆。任何门失败自动升级完整管线。重任务（多步/改真实仓库）走隔离工作区 + 验收员管线：涌现探针实测 68s/35k tokens vs baseline 121s/50k tokens——**又快又省**。

## 体验

- **流式输出**：worker 生成时聊天节点内实时长出文字（SSE → 事件总线 → 生长气泡，120ms 节流；工具调用从 delta 装配，实测 3 并行 worker fitness=1）
- **画布可视化**：聊天为根、agent 图向右生长、LOD 分层、MiniMap、64 聊天无重叠级联
- **等待可见**：权限/预算门 → 任务栏闪烁 + toast + 「N 等待回复」徽章一键定位
- **一键应答**：允许/全部允许/拒绝、继续/取消；停止 → 中止整棵子树；失败 → 重试/忽略

## 上下文治理

见 [docs/context-governance.md](docs/context-governance.md)。核心：世界状态落盘、上下文持引用、工具结果当轮内联跨轮压实（`compactHistory`，实测多轮长任务 25 次压实零 API 错误）、思考不跨轮而结论压缩跨轮。

## Jev/AnyJev 集成

- **Round-0 规划**：Jev Choice（ANSWER/BUILD + 并行判定）→ GLM 兜底
- **验收快筛**：Jev Noul（goal_met 概率）→ 高置信接受，低置信升级 GLM 验收员
- **权限门**：Jev Noul（safe 分类）→ 高置信自动放行，低置信询问用户
- **校准**：routing.jsonl + calibration.jsonl → 置信度自调（AnyJev observe() 模式）

### 本地决策层（零成本 / 离线 / 隐私）

无 OPENROUTER_API_KEY 时，Jev 自动探测本机 OpenAI 兼容端点（默认 `:11434`，可用 `OCC_JEV_LOCAL` / `OCC_JEV_LOCAL_MODEL` 指定），用本地小模型（实测 MiniCPM5-2B @ 4090，llama.cpp Q4_K_M）承担三级决策：

| 决策 | 本地实测 | 成本 |
|---|---|---|
| route（ANSWER/BUILD + 并行） | 5/5 准确，~500ms | $0 |
| goal_met（验收快筛） | 正反例全对，0.85 快收 | $0 |
| tool_safe（权限分类） | 危险/安全分类正确；**安全帽：本地概率封顶 0.85，永不越过 0.9 自动放行线** | $0 |

级联次序：OpenRouter Jev（质量最高）→ 本地小模型（$0）→ GLM 兜底。任意一级不可用自动滑落。

## 设计原则

1. 继承 = 投影，不是复制
2. 上下文与工作区正交
3. 不写合并算法——冲突交给 agent
4. append-only——节点永不删除
5. 白板共笔——worker 间接交互
6. 梯度适应度——不止过/不过
7. 策略自进化——失败经验写入规则
8. 验收价值学习——零捕获则跳过验收

## License

MIT
