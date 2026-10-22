"""独立验收（SWE-bench 式）

要求：修复提交引入的目标测试全部通过；其余既有测试不得出现新增失败。
预置失败（环境/平台原因）已在生成时记录并自动豁免。
 Integrity 约束由评测器另行检查：不得改动仓库既有测试文件。
"""
import subprocess
import sys

files = ['test/test_output.py']
r = subprocess.run([sys.executable, "-m", "pytest"] + files + ["-q", "--no-header"], capture_output=True, text=True)
tail = "\n".join((r.stdout or "").splitlines()[-15:])
print(tail)
sys.exit(0 if r.returncode == 0 else 1)
