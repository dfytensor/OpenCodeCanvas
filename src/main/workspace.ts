import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { mkdir, cp, rm, readdir, appendFile, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { execGit, isRepo, repoRoot } from './worktree'
import type { ForkWorkspace } from '../shared/types'

const run = promisify(execFile)
const STORE_DIR = '.opencode-canvas'
const IGNORE = new Set([STORE_DIR, 'node_modules', '.git', '.cache', 'dist', 'out', 'build'])

function storeRoot(projectDir: string): string {
  return join(projectDir, STORE_DIR)
}

/**
 * Ensure the tool-managed store dir is gitignored so worktrees/snapshots
 * don't pollute the user's repo.
 */
async function ensureGitignored(root: string): Promise<void> {
  const gi = join(root, '.gitignore')
  let content = ''
  if (existsSync(gi)) content = await readFile(gi, 'utf8')
  if (!content.includes(STORE_DIR + '/')) {
    await appendFile(gi, `\n# opencode-canvas tool store\n${STORE_DIR}/\n`)
  }
}

/**
 * Copy a project tree (skipping heavy/tool-managed dirs) into dest.
 * Used for the non-git isolation fallback.
 */
async function copyProject(src: string, dest: string): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true })
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue
    await cp(join(src, e.name), join(dest, e.name), { recursive: true })
  }
}

/**
 * Prepare an isolated working directory for a fork.
 *  - git repo  -> a real `git worktree` (shares .git, isolated files)
 *  - non-git   -> a copied snapshot (self-contained isolation)
 */
export async function prepareForkWorkspace(
  projectDir: string,
  nodeId: string
): Promise<ForkWorkspace> {
  const shortId = nodeId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'fork'
  const repo = await isRepo(projectDir)

  if (repo) {
    const root = await repoRoot(projectDir)
    await ensureGitignored(root)
    const branchName = `oc-fork-${shortId}`
    const wtPath = join(root, STORE_DIR, 'worktrees', branchName)
    await mkdir(join(root, STORE_DIR, 'worktrees'), { recursive: true })
    // branch from current HEAD, materialise in its own worktree
    await execGit(root, ['worktree', 'add', '-b', branchName, wtPath, 'HEAD'])
    return { path: wtPath, type: 'worktree', branchName, mainRepoPath: root, baseRef: 'HEAD' }
  }

  // non-git: self-built isolation via snapshot + copy
  const baseSnap = join(storeRoot(projectDir), 'snapshots', shortId)
  const wsCopy = join(storeRoot(projectDir), 'copies', shortId)
  await mkdir(baseSnap, { recursive: true })
  await mkdir(wsCopy, { recursive: true })
  await copyProject(projectDir, baseSnap)
  await copyProject(projectDir, wsCopy)
  return { path: wsCopy, type: 'copy', mainRepoPath: projectDir, baseRef: baseSnap }
}

/**
 * Unified diff of what the branch changed vs its fork point.
 *  - worktree: working tree vs branch tip
 *  - copy:     workspace vs base snapshot (git diff --no-index, no repo needed)
 */
export async function diffWorkspace(ws: ForkWorkspace): Promise<string> {
  if (ws.type === 'worktree') {
    try {
      return await execGit(ws.path, ['diff', 'HEAD'])
    } catch {
      return ''
    }
  }
  // git diff --no-index exits 1 when differences exist (stdout = the diff)
  try {
    const r = await run('git', ['diff', '--no-index', '--no-color', ws.baseRef!, ws.path])
    return r.stdout
  } catch (e: unknown) {
    const err = e as { stdout?: string }
    return err.stdout ?? ''
  }
}

/**
 * Merge / copy the branch's changes back into the main project.
 */
export async function applyWorkspaceToMain(
  ws: ForkWorkspace
): Promise<{ ok: boolean; message: string }> {
  if (ws.type === 'worktree' && ws.branchName) {
    try {
      // commit the branch's working tree so it can be merged
      await execGit(ws.path, ['add', '-A'])
      try {
        await execGit(ws.path, ['commit', '-m', `opencode-canvas: ${ws.branchName} snapshot`])
      } catch {
        // nothing to commit is fine
      }
      await execGit(ws.mainRepoPath, ['merge', '--no-edit', ws.branchName])
      return { ok: true, message: `merged '${ws.branchName}' into the main branch` }
    } catch (e: unknown) {
      const err = e as { stderr?: string; message?: string }
      return { ok: false, message: String(err.stderr ?? err.message ?? e) }
    }
  }
  // copy mode: write the branch's files back over the main project
  try {
    await copyProject(ws.path, ws.mainRepoPath)
    return { ok: true, message: 'copied fork files back into the project' }
  } catch (e: unknown) {
    const err = e as { message?: string }
    return { ok: false, message: String(err.message ?? e) }
  }
}

/**
 * Tear down an isolated workspace (worktree removal / dir delete).
 */
export async function removeWorkspace(ws: ForkWorkspace): Promise<void> {
  try {
    if (ws.type === 'worktree') {
      await execGit(ws.mainRepoPath, ['worktree', 'remove', '--force', ws.path])
      if (ws.branchName) {
        try {
          await execGit(ws.mainRepoPath, ['branch', '-D', ws.branchName])
        } catch {
          // branch may be merged/in-use; ignore
        }
      }
    } else {
      await rm(ws.path, { recursive: true, force: true })
      if (ws.baseRef) await rm(ws.baseRef, { recursive: true, force: true })
    }
  } catch {
    // best-effort cleanup
  }
}
