"""独立验收：toml-sort-keys

判据（任务运行前已定义）：
  1. 默认（不传 sort_keys）：保持插入序——b = 1 在最前，嵌套 d 在 c 前
  2. sort_keys=True：嵌套表键按字典序（c 在 d 前）
  3. TOML 结构约束：标量 b 仍必须在 [a] 表头之前
  4. dump 到文件对象同样生效
"""
import importlib
import io
import sys

sys.path.insert(0, ".")
toml = importlib.import_module("toml")

sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # never crash printing mojibake diagnostics

fails = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (("  " + detail[:160]) if detail and not cond else ""))
    if not cond:
        fails.append(name)


data = {"b": 1, "a": {"d": 2, "c": 3}}

# 1) baseline
default_out = toml.dumps(data)
lines = [l for l in default_out.splitlines() if l.strip()]
check("默认：b = 1 在最前", lines[0] == "b = 1", default_out)
try:
    i_d = lines.index("d = 2")
    i_c = lines.index("c = 3")
    check("默认：嵌套保持插入序（d 在 c 前）", i_d < i_c)
except ValueError as e:
    check("默认：嵌套保持插入序（d 在 c 前）", False, str(e))

# 2) sorted
sorted_out = toml.dumps(data, sort_keys=True)
lines2 = [l for l in sorted_out.splitlines() if l.strip()]
check("sort_keys：输出非空", len(lines2) > 0, sorted_out)
try:
    i_b2 = lines2.index("b = 1")
    i_a2 = lines2.index("[a]")
    check("sort_keys：标量 b 仍在 [a] 之前（TOML 结构约束）", i_b2 < i_a2, sorted_out)
    after_a = lines2[i_a2:]
    i_c2 = after_a.index("c = 3")
    i_d2 = after_a.index("d = 2")
    check("sort_keys：[a] 内嵌套键 c 在 d 前", i_c2 < i_d2, sorted_out)
except ValueError as e:
    check("sort_keys：结构解析", False, str(e) + " | " + sorted_out)

# 3) dump to file object
buf = io.StringIO()
toml.dump(data, buf, sort_keys=True)
file_out = buf.getvalue()
check("dump(文件, sort_keys) 同样生效", "[a]" in file_out and file_out.index("b = 1") < file_out.index("[a]"), file_out)

print("RESULT:", "PASS" if not fails else "FAIL")
sys.exit(0 if not fails else 1)
