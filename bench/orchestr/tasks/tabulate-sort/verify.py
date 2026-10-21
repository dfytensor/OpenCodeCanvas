"""独立验收：tabulate-sort（不依赖 agent 工作区之外的任何状态）

判据（在任务运行前已定义）：
  1. `python -m tabulate -h` 帮助文本出现 --sort
  2. `--read csv --sort 0 --format plain` 输出行按第 0 列有序
  3. 短选项 `-S 1` 按第 1 列有序
"""
import os
import subprocess
import sys

os.chdir(os.path.dirname(os.path.abspath("__file__")) or ".")

sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # never crash printing mojibake diagnostics

fails = []


def run(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (("  " + detail[:200]) if detail and not cond else ""))
    if not cond:
        fails.append(name)


# 准备样例输入（未排序）
with open("sample.csv", "w", encoding="utf-8") as f:
    f.write("b,2\na,3\nc,1\n")

help_out = run([sys.executable, "-m", "tabulate", "-h"]).stdout
check("帮助文本包含 --sort", "--sort" in help_out)

r = run([sys.executable, "-m", "tabulate", "--read", "csv", "--sort", "0", "--format", "plain", "sample.csv"])
rows = [l.rstrip() for l in r.stdout.splitlines() if l.strip()]
first_cols = [l.split("  ")[0] for l in rows[:3]]
check("--sort 0 输出行有序（a, b, c）", first_cols == ["a", "b", "c"], r.stdout + r.stderr)

r2 = run([sys.executable, "-m", "tabulate", "--read", "csv", "-S", "1", "--format", "plain", "sample.csv"])
rows2 = [l.rstrip() for l in r2.stdout.splitlines() if l.strip()]
last_cols = [l.split("  ")[-1] for l in rows2[:3]]
check("-S 1 输出行按第 1 列有序（1, 2, 3）", last_cols == ["1", "2", "3"], r2.stdout + r2.stderr)

print("RESULT:", "PASS" if not fails else "FAIL")
sys.exit(0 if not fails else 1)
