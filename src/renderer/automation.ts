// Dev-only scripted GUI automation (?auto=1): drives the REAL rendered UI —
// native textarea value setter + DOM events on the live React Flow nodes —
// and reports progress via document.title (main process polls it to a file).
// Exercises the full UX loop: goal → permission gate → one-click reply → final,
// plus token badge visibility and last-project auto-restore.
import { useOccStore } from './store/occStore'

export function initAutomation(): void {
  if (!new URLSearchParams(window.location.search).has('auto')) return
  const store = useOccStore
  ;(window as unknown as { __occStore: unknown }).__occStore = store

  const log = (m: string): void => {
    document.title = 'OCC-AUTOTEST: ' + m.slice(0, 140)
  }

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  setTimeout(async () => {
    try {
      // launch auto-restore: on 2nd+ run the project is already open before we act
      const wasRestored = !!store.getState().project
      log(wasRestored ? 'auto-restore OK (project already open)' : 'first run — opening project')
      if (!wasRestored) await store.getState().openProject('F:\\occ-gui-test')
      await store.getState().setEngine('native')
      // force gates ON so the GUI gate flow is exercised end-to-end
      await window.electronAPI.occ.updatePolicy({ toolPermission: 'ask', budgetTokensPerChat: 0 })
      log('project ready, creating chat')
      const chatId = await store.getState().createChat()
      if (!chatId) throw new Error('createChat failed')

      const nodeSel = `.react-flow__node[data-id="${chatId}"]`
      const sel = nodeSel + ' textarea'
      let tries = 0
      while (!document.querySelector(sel) && tries < 60) {
        await sleep(500)
        tries++
      }
      if (!document.querySelector(sel)) throw new Error('chat textarea never mounted')
      log('textarea mounted, typing goal')

      const el = document.querySelector(sel) as HTMLTextAreaElement
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      if (!setter) throw new Error('no value setter')
      setter.call(el, '在当前目录创建 auto.txt，内容是 driven-by-gui，验证写入后报告任务完成')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      log('goal sent via real DOM events')

      // answer gates as they appear (allow-all covers the worker's repeated
      // bash/write calls), until the final verdict arrives
      const gateDeadline = Date.now() + 3 * 60_000
      let gateClicks = 0
      while (Date.now() < gateDeadline) {
        const s = store.getState()
        const entries = s.chats[chatId] ?? []
        if (entries.some((e) => e.role === 'final')) break
        const node = s.graph?.nodes[chatId]
        if (node?.status === 'awaiting_input') {
          const btns = Array.from(document.querySelectorAll(nodeSel + ' button')) as HTMLButtonElement[]
          const allow = btns.find((b) => b.textContent?.trim() === '全部允许') ?? btns.find((b) => b.textContent?.trim() === '允许')
          if (allow) {
            gateClicks++
            if (gateClicks === 1) {
              const badgeSeen = document.body.innerText.includes('等待回复')
              log('gate bar rendered (topBadge=' + badgeSeen + ') — clicking 全部允许')
            }
            allow.click()
            await sleep(1200)
            continue
          }
        }
        await sleep(1500)
      }
      log('gates answered: ' + gateClicks + ' — waiting final')

      const deadline2 = Date.now() + 5 * 60_000
      while (Date.now() < deadline2) {
        const s = store.getState()
        const entries = s.chats[chatId] ?? []
        const final = entries.filter((e) => e.role === 'final').pop()
        if (final) {
          const nodeText = document.querySelector(nodeSel)?.textContent ?? ''
          const tok = nodeText.includes('tok')
          log('FINAL(' + gateClicks + 'gates,tokenBadge=' + tok + '): ' + final.text.slice(0, 90))
          return
        }
        await sleep(2000)
      }
      log('TIMEOUT waiting for final answer')
    } catch (e) {
      log('ERROR: ' + String(e).slice(0, 140))
    }
  }, 3000)
}
