// §2.2 node state machine — append-only, freeze is the only terminal action (§14)
import type { NodeStatus } from '../../shared/types'

export type GraphErrorCode = 'ILLEGAL_TRANSITION' | 'CYCLE' | 'INELIGIBLE_SOURCE' | 'NOT_FOUND'

export class GraphError extends Error {
  code: GraphErrorCode

  constructor(code: GraphErrorCode, message: string) {
    super(message)
    this.name = 'GraphError'
    this.code = code
  }
}

const ALLOWED: Record<NodeStatus, NodeStatus[]> = {
  draft: ['provisioning', 'running', 'failed', 'aborted', 'frozen'], // running = direct session (baseline/ephemeral) starts from draft
  provisioning: ['running', 'failed', 'aborted', 'frozen'],
  running: ['awaiting_input', 'completed', 'failed', 'aborted', 'frozen'],
  awaiting_input: ['running', 'completed', 'failed', 'aborted', 'frozen'],
  completed: ['running', 'awaiting_input', 'frozen'],
  failed: ['running', 'frozen'],
  aborted: ['running', 'frozen'],
  frozen: ['archived', 'running'], // running = unfreeze
  archived: [] // terminal: content stays inheritable, rehydrate never mutates state
}

export function canTransition(from: NodeStatus, to: NodeStatus): boolean {
  return ALLOWED[from].includes(to)
}

export function assertTransition(from: NodeStatus, to: NodeStatus): void {
  if (!canTransition(from, to)) {
    throw new GraphError('ILLEGAL_TRANSITION', `illegal node status transition: ${from} -> ${to}`)
  }
}

export function isTerminal(status: NodeStatus): boolean {
  return status === 'frozen' || status === 'archived'
}

// completed/frozen/archived are inheritable; running only when allowPartial (caller sets partial flag)
export function isInheritable(status: NodeStatus, allowPartial: boolean): boolean {
  if (status === 'completed' || status === 'frozen' || status === 'archived') return true
  return allowPartial && status === 'running'
}

export function isSourceEligible(status: NodeStatus, allowPartial: boolean): boolean {
  return isInheritable(status, allowPartial)
}
