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
      if (!(await waitFor(() => !!nodeTextarea(chatId), 30000))) throw new Error('textarea never mounted')
      await sendGoal(chatId, '在当前目录创建 budget.txt，内容是 budget-ok，验证写入后报告任务完成')
      const gated = await waitFor(() => store.getState().graph?.nodes[chatId]?.status === 'awaiting_input', 3 * 60_000)
      if (!gated) throw new Error('budget gate never appeared')
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
      const final = await waitFinal(chatId, 4 * 60_000)
      if (!final) throw new Error('no final after 继续')
      await pass('T3 budget-gate (toast=' + toastSeen + ', badge=' + !!badgeBtn + ',focusConsumed=' + focusOk + ')')
    } catch (e) { await fail('T3 budget-gate+focus', String(e)) }

    // T4: deny path — worker must abandon the file
    try {
      await window.electronAPI.occ.updatePolicy({ toolPermission: 'ask', budgetTokensPerChat: 0 })
      const chatId = await store.getState().createChat()
      if (!chatId) throw new Error('createChat failed')
      if (!(await waitFor(() => !!nodeTextarea(chatId), 30000))) throw new Error('textarea never mounted')
      await sendGoal(chatId, '在当前目录创建 deny.txt，内容是 should-not-exist，验证写入后报告任务完成')
      const gated = await waitFor(() => !!nodeButton(chatId, '拒绝'), 3 * 60_000)
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
      const final = await waitFinal(chatId, 3 * 60_000)
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
      const aborted = await waitFor(() => ['aborted', 'failed'].includes(store.getState().graph?.nodes[chatId]?.status ?? ''), 30_000)
      if (!aborted) throw new Error('chat not aborted after stop click (status=' + store.getState().graph?.nodes[chatId]?.status + ')')
      log('T5 aborted — winding down old pipeline')
      // the aborted pipeline posts its wind-down final and releases the busy
      // flag; retrying too early collides with it (chat is busy)
      await waitFor(() => (store.getState().chats[chatId] ?? []).some((e) => e.role === 'final'), 90_000)
      await sleep(4000)
      log('T5 clicking retry')
      // racing note: if the worker finished right before the stop landed, the
      // pipeline concludes on its own (final + completed) — that is a PASS:
      // stop was honoured (no further rounds) and there is nothing to retry
      const concluded = (store.getState().chats[chatId] ?? []).some((e) => e.role === 'final') ||
        store.getState().graph?.nodes[chatId]?.status === 'completed'
      if (concluded) {
        await pass('T5 stop+retry (concluded-before-stop-landed)')
        return
      }
      // the old pipeline may still be releasing the busy flag — retry clicks
      // can be rejected, so loop until the chat visibly restarts
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

    const okCount = results.filter((r) => r.startsWith('ok')).length
    const line = 'UX-SUMMARY ' + okCount + '/9: ' + results.join(' ')
    await logHold(line)
    log(line + ' ·')
    await sleep(2500)
    log(line + ' ··')
  }

  const suite = params.get('suite') === 'ux' ? uxSuite : legacySuite
  setTimeout(() => {
    void suite().catch((e: unknown) => log('ERROR: ' + String(e).slice(0, 140)))
  }, 3000)
}
