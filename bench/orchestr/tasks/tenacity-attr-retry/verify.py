"""独立验收：tenacity-attr-retry

判据（任务运行前已定义）：
  1. tenacity.retry 提供 retry_if_exception_attribute / retry_if_not_exception_attribute
  2. retry_if_exception_attribute("code", 42)：code==42 时重试，属性改变后停止
  3. retry_if_not_exception_attribute("code", 42)：code==42 时不重试
"""
import importlib
import sys

sys.path.insert(0, ".")
tenacity = importlib.import_module("tenacity")

sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # never crash printing mojibake diagnostics

fails = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        fails.append(name)


retry_mod = importlib.import_module("tenacity.retry")
check("retry.retry_if_exception_attribute 存在", hasattr(retry_mod, "retry_if_exception_attribute"))
check("retry.retry_if_not_exception_attribute 存在", hasattr(retry_mod, "retry_if_not_exception_attribute"))
check("tenacity 顶层导出 retry_if_exception_attribute", hasattr(tenacity, "retry_if_exception_attribute"))
check("tenacity 顶层导出 retry_if_not_exception_attribute", hasattr(tenacity, "retry_if_not_exception_attribute"))

if not fails:

    class MyErr(Exception):
        pass

    attempts = {"match": 0, "nomatch": 0}

    @tenacity.retry(
        retry=tenacity.retry_if_exception_attribute("code", 42),
        stop=tenacity.stop_after_attempt(3),
        reraise=True,
    )
    def matching():
        attempts["match"] += 1
        e = MyErr("boom")
        e.code = 42 if attempts["match"] < 3 else 0
        raise e

    @tenacity.retry(
        retry=tenacity.retry_if_not_exception_attribute("code", 42),
        stop=tenacity.stop_after_attempt(2),
        reraise=True,
    )
    def not_matching():
        attempts["nomatch"] += 1
        e = MyErr("boom")
        e.code = 42
        raise e

    try:
        matching()
    except MyErr:
        pass
    check("code==42 时重试到属性改变（共尝试 3 次）", attempts["match"] == 3)

    try:
        not_matching()
    except MyErr:
        pass
    check("retry_if_not：条件满足则不重试（1 次）", attempts["nomatch"] == 1)

print("RESULT:", "PASS" if not fails else "FAIL")
sys.exit(0 if not fails else 1)
