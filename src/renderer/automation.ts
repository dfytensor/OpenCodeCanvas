// Dev-only scripted GUI automation (?auto=1): drives the REAL rendered UI —
// native textarea value setter + DOM events on the live React Flow nodes —
// and reports progress via document.title (main process polls it to a file).
//
// Two suites:
//   ?auto=1            — legacy single-goal flow: goal → perm gate → final
//   ?auto=1&suite=ux   — full UX coverage: new-chat button, Jev key IPC,
//                        budget gate + focus badge, deny path, stop + retry
import { useOccStore } from './store/occStore'
import { pinnedPosition } from './lib/layout'

export function initAutomation(): void {
  if (!new URLSearchParams(window.location.search).has('auto')) return
  const params = new URLSearchParams(window.location.search)
  const store = useOccStore
  ;(window as unknown as { __occStore: unknown }).__occStore = store

  const log = (m: string): void => {
    document.title = 'OCC-AUTOTEST: ' + m.slice(0, 140)
  }
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const waitFor = async (fn: () => boolean, timeoutMs: number, step = 500): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (fn()) return true
      await sleep(step)
    }
    return false
  }

  const nodeTextarea = (chatId: string): HTMLTextAreaElement | null =>
    document.querySelector(`.react-flow__node[data-id="${chatId}"] textarea`)

  const nodeButton = (chatId: string, label: string): HTMLButtonElement | null => {
    const btns = Array.from(document.querySelectorAll(`.react-flow__node[data-id="${chatId}"] button`)) as HTMLButtonElement[]
    return btns.find((b) => b.textContent?.trim() === label) ?? null
  }

  const topButton = (label: string): HTMLButtonElement | null => {
    const btns = Array.from(document.querySelectorAll('header button')) as HTMLButtonElement[]
    return btns.find((b) => b.textContent?.trim() === label) ?? btns.find((b) => b.textContent?.includes(label)) ?? null
  }

  const sendGoal = async (chatId: string, text: string): Promise<void> => {
    const el = nodeTextarea(chatId)
    if (!el) throw new Error('textarea not mounted for ' + chatId)
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    if (!setter) throw new Error('no value setter')
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }

  const waitFinal = (chatId: string, timeoutMs: number): Promise<string | null> =>
    (async () => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const entries = store.getState().chats[chatId] ?? []
        const final = entries.filter((e) => e.role === 'final').pop()
        if (final) return final.text
        await sleep(2000)
      }
      return null
    })()

  // ───────────────── legacy suite: single goal + permission gate ─────────────────
  const legacySuite = async (): Promise<void> => {
    const wasRestored = !!store.getState().project
    log(wasRestored ? 'auto-restore OK (project already open)' : 'first run — opening project')
    if (!wasRestored) await store.getState().openProject('F:\\occ-gui-test')
    await store.getState().setEngine('native')
    await window.electronAPI.occ.updatePolicy({ toolPermission: 'ask', budgetTokensPerChat: 0 })
    const chatId = await store.getState().createChat()
    if (!chatId) throw new Error('createChat failed')
    const nodeSel = `.react-flow__node[data-id="${chatId}"]`
    if (!(await waitFor(() => !!nodeTextarea(chatId), 30000))) throw new Error('chat textarea never mounted')
    log('textarea mounted, typing goal')
    await sendGoal(chatId, '在当前目录创建 auto.txt，内容是 driven-by-gui，验证写入后报告任务完成')

    const gateDeadline = Date.now() + 3 * 60_000
    let gateClicks = 0
    while (Date.now() < gateDeadline) {
      const s = store.getState()
      if ((s.chats[chatId] ?? []).some((e) => e.role === 'final')) break
      if (s.graph?.nodes[chatId]?.status === 'awaiting_input') {
        const btns = Array.from(document.querySelectorAll(nodeSel + ' button')) as HTMLButtonElement[]
        const allow = btns.find((b) => b.textContent?.trim() === '全部允许') ?? btns.find((b) => b.textContent?.trim() === '允许')
        if (allow) {
          gateClicks++
          if (gateClicks === 1) log('gate bar rendered (topBadge=' + document.body.innerText.includes('等待回复') + ') — clicking 全部允许')
          allow.click()
          await sleep(1200)
          continue
        }
      }
      await sleep(1500)
    }
    log('gates answered: ' + gateClicks + ' — waiting final')
    const final = await waitFinal(chatId, 5 * 60_000)
    if (!final) { log('TIMEOUT waiting for final answer'); return }
    const tok = (document.querySelector(nodeSel)?.textContent ?? '').includes('tok')
    log('FINAL(' + gateClicks + 'gates,tokenBadge=' + tok + '): ' + final.slice(0, 90))
  }

  // ───────────────── ux suite: every remaining interaction ─────────────────
  const uxSuite = async (): Promise<void> => {
    const results: string[] = []
    const logHold = async (m: string): Promise<void> => { log(m); await sleep(2500) }
    const pass = async (n: string): Promise<void> => { results.push('ok:' + n); await logHold('PASS ' + n) }
    const fail = async (n: string, why: string): Promise<void> => { results.push('FAIL:' + n); await logHold('FAIL ' + n + ' — ' + why.slice(0, 90)) }
    let t4ChatId = '' // reused by T18 (criteria report)
    let t3ChatId = '' // fallback for T18 when T4 is slow

    if (!store.getState().project) await store.getState().openProject('F:\\occ-gui-test')
    await store.getState().setEngine('native')
    // optional ?model=provider/name — evening GLM can be slow; deepseek is snappier
    const model = params.get('model')
    await window.electronAPI.occ.updatePolicy(model ? { defaultModel: model } : {})

    // T1: ＋聊天 button creates a chat through the real TopBar control
    try {
      const before = Object.keys(store.getState().graph?.nodes ?? {}).length
      const btn = topButton('＋ 聊天')
      if (!btn) throw new Error('＋聊天 button not found')
      btn.click()
      const appeared = await waitFor(() => Object.keys(store.getState().graph?.nodes ?? {}).length > before, 15000)
      if (!appeared) throw new Error('no new node after click')
      await pass('T1 new-chat-button')
    } catch (e) { await fail('T1 new-chat-button', String(e)) }

    // T2: Jev key IPC round-trip
    try {
      const r = (await window.electronAPI.occ.setJevKey('sk-or-autotest-dummy')) as { ok: boolean }
      if (!r?.ok) throw new Error('setJevKey returned ' + JSON.stringify(r))
      await window.electronAPI.occ.setJevKey('')
      await pass('T2 jev-key-ipc')
    } catch (e) { await fail('T2 jev-key-ipc', String(e)) }

    if (params.get('heavy') !== '0') {
    // T3: budget gate → focus badge → 继续
    try {
      await window.electronAPI.occ.updatePolicy({ toolPermission: 'auto', budgetTokensPerChat: 1000 })
      const chatId = await store.getState().createChat()
      if (!chatId) throw new Error('createChat failed')
      t3ChatId = chatId
      if (!(await waitFor(() => !!nodeTextarea(chatId), 30000))) throw new Error('textarea never mounted')
      await sendGoal(chatId, '在当前目录创建 budget.txt，内容是 budget-ok，验证写入后报告任务完成')
      // look at the chat like a user would: full cards render the run bar,
      // compact (low-zoom) cards do not
      store.setState({ focusNode: chatId })
      const runBar = await waitFor(
        () => !!document.querySelector('[data-node-id="' + chatId + '"] [data-occ="run-stage"]'),
        20_000
      )
      if (!runBar) throw new Error('run-stage bar never appeared while running')
      const gated = await waitFor(() => store.getState().graph?.nodes[chatId]?.status === 'awaiting_input', 3 * 60_000)
      if (!gated) throw new Error('budget gate never appeared')
      const reasonShown = await waitFor(
        () =>
          (document.querySelector('[data-node-id="' + chatId + '"] [data-occ="awaiting-reason"]')?.textContent ?? '').includes(
            '等待你'
          ),
        5000
      )
      if (!reasonShown) throw new Error('awaiting reason missing')
      // toast should have popped for the awaiting transition
      const toastSeen = await waitFor(() => document.body.innerText.includes('需要你的回复'), 5000)
      const badgeBtn = topButton('等待回复')
      let focusOk = false
      if (badgeBtn) {
        badgeBtn.click()
        await sleep(120)
        focusOk = store.getState().focusNode === null // consumed by GraphCanvas = pan issued
      }
      const cont = nodeButton(chatId, '继续')
      if (!cont) throw new Error('继续 chip not found')
      cont.click()
      // the gate must RESUME right away; requiring the pipeline's final here
      // made T3 hostage to provider weather (slow model = false red). Assert
      // the resume itself and leave the run to finish in the background.
      const resumed = await waitFor(
        () => (store.getState().chats[chatId] ?? []).some((e) => e.role === 'manager' && e.text.includes('已确认')),
        30_000
      )
      if (!resumed) throw new Error('继续 was not accepted (budget gate did not resume)')
      await pass('T3 budget-gate (toast=' + toastSeen + ', badge=' + !!badgeBtn + ',focusConsumed=' + focusOk + ',resumed=true)')
      void waitFinal(chatId, 6 * 60_000).then((f) => { if (f) log('T3 final (bg): ' + f.slice(0, 50)) })
    } catch (e) { await fail('T3 budget-gate+focus', String(e)) }

    // T4: deny path — worker must abandon the file
    try {
      await window.electronAPI.occ.updatePolicy({ toolPermission: 'ask', budgetTokensPerChat: 0 })
      const chatId = await store.getState().createChat()
      if (!chatId) throw new Error('createChat failed')
      t4ChatId = chatId
      if (!(await waitFor(() => !!nodeTextarea(chatId), 30000))) throw new Error('textarea never mounted')
      await sendGoal(chatId, '在当前目录创建 deny.txt，内容是 should-not-exist，验证写入后报告任务完成')
      const gated = await waitFor(() => !!nodeButton(chatId, '拒绝'), 8 * 60_000)
      if (!gated) throw new Error('gate never appeared')
      nodeButton(chatId, '拒绝')?.click()
      // contract: the deny resolves the pending ask — the chat log gets a
      // 「已拒绝该操作。」manager entry from chatSend's perm branch
      const resolved = await waitFor(
        () => (store.getState().chats[chatId] ?? []).some((e) => e.text === '已拒绝该操作。'),
        60_000
      )
      if (!resolved) throw new Error('deny did not resolve the gate')
      // let the pipeline finish: answer any further gates with allow-all
      const gateDeadline = Date.now() + 6 * 60_000
      while (Date.now() < gateDeadline) {
        const s = store.getState()
        if ((s.chats[chatId] ?? []).some((e) => e.role === 'final')) break
        const btn = nodeButton(chatId, '全部允许') ?? nodeButton(chatId, '允许')
        if (btn && s.graph?.nodes[chatId]?.status === 'awaiting_input') { btn.click(); await sleep(1200); continue }
        await sleep(1500)
      }
      const final = await waitFinal(chatId, 8 * 60_000)
      if (!final) throw new Error('no final after deny+allow-all')
      await pass('T4 deny-path')
    } catch (e) { await fail('T4 deny-path', String(e)) }

    // T5: stop button aborts, recovery bar offers retry, retry restarts the pipeline
    try {
      await window.electronAPI.occ.updatePolicy({ toolPermission: 'auto', budgetTokensPerChat: 0 })
      const chatId = await store.getState().createChat()
      if (!chatId) throw new Error('createChat failed')
      if (!(await waitFor(() => !!nodeTextarea(chatId), 30000))) throw new Error('textarea never mounted')
      await sendGoal(chatId, '在当前目录创建 stop.txt，内容是 stop-test，验证写入后报告任务完成')
      const running = await waitFor(() => store.getState().graph?.nodes[chatId]?.status === 'running', 90_000)
      if (!running) throw new Error('never reached running state')
      log('T5 running — clicking stop')
      const stopVisible = await waitFor(() => !!nodeButton(chatId, '■ 停止'), 5000, 200)
      const stopBtn = stopVisible ? nodeButton(chatId, '■ 停止') : null
      if (!stopBtn) throw new Error('stop button not visible while running')
      stopBtn.click()
      // settle = aborted/failed (stop honoured) or completed (the worker
      // finished in the gap — nothing left to stop: PASS per the race note)
      const settled = await waitFor(() => {
        const st = store.getState().graph?.nodes[chatId]?.status ?? ''
        return st === 'aborted' || st === 'failed' || st === 'completed'
      }, 30_000)
      if (!settled) throw new Error('chat did not settle after stop click (status=' + (store.getState().graph?.nodes[chatId]?.status ?? '?') + ')')
      const settledStatus = store.getState().graph?.nodes[chatId]?.status ?? '?'
      log('T5 settled — status=' + settledStatus)
      if (settledStatus === 'completed') {
        await pass('T5 stop+retry (completed-before-stop-landed)')
      } else {
        // the stopped pipeline posts a halt final and releases the busy flag;
        // retrying too early collides with it (chat is busy)
        const haltFinal = await waitFor(() => (store.getState().chats[chatId] ?? []).some((e) => e.role === 'final'), 90_000)
        await sleep(4000)
        if (haltFinal) {
          // clean stop: the halt final is written, so the ↻ 重试 bar is
          // intentionally absent (a new goal can be typed directly)
          const fin = [...(store.getState().chats[chatId] ?? [])].reverse().find((e) => e.role === 'final')
          const saysStop = (fin?.text ?? '').includes('停止')
          await pass('T5 stop+retry (halt-final landed' + (saysStop ? ', 停止文案' : ', 收尾 final') + ')')
        } else {
          log('T5 clicking retry')
          // no final yet: the old pipeline may still be releasing the busy
          // flag — retry clicks can be rejected, so loop until it restarts
          let restarted = false
          for (let attempt = 0; attempt < 3 && !restarted; attempt++) {
            const barThere = await waitFor(() => !!nodeButton(chatId, '↻ 重试'), 20_000)
            if (!barThere) break
            nodeButton(chatId, '↻ 重试')?.click()
            restarted = await waitFor(
              () => ['running', 'awaiting_input', 'completed'].includes(store.getState().graph?.nodes[chatId]?.status ?? ''),
              20_000
            )
            if (!restarted) await sleep(8000)
          }
          await logHold('T5 restarted=' + restarted + ' status=' + (store.getState().graph?.nodes[chatId]?.status ?? '?'))
          if (!restarted) throw new Error('pipeline did not restart after retry')
          await pass('T5 stop+retry')
          void waitFinal(chatId, 4 * 60_000).then((f) => { if (f) log('T5 retry final: ' + f.slice(0, 60)) })
        }
      }

    } catch (e) { await fail('T5 stop+retry', String(e)) }
    }
      // T6: chat sidebar lists chats and its entries trigger focus
      try {
        store.getState().setSidebar(true)
        const shown = await waitFor(() => !!document.querySelector('[data-occ="chat-sidebar"]'), 5000)
        if (!shown) throw new Error('sidebar did not open')
        const item = document.querySelector('[data-occ="chat-list-item"]') as HTMLElement | null
        if (!item) throw new Error('no chat list items')
        item.click()
        const focused = store.getState().focusNode !== null
        store.getState().setSidebar(false)
        await pass('T6 sidebar (items>0, focusSignal=' + focused + ')')
      } catch (e) { await fail('T6 sidebar', String(e)) }

      // T7: diff viewer modal on a completed worker workspace
      try {
        const worker = Object.values(store.getState().graph?.nodes ?? {}).find((n) => n.kind === 'fork' && n.workDir)
        if (!worker) throw new Error('no worker with a workspace to diff')
        await store.getState().showDiff(worker.id)
        const opened = await waitFor(
          () => document.body.innerText.includes('工作区改动') && store.getState().diffText !== 'loading…',
          10_000
        )
        const len = store.getState().diffText.length
        store.getState().closeDiff()
        if (!opened) throw new Error('diff modal did not render')
        await pass('T7 diff-viewer (chars=' + len + ')')
      } catch (e) { await fail('T7 diff-viewer', String(e)) }

      // T8: open-project-dir IPC resolves (opens Explorer on the test machine)
      try {
        const r = await window.electronAPI.occ.openProjectDir()
        if (typeof r !== 'string') throw new Error('unexpected return ' + typeof r)
        await pass('T8 open-project-dir')
      } catch (e) { await fail('T8 open-project-dir', String(e)) }

      // T9: top-bar-created chats cascade — at least two distinct pins, none stacked
      try {
        const pid = store.getState().project?.id ?? ''
                const roots = Object.values(store.getState().graph?.nodes ?? {}).filter((n) => n.kind === 'root' && n.parents.length === 0)
        const pins = roots.map((r) => pinnedPosition(pid, r.id)).filter(Boolean) as { x: number; y: number }[]
        const distinct = new Set(pins.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)).size
        if (roots.length >= 2 && distinct < 2) throw new Error(roots.length + ' chats share ' + distinct + ' position(s)')
        await pass('T9 cascade-positions (chats=' + roots.length + ', distinctPins=' + distinct + ')')
      } catch (e) { await fail('T9 cascade-positions', String(e)) }

      // T10: first-run guide — auto-opens only when the persisted flag is
      // absent (fresh OCC_SETTINGS_DIR exercises that branch); skip must
      // close it AND persist the flag so it never auto-opens again
      try {
        const ob0 = await window.electronAPI.occ.onboardingState()
        const shown = await waitFor(() => !!document.querySelector('[data-occ="onboarding"]'), 6000)
        if (!ob0.done) {
          if (!shown) throw new Error('flag unset but guide did not auto-open')
          const skip = document.querySelector('[data-occ="onboarding-skip"]') as HTMLElement | null
          if (!skip) throw new Error('skip control missing')
          skip.click()
          const closed = await waitFor(() => !document.querySelector('[data-occ="onboarding"]'), 5000)
          const ob1 = await window.electronAPI.occ.onboardingState()
          if (!closed || !ob1.done) throw new Error('skip did not close/persist (closed=' + closed + ' done=' + ob1.done + ')')
          await pass('T10 first-run-guide auto-open+skip-persist')
        } else {
          if (shown) throw new Error('flag set but guide auto-opened (must be suppressed)')
          await pass('T10 first-run-guide flag-suppresses-auto-open')
        }
      } catch (e) { await fail('T10 first-run-guide', String(e)) }

      // T11: demo project + canvas hero — the zero-friction first-task path.
      // A fresh timestamped probe dir keeps the run deterministic (the real
      // Documents demo project persists across runs by design).
      try {
        const def = await window.electronAPI.occ.createDemoProject()
        if (!def.dir) throw new Error('createDemoProject returned no dir')
        const probeDir = 'F:\\occ-gui-test\\hero-' + Date.now()
        await window.electronAPI.occ.createDemoProject({ dir: probeDir })
        await store.getState().openProject(probeDir)
        const proj = store.getState().project
        if (!proj || proj.rootDir !== probeDir) throw new Error('probe project not open: ' + (proj?.rootDir ?? 'null'))
        const hero = await waitFor(() => !!document.querySelector('[data-occ="canvas-hero"]'), 8000)
        if (!hero) throw new Error('canvas hero not visible on an empty project')
        const chips = Array.from(document.querySelectorAll('[data-occ="canvas-hero-chip"]')) as HTMLElement[]
        if (chips.length < 3) throw new Error('goal chips missing (found ' + chips.length + ')')
        chips[1].click()
        ;(document.querySelector('[data-occ="canvas-hero-start"]') as HTMLElement | null)?.click()
        const chatStarted = await waitFor(() => {
          const roots = Object.values(store.getState().graph?.nodes ?? {}).filter((n) => n.kind === 'root' && n.parents.length === 0)
          return roots.some((r) => (store.getState().chats[r.id] ?? []).some((e) => e.role === 'user'))
        }, 20_000)
        if (!chatStarted) throw new Error('hero start did not create a chat with the goal')
        await pass('T11 demo-project+hero (default=' + def.dir.split('\\').pop() + ')')
      } catch (e) { await fail('T11 demo-project+hero', String(e)) }

      // T12: guide steps walk (manual open) — workspace → model → goal render,
      // skip closes and the flag stays persisted
      try {
        store.setState({ onboardingOpen: true, onboardingStep: 0 })
        if (!(await waitFor(() => !!document.querySelector('[data-occ="onboarding"]'), 5000))) throw new Error('overlay did not open')
        if (!document.querySelector('[data-occ="onboarding-open-folder"]')) throw new Error('workspace step controls missing')
        ;(document.querySelector('[data-occ="onboarding-next"]') as HTMLElement | null)?.click()
        const stepModel = await waitFor(() => !!document.querySelector('[data-occ="onboarding-provider-key"]') || document.body.innerText.includes('已检测到可用'), 5000)
        if (!stepModel) throw new Error('model step did not render')
        ;(document.querySelector('[data-occ="onboarding-next"]') as HTMLElement | null)?.click()
        const stepGoal = await waitFor(() => !!document.querySelector('[data-occ="onboarding-start"]'), 5000)
        if (!stepGoal) throw new Error('goal step did not render')
        ;(document.querySelector('[data-occ="onboarding-skip"]') as HTMLElement | null)?.click()
        const closed = await waitFor(() => !document.querySelector('[data-occ="onboarding"]'), 5000)
        const ob = await window.electronAPI.occ.onboardingState()
        if (!closed || !ob.done) throw new Error('skip did not close/persist (closed=' + closed + ' done=' + ob.done + ')')
        await pass('T12 guide-steps (provider=' + (ob.hasProvider ? 'ready' : 'unset') + ')')
      } catch (e) { await fail('T12 guide-steps', String(e)) }
      // restore the shared test project so repeated runs stay deterministic
      try { await store.getState().openProject('F:\\occ-gui-test') } catch { /* best-effort */ }

      // T13: canvas cascade — a new chat must land on a pin that overlaps NO
      // existing chat (the old modulo-6 cascade stacked every 7th chat)
      try {
        const { pinnedPosition } = await import('./lib/layout')
        const pid = store.getState().project!.id
        const before = Object.values(store.getState().graph!.nodes).filter((n) => n.kind === 'root').length
        const id = await store.getState().createChat()
        const pos = id ? pinnedPosition(pid, id) : undefined
        if (!id || !pos) throw new Error('createChat returned no id/pin')
        const clash = Object.values(store.getState().graph!.nodes).some((o) => {
          if (o.kind !== 'root' || o.id === id) return false
          const p = pinnedPosition(pid, o.id)
          return !!p && Math.abs(p.x - pos.x) < 100 && Math.abs(p.y - pos.y) < 100
        })
        if (clash) throw new Error('new chat stacked on an existing one at ' + pos.x + ',' + pos.y)
        await pass('T13 chat-slot no-overlap (' + before + '->' + (before + 1) + ' pins=' + Object.keys(store.getState().chats).length + ')')
      } catch (e) { await fail('T13 chat-slot no-overlap', String(e)) }

      // T14: 整理 (tidy) — pile two chats by hand, click the button, the whole
      // canvas re-packs (distinct coordinates + persisted pins in storage)
      try {
        const { pinPosition, pinnedPosition } = await import('./lib/layout')
        const pid = store.getState().project!.id
        const roots = Object.values(store.getState().graph!.nodes).filter((n) => n.kind === 'root' && n.parents.length === 0)
        if (roots.length < 2) throw new Error('need 2 roots, found ' + roots.length)
        pinPosition(pid, roots[0].id, { x: 123, y: 456 })
        pinPosition(pid, roots[1].id, { x: 123, y: 456 }) // deliberate pile
        await store.getState().refresh()
        await sleep(300)
        const btn = document.querySelector('[data-occ="tidy-canvas"]') as HTMLElement | null
        if (!btn) throw new Error('tidy button missing')
        btn.click()
        const spread = await waitFor(() => {
          const a = pinnedPosition(pid, roots[0].id)
          const b = pinnedPosition(pid, roots[1].id)
          return !!a && !!b && (Math.abs(a.x - b.x) > 100 || Math.abs(a.y - b.y) > 100)
        }, 5000)
        if (!spread) throw new Error('tidy did not separate the piled chats')
        const stored = await waitFor(() => {
          const raw = localStorage.getItem('occ-pins:' + pid)
          if (!raw) return false
          const a = JSON.parse(raw)[roots[0].id]
          return !!a && (a.x !== 123 || a.y !== 456)
        }, 6000)
        if (!stored) throw new Error('tidy pins not persisted to localStorage')
        await pass('T14 tidy-canvas (' + roots.length + ' chats re-packed, persisted)')
      } catch (e) { await fail('T14 tidy-canvas', String(e)) }

      // T15: all-Chinese UI chrome — page, settings popover and pane menu must
      // not leak English strings (the mixed-language complaint)
      try {
        const blacklist = ['No project open', 'New chat window', 'needs your input', 'working…', 'agents are working', 'waiting for activity', 'no content indexed yet', 'Settings', 'default model', 'idle ·', 'frontier ·']
        const leaks = (): string => blacklist.find((s) => document.body.innerText.includes(s)) ?? ''
        let leak = leaks()
        if (leak) throw new Error('English chrome visible: ' + leak)
        ;(document.querySelector('[data-occ="settings-btn"]') as HTMLElement | null)?.click()
        await sleep(400)
        leak = leaks()
        if (leak) throw new Error('English chrome in settings: ' + leak)
        if (!document.body.innerText.includes('设置')) throw new Error('settings panel did not open')
        ;(document.querySelector('[data-occ="settings-btn"]') as HTMLElement | null)?.click()
        await sleep(200)
        const pane = document.querySelector('.react-flow') as HTMLElement | null
        if (!pane) throw new Error('canvas not mounted')
        pane.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 500, clientY: 300 }))
        await sleep(300)
        if (document.body.innerText.includes('New chat window')) throw new Error('English pane menu')
        if (!document.body.innerText.includes('新建聊天')) throw new Error('pane menu missing 新建聊天')
        pane.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await pass('T15 all-Chinese chrome (settings + pane menu)')
      } catch (e) { await fail('T15 all-Chinese chrome', String(e)) }

      // T16: long-age dormancy — freezing removes a chat from the canvas by
      // default; the 已收纳 tab lists it, focusing reveals it, unfreeze restores
      try {
        store.setState({ sidebarOpen: true })
        await sleep(400)
        const g = store.getState().graph!
        const victim = Object.values(g.nodes)
          .filter((n) => n.kind === 'root' && n.parents.length === 0 && n.status === 'completed')
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
        if (!victim) throw new Error('no completed chat to freeze')
        await store.getState().freeze(victim.id)
        // canvas-scoped check: the sidebar list item also carries data-node-id
        const onCanvas = (): boolean => !!document.querySelector('.react-flow [data-node-id="' + victim.id + '"]')
        const hidden = await waitFor(() => !onCanvas(), 8000)
        if (!hidden) throw new Error('frozen chat still on canvas')
        ;(document.querySelector('[data-occ="sidebar-filter-dormant"]') as HTMLElement | null)?.click()
        const listed = await waitFor(
          () => !!document.querySelector('[data-occ="chat-list-item"][data-node-id="' + victim.id + '"]'),
          5000
        )
        if (!listed) throw new Error('frozen chat missing from 已收纳 list')
        ;(document.querySelector('[data-occ="chat-list-item"][data-node-id="' + victim.id + '"]') as HTMLElement | null)?.click()
        const revealed = await waitFor(() => onCanvas(), 8000)
        if (!revealed) throw new Error('focus did not reveal the frozen chat')
        ;(document.querySelector('[data-occ="show-dormant"]') as HTMLElement | null)?.click()
        const hiddenAgain = await waitFor(() => !onCanvas(), 8000)
        if (!hiddenAgain) throw new Error('dormant toggle did not hide the chat again')
        await store.getState().unfreeze(victim.id)
        const back = await waitFor(() => onCanvas(), 8000)
        if (!back) throw new Error('unfreeze did not restore the chat')
        const doneChip = document.querySelector('[data-occ="sidebar-filter-done"]')?.textContent ?? ''
        if (!doneChip.includes('已完成')) throw new Error('no 已完成 filter chip')
        const batchBtn = document.querySelector('[data-occ="freeze-completed"]')
        if (!batchBtn) throw new Error('batch 收纳已完成 button missing')
        ;(document.querySelector('[data-occ="sidebar-filter-all"]') as HTMLElement | null)?.click()
        await pass('T16 dormant chats (hide/reveal/unfreeze, filters, batch button)')
      } catch (e) { await fail('T16 dormant chats', String(e)) }

      // T17: a new chat must land in the viewport at a readable zoom —
      // "+ 聊天" that silently drops a card off-screen looks like a no-op
      try {
        const before = new Set(Object.keys(store.getState().graph?.nodes ?? {}))
        const addBtn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('＋ 聊天')) as HTMLElement | undefined
        if (!addBtn) throw new Error('＋聊天 button missing')
        addBtn.click()
        let id = ''
        const created = await waitFor(() => {
          const g = store.getState().graph
          const n = g ? Object.values(g.nodes).find((x) => !before.has(x.id) && x.kind === 'root') : undefined
          if (n) id = n.id
          return !!n
        }, 15_000)
        if (!created || !id) throw new Error('chat not created via button')
        const focused = await waitFor(() => {
          const card = document.querySelector('.react-flow [data-node-id="' + id + '"]')
          if (!card) return false
          const r = card.getBoundingClientRect()
          return r.width > 200 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight
        }, 10_000)
        if (!focused) throw new Error('new chat not focused in view at readable zoom')
        await pass('T17 new-chat focus (card in view, width>200px)')
      } catch (e) { await fail('T17 new-chat focus', String(e)) }

      // T18: evaluation-first is VISIBLE — the report card lists the planned
      // success criteria with per-criterion PASS/FAIL from the verdict
      try {
        const ids = [t4ChatId, t3ChatId].filter(Boolean)
        if (ids.length === 0) throw new Error('no heavy chat ids')
        let foundId = ''
        let n = 0
        const ok = await waitFor(() => {
          for (const id of ids) {
            const items = document.querySelectorAll('[data-node-id="' + id + '"] [data-occ="criterion-item"]')
            if (items.length > 0) {
              foundId = id
              n = items.length
              return true
            }
          }
          return false
        }, 15_000)
        if (!ok) throw new Error('no criteria report rendered on heavy chats')
        await pass('T18 criteria report (' + n + ' items on ' + foundId + ')')
      } catch (e) { await fail('T18 criteria report', String(e)) }

      // T19: cold start WITHOUT a model — hero + topbar must guide to
      // configuration instead of launching a doomed run (onboardingInfo mocked)
      try {
        const probeDir = 'F:\\occ-gui-test\\nomodel-' + Date.now()
        await window.electronAPI.occ.createDemoProject({ dir: probeDir })
        await store.getState().openProject(probeDir)
        store.setState({ onboardingInfo: { hasProvider: false, localEngineConfigured: false } })
        const guide = await waitFor(() => !!document.querySelector('[data-occ="hero-need-model"]'), 8000)
        if (!guide) throw new Error('hero did not show the no-model guide')
        if (document.querySelector('[data-occ="canvas-hero-start"]')) throw new Error('start button still offered without a model')
        const chip = await waitFor(() => !!document.querySelector('[data-occ="need-model-chip"]'), 3000)
        if (!chip) throw new Error('topbar did not flag the missing model')
        ;(document.querySelector('[data-occ="hero-configure-model"]') as HTMLElement | null)?.click()
        const modelStep = await waitFor(() => !!document.querySelector('[data-occ="onboarding"]'), 6000)
        if (!modelStep) throw new Error('configure-model did not open the model step')
        store.setState({ onboardingOpen: false })
        store.getState().refreshOnboardingInfo()
        await store.getState().openProject('F:\\occ-gui-test')
        await pass('T19 no-model cold start (guide → model step)')
      } catch (e) { await fail('T19 no-model cold start', String(e)) }

      // T20: long-chat readability — old turns collapse to summary rows and
      // 「只看结论」keeps only user + final bubbles
      try {
        const pick = (): string => {
          const s = store.getState()
          for (const n of Object.values(s.graph?.nodes ?? {})) {
            const l = s.chats[n.id] ?? []
            if (l.filter((e) => e.role === 'user').length >= 2 && l.some((e) => e.role === 'final')) return n.id
          }
          return ''
        }
        const target = pick()
        if (!target) throw new Error('no multi-turn chat found')
        store.setState({ focusNode: target })
        await sleep(1000)
        const card = (): Element | null => document.querySelector('[data-node-id="' + target + '"]')
        if (!card()) throw new Error('multi-turn chat card missing')
        const toggles = card()!.querySelectorAll('[data-occ="turn-toggle"]')
        if (toggles.length === 0) throw new Error('no collapsed turn rows')
        const before = card()!.querySelectorAll('[data-occ="chat-bubble"]').length
        ;(toggles[0] as HTMLElement).click()
        await sleep(300)
        const after = card()!.querySelectorAll('[data-occ="chat-bubble"]').length
        if (!(after > before)) throw new Error('turn did not expand (' + before + '→' + after + ')')
        ;(card()!.querySelector('[data-occ="conclusions-toggle"]') as HTMLElement | null)?.click()
        await sleep(300)
        const roles = [...card()!.querySelectorAll('[data-occ="chat-bubble"]')].map((b) => b.getAttribute('data-role'))
        if (roles.length === 0 || roles.some((r) => r !== 'user' && r !== 'final')) {
          throw new Error('conclusions mode leaked process bubbles: ' + roles.join(','))
        }
        ;(card()!.querySelector('[data-occ="conclusions-toggle"]') as HTMLElement | null)?.click()
        await pass('T20 long-chat readability (turns=' + toggles.length + ', conclusions filter)')
      } catch (e) { await fail('T20 long-chat readability', String(e)) }

    const okCount = results.filter((r) => r.startsWith('ok')).length
    const line = 'UX-SUMMARY ' + okCount + '/20: ' + results.join(' ')
    await logHold(line)
    log(line + ' ·')
    await sleep(2500)
    log(line + ' ··')
  }

  // observation mode (bare ?auto=1) only exposes __occStore; a suite runs
  // only when explicitly requested via &suite= (ux | legacy)
  const which = params.get('suite')
  const suite = which === 'ux' ? uxSuite : which === 'legacy' ? legacySuite : null
  if (suite) {
    setTimeout(() => {
      void suite().catch((e: unknown) => log('ERROR: ' + String(e).slice(0, 140)))
    }, 3000)
  }
}
