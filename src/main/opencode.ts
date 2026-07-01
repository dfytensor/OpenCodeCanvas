import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomBytes } from 'crypto'
import { writeFile, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { shortId } from './worktree'

const run = promisify(execFile)

function oc(args: string[], opts: { cwd?: string } = {}): Promise<string> {
  // On Windows `opencode` is an npm shim (opencode.cmd); child_process can't
  // launch .cmd directly, so route through cmd.exe (resolves PATH + PATHEXT).
  const isWin = process.platform === 'win32'
  const file = isWin ? (process.env.COMSPEC ?? 'cmd.exe') : 'opencode'
  const finalArgs = isWin ? ['/c', 'opencode', ...args] : args
  return run(file, finalArgs, {
    cwd: opts.cwd && existsSync(opts.cwd) ? opts.cwd : undefined,
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

/** Generate an opencode-style session id (ses_ + 24 base36 chars). */
function newSessionId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(24)
  let s = ''
  for (let i = 0; i < 24; i++) s += alphabet[bytes[i] % alphabet.length]
  return 'ses_' + s
}

/**
 * Copy a session's CONVERSATION into a different working directory.
 *
 * opencode's `--session <id> --fork` ties the new session to the PARENT's
 * directory (cwd is ignored), so it can't be used for directory-isolated forks.
 * Instead we export the parent, rewrite the session id (so import creates a NEW
 * session instead of overwriting the parent), and import it from destDir —
 * opencode binds the imported session to the cwd it's run from. Returns the new
 * session id (already bound to destDir, with the full history).
 */
export async function forkSessionIntoDir(
  parentSessionId: string,
  parentCwd: string,
  destDir: string
): Promise<string> {
  const json = await oc(['export', parentSessionId], { cwd: parentCwd })
  const newId = newSessionId()
  const rewritten = json.split(parentSessionId).join(newId)
  const tmp = join(tmpdir(), `canvas-fork-${newId}.json`)
  await writeFile(tmp, rewritten, 'utf8')
  try {
    const out = await oc(['import', tmp], { cwd: destDir })
    if (!out.includes(newId)) {
      throw new Error('import did not create the forked session: ' + out.trim())
    }
  } finally {
    await rm(tmp, { force: true })
  }
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
