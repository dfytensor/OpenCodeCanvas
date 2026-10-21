"""独立验收：tablib-sort-by

判据（任务运行前已定义）：
  1. ds.sort_by('name') 返回新 Dataset（非原地），按 name 升序
  2. 原 Dataset 保持追加时的顺序
  3. reverse=True 降序
  4. 不存在的列名抛异常
"""
import importlib
import sys

sys.path.insert(0, "src")
tablib = importlib.import_module("tablib")

sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # never crash printing mojibake diagnostics

fails = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (("  " + detail[:160]) if detail and not cond else ""))
    if not cond:
        fails.append(name)


ds = tablib.Dataset(headers=["name", "age"])
ds.append(("b", 2))
ds.append(("a", 3))
ds.append(("c", 1))

ds2 = ds.sort_by("name")
check("sort_by 返回新实例（非原地）", ds2 is not ds)
names2 = [r[0] for r in ds2]
check("按 name 升序（a, b, c）", names2 == ["a", "b", "c"], str(names2))

orig_names = [r[0] for r in ds]
check("原 Dataset 顺序不变（b, a, c）", orig_names == ["b", "a", "c"], str(orig_names))

ds3 = ds.sort_by("name", reverse=True)
names3 = [r[0] for r in ds3]
check("reverse=True 降序（c, b, a）", names3 == ["c", "b", "a"], str(names3))

raised = False
try:
    ds.sort_by("no_such_column")
except Exception:
    raised = True
check("不存在的列抛异常", raised)

print("RESULT:", "PASS" if not fails else "FAIL")
sys.exit(0 if not fails else 1)
