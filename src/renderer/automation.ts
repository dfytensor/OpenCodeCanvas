// Dev-only scripted GUI automation (?auto=1): drives the REAL rendered UI —
// native textarea value setter + DOM events on the live React Flow nodes —
// and reports progress via document.title (main process polls it to a file).
import { useOccStore } from './store/occStore'

export function initAutomation(): void {
  if (!new URLSearchParams(window.location.search).has('auto')) return
  const store = useOccStore
  ;(window as unknown as { __occStore: unknown }).__occStore = store

  const log = (m: string): void => {
    document.title = 'OCC-AUTOTEST: ' + m.slice(0, 140)
  }

  setTimeout(async () => {
    try {
      log('opening project')
      await store.getState().openProject('F:\\occ-gui-test')
      await store.getState().setEngine('native')
      log('project open, creating chat')
      const chatId = await store.getState().createChat()
      if (!chatId) throw new Error('createChat failed')
      log('chat created: ' + chatId)

      const sel = `.react-flow__node[data-id="${chatId}"] textarea`
      let tries = 0
      while (!document.querySelector(sel) && tries < 60) {
        await new Promise((r) => setTimeout(r, 500))
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
      log('goal sent via real DOM events, waiting for final')

      const deadline = Date.now() + 5 * 60_000
      while (Date.now() < deadline) {
        const s = store.getState()
        const entries = s.chats[chatId] ?? []
        const final = entries.filter((e) => e.role === 'final').pop()
        if (final) {
          log('FINAL: ' + final.text.slice(0, 110))
          return
        }
        await new Promise((r) => setTimeout(r, 2000))
      }
      log('TIMEOUT waiting for final answer')
    } catch (e) {
      log('ERROR: ' + String(e).slice(0, 140))
    }
  }, 3000)
}
