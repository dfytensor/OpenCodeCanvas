// Provider catalog for the native agent engine. Credentials and endpoints are
// sourced from the user's existing opencode configuration (opencode.json +
// auth.json) so nothing needs to be configured twice. HTTP goes through
// Electron's net.fetch (system-proxy aware) at call time — see loop.ts.
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export interface AgentProviderConfig {
  id: string
  name: string
  baseURL: string
  apiKey: string
  models: string[]
}

/** A usable (provider, model) pair with credentials resolved. */
export interface UsableModel {
  ref: string // "providerId/modelId"
  providerId: string
  model: string
  baseURL: string
  apiKey: string
}

// opencode provider aliases → real OpenAI-compatible endpoints.
// models lists are fallback catalogs for providers whose config doesn't pin ids.
const BUILTIN: Record<string, { baseURL: string; name: string; models?: string[] }> = {
  zhipuai: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', name: 'Zhipu (BigModel)', models: ['glm-4.6', 'glm-4.5-air'] },
  'zhipuai-coding-plan': { baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', name: 'GLM Coding Plan', models: ['glm-4.6', 'glm-4.5-air'] },
  deepseek: { baseURL: 'https://api.deepseek.com', name: 'DeepSeek', models: ['deepseek-chat', 'deepseek-reasoner'] }
}

interface Cached {
  providers: AgentProviderConfig[]
  defaultRef: string
  at: number
}

let cache: Cached | null = null

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function isLocal(baseURL: string): boolean {
  return baseURL.includes('localhost') || baseURL.includes('127.0.0.1')
}

export function listAgentProviders(force = false): AgentProviderConfig[] {
  if (cache && !force && Date.now() - cache.at < 30_000) return cache.providers
  const out = new Map<string, AgentProviderConfig>()

  const configDir = join(homedir(), '.config', 'opencode')
  const cfg =
    readJson(join(configDir, 'opencode.json')) ??
    readJson(join(configDir, 'opencode.jsonc')) ??
    {}
  const auth = readJson(join(homedir(), '.local', 'share', 'opencode', 'auth.json')) ?? {}
  const authKey = (id: string): string => {
    const e = auth[id] as { key?: string; api?: string } | undefined
    return e?.key ?? e?.api ?? ''
  }

  const add = (id: string, apiKey: string, baseURL: string, models: string[], name?: string): void => {
    if (!apiKey && !isLocal(baseURL)) return
    out.set(id, { id, name: name ?? BUILTIN[id]?.name ?? id, baseURL, apiKey, models })
  }

  const providers = (cfg.provider ?? {}) as Record<string, { options?: { apiKey?: string; baseURL?: string }; models?: Record<string, unknown>; name?: string }>
  for (const [id, p] of Object.entries(providers)) {
    const builtin = BUILTIN[id]
    const baseURL = p.options?.baseURL ?? builtin?.baseURL
    if (!baseURL) continue
    const models = Object.keys(p.models ?? {})
    add(id, p.options?.apiKey ?? authKey(id), baseURL, models, p.name ?? builtin?.name)
  }
  for (const [id, b] of Object.entries(BUILTIN)) {
    if (!out.has(id)) add(id, authKey(id), b.baseURL, [])
  }

  const providers2 = [...out.values()]
  const defaultRef = typeof cfg.model === 'string' ? cfg.model : ''
  const entry: Cached = { providers: providers2, defaultRef, at: Date.now() }
  cache = entry
  return providers2
}

function readDefaultRef(): string {
  const configDir = join(homedir(), '.config', 'opencode')
  const cfg =
    readJson(join(configDir, 'opencode.json')) ??
    readJson(join(configDir, 'opencode.jsonc'))
  return typeof cfg?.model === 'string' ? cfg.model : ''
}

export function agentDefaultModelRef(): string {
  return cache?.defaultRef ?? readDefaultRef()
}

/** Flat catalog of every usable (provider, model) pair, interleaved across
 *  providers so round-robin assignment gives genuine model diversity. */
export function usableModelRefs(): UsableModel[] {
  const out: UsableModel[] = []
  for (const p of listAgentProviders(true)) {
    for (const m of p.models.length ? p.models : ['default']) {
      out.push({ ref: `${p.id}/${m}`, providerId: p.id, model: m, baseURL: p.baseURL, apiKey: p.apiKey })
    }
  }
  return out
}

export function resolveAgentModel(
  ref: string | undefined
): { provider: AgentProviderConfig; model: string } | null {
  const providers = listAgentProviders()
  let use = ref || agentDefaultModelRef()
  if (!use && providers.length > 0) {
    const p = providers[0]
    return { provider: p, model: p.models[0] ?? 'default' }
  }
  const idx = use.indexOf('/')
  const pid = idx > 0 ? use.slice(0, idx) : use
  const mid = idx > 0 ? use.slice(idx + 1) : ''
  const provider = providers.find((p) => p.id === pid)
  if (!provider) return null
  const model = mid || provider.models[0] || 'default'
  return { provider, model }
}
