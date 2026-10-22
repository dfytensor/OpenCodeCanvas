// orch-bench runner v2 — pipeline arm
// 支持：feature 任务（repos 复制）+ bugfix 任务（git 复位到 bug 态）；--runs N 多次运行取方差；
// token 成本核算（chatStats）；检查点验收（5/10 分钟采样 time-to-first-green）。
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
const TIMEOUT_MIN = 20

const args = process.argv.slice(2)
const only = args.includes('--tasks') ? args[args.indexOf('--tasks') + 1].split(',') : null
const RUNS = args.includes('--runs') ? Number(args[args.indexOf('--runs') + 1]) : 1

// ── collect tasks
const tasks = []
for (const dir of fs.readdirSync(BENCH + '/tasks')) {
  if (only && !only.includes(dir)) continue
  const raw = fs.readFileSync(BENCH + '/tasks/' + dir + '/task.json', 'utf8').replace(/^\uFEFF/, '')
  const t = JSON.parse(raw)
  t.verifyAbs = BENCH + '/tasks/' + dir + '/verify.py'
  t.repoDir = path.basename(t.repo).replace(/\.git$/, '')
  t.dir = dir
  tasks.push(t)
}
console.log('tasks:', tasks.map((t) => t.id).join(', '), '| runs per task:', RUNS)

fs.mkdirSync(WORKSPACES, { recursive: true })
fs.mkdirSync(SETTINGS, { recursive: true })
fs.mkdirSync(BENCH + '/results', { recursive: true })

// ── launch the app（整棵进程树输出重定向：npm→electron-vite→electron 的日志全落盘，崩溃可取证）
const app = spawn(
    'cmd.exe',
    ['/c', 'npm run dev >> F:\\occ-bench\\app.log 2>&1'],
    {
        cwd: CANVAS,
        env: { ...process.env, OCC_SETTINGS_DIR: SETTINGS, OCC_CDP_PORT: CDP_PORT, OCC_AUTOMATION: '1' },
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore']
    }
)
console.log('app launcher pid:', app.pid)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

// ── workspace prep
function prepWorkspace(task) {
  const wsp = path.join(WORKSPACES, task.id).replace(/\//g, '\\')
  if (task.goldCommit) {
    // bugfix 任务：生成器已备好工作区，复位到 bug 态（源码=parent，测试=gold 版本）
    const g = (a) => spawnSync('git', a, { cwd: wsp, encoding: 'utf8' })
    g(['checkout', '-q', '-f', task.commit])
    for (const tf of task.integrity) g(['checkout', '-q', '-f', task.goldCommit, '--', tf])
    g(['clean', '-qfdx'])
    return wsp
  }
  fs.rmSync(wsp, { recursive: true, force: true })
  fs.cpSync(path.join(REPOS, task.repoDir), wsp, { recursive: true })
  return wsp
}

function verifyRun(task, wsp) {
  const v = spawnSync('python', [task.verifyAbs], { cwd: wsp, encoding: 'utf8', timeout: 300 })
  return { ok: v.status === 0, tail: (v.stdout || '').slice(-400) }
}

// ── run one task once
async function runTask(task, runIdx) {
  const wsp = prepWorkspace(task)
  await jget(`await window.__occStore.getState().openProject('${wsp.replaceAll('\\', '\\\\')}').then(() => 'ok')`, true)
  await jget(
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
  await sleep(800)

  const chatId = await jget(
    `(async () => {
      try {
        const s = window.__occStore.getState()
        const id = await s.createChat()
        if (!id) return 'NULL:' + (s.error ?? '')
        await s.sendChat(id, ${JSON.stringify(task.description)})
        return id
      } catch (e) {
        return 'ERR:' + String(e).slice(0, 200)
      }
    })()`,
    true
  )
  console.log(`[${task.id} run${runIdx}] chat:`, chatId)
  if (!chatId || chatId.startsWith('NULL') || chatId.startsWith('ERR')) {
    return { chatId, status: 'no-chat', wallSec: 0 }
  }

  const t0 = Date.now()
  let status = ''
  let finalText = ''
  let ttfg = null
  let lastVerify = 0
  let lostStreak = 0
  const deadline = t0 + TIMEOUT_MIN * 60_000
  while (Date.now() < deadline) {
    await sleep(5000)
    const r = await jget(`(() => {
      const s = window.__occStore.getState()
      const log = s.chats['${chatId}'] ?? []
      const fin = [...log].reverse().find((e) => e.role === 'final')
      return JSON.stringify({ status: s.graph?.nodes['${chatId}']?.status ?? '', final: fin ? fin.text : '' })
    })()`)
    if (r === undefined || r === null) {
      lostStreak++
      if (lostStreak >= 4) {
        console.log(`[${task.id} run${runIdx}] app/store lost (${lostStreak} consecutive failed polls)`)
        break
      }
      await sleep(2000)
      continue
    }
    lostStreak = 0
    const o = JSON.parse(r || '{}')
    status = o.status ?? ''
    if (o.final) finalText = o.final

    // 检查点验收：5/10 分钟采样 time-to-first-green
    const elapsed = (Date.now() - t0) / 1000
    if (ttfg === null && (elapsed > 300 || status === 'completed') && elapsed - lastVerify > 240) {
      lastVerify = elapsed
      const vr = verifyRun(task, wsp)
      if (vr.ok) ttfg = Math.round(elapsed)
      if (status === 'completed' && vr.ok) break
    }
    if (status === 'failed') break
    if (status === 'completed') break
  }
  const wallSec = Math.round((Date.now() - t0) / 1000)

  // tokens（子树累计，来自 routing 记录）
  let tokens = null
  try {
    const statsRaw = await jget(
      `window.electronAPI.occ.chatStats('${chatId}').then((s) => JSON.stringify(s ?? {}))`,
      true
    )
    const stats = JSON.parse(statsRaw || '{}')
    if (typeof stats.tokens === 'number') tokens = stats.tokens
  } catch {
    /* best-effort */
  }

  // 终局验收 + 完整性（不得改动既有测试）
  const fin = verifyRun(task, wsp)
  const baseRef = task.goldCommit ?? 'HEAD'
  const integ = spawnSync('git', ['diff', '--exit-code', baseRef, '--', ...(task.integrity ?? [])], {
    cwd: wsp,
    encoding: 'utf8'
  })
  const integrityOk = integ.status === 0
  return { chatId, status, wallSec, finalText, tokens, ttfg, verifyOk: fin.ok, integrityOk, verifyTail: fin.tail }
}

// ── main
const all = []
for (const task of tasks) {
  for (let runIdx = 1; runIdx <= RUNS; runIdx++) {
    console.log(`\n=== ${task.id} run${runIdx} ===`)
    let res
    try {
      res = await runTask(task, runIdx)
    } catch (e) {
      console.log('run error:', String(e).slice(0, 300))
      continue
    }
    const result = {
      id: task.id,
      arm: 'pipeline',
      model: MODEL,
      run: runIdx,
      commit: task.commit ?? '',
      goldCommit: task.goldCommit ?? null,
      chatId: res.chatId,
      agentStatus: res.status,
      wallSec: res.wallSec,
      tokens: res.tokens,
      ttfgSec: res.ttfg,
      verifyOk: res.verifyOk ?? false,
      integrityOk: res.integrityOk ?? false,
      pass: !!(res.verifyOk && res.integrityOk),
      finalTail: (res.finalText || '').slice(-300),
      verifyTail: (res.verifyTail || '').slice(-400),
      ts: new Date().toISOString()
    }
    fs.writeFileSync(BENCH + '/results/' + task.id + '.pipeline.r' + runIdx + '.json', JSON.stringify(result, null, 2))
    all.push(result)
    console.log(`[${task.id} run${runIdx}] pass=${result.pass} status=${result.agentStatus} wall=${result.wallSec}s`)
  }
}

fs.writeFileSync(BENCH + '/results/summary.pipeline.json', JSON.stringify(all, null, 2))
console.log('\nSUMMARY:', JSON.stringify(all.map((r) => ({ id: r.id, run: r.run, pass: r.pass, wallSec: r.wallSec }))))

try {
  spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'])
} catch {
  /* */
}
process.exit(0)
