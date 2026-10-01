// §6.1 layered storage downgrade: archive keeps everything needed to
// reconstruct a node, frees the heavy live copy. Never deletes the snapshot,
// the archived diff, or metadata — nodes are never fully erased (§14).
import { spawn } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import type { BaseRef, SessionNode } from '../../shared/types'
import { copyTree } from './copy'
import { diffDirs } from './diff'
import { nodeDirs, materializeBase } from './snapshot'

export async function dirSize(dir: string): Promise<number> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      total += await dirSize(p)
    } else if (e.isFile()) {
      const st = await stat(p)
      total += st.size
    }
  }
  return total
}

/**
 * Archive a node's storage: persist the snapshot→work diff to archive.diff,
 * then remove the live copy. snapshot + archive.diff + meta are kept.
 */
export async function archiveNodeStorage(
  rootDir: string,
  node: SessionNode
): Promise<{ diffPath: string | null; freedBytes: number }> {
  if (!node.workDir || !existsSync(node.workDir)) {
    throw new Error(`archiveNodeStorage: workDir missing for node ${node.id}`)
  }
  const dirs = nodeDirs(rootDir, node.id)
  const diff = node.snapshotDir && existsSync(node.snapshotDir)
    ? await diffDirs(node.snapshotDir, node.workDir)
    : ''
  let diffPath: string | null = null
  if (diff.trim()) {
    await mkdir(dirs.nodeDir, { recursive: true })
    diffPath = join(dirs.nodeDir, 'archive.diff')
    await writeFile(diffPath, diff, 'utf8')
  }
  const freedBytes = existsSync(dirs.copyDir) ? await dirSize(dirs.copyDir) : 0
  await rm(dirs.copyDir, { recursive: true, force: true })
  return { diffPath, freedBytes }
}

/** Rebuild the live copy dir for an archived node. */
export async function rehydrateNodeStorage(
  rootDir: string,
  node: SessionNode
): Promise<{ copyDir: string; restored: 'diff' | 'copy' }> {
  const dirs = nodeDirs(rootDir, node.id)
  if (existsSync(dirs.copyDir)) {
    return { copyDir: dirs.copyDir, restored: 'copy' }
  }

  const base = effectiveBase(node)
  await mkdir(dirs.nodeDir, { recursive: true })
  await materializeBase(base, dirs.copyDir)

  const diffPath = join(dirs.nodeDir, 'archive.diff')
  if (existsSync(diffPath)) {
    const diffText = await readFile(diffPath, 'utf8')
    if (await tryGitApply(dirs.copyDir, diffText)) {
      return { copyDir: dirs.copyDir, restored: 'diff' }
    }
    // diff apply failed — fall back to a full snapshot copy when possible
    if (node.snapshotDir && existsSync(node.snapshotDir)) {
      await rm(dirs.copyDir, { recursive: true, force: true })
      await copyTree(node.snapshotDir, dirs.copyDir)
    }
  }
  return { copyDir: dirs.copyDir, restored: 'copy' }
}

function effectiveBase(node: SessionNode): BaseRef {
  if (node.baseRef?.dir) return node.baseRef
  // baseRef.dir missing → fall back to the node's own snapshot
  if (node.baseRef && node.snapshotDir) {
    return { ...node.baseRef, kind: 'snapshot', dir: node.snapshotDir }
  }
  if (node.snapshotDir) {
    return { kind: 'snapshot', contentHash: '', label: 'snapshot', dir: node.snapshotDir }
  }
  throw new Error(`rehydrateNodeStorage: no baseRef or snapshot for node ${node.id}`)
}

function tryGitApply(cwd: string, diffText: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('git', ['apply', '--whitespace=nowarn', '-'], { cwd, windowsHide: true })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
    child.stdin.on('error', () => {})
    child.stdin.end(diffText)
  })
}
