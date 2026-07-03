import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'
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

/**
 * Copy a session's CONVERSATION (full message history) into a different working
 * directory, INSTANTLY and without any LLM call.
 *
 * Why this way: opencode's `--session <id> --fork` copies history but binds the
 * fork to the PARENT's directory (cwd ignored) AND requires an LLM round-trip
 * (slow / can hang). `opencode import` drops messages entirely. So we copy the
 * session + message + part (+ session_message + context epoch) rows directly in
 * opencode's SQLite (opencode.db) with fresh ids and the new directory. The
 * `data` JSON columns are self-contained (no cross-row id references), so no
 * JSON surgery is needed — only session_id / message_id remapping.
 *
 * Runs under the system `node` (Electron's Node lacks node:sqlite) via a small
 * script written to the temp dir.
 */
const DBOP_SCRIPT = join(tmpdir(), 'opencode-canvas-dbop.js')
let dbopReady = false
const DBOP_CODE = `
const { DatabaseSync } = require('node:sqlite')
const crypto = require('crypto')
const os = require('os'), path = require('path')
const [, , parentSessionId, newDir] = process.argv
const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
const db = new DatabaseSync(path.join(base, 'opencode', 'opencode.db'))
db.exec('PRAGMA busy_timeout = 5000')
const BS = String.fromCharCode(92)
const norm = (p) => p.split(BS).join('/')
function newId(prefix){const a='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';const b=crypto.randomBytes(24);let s='';for(let i=0;i<24;i++)s+=a[b[i]%a.length];return prefix+s}
const parent = db.prepare('SELECT * FROM session WHERE id=?').get(parentSessionId)
if(!parent){db.close();console.log('');process.exit(0)}
const sid = newId('ses_')
const now = Date.now()
let newPath = norm(newDir).replace(/^[A-Za-z]:/, '')
if (newPath.charAt(0) === '/') newPath = newPath.slice(1)
const overrides = { id: sid, directory: norm(newDir), path: newPath, parent_id: parentSessionId, time_created: now, time_updated: now }
db.exec('BEGIN')
try {
  const cols = Object.keys(parent)
  const vals = cols.map((c) => (overrides[c] !== undefined ? overrides[c] : parent[c]))
  db.prepare('INSERT INTO session (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')').run(...vals)
  const msgMap = new Map()
  for (const m of db.prepare('SELECT * FROM message WHERE session_id=?').all(parentSessionId)) {
    const nm = newId('msg_'); msgMap.set(m.id, nm)
    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)').run(nm, sid, m.time_created, m.time_updated, m.data)
  }
  for (const p of db.prepare('SELECT * FROM part WHERE session_id=?').all(parentSessionId)) {
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)').run(newId('prt_'), msgMap.get(p.message_id), sid, p.time_created, p.time_updated, p.data)
  }
  for (const s of db.prepare('SELECT * FROM session_message WHERE session_id=?').all(parentSessionId)) {
    db.prepare('INSERT INTO session_message (id, session_id, type, time_created, time_updated, data, seq) VALUES (?,?,?,?,?,?,?)').run(newId('msg_'), sid, s.type, s.time_created, s.time_updated, s.data, s.seq)
  }
  const ep = db.prepare('SELECT * FROM session_context_epoch WHERE session_id=?').get(parentSessionId)
  if (ep) db.prepare('INSERT INTO session_context_epoch (session_id, baseline, snapshot, baseline_seq) VALUES (?,?,?,?)').run(sid, ep.baseline, ep.snapshot, ep.baseline_seq)
  db.exec('COMMIT')
} catch (e) {
  db.exec('ROLLBACK'); db.close(); throw e
}
db.close()
console.log(sid)
`

export async function forkSessionIntoDir(
  parentSessionId: string,
  _parentCwd: string,
  destDir: string
): Promise<string> {
  if (!dbopReady) {
    await writeFile(DBOP_SCRIPT, DBOP_CODE, 'utf8')
    dbopReady = true
  }
  const { stdout } = await run('node', [DBOP_SCRIPT, parentSessionId, destDir], {
    windowsHide: true
  })
  const id = stdout.trim()
  if (!id) throw new Error('could not copy session history into the new directory')
  return id
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
