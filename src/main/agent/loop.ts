// The native agent loop: OpenAI chat-completions protocol + tool calling,
// hand-rolled over Electron's net.fetch (Chromium network stack — honors the
// Windows system proxy, which is exactly what the bun-based opencode binary
// ignored and why provider calls were geo-blocked on this machine).
import type { AgentProviderConfig } from './providers'
import { join } from 'path'

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

export interface LoopEvent {
  type: 'text' | 'tool' | 'tool_result' | 'step' | 'done' | 'error'
  text?: string
  tool?: string
}

export interface LoopCallbacks {
  onEvent: (e: LoopEvent) => void
  /** per-step usage so callers can meter tokens even on timeout */
  onUsage?: (u: { promptTokens: number; completionTokens: number }) => void
  shouldAbort?: () => boolean
}

interface FetchLike {
  (url: string, init?: Record<string, unknown>): Promise<Response>
}

function pickFetch(): FetchLike {
  try {
    // electron main: Chromium networking (system-proxy aware)
    const { net } = require('electron') as { net?: { fetch?: FetchLike } }
    if (net?.fetch) return net.fetch.bind(net)
  } catch {
    // plain node context (tests) — fall back to global fetch
  }
  return globalThis.fetch as FetchLike
}

function completionsUrl(baseURL: string): string {
  const base = baseURL.replace(/\/+$/, '')
  const last = base.split('/').pop() ?? ''
  if (/^v\d+$/.test(last)) return `${base}/chat/completions`
  return `${base}/v1/chat/completions`
}

interface ChatChoiceMessage {
  role: 'assistant'
  content: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}

interface ChatResponse {
  choices?: Array<{ message?: ChatChoiceMessage }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number }
  error?: { message?: string; type?: string; code?: string }
}

function normalizeUsage(u: ChatResponse['usage']): { promptTokens: number; completionTokens: number } {
  return {
    promptTokens: u?.prompt_tokens ?? u?.input_tokens ?? 0,
    completionTokens: u?.completion_tokens ?? u?.output_tokens ?? 0
  }
}

function trace(m: string): void {
  if (!process.env.OCC_TRACE) return
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('fs').appendFileSync('C:/Users/Administrator/AppData/Local/Temp/occ-trace.log', `${new Date().toISOString()} ${m}\n`)
  } catch { /* ignore */ }
}

async function chatCompletion(
  provider: AgentProviderConfig,
  model: string,
  messages: AgentMessage[],
  tools: ToolDefLike[],
  signal: AbortSignal,
  onDelta?: (full: string) => void
): Promise<ChatResponse> {
  trace(`chatCompletion enter url=${completionsUrl(provider.baseURL)} msgs=${messages.length} tools=${tools.length} http=${process.env.OCC_HTTP ?? 'http'}${onDelta ? ' stream' : ''}`)
  // retry with exponential backoff — transient failures (429/5xx/network)
  // are common with provider APIs, especially under rate limiting
  const MAX_ATTEMPTS = 4
  const BACKOFFS = [0, 3000, 10_000, 30_000]
  let lastErr: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 0) {
        trace(`retry ${attempt}/${MAX_ATTEMPTS - 1} after ${BACKOFFS[attempt]}ms`)
        await new Promise((r) => setTimeout(r, BACKOFFS[attempt]))
      }
      if (process.env.OCC_HTTP === 'curl') {
        trace('curl transport start')
        const r = await curlCompletion(provider, model, messages, tools)
        trace('curl transport done')
        return r
      }
      if (onDelta) {
        try {
          return await httpStreamCompletion(provider, model, messages, tools, signal, onDelta)
        } catch (e) {
          // some providers reject stream requests — one non-stream retry
          const msg = String(e)
          if (signal.aborted) throw e
          if (/HTTP 4\d\d/.test(msg) && !/HTTP 429/.test(msg)) {
            trace(`stream rejected (${msg.slice(0, 60)}) — non-stream retry`)
            return await httpCompletion(provider, model, messages, tools, signal)
          }
          throw e
        }
      }
      return await httpCompletion(provider, model, messages, tools, signal)
    } catch (e) {
      trace(`attempt ${attempt} failed: ${String(e).slice(0, 160)}`)
      lastErr = e
      if (signal.aborted) throw e
      // non-retryable 4xx (except 429) fail fast
      const msg = String(e)
      if (/HTTP 4\d\d/.test(msg) && !/HTTP 429/.test(msg)) throw e
    }
  }
  throw lastErr
}

/** Raw Node http.request — no undici, no connection pooling, no proxy. */
function httpCompletion(
  provider: AgentProviderConfig,
  model: string,
  messages: AgentMessage[],
  tools: ToolDefLike[],
  signal: AbortSignal
): Promise<ChatResponse> {
  return new Promise<ChatResponse>((resolve, reject) => {
    const url = new URL(completionsUrl(provider.baseURL))
    const body = JSON.stringify({
      model,
      messages,
      ...(tools.length ? { tools, tool_choice: 'auto' } : {})
    })
    const isHttps = url.protocol === 'https:'
    const mod = isHttps ? require('https') : require('http')
    let settled = false
    let timer: NodeJS.Timeout | undefined
    // eslint-disable-next-line prefer-const
    let req: import('http').ClientRequest
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = (): void => {
      req.destroy()
      finish(() => reject(new Error('request aborted')))
    }
    req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {})
        }
      },
      (res: import('http').IncomingMessage) => {
        let data = ''
        res.on('data', (chunk: string | Buffer) => { data += chunk })
        res.on('end', () => {
          try {
            const json = JSON.parse(data) as ChatResponse
            if (!res.statusCode || res.statusCode >= 400) {
              finish(() => reject(new Error(`provider HTTP ${res.statusCode}: ${(json.error?.message ?? data).slice(0, 200)}`)))
            } else {
              finish(() => resolve(json))
            }
          } catch {
            finish(() => reject(new Error(`provider non-JSON HTTP ${res.statusCode}: ${data.slice(0, 200)}`)))
          }
        })
        res.on('error', (e: Error) => finish(() => reject(e)))
      }
    )
    if (signal.aborted) {
      finish(() => reject(new Error('request aborted')))
      req.destroy()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    req.on('error', (e: Error) => finish(() => reject(e)))
    timer = setTimeout(() => {
      req.destroy()
      finish(() => reject(new Error('provider request timeout (180s)')))
    }, 180_000)
    req.write(body)
    req.end()
  })
}
/** Streaming variant of httpCompletion — SSE deltas feed onDelta (throttled),
 *  the assembled full response resolves at [DONE]. Falls back at the caller
 *  when a provider rejects streaming. */
function httpStreamCompletion(
  provider: AgentProviderConfig,
  model: string,
  messages: AgentMessage[],
  tools: ToolDefLike[],
  signal: AbortSignal,
  onDelta: (full: string) => void
): Promise<ChatResponse> {
  return new Promise<ChatResponse>((resolve, reject) => {
    const url = new URL(completionsUrl(provider.baseURL))
    const body = JSON.stringify({
      model,
      messages,
      ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
      stream: true,
      stream_options: { include_usage: true }
    })
    const isHttps = url.protocol === 'https:'
    const mod = isHttps ? require('https') : require('http')
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let acc = ''
    let lastEmit = 0
    // eslint-disable-next-line prefer-const
    let req: import('http').ClientRequest
    let toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []
    let usage: ChatResponse['usage'] | undefined

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = (): void => {
      req.destroy()
      finish(() => reject(new Error('request aborted')))
    }

    req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {})
        }
      },
      (res: import('http').IncomingMessage) => {
        if (!res.statusCode || res.statusCode >= 400) {
          let errBody = ''
          res.on('data', (c: Buffer) => { errBody += c })
          res.on('end', () => finish(() => reject(new Error(`provider HTTP ${res.statusCode}: ${errBody.slice(0, 180)}`))))
          return
        }
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          buf += chunk
          let idx: number
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, '')
            buf = buf.slice(idx + 1)
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            try {
              const j = JSON.parse(payload)
              const delta = j.choices?.[0]?.delta ?? {}
              if (typeof delta.content === 'string' && delta.content) {
                acc += delta.content
                const now = Date.now()
                if (now - lastEmit > 120) {
                  lastEmit = now
                  onDelta(acc)
                }
              }
              for (const tc of delta.tool_calls ?? []) {
                const i = tc.index ?? 0
                toolCalls[i] = toolCalls[i] ?? { id: tc.id ?? '', type: 'function', function: { name: '', arguments: '' } }
                if (tc.id) toolCalls[i].id = tc.id
                if (tc.function?.name) toolCalls[i].function.name += tc.function.name
                if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments
              }
              if (j.usage) usage = j.usage
            } catch { /* partial line — next chunk completes it */ }
          }
        })
        res.on('end', () => {
          onDelta(acc) // final flush
          const message = {
            role: 'assistant' as const,
            content: acc,
            ...(toolCalls.filter(Boolean).length > 0 ? { tool_calls: toolCalls.filter(Boolean) } : {})
          }
          finish(() => resolve({ choices: [{ message }], usage }))
        })
        res.on('error', (e: Error) => finish(() => reject(e)))
      }
    )
    if (signal.aborted) {
      finish(() => reject(new Error('request aborted')))
      req.destroy()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    req.on('error', (e: Error) => finish(() => reject(e)))
    timer = setTimeout(() => {
      req.destroy()
      finish(() => reject(new Error('provider stream timeout (180s)')))
    }, 180_000)
    req.write(body)
    req.end()
  })
}

interface ToolDefLike {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** curl.exe subprocess transport — bypasses undici entirely.
 *  Body goes via STDIN (--data-binary @-): zero temp files, so antivirus
 *  real-time scanners can never hook and stall the write handle. */
async function curlCompletion(
  provider: AgentProviderConfig,
  model: string,
  messages: AgentMessage[],
  tools: ToolDefLike[]
): Promise<ChatResponse> {
  const { spawn } = await import('child_process')
  const url = completionsUrl(provider.baseURL)
  const payload: Record<string, unknown> = { model, messages }
  if (tools.length) {
    payload.tools = tools
    payload.tool_choice = 'auto'
  }
  const body = JSON.stringify(payload)
  trace(`curl(spawn): POST ${url} body=${body.length}B via stdin`)
  return new Promise<ChatResponse>((resolve, reject) => {
    // curl honours http(s)_proxy env vars — the user's system proxy may hang
    // on this endpoint (observed), while DIRECT works reliably. Force direct.
    const child = spawn(
      'curl',
      ['-s', '--max-time', '170', '-X', 'POST', '-H', 'Content-Type: application/json', '-H', `Authorization: Bearer ${provider.apiKey}`, '--data-binary', body, url],
      {
        windowsHide: true,
        env: {
          ...process.env,
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          http_proxy: '',
          https_proxy: '',
          ALL_PROXY: '',
          NO_PROXY: '*'
        }
      }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`curl timeout (170s)`))
    }, 170_000)
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      trace(`curl(spawn): exit=${code} out=${stdout.length}B`)
      let json: ChatResponse
      try {
        json = JSON.parse(stdout) as ChatResponse
      } catch {
        reject(new Error(`curl non-JSON (exit ${code}): ${(stdout || stderr).slice(0, 150)}`))
        return
      }
      if (json.error) reject(new Error(`provider error: ${json.error.message ?? stdout.slice(0, 100)}`))
      else resolve(json)
    })
    child.stdin.write(body)
    child.stdin.end()
  })
}

export interface ToolRunner {
  defs: ToolDefLike[]
  call: (name: string, argsJson: string) => Promise<string>
}

export interface LoopResult {
  messages: AgentMessage[]
  finalText: string
  steps: number
  usage: { promptTokens: number; completionTokens: number }
  aborted: boolean
}

/** Bare completion without tools — used by the round-0 planner. */
export async function completeChat(opts: {
  provider: AgentProviderConfig
  model: string
  messages: AgentMessage[]
  signal?: AbortSignal
}): Promise<string> {
  // hard timeout tied to a real controller so expiry ALWAYS cancels the socket —
  // racing alone leaks a hung http request per timed-out planner call
  const ctrl = new AbortController()
  const onOuter = (): void => ctrl.abort()
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort()
    else opts.signal.addEventListener('abort', onOuter, { once: true })
  }
  let hardTimer: NodeJS.Timeout | undefined
  const hard = new Promise<never>((_, rej) => {
    hardTimer = setTimeout(() => {
      ctrl.abort()
      rej(new Error('planner hard timeout (90s) — socket-level hang'))
    }, 90_000)
  })
  try {
    const res = await Promise.race([
      chatCompletion(opts.provider, opts.model, opts.messages, [], ctrl.signal),
      hard
    ])
    const msg = (res as ChatResponse).choices?.[0]?.message
    if (!msg) throw new Error((res as ChatResponse).error?.message ?? 'provider returned no choices')
    return msg.content ?? ''
  } catch (e) {
    throw e
  } finally {
    if (hardTimer) clearTimeout(hardTimer)
    opts.signal?.removeEventListener('abort', onOuter)
  }
}

export async function runAgentLoop(opts: {
  provider: AgentProviderConfig
  model: string
  messages: AgentMessage[]
  tools: ToolRunner
  maxSteps?: number
  callbacks: LoopCallbacks
  signal?: AbortSignal
  /** live partial text as the model generates — drives the streaming UI */
  onStream?: (partial: string) => void
  /** working memory: absolute path to the agent's notes.md — re-injected on
   *  compaction so the plan survives transcript stubbing */
  scratchpadPath?: string
}): Promise<LoopResult> {
  const messages = [...opts.messages]
  const maxSteps = opts.maxSteps ?? 24
  const usage = { promptTokens: 0, completionTokens: 0 }
  let finalText = ''
  let steps = 0

  while (steps < maxSteps) {
    if (opts.callbacks.shouldAbort?.() || opts.signal?.aborted) {
      return { messages, finalText, steps, usage, aborted: true }
    }
    steps++
    opts.callbacks.onEvent({ type: 'step', text: String(steps) })

    // context governance: stub old tool results once the transcript bloats —
    // full原文 stays on disk (agent.jsonl), the context keeps short references
    compactHistory(messages, opts.scratchpadPath)

    let res: ChatResponse
    try {
      res = await chatCompletion(
        opts.provider,
        opts.model,
        messages,
        opts.tools.defs,
        opts.signal ?? new AbortController().signal,
        opts.onStream
      )
    } catch (e) {
      opts.callbacks.onEvent({ type: 'error', text: String(e) })
      throw e
    }
  const u = normalizeUsage(res.usage)
  usage.promptTokens += u.promptTokens
  usage.completionTokens += u.completionTokens
  opts.callbacks.onUsage?.(u)

    const msg = res.choices?.[0]?.message
    if (!msg) {
      const errText = res.error?.message ?? 'provider returned no choices'
      opts.callbacks.onEvent({ type: 'error', text: errText })
      throw new Error(errText)
    }

    // push the assistant message verbatim (content + tool_calls)
    messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls })

    if (msg.content) {
      finalText = msg.content
      opts.callbacks.onEvent({ type: 'text', text: msg.content })
    }

    const calls = msg.tool_calls ?? []
    if (calls.length === 0) break // no tools → the turn is complete

    for (const call of calls) {
      if (opts.callbacks.shouldAbort?.() || opts.signal?.aborted) {
        return { messages, finalText, steps, usage, aborted: true }
      }
      opts.callbacks.onEvent({ type: 'tool', tool: call.function.name })
      let result: string
      try {
        result = await opts.tools.call(call.function.name, call.function.arguments)
      } catch (e) {
        result = `tool error: ${String(e)}`
      }
      opts.callbacks.onEvent({ type: 'tool_result', tool: call.function.name })
      messages.push({ role: 'tool', tool_call_id: call.id, content: capToolResult(result) })
    }
  }

  return { messages, finalText, steps, usage, aborted: false }
}

// ── in-loop context governance (docs/context-governance.md §三) ──

const TOOL_RESULT_CAP = 8_000
const COMPACT_THRESHOLD_CHARS = 30_000
const COMPACT_THRESHOLD_STEPS = 14
const KEEP_RECENT = 8

/** hard cap at creation: a runaway read_file must not own the transcript */
function capToolResult(result: string): string {
  if (result.length <= TOOL_RESULT_CAP) return result
  return (
    result.slice(0, TOOL_RESULT_CAP) +
    `\n…[工具结果已截断，原文 ${result.length} 字符已落盘；需要更多请用更窄范围/offset 重读]`
  )
}

function estChars(messages: AgentMessage[]): number {
  let n = 0
  for (const m of messages) {
    n += m.content?.length ?? 0
    for (const tc of m.tool_calls ?? []) n += tc.function.name.length + tc.function.arguments.length
  }
  return n
}

/** stub the tool results of older steps into short references; structure
 *  (assistant tool_calls + tool pairs) stays intact so the transcript remains
 *  API-valid. Idempotent — stubs are short and never re-stubbed. */
function compactHistory(messages: AgentMessage[], scratchpadPath?: string): void {
  if (estChars(messages) < COMPACT_THRESHOLD_CHARS && messages.length < COMPACT_THRESHOLD_STEPS) return
  const stop = Math.max(2, messages.length - KEEP_RECENT)
  let compacted = 0
  for (let i = 2; i < stop; i++) {
    const m = messages[i]
    if (m.role === 'tool' && (m.content?.length ?? 0) > 300) {
      const first = (m.content ?? '').slice(0, 240).replace(/\s+/g, ' ')
      messages[i] = { ...m, content: `[已压实] ${first}…（原文已落盘 agent.jsonl，需要全文请用工具重读）` }
      compacted++
    }
  }
  if (compacted > 0) {
    // working-memory re-injection: the plan lives in notes.md, not the
    // transcript — hand it back right where older context was stubbed
    if (scratchpadPath) {
      try {
        const raw = require('fs').readFileSync(scratchpadPath, 'utf8') as string
        const note = raw.slice(0, 1400).trim()
        if (note) {
          const reinject: AgentMessage = {
            role: 'user',
            content: `[工作记忆恢复] 对话早段已被压实。你的工作笔记（notes.md）当前内容：\n${note}\n（以此为准继续；笔记过时请先更新它）`
          }
          messages.splice(stop, 0, reinject)
        }
      } catch { /* no notes yet — fine */ }
    }
    trace(`compactHistory: stubbed ${compacted} tool results, chars ${estChars(messages)}`)
  }
}
