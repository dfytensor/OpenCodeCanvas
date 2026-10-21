"""独立验收：tabulate-encoding

判据（任务运行前已定义；默认编码行为在 Windows cp936 环境下验证）：
  1. CLI 帮助包含 --encoding
  2. --encoding utf-8 读取 UTF-8 中文 CSV：字段名与值正确渲染
  3. 不带 --encoding 时同一文件按系统代码页误读出现乱码（证明选项必要）
"""
import os
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # never crash printing mojibake diagnostics

fails = []


def run(args, utf8=True):
    env = {**os.environ}
    if utf8:
        env["PYTHONUTF8"] = "1"  # child prints utf-8 for stable capture
    return subprocess.run(
        [sys.executable, "-m", "tabulate"] + args,
        capture_output=True,
        text=True,
        encoding="utf-8" if utf8 else "cp936",
        errors="replace",
        env=env,
    )


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (("  " + detail[:200]) if detail and not cond else ""))
    if not cond:
        fails.append(name)


with open("chinese.csv", "w", encoding="utf-8") as f:
    f.write("名字,分数\n张三,90\n")

check("帮助文本包含 --encoding", "--encoding" in run(["-h"]).stdout)

r_good = run(["--read", "csv", "--encoding", "utf-8", "--format", "plain", "chinese.csv"])
check(
    "--encoding utf-8 正确读取中文",
    "张三" in r_good.stdout and "名字" in r_good.stdout and "90" in r_good.stdout,
    r_good.stdout + r_good.stderr,
)

r_bad = run(["--read", "csv", "--format", "plain", "chinese.csv"], utf8=False)
check(
    "默认编码出现乱码（证明 --encoding 必要）",
    ("张三" not in r_bad.stdout) or ("名字" not in r_bad.stdout),
    r_bad.stdout,
)

print("RESULT:", "PASS" if not fails else "FAIL")
sys.exit(0 if not fails else 1)
