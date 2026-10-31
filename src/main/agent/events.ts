// State-chain evidence log (integration of the event-sourcing memory report):
// the canonical memory of an agent session is an APPEND-ONLY event stream —
// one line per step, never rewritten. `agent.jsonl` stays a turn-boundary
// snapshot for compatibility; `events.jsonl` is the authoritative replay
// source: message-by-message persistence survives crashes mid-turn (the old
// persist-at-turn-end could lose a whole turn of work), gives structural
// provenance (`/prov` = grep), and never mutates history.
//
// Progression rule: state = projection of the log. Nothing here rewrites a file.
import { appendFile, mkdir, readFile } from 'fs/promises'
import { join } from 'path'

export interface AgentEvent {
  ts: string
  type: string
  [k: string]: unknown
}

/** Where an agent session's event log lives. */
export function eventLogPath(rootDir: string, nodeId: string): string {
  return join(rootDir, '.occ', 'nodes', nodeId, 'events.jsonl')
}

/** Append one event. Best-effort by design: an evidence-log failure must
 *  never take the agent down. JSON.stringify keeps every event on one line. */
export async function appendAgentEvent(
  rootDir: string,
  nodeId: string,
  type: string,
  fields: Record<string, unknown> = {}
): Promise<void> {
  try {
    const dir = join(rootDir, '.occ', 'nodes', nodeId)
    await mkdir(dir, { recursive: true })
    const rec = JSON.stringify({ ts: new Date().toISOString(), type, ...fields })
    await appendFile(eventLogPath(rootDir, nodeId), rec + '\n', 'utf8')
  } catch {
    // best-effort
  }
}

/** Read an agent's full event stream (for replay / provenance forensics). */
export async function readAgentEvents(rootDir: string, nodeId: string): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  try {
    const raw = await readFile(eventLogPath(rootDir, nodeId), 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as AgentEvent)
      } catch {
        // torn write from a hard kill — keep the rest
      }
    }
  } catch {
    // no log yet
  }
  return out
}
