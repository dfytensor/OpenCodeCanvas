# orch-bench — 编排能力基准（OpenCodeCanvas）

**Evaluation-first benchmark for agent orchestration.** 判据在运行前写死；验收由独立脚本执行；不做自我评分；失败案例同样公开。

## 我们要证明什么

同一个模型下，**编排管线**（规划→并行执行→独立验收）相比**单发直调**（一次 prompt 生成全部代码）是否提升任务成功率与可验收性。这不是模型能力榜单——是编排价值的直接度量。

## 实验设计

- **任务**：真实开源仓库上的新功能开发（仓库里当前不存在该功能），每个任务附精确规格与验收判据
- **三条臂**：
  1. `pipeline` — OpenCodeCanvas 全管线（同默认模型，规划→worker→独立验收）
  2. `singleshot` — 同模型一次直调：给文件树 + 任务描述，要求输出完整文件 JSON，落盘后同判据验收
  3. （可选）`singleshot+retry` — 单发 + 最多 3 轮自我修正
- **验收**：`verify.py` 独立脚本（不属于 agent 工作区），exit 0 = 通过；另检查「不得修改既有测试」完整性约束
- **指标**：成功率、每任务用时、token 消耗、验收抓错率（verifier 否决 agent 自称完成的比率）
- **诚实规则**：判据先于运行提交进 git；失败与超时如实计入；全部结果 JSON 随仓库公开

## 复现

```bash
# 1) 克隆任务仓库到 ../repos（runner 会复制到独立工作区再运行，不污染源克隆）
# 2) 管线臂（需要本机可运行 OpenCodeCanvas 与已配置的模型）
node runner.mjs --tasks all
# 3) 单发基线臂（读取 ~/.config/opencode/opencode.json 里的 deepseek key）
node singleshot.mjs --tasks all
```

## 任务列表

| id | 仓库 | commit | 任务 |
|---|---|---|---|
| tabulate-sort | astanin/python-tabulate | 268615a | CLI 新增 `-S/--sort COLUMN` 排序 |
| tenacity-attr-retry | jd/tenacity | 32ac68f | 新增 `retry_if_(not_)exception_attribute` |
| schedule-jitter | dbader/schedule | 82a43db | `do(..., jitter=N)` 抖动调度 |

## 结果

见 `results/`（运行后生成）。首期数据点数少，只做方向性结论；扩到 10+ 任务后再谈统计显著性。
