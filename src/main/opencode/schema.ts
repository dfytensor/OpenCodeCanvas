// Defensive schema adaptation between opencode's raw payloads and OcMessageDTO (§11.5).
import type { OcMessageDTO } from '../../shared/types'

export function isMessageArray(x: unknown): x is OcMessageDTO[] {
  if (!Array.isArray(x)) return false
  return x.every((el) => {
    const info = (el as { info?: { role?: unknown } } | null)?.info
    return (
      !!info &&
      typeof info.role === 'string' &&
      Array.isArray((el as { parts?: unknown }).parts)
    )
  })
}

export function normalizeTranscript(x: unknown): OcMessageDTO[] | null {
  if (isMessageArray(x)) return x

  if (Array.isArray(x)) {
    // raw [{ role, parts, ... }] without the info wrapper
    const out: OcMessageDTO[] = []
    for (let i = 0; i < x.length; i++) {
      const m = x[i] as {
        role?: unknown
        parts?: unknown
        id?: unknown
        sessionID?: unknown
        info?: unknown
      }
      if (typeof m?.role === 'string' && Array.isArray(m.parts)) {
        out.push({
          info: {
            id: typeof m.id === 'string' ? m.id : `msg_${i}`,
            sessionID: typeof m.sessionID === 'string' ? m.sessionID : '',
            role: m.role === 'assistant' ? 'assistant' : 'user'
          },
          parts: m.parts as OcMessageDTO['parts']
        })
      } else {
        return null
      }
    }
    return out
  }

  if (x && typeof x === 'object') {
    const obj = x as Record<string, unknown>
    if ('messages' in obj) return normalizeTranscript(obj.messages)
    // single message object — {info, parts} or bare {role, parts}
    if ('parts' in obj) return normalizeTranscript([x])
  }
  return null
}

export function filterMessages(
  msgs: OcMessageDTO[],
  f: { roles?: string[] }
): OcMessageDTO[] {
  if (!f.roles || f.roles.length === 0) return msgs
  const roles = f.roles
  return msgs.filter((m) => roles.includes(m.info.role))
}
