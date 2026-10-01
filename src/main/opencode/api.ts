// Thin typed wrapper over the opencode HTTP API (Basic auth, JSON, timeouts).
import type { OcMessageDTO, OcSessionDTO } from '../../shared/types'
import { ensureServer, basicAuthHeader, getServer, type ServerHandle } from './server'

export class OcApiError extends Error {
  readonly status: number
  readonly body?: string

  constructor(status: number, message: string, body?: string) {
    super(message)
    this.name = 'OcApiError'
    this.status = status
    this.body = body
  }
}

export interface OcModelInfo {
  id: string
  name: string
}

export interface OcProviderInfo {
  id: string
  name: string
  models: OcModelInfo[]
}

export interface OcAgentInfo {
  name: string
  description?: string
  mode?: string
}

interface ReqOptions {
  method?: string
  body?: unknown
  timeoutMs?: number
}

async function req<T>(path: string, opts: ReqOptions = {}): Promise<T> {
  const h: ServerHandle = (await getServer()) ?? (await ensureServer())
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15000)
  try {
    const res = await fetch(h.baseUrl + path, {
      method: opts.method ?? 'GET',
      headers: {
        Authorization: basicAuthHeader(h),
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => undefined)
      throw new OcApiError(res.status, `${opts.method ?? 'GET'} ${path} → HTTP ${res.status}`, text)
    }
    if (res.status === 204) return undefined as T
    const text = await res.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  } finally {
    clearTimeout(timer)
  }
}

function enc(s: string): string {
  return encodeURIComponent(s)
}

export const ocApi = {
  async health(): Promise<{ healthy: boolean; version: string }> {
    return req<{ healthy: boolean; version: string }>('/global/health', { timeoutMs: 3000 })
  },

  async getOpenApi(): Promise<Record<string, unknown>> {
    return req<Record<string, unknown>>('/doc')
  },

  async createSession(opts?: {
    title?: string
    parentID?: string
    directory?: string
    model?: { id: string; providerID: string }
  }): Promise<OcSessionDTO> {
    const body: Record<string, unknown> = {}
    if (opts?.title !== undefined) body.title = opts.title
    if (opts?.parentID !== undefined) body.parentID = opts.parentID
    if (opts?.model) body.model = opts.model
    const q = opts?.directory ? `?directory=${enc(opts.directory)}` : ''
    return req<OcSessionDTO>(`/session${q}`, { method: 'POST', body })
  },

  async listProviders(): Promise<OcProviderInfo[]> {
    const raw = await req<unknown>('/config/providers')
    const list = Array.isArray(raw)
      ? raw
      : ((raw as { list?: unknown[] } | null)?.list ?? [])
    return (list as Array<Record<string, unknown>>).map((p) => ({
      id: String(p.id ?? ''),
      name: String(p.name ?? p.id ?? ''),
      models: Object.values((p.models as Record<string, Record<string, unknown>>) ?? {}).map(
        (m) => ({ id: String(m.id ?? ''), name: String(m.name ?? m.id ?? '') })
      )
    }))
  },

  async listAgents(): Promise<OcAgentInfo[]> {
    const raw = await req<unknown>('/agent')
    const list = Array.isArray(raw)
      ? raw
      : ((raw as { list?: unknown[] } | null)?.list ?? [])
    return (list as Array<Record<string, unknown>>).map((a) => ({
      name: String(a.name ?? ''),
      description: a.description ? String(a.description) : undefined,
      mode: a.mode ? String(a.mode) : undefined
    }))
  },

  async getSession(id: string): Promise<OcSessionDTO> {
    return req<OcSessionDTO>(`/session/${enc(id)}`)
  },

  async updateSession(id: string, patch: { title?: string }): Promise<OcSessionDTO> {
    return req<OcSessionDTO>(`/session/${enc(id)}`, { method: 'PATCH', body: patch })
  },

  async promptAsync(
    id: string,
    text: string,
    opts?: { agent?: string; model?: string }
  ): Promise<void> {
    const body: Record<string, unknown> = { parts: [{ type: 'text', text }] }
    if (opts?.agent) body.agent = opts.agent
    if (opts?.model) body.model = opts.model
    await req<void>(`/session/${enc(id)}/prompt_async`, { method: 'POST', body })
  },

  async getStatus(): Promise<Record<string, { type?: string }>> {
    return req<Record<string, { type?: string }>>('/session/status')
  },

  async listMessages(id: string): Promise<OcMessageDTO[]> {
    const out = await req<unknown>(`/session/${enc(id)}/message`)
    return Array.isArray(out) ? (out as OcMessageDTO[]) : []
  },

  async getDiff(id: string, messageID?: string): Promise<unknown> {
    const q = messageID ? `?messageID=${enc(messageID)}` : ''
    return req<unknown>(`/session/${enc(id)}/diff${q}`)
  },

  async forkSession(id: string, messageID?: string): Promise<OcSessionDTO> {
    const body = messageID ? { messageID } : {}
    return req<OcSessionDTO>(`/session/${enc(id)}/fork`, { method: 'POST', body })
  },

  async summarize(id: string, providerID: string, modelID: string): Promise<void> {
    await req<void>(`/session/${enc(id)}/summarize`, {
      method: 'POST',
      body: { providerID, modelID }
    })
  },

  async abort(id: string): Promise<void> {
    // best-effort by design: aborting must never surface as a hard failure
    try {
      await req<void>(`/session/${enc(id)}/abort`, { method: 'POST', timeoutMs: 5000 })
    } catch {
      // ignore
    }
  },

  async respondPermission(
    id: string,
    permissionID: string,
    response: 'allow' | 'deny'
  ): Promise<void> {
    await req<void>(`/session/${enc(id)}/permissions/${enc(permissionID)}`, {
      method: 'POST',
      body: { response }
    })
  },

  async getChildren(id: string): Promise<OcSessionDTO[]> {
    const out = await req<unknown>(`/session/${enc(id)}/children`)
    if (Array.isArray(out)) return out as OcSessionDTO[]
    const items = (out as { items?: unknown } | null)?.items
    return Array.isArray(items) ? (items as OcSessionDTO[]) : []
  }
}
