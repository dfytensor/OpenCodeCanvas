import { execFile } from 'child_process'
import { promisify } from 'util'
import { join, dirname, relative } from 'path'
import { mkdir, cp, rm, readdir, readFile, appendFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { isRepo } from './worktree'
import type { ForkWorkspace } from '../shared/types'

const run = promisify(execFile)
const STORE_DIR = '.opencode-canvas'
// never copy these into a branch workspace
const IGNORE = new Set([
  STORE_DIR,
  'node_modules',
  '.git',
  '.cache',
  'dist',
  'out',
  'build',
  '.next',
  '.venv'
])

function storeRoot(projectDir: string): string {
  return join(projectDir, STORE_DIR)
}

/** Copy a project tree (skipping heavy / tool-managed / vcs dirs). */
async function copyProject(src: string, dest: string): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true })
  await mkdir(dest, { recursive: true })
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue
    await cp(join(src, e.name), join(dest, e.name), { recursive: true })
  }
}

/**
 * Keep the tool store out of the user's git status / diffs. Appends an
 * ignore entry to the project .gitignore if the project is a git repo.
 */
async function ensureGitignored(projectDir: string): Promise<void> {
  if (!(await isRepo(projectDir))) return
  const gi = join(projectDir, '.gitignore')
  let content = ''
  if (existsSync(gi)) content = await readFile(gi, 'utf8')
  if (!content.includes(STORE_DIR + '/')) {
    await appendFile(gi, `\n# opencode-canvas tool store\n${STORE_DIR}/\n`)
  }
}

const ISOLATION_RULE = `
## Branch Workspace (OpenCode Canvas)

You are running inside an ISOLATED BRANCH WORKSPACE — an independent copy of the project.
- ALWAYS use paths RELATIVE to the current working directory.
- NEVER reuse absolute paths that appear earlier in this conversation — they point at a DIFFERENT directory (the original project) and would break this branch's isolation.
- Every file read / write / edit must target this workspace only.
`

/**
 * Inject a branch-isolation rule into the copy so the forked agent stays inside
 * the workspace and uses relative paths. Appends to AGENTS.md (or CLAUDE.md if
 * that's what the project uses); creates AGENTS.md only when neither exists, to
 * avoid shadowing an existing CLAUDE.md.
 */
async function injectIsolationRule(wsCopy: string): Promise<void> {
  const agents = join(wsCopy, 'AGENTS.md')
  const claude = join(wsCopy, 'CLAUDE.md')
  if (existsSync(agents)) {
    await appendFile(agents, '\n' + ISOLATION_RULE)
  } else if (existsSync(claude)) {
    await appendFile(claude, '\n' + ISOLATION_RULE)
  } else {
    await writeFile(agents, '# Branch Workspace\n' + ISOLATION_RULE)
  }
}

/**
 * Prepare an isolated workspace for a fork by copying the project's CURRENT
 * state (including uncommitted changes). Two copies are made:
 *   - base snapshot (frozen fork-point; the diff baseline)
 *   - working copy  (where the branch's agent runs and edits)
 * This always captures the live working tree, so a forked conversation's
 * context matches the branch's file state.
 */
export async function prepareForkWorkspace(
  projectDir: string,
  nodeId: string
): Promise<ForkWorkspace> {
  const shortId = nodeId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'fork'
  const baseSnap = join(storeRoot(projectDir), 'snapshots', shortId)
  const wsCopy = join(storeRoot(projectDir), 'copies', shortId)
  await rm(baseSnap, { recursive: true, force: true })
  await rm(wsCopy, { recursive: true, force: true })
  await copyProject(projectDir, baseSnap)
  await copyProject(projectDir, wsCopy)
  await ensureGitignored(projectDir)
  await injectIsolationRule(wsCopy)
  return { path: wsCopy, type: 'copy', mainRepoPath: projectDir, baseRef: baseSnap }
}

/**
 * Unified diff of what the branch changed vs its fork point (base snapshot).
 * Uses `git diff --no-index` so no repository is required. Absolute store
 * paths are stripped from the output for a readable diff.
 */
export async function diffWorkspace(ws: ForkWorkspace): Promise<string> {
  // git diff --no-index exits 1 when differences exist (stdout = the diff)
  let raw = ''
  try {
    const r = await run('git', ['diff', '--no-index', '--no-color', ws.baseRef!, ws.path])
    raw = r.stdout
  } catch (e: unknown) {
    const err = e as { stdout?: string }
    raw = err.stdout ?? ''
  }
  // collapse the absolute snapshot/copy prefixes into clean a/ b/ labels
  return raw
    .split(ws.baseRef!)
    .join('')
    .split(ws.path)
    .join('')
    .replace(/\/{2,}/g, '/')
}

interface FileChange {
  status: 'A' | 'M' | 'D'
  rel: string
}

/** Turn one `git diff --no-index` path token into a project-relative path. */
function toRel(token: string, baseRef: string, copyPath: string): string {
  // git may emit either `a/<abspath>` (in unified diff) or a bare `<abspath>`
  // (in --name-status). Strip an optional a//b/ prefix, then strip the known
  // snapshot/copy directory prefix to recover the project-relative path.
  const t = token.replace(/^"|"$/g, '').replace(/^[ab]\//, '')
  const aP = baseRef + '/'
  const bP = copyPath + '/'
  if (t.startsWith(aP)) return t.slice(aP.length).replace(/\\/g, '/')
  if (t.startsWith(bP)) return t.slice(bP.length).replace(/\\/g, '/')
  const rb = relative(baseRef, t)
  if (rb && !rb.startsWith('..') && rb !== '') return rb.replace(/\\/g, '/')
  const rp = relative(copyPath, t)
  if (rp && !rp.startsWith('..') && rp !== '') return rp.replace(/\\/g, '/')
  return t.replace(/\\/g, '/')
}

/** Parse `git diff --no-index --name-status a b` into per-file changes. */
function parseNameStatus(out: string, baseRef: string, copyPath: string): FileChange[] {
  const changes: FileChange[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const status = line[0] as 'A' | 'M' | 'D'
    if (status !== 'A' && status !== 'M' && status !== 'D') continue
    // rename lines look like: R100\t"b/.../old"\t"b/.../new" — take the last token
    const tokens = line.slice(1).trim().split('\t')
    const rel = toRel(tokens[tokens.length - 1], baseRef, copyPath)
    if (rel) changes.push({ status, rel })
  }
  return changes
}

/**
 * Apply the branch's changes back to the main project. Only files that differ
 * from the fork-point snapshot are written, so concurrent main work on other
 * files is preserved.
 */
export async function applyWorkspaceToMain(
  ws: ForkWorkspace
): Promise<{ ok: boolean; message: string }> {
  try {
    let nameStatus = ''
    try {
      const r = await run('git', [
        'diff',
        '--no-index',
        '--name-status',
        ws.baseRef!,
        ws.path
      ])
      nameStatus = r.stdout
    } catch (e: unknown) {
      const err = e as { stdout?: string }
      nameStatus = err.stdout ?? ''
    }

    const changes = parseNameStatus(nameStatus, ws.baseRef!, ws.path)
    if (changes.length === 0) {
      return { ok: true, message: 'no changes to apply' }
    }

    for (const ch of changes) {
      const dest = join(ws.mainRepoPath, ch.rel)
      if (ch.status === 'D') {
        await rm(dest, { force: true })
      } else {
        await mkdir(dirname(dest), { recursive: true })
        await cp(join(ws.path, ch.rel), dest, { recursive: true })
      }
    }
    return { ok: true, message: `applied ${changes.length} change(s) to the project` }
  } catch (e: unknown) {
    const err = e as { message?: string }
    return { ok: false, message: String(err.message ?? e) }
  }
}

/** Tear down a branch workspace (snapshot + working copy). */
export async function removeWorkspace(ws: ForkWorkspace): Promise<void> {
  try {
    await rm(ws.path, { recursive: true, force: true })
    if (ws.baseRef) await rm(ws.baseRef, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}
