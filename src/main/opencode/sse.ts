// SSE subscription to opencode's /event stream with manual line parsing
// (fetch Web Stream + TextDecoder — no EventSource, so we can send Basic auth).
import { basicAuthHeader, getServer } from './server'

export interface SseHandlers {
  onEvent: (event: { type: string; properties?: unknown }) => void
  onDown?: () => void
  onUp?: () => void
}

const MIN_BACKOFF = 1000
const MAX_BACKOFF = 10000

export function subscribeEvents(handlers: SseHandlers): () => void {
  const ctrl = new AbortController()
  let stopped = false
  let backoff = MIN_BACKOFF
  let up = false

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  async function loop(): Promise<void> {
    while (!stopped) {
      const h = await getServer()
      if (!h) {
        // server not up yet — retry shortly
        await sleep(1000)
        continue
      }
      try {
        const res = await fetch(`${h.baseUrl}/event`, {
          headers: { Authorization: basicAuthHeader(h) },
          signal: ctrl.signal
        })
        if (!res.ok || !res.body) throw new Error(`event stream HTTP ${res.status}`)

        if (!up) {
          up = true
          backoff = MIN_BACKOFF
          handlers.onUp?.()
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let pending = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let nl: number
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, '')
            buf = buf.slice(nl + 1)
            if (line.startsWith('data:')) {
              pending += (pending ? '\n' : '') + line.slice(5).trimStart()
            } else if (line === '' && pending) {
              // empty line = end of frame
              try {
                const ev = JSON.parse(pending) as { type?: unknown; properties?: unknown }
                if (ev && typeof ev.type === 'string') {
                  handlers.onEvent({ type: ev.type, properties: ev.properties })
                }
              } catch {
                // malformed frame — drop
              }
              pending = ''
            }
          }
        }
      } catch (e) {
        if (stopped || (e instanceof Error && e.name === 'AbortError')) break
      }
      if (stopped) break
      if (up) {
        up = false
        handlers.onDown?.()
      }
      await sleep(backoff)
      backoff = Math.min(backoff * 2, MAX_BACKOFF)
    }
  }

  void loop()

  return () => {
    stopped = true
    ctrl.abort()
  }
}
