// orch-bench singleshot — baseline arm: same model, ONE direct API call per task.
// 文件树 + 任务描述 → 要求输出完整文件 JSON → 落盘 → 同一套独立验收脚本。
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'

const BENCH = process.cwd().includes('bench') ? path.join(process.cwd(), 'bench/orchestr') : 'F:/OpenCodeCanvas/bench/orchestr'
const REPOS = 'F:/occ-bench/repos'
const WORKSPACES = 'F:/occ-bench/workspaces'
const MODEL = 'deepseek-chat'
const ENDPOINT = 'https://api.deepseek.com/chat/completions'
const AUTH_FILE = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json')

const args = process.argv.slice(2)
const only = args.includes('--tasks') ? args[args.indexOf('--tasks') + 1].split(',') : null

// deepseek key from the same auth store the app uses（与管线臂同 key、同模型 → 公平对比）
const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'))
const KEY = auth?.deepseek?.key
if (!KEY) {
  console.log('FATAL: no deepseek key in', AUTH_FILE)
  process.exit(1)
}

const tasks = []
for (const dir of fs.readdirSync(BENCH + '/tasks')) {
  if (!only || only.includes(dir)) {
    const t = JSON.parse(fs.readFileSync(BENCH + '/tasks/' + dir + '/task.json', 'utf8').replace(/^\uFEFF/, ''))
    t.verifyAbs = BENCH + '/tasks/' + dir + '/verify.py'
    t.repoDir = path.basename(t.repo).replace(/\.git$/, '')
    tasks.push(t)
  }
}
fs.mkdirSync(WORKSPACES, { recursive: true })
fs.mkdirSync(BENCH + '/results', { recursive: true })

async function callDeepseek(messages, timeoutMs = 420000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: 8192, temperature: 0.2 }),
      signal: ctrl.signal
    })
    const j = await r.json()
    return j?.choices?.[0]?.message?.content ?? ''
  } finally {
    clearTimeout(timer)
  }
}

const summary = []
for (const task of tasks) {
  const wsp = WORKSPACES + '/' + task.id
  console.log('\n=== task', task.id, '(singleshot) ===')
  fs.rmSync(wsp, { recursive: true, force: true })
  fs.cpSync(REPOS + '/' + task.repoDir, wsp, { recursive: true })

  const tree = spawnSync('git', ['ls-files'], { cwd: wsp, encoding: 'utf8' }).stdout ?? ''

  const messages = [
    { role: 'system', content: '你是资深 Python 工程师。只输出一个 JSON 对象，不要 markdown 代码块之外的任何文本。' },
    {
      role: 'user',
      content:
        task.description +
        '\n\n仓库文件清单（git ls-files）:\n' +
        tree +
        '\n\n输出格式（严格 JSON）：{"files":[{"path":"相对路径","content":"完整文件内容"}]}\n对需要修改的文件，输出修改后的完整内容；不要输出未改动的文件。'
    }
  ]

  const t0 = Date.now()
  let raw = ''
  try {
    raw = await callDeepseek(messages)
  } catch (e) {
    console.log('API error:', String(e).slice(0, 120))
  }
  const wallSec = Math.round((Date.now() - t0) / 1000)

  // parse files JSON（容错：截取第一个 { 到最后一个 }）
  let files = []
  try {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    const parsed = JSON.parse(raw.slice(start, end + 1))
    files = Array.isArray(parsed.files) ? parsed.files : []
  } catch {
    console.log('JSON parse failed; raw tail:', raw.slice(-200))
  }
  for (const f of files) {
    const dest = path.join(wsp, f.path)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, String(f.content), 'utf8')
  }
  console.log('files written:', files.length, '| wall:', wallSec + 's')

  const v = spawnSync('python', [task.verifyAbs], { cwd: wsp, encoding: 'utf8' })
  const verifyOk = v.status === 0
  console.log('verify:', verifyOk)

  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: wsp }).stdout?.toString().trim() ?? task.commit
  const result = {
    id: task.id,
    arm: 'singleshot',
    model: MODEL,
    commit,
    wallSec,
    filesWritten: files.length,
    verifyOk,
    pass: verifyOk,
    rawTail: raw.slice(-200),
    verifyTail: (v.stdout || '').slice(-500),
    ts: new Date().toISOString()
  }
  fs.writeFileSync(BENCH + '/results/' + task.id + '.singleshot.json', JSON.stringify(result, null, 2))
  summary.push({ id: task.id, pass: result.pass, wallSec })
}

fs.writeFileSync(BENCH + '/results/summary.singleshot.json', JSON.stringify(summary, null, 2))
console.log('\nSUMMARY:', JSON.stringify(summary))
process.exit(0)
