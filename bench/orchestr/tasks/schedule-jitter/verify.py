"""独立验收：schedule-jitter

判据（任务运行前已定义）：
  1. every(2).seconds.do(fn, jitter=10) 可用且 job.jitter == 10
  2. jitter=10 时 next_run 距今落在 [2s, 12.5s]（30 次采样全部命中）
  3. 默认 jitter=0：next_run 距今 ≈ interval（±2s 执行误差）
"""
import datetime
import importlib
import random
import sys

sys.path.insert(0, ".")
schedule = importlib.import_module("schedule")

sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # never crash printing mojibake diagnostics

fails = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        fails.append(name)


# 1) API surface
try:
    job = schedule.every(2).seconds.do(lambda: None, jitter=10)
    check("every().do(..., jitter=N) 可用且保存为 job.jitter", getattr(job, "jitter", None) == 10)
except TypeError as e:
    check("every().do(..., jitter=N) 可用且保存为 job.jitter", False)
    print("  TypeError:", e)
    job = None

# 2) bounds
if job is not None:
    random.seed(42)
    bounds_ok = True
    for _ in range(30):
        job._schedule_next_run()
        delta = (job.next_run - datetime.datetime.now()).total_seconds()
        if not (2 <= delta <= 12.5):
            bounds_ok = False
            print("  越界样本:", delta)
            break
    check("jitter=10 时 next_run ∈ [2s, 12.5s]（30 次采样）", bounds_ok)

# 3) default unchanged
job2 = schedule.every(5).seconds.do(lambda: None)
job2._schedule_next_run()
d2 = (job2.next_run - datetime.datetime.now()).total_seconds()
check("默认无 jitter：next_run ≈ interval（5s ± 2s）", abs(d2 - 5) < 2.0)

print("RESULT:", "PASS" if not fails else "FAIL")
sys.exit(0 if not fails else 1)
