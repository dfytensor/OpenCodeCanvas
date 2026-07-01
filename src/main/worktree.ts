import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { randomBytes } from 'crypto'

const run = promisify(execFile)

export function shortId(): string {
  return randomBytes(4).toString('hex')
}

export function execGit(cwd: string, args: string[]): Promise<string> {
  return run('git', ['-C', cwd, ...args], {
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true
  }).then((r) => r.stdout)
}

export async function isRepo(path: string): Promise<boolean> {
  try {
    await execGit(path, ['rev-parse', '--is-inside-work-tree'])
    return true
  } catch {
    return false
  }
}

export async function repoRoot(path: string): Promise<string> {
  const root = (await execGit(path, ['rev-parse', '--show-toplevel'])).trim()
  return root
}

export async function worktreeAdd(repoPath: string, branchName: string): Promise<string> {
  const root = await repoRoot(repoPath)
  const wtPath = join(root, '.opencode-canvas', 'worktrees', branchName)
  // create branch from current HEAD, add worktree at wtPath
  await execGit(root, ['worktree', 'add', '-b', branchName, wtPath, 'HEAD'])
  return wtPath
}

export async function worktreeRemove(path: string): Promise<void> {
  try {
    const root = await repoRoot(path)
    await execGit(root, ['worktree', 'remove', '--force', path])
    // prune the worktree dir
    const branch = path.split(/[/\\]/).pop()!
    try {
      await execGit(root, ['branch', '-D', branch])
    } catch {
      // branch may be checked out / merged; ignore
    }
  } catch {
    // ignore cleanup failures
  }
}

export async function gitDiff(worktree: string, base?: string): Promise<string> {
  const args = base ? ['diff', base] : ['diff', 'HEAD']
  return execGit(worktree, args)
}
