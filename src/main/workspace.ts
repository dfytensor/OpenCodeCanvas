import { execFile } from 'child_process'
import { promisify } from 'util'
import { join, dirname, relative } from 'path'
import { mkdir, cp, rm, readdir, readFile, appendFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { isRepo } from './worktree'
import type { ForkWorkspace, PrepareOptions, MergePrepareOptions } from '../shared/types'

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

const MERGE_RULE = `
## Merge Workspace (OpenCode Canvas)

You are running inside a MERGE WORKSPACE. Read MERGE_TASK.md and perform the
merge it describes.
- You MAY read full files from the absolute branch directories listed in
  MERGE_TASK.md — they are intentional merge inputs (the only absolute paths
  you should touch outside the current working directory).
- All writes target the CURRENT working directory using RELATIVE paths.
`

/**
 * Inject a rule block (isolation/merge) into the workspace's agent-instructions
 * file (AGENTS.md, or CLAUDE.md if that's what the project uses; creates
 * AGENTS.md only when neither exists). Idempotent: skips if the signature is
 * already present, so re-copying a parent workspace won't duplicate the rule.
 */
async function injectRule(
  wsCopy: string,
  heading: string,
  rule: string,
  signature: string
): Promise<void> {
  const agents = join(wsCopy, 'AGENTS.md')
  const claude = join(wsCopy, 'CLAUDE.md')
  let target: string | null = null
  if (existsSync(agents)) target = agents
  else if (existsSync(claude)) target = claude
  if (target) {
    const content = await readFile(target, 'utf8')
    if (!content.includes(signature)) await appendFile(target, '\n' + rule)
  } else {
    await writeFile(agents, `# ${heading}\n` + rule)
  }
}

/**
 * Prepare an isolated working folder by copying `srcDir` into
 * `<mainRepoPath>/.opencode-canvas/<folder>/<dirName>`.
 *
 * `srcDir` is also recorded as the diff baseline (baseRef):
 *   - root opencode terminal: srcDir = the project (mainRepoPath)
 *   - fork:                    srcDir = the (frozen) parent working folder
 *   - merge:                   srcDir = the project
 * Because a forked-from parent is frozen, the parent folder is immutable and
 * therefore serves as a stable baseline — no separate snapshot is needed.
 */
export async function prepare(opts: PrepareOptions): Promise<ForkWorkspace> {
  const { srcDir, mainRepoPath, folder, dirName } = opts
  if (!mainRepoPath) throw new Error('prepare: mainRepoPath is required')
  if (!folder || !dirName) throw new Error('prepare: folder and dirName are required')
  const dest = join(storeRoot(mainRepoPath), folder, dirName)
  await rm(dest, { recursive: true, force: true })
  await copyProject(srcDir, dest)
  await ensureGitignored(mainRepoPath)
  await injectRule(dest, 'Branch Workspace', ISOLATION_RULE, 'Branch Workspace (OpenCode Canvas)')
  return { path: dest, type: 'copy', mainRepoPath, baseRef: srcDir }
}

const MAX_MERGE_DIFF_CHARS = 8000

function capDiff(s: string, max = MAX_MERGE_DIFF_CHARS): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n...[diff truncated — read the full file from the branch directory]\n`
}

/**
 * Prepare a MERGE workspace: a fresh isolated copy of the project that an
 * OpenCode agent turns into the merged result of several branches.
 *
 * Layout: `<mainRepoPath>/.opencode-canvas/<folder>/<dirName>`. baseline
 * (baseRef) = the project. For each source branch we compute its diff vs its own
 * baseline and write everything (path + diff) into MERGE_TASK.md; the agent then
 * merges all sources into the working copy.
 */
export async function prepareMerge(
  sources: ForkWorkspace[],
  opts: MergePrepareOptions
): Promise<ForkWorkspace> {
  if (!sources || sources.length < 2) {
    throw new Error('merge needs at least 2 source branches')
  }
  const { mainRepoPath, folder, dirName } = opts
  if (!mainRepoPath) throw new Error('prepareMerge: mainRepoPath is required')
  if (!folder || !dirName) throw new Error('prepareMerge: folder and dirName are required')

  const dest = join(storeRoot(mainRepoPath), folder, dirName)
  await rm(dest, { recursive: true, force: true })
  await copyProject(mainRepoPath, dest)

  const sections: string[] = []
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i]
    let diff = ''
    try {
      diff = src.baseRef ? await diffWorkspace(src) : ''
    } catch {
      diff = ''
    }
    sections.push(
      `### Branch ${i + 1}\n` +
        `Working dir: \`${src.path}\`\n` +
        `Changed files (diff vs this branch's baseline):\n` +
        '```diff\n' +
        (capDiff(diff.trim()) || '(no changes detected / no baseline)') +
        '\n```\n'
    )
  }

  const task =
    '# Merge Task (OpenCode Canvas)\n\n' +
    'You are in a MERGE WORKSPACE. Your job is to combine the changes from the\n' +
    'branch working directories below into THIS directory (the current working\n' +
    'directory).\n\n' +
    '## Source branches\n\n' +
    sections.join('\n') +
    '\n## Rules\n' +
    "- Merge ALL listed branches' changes into the current directory.\n" +
    "- You MAY read full files from each branch's working-dir path above — they\n" +
    '  are the ONLY absolute paths you should touch outside the cwd.\n' +
    '- When two branches changed the SAME file, combine both sets of changes\n' +
    "  intelligently; do not drop either side's edits. If truly contradictory,\n" +
    '  keep both and add a short comment noting the conflict.\n' +
    '- Do NOT modify files that none of the branches changed.\n' +
    '- Write merged results to the current working directory using RELATIVE paths.\n' +
    '- When done, briefly summarize what you merged.\n'

  await writeFile(join(dest, 'MERGE_TASK.md'), task)
  await injectRule(dest, 'Merge Workspace', MERGE_RULE, 'Merge Workspace (OpenCode Canvas)')
  await ensureGitignored(mainRepoPath)

  return { path: dest, type: 'copy', mainRepoPath, baseRef: mainRepoPath }
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

/** Tear down a branch workspace (its own working folder only). */
export async function removeWorkspace(ws: ForkWorkspace): Promise<void> {
  try {
    await rm(ws.path, { recursive: true, force: true })
    // NOTE: baseRef is NOT owned by this node — it is the parent folder or the
    // project itself — so it must never be deleted here.
  } catch {
    // best-effort
  }
}
