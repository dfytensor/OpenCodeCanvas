import type { Terminal } from '@xterm/xterm'

// Maps ptyId -> active Terminal instance, used by the single global output router.
const registry = new Map<string, Terminal>()

export function registerTerminal(ptyId: string, term: Terminal): void {
  registry.set(ptyId, term)
}

export function unregisterTerminal(ptyId: string): void {
  registry.delete(ptyId)
}

export function getTerminal(ptyId: string): Terminal | undefined {
  return registry.get(ptyId)
}
