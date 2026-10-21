// orch-bench runner — pipeline arm: drive OpenCodeCanvas through real tasks.
// 每个任务：干净工作区副本 → openProject → 建聊天发目标 → 等 final → 独立脚本验收 → 结果落盘
import fs from 'fs'
import path from 'path'
import { spawn, spawnSync } from 'child_process'

const CANVAS = 'F:/OpenCodeCanvas'
const BENCH = CANVAS + '/bench/orchestr'
const REPOS = 'F:/occ-bench/repos'
const WORKSPACES = 'F:/occ-bench/workspaces'
const SETTINGS = process.env.LOCALAPPDATA + '\\Temp\\occ-bench-settings'
const CDP_PORT = '9335'
const MODEL = 'deepseek/deepseek-chat'

const args = process.argv.slice(2)
const only = args.includes('--tasks') ? args[args.indexOf('--tasks') + 1].split(',') : null

// ── collect tasks
const tasks = []
for (const dir of fs.readdirSync(BENCH + '/tasks')) {
  if (!only || only.includes(dir)) {
    const t = JSON.parse(fs.readFileSync(BENCH + '/tasks/' + dir + '/task.json', 'utf8'))
    t.verifyAbs = BENCH + '/tasks/' + dir + '/verify.py'
    t.repoDir = path.basename(t.repo).replace(/\.git$/, '')
    tasks.push(t)
  }
}
console.log('tasks:', tasks.map((t) => t.id).join(', '))

fs.mkdirSync(WORKSPACES, { recursive: true })
fs.mkdirSync(SETTINGS, { recursive: true })
fs.mkdirSync(BENCH + '/results', { recursive: true })

// ── launch the app (automation mode)
const app = spawn('cmd.exe', ['/c', 'npm run dev'], {
  cwd: CANVAS,
  env: { ...process.env, OCC_SETTINGS_DIR: SETTINGS, OCC_CDP_PORT: CDP_PORT, OCC_AUTOMATION: '1' },
  detached: true,
  stdio: 'ignore'
})
console.log('app launcher pid:', app.pid)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── CDP plumbing
let page = null
for (let i = 0; i < 150 && !page; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
    page = list.find((t) => t.type === 'page' && String(t.url).includes('5173'))
  } catch {
    /* not up */
  }
  if (!page) await sleep(1000)
}
if (!page) {
  console.log('FATAL: no CDP page')
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
let msgId = 0
const pending = new Map()
const send = (m, p = {}) =>
  new Promise((resolve) => {
    const i = ++msgId
    pending.set(i, resolve)
    ws.send(JSON.stringify({ id: i, method: m, params: p }))
  })
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data))
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result ?? m.error)
    pending.delete(m.id)
  }
}
await new Promise((r) => {
  ws.onopen = r
})
const jget = async (e, ap = false) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: ap })
  return r?.result?.value
}

let hookReady = false
for (let i = 0; i < 60 && !hookReady; i++) {
  hookReady = await jget('typeof window.__occStore !== "undefined"')
  if (!hookReady) await sleep(1000)
}
if (!hookReady) {
  console.log('FATAL: store hook missing')
  process.exit(1)
}
// policy is set per-task AFTER openProject (see loop) — requireProject() throws earlier

// ── run tasks
const summary = []
for (const task of tasks) {
  const wsp = WORKSPACES + '/' + task.id
  console.log('\n=== task', task.id, '===')
  fs.rmSync(wsp, { recursive: true, force: true })
  fs.cpSync(REPOS + '/' + task.repoDir, wsp, { recursive: true })
  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: wsp }).stdout?.toString().trim() ?? task.commit

  const openRes = await jget(
    `(async () => {
      try {
        await window.__occStore.getState().openProject('${wsp.replaceAll('\\', '\\\\')}')
        const s = window.__occStore.getState()
        return JSON.stringify({ ok: !!s.project, root: s.project?.rootDir ?? '', err: s.error ?? '' })
      } catch (e) {
        return JSON.stringify({ ok: false, err: String(e).slice(0, 200) })
      }
    })()`,
    true
  )
  console.log('openProject:', openRes)

  // policy AFTER openProject (requireProject() throws before any project is open)
  const polRes = await jget(
    `(async () => {
      try {
        await window.electronAPI.occ.updatePolicy({
          defaultModel: '${MODEL}',
          engine: 'native',
          toolPermission: 'auto',
          budgetTokensPerChat: 0,
          disableFastPath: true
        })
        return 'ok'
      } catch (e) {
        return 'ERR:' + String(e).slice(0, 160)
      }
    })()`,
    true
  )
  console.log('policy:', polRes)

  const chatId = await jget(
    `(async () => {
      try {
        const s = window.__occStore.getState()
        const id = await s.createChat()
        if (!id) return 'NULL:' + (s.error ?? 'no error')
        await s.sendChat(id, ${JSON.stringify(task.description)})
        return id
      } catch (e) {
        return 'ERR:' + String(e).slice(0, 200)
      }
    })()`,
    true
  )
  console.log('chat:', chatId, '| deadline:', task.timeoutMin, 'min')
  const t0 = Date.now()
  let status = ''
  let finalText = ''
  for (let i = 0; i < task.timeoutMin * 60; i++) {
    const r = await jget(`(() => {
      const s = window.__occStore.getState()
      const log = s.chats['${chatId}'] ?? []
      const fin = [...log].reverse().find((e) => e.role === 'final')
      return JSON.stringify({ status: s.graph?.nodes['${chatId}']?.status ?? '', final: fin ? fin.text : '' })
    })()`)
    const o = JSON.parse(r || '{}')
    status = o.status ?? ''
    if (o.final) {
      finalText = o.final
      break
    }
    if (status === 'failed') break
    await sleep(1000)
  }
  const wallSec = Math.round((Date.now() - t0) / 1000)
  console.log('status:', status, '| wall:', wallSec + 's')

  // integrity: existing tests untouched
  const integrityArgs = ['diff', '--exit-code', 'HEAD', '--', ...(task.integrity ?? [])]
  const integrity = spawnSync('git', integrityArgs, { cwd: wsp })
  const integrityOk = integrity.status === 0

  // independent verifier
  const v = spawnSync('python', [task.verifyAbs], { cwd: wsp, encoding: 'utf8' })
  const verifyOk = v.status === 0
  console.log('integrity:', integrityOk, '| verify:', verifyOk)
  console.log((v.stdout || '').split('\n').filter((l) => l.startsWith('PASS') || l.startsWith('FAIL') || l.startsWith('RESULT')).join('\n'))

  const result = {
    id: task.id,
    arm: 'pipeline',
    model: MODEL,
    commit,
    wallSec,
    agentStatus: status,
    selfClaimedDone: !!finalText,
    integrityOk,
    verifyOk,
    pass: verifyOk && integrityOk,
    finalTail: finalText.slice(-300),
    verifyTail: (v.stdout || '').slice(-500),
    ts: new Date().toISOString()
  }
  fs.writeFileSync(BENCH + '/results/' + task.id + '.pipeline.json', JSON.stringify(result, null, 2))
  summary.push({ id: task.id, pass: result.pass, wallSec })
}

fs.writeFileSync(BENCH + '/results/summary.pipeline.json', JSON.stringify(summary, null, 2))
console.log('\nSUMMARY:', JSON.stringify(summary))

// stop the app
try {
  spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'])
} catch {
  /* */
}
process.exit(0)
