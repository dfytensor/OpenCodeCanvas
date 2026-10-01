// Capability probing: health + OpenAPI introspection + CLI version, cached 60s.
import { ocApi } from './api'
import { cliVersion } from './cli'

export interface OcCapabilities {
  apiAvailable: boolean
  version?: string
  endpoints: Record<string, boolean>
  cliVersion?: string
}

// [capability key, OpenAPI path substring]
const ENDPOINT_PROBES: Array<[string, string]> = [
  ['prompt_async', 'prompt_async'],
  ['fork', '/fork'],
  ['diff', '/diff'],
  ['summarize', '/summarize'],
  ['abort', '/abort'],
  ['event', '/event'],
  ['status', '/session/status']
]

const TTL_MS = 60000

let cache: { at: number; caps: OcCapabilities } | null = null

export async function probeCapabilities(force = false): Promise<OcCapabilities> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.caps

  const caps: OcCapabilities = { apiAvailable: false, endpoints: {} }

  try {
    const health = await ocApi.health()
    caps.apiAvailable = health.healthy === true
    caps.version = health.version
  } catch {
    // api not reachable — capabilities stay empty
  }

  if (caps.apiAvailable) {
    try {
      const doc = (await ocApi.getOpenApi()) as { paths?: Record<string, unknown> }
      const paths = Object.keys(doc.paths ?? {})
      for (const [key, needle] of ENDPOINT_PROBES) {
        caps.endpoints[key] = paths.some((p) => p.includes(needle))
      }
    } catch {
      caps.endpoints = {}
    }
  }

  try {
    caps.cliVersion = (await cliVersion()) ?? undefined
  } catch {
    // cli missing — fine
  }

  cache = { at: Date.now(), caps }
  return caps
}
