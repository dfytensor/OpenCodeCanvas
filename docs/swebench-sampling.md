# SWE-bench 抽样：无容器尝试的结论（2026-10-12）

## 结论

**无 Docker 的本机抽样被「环境不可复现性」拦住。** 两个 sympy 实例（20212 v1.7 / 23262 v1.11）经金标准 patch 自检后，PRE 状态（应失败）全部 PASS——老 bug 在现代本地环境（Python 3.14 + mpmath 1.4.1）中**天然不复现**。环境敏感型缺陷（幂运算/lambdify 依赖当年运行时行为）是主因。

**这正是 SWE-bench 官方强制 Docker 的原因**：容器锁定当年 Python/mpmath 版本，bug 才能复现。我们的 harness 设计（先金 patch 自检 PRE→POST）在浪费 agent 跑分之前就拦住了无效环境——验证器先验证自己。

## 要跑官方抽样

1. 安装 Docker Desktop（一次性，需重启）
2. `pip install swebench` → 官方 harness 锁环境
3. 样本筛选已就绪：sympy 77 例池 + 最小样本清单（patch+test ≤1KB 的单测试实例优先）

## 已交付

- `bench/swe-harness.mjs` — 迷你 harness（无容器版，留档）：PRE-Fail 自检 → git apply 金/测试 patch → POST-Pass → P2P 抽样 → 复位
- `bench/swe-instance-sample.json` — sympy__sympy-23262 实例全字段样本
- 数据源：datasets-server API（princeton-nlp/SWE-bench_Lite，300 例，sympy 77/django 94/sklearn 23…）

## 有价值的副作用

harness 的「金标准自检」模式本身是通用方法论：**任何自建评测环境，必须先用已知答案（gold patch）验证评测器本身**。我们的 agent 验收员、Jev 校准、测试报告全部遵循同一原则——这次在 SWE-bench 上再次自证。
