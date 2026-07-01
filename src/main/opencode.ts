import { execFile } from 'child_process'
import { promisify } from 'util'
import { shortId } from './worktree'

const run = promisify(execFile)

function oc(args: string[], opts: { cwd?: string } = {}): Promise<string> {
  // On Windows `opencode` is an npm shim (opencode.cmd); child_process can't
  // launch .cmd directly, so route through cmd.exe (resolves PATH + PATHEXT).
  const isWin = process.platform === 'win32'
  const file = isWin ? (process.env.COMSPEC ?? 'cmd.exe') : 'opencode'
  const finalArgs = isWin ? ['/c', 'opencode', ...args] : args
  return run(file, finalArgs, {
    cwd: opts.cwd,
    maxBuffer: 50 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env }
  }).then((r) => r.stdout)
}

/**
 * List sessions as JSON.
 */
export async function sessionList(cwd?: string): Promise<any[]> {
  const raw = await oc(['session', 'list', '--format', 'json'], { cwd })
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : parsed.sessions ?? []
  } catch {
    return []
  }
}

/**
 * Find the most recent session whose parentID === parentSessionId.
 * Falls back to scanning createdAt descending.
 */
export async function findForkedSession(parentSessionId: string, cwd?: string): Promise<string | null> {
  const sessions = await sessionList(cwd)
  const children = sessions
    .filter((s) => String(s.parentID ?? s.parentId ?? s.parent) === parentSessionId)
    .sort((a, b) => String(b.createdAt ?? b.created_at ?? '').localeCompare(String(a.createdAt ?? a.created_at ?? '')))
  if (children.length > 0) return String(children[0].id)
  return null
}

/**
 * Fork a session non-interactively and return the new session id.
 * `opencode run --session <id> --fork` with an empty message creates the fork.
 */
export async function forkSession(parentSessionId: string, cwd: string): Promise<string> {
  // create the fork with an effectively empty prompt so no real work is done
  await oc(['run', '--session', parentSessionId, '--fork', '--format', 'json', ''], { cwd })
  const newId = await findForkedSession(parentSessionId, cwd)
  if (!newId) throw new Error('Could not locate forked session id')
  return newId
}

/**
 * Best-effort: detect the active session in a working directory by listing
 * sessions and returning the latest one for the current project.
 */
export async function detectSession(cwd: string): Promise<string | null> {
  const sessions = await sessionList(cwd)
  if (sessions.length === 0) return null
  const sorted = [...sessions].sort((a, b) =>
    String(b.createdAt ?? b.created_at ?? '').localeCompare(String(a.createdAt ?? a.created_at ?? ''))
  )
  return String(sorted[0].id)
}

/**
 * Run an arbitrary opencode command (used for diagnostics / dry runs).
 */
export async function runRaw(cwd: string, args: string[]): Promise<string> {
  return oc(args, { cwd })
}

export function newBranchName(): string {
  return `fork-${shortId()}`
}
