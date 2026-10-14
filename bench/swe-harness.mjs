// SWE-bench mini-harness (no Docker): sympy at base_commit
// 1) extract test file + patches  2) pre-state FAIL check  3) apply GOLD patch
// 4) post-state PASS check  → harness validated, ready for agent runs
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'

const TEMP = process.env.TEMP
const inst = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''))
const repoDir = fs.readdirSync(path.join(TEMP, 'opencode', 'swe')).filter((d) => d.startsWith('sympy-')).map((d) => path.join(TEMP, 'opencode', 'swe', d)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
const f2p = JSON.parse(inst.FAIL_TO_PASS)
const p2p = JSON.parse(inst.PASS_TO_PASS)
const testFile = [...inst.test_patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1])[0]

const run = (cmd, opts = {}) => {
  try {
    return execFileSync(cmd[0], cmd.slice(1), { encoding: 'utf8', timeout: 300_000, windowsHide: true, ...opts })
  } catch (e) {
    return `__EXIT${e.status ?? '?'}__` + (e.stdout ?? '') + '\n[stderr]\n' + (e.stderr ?? '')
  }
}
const runPytest = (k, extra = []) => {
  const out = run(['python', '-m', 'pytest', path.join(repoDir, testFile), '-k', k, '-q', '--no-header', ...extra])
  return { out, pass: !out.includes('__EXIT') && !/(\d+ failed|error)/i.test(out.split('\n').filter(Boolean).pop() ?? 'failed') && /passed/.test(out) }
}

console.log('instance:', inst.instance_id, '· testFile:', testFile, '· F2P:', f2p.join(','))

// 1) pre-state: F2P must FAIL
const pre = runPytest(f2p[0])
console.log('PRE  state:', pre.pass ? 'PASS (bad — harness invalid)' : 'FAIL (correct)')
console.log('  tail:', pre.out.split('\n').filter(Boolean).pop()?.slice(0, 120))

// 2) apply GOLD patch + test patch with git
fs.writeFileSync(path.join(repoDir, '__gold.patch'), inst.patch, 'utf8')
fs.writeFileSync(path.join(repoDir, '__test.patch'), inst.test_patch, 'utf8')
console.log('apply gold:', run(['git', 'apply', '--whitespace=nowarn', '__gold.patch'], { cwd: repoDir }).includes('__EXIT') ? 'FAILED' : 'ok')
console.log('apply tests:', run(['git', 'apply', '--whitespace=nowarn', '__test.patch'], { cwd: repoDir }).includes('__EXIT') ? 'FAILED' : 'ok')

// 3) post-state: F2P must PASS
const post = runPytest(f2p[0])
console.log('POST state:', post.pass ? 'PASS (harness VALIDATED ✓)' : 'FAIL (harness broken)')
if (!post.pass) console.log('  tail:', post.out.split('\n').filter(Boolean).pop()?.slice(0, 160))

// 4) P2P sample still passing (first 8)
let p2pOk = 0
let p2pN = 0
for (const t of p2p.slice(0, 8)) {
  const r = runPytest(t)
  p2pN++
  if (r.pass) p2pOk++
}
console.log(`P2P sample: ${p2pOk}/${p2pN} still passing`)

// reset for agent runs
console.log('resetting repo to base state…')
console.log('reset:', run(['git', 'checkout', '--', '.'], { cwd: repoDir }).includes('__EXIT') ? 'FAILED' : 'ok')
run(['git', 'clean', '-fd'], { cwd: repoDir })
fs.rmSync(path.join(repoDir, '__gold.patch'), { force: true })
fs.rmSync(path.join(repoDir, '__test.patch'), { force: true })
console.log('harness ready for agent run — repo at base_commit, tests restored to pre-state')
