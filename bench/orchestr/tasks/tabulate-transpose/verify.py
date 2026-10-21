"""独立验收：tabulate-transpose

判据（任务运行前已定义）：
  1. CLI 帮助包含 --transpose
  2. 输入 2 行 × 3 列，-t 转置后输出 3 行 × 2 列，值位置精确匹配
  3. 不加 -t 时输出保持原样（2 行）
"""
import os
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # never crash printing mojibake diagnostics

fails = []


def run(args):
    return subprocess.run(
        [sys.executable, "-m", "tabulate"] + args,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (("  " + detail[:200]) if detail and not cond else ""))
    if not cond:
        fails.append(name)


with open("grid.csv", "w", encoding="utf-8") as f:
    f.write("a,b,c\n1,2,3\n")

check("帮助文本包含 --transpose", "--transpose" in run(["-h"]).stdout)

r_t = run(["--read", "csv", "-t", "--format", "plain", "grid.csv"])
lines_t = [l.rstrip() for l in r_t.stdout.splitlines() if l.strip()]
expected = ["a  1", "b  2", "c  3"]
check(
    "-t 转置为 3×2 且值位置正确",
    len(lines_t) == 3 and all(lines_t[i] == expected[i] for i in range(3)),
    r_t.stdout,
)

r_no = run(["--read", "csv", "--format", "plain", "grid.csv"])
lines_no = [l.rstrip() for l in r_no.stdout.splitlines() if l.strip()]
check("不加 -t 保持原样（首行 a, b, c）", len(lines_no) >= 1 and lines_no[0].startswith("a  b"), r_no.stdout)

print("RESULT:", "PASS" if not fails else "FAIL")
sys.exit(0 if not fails else 1)
