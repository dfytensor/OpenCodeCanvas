// Snapshot / baseline materialization for the §3.5 content-addressed store.
// Layout: <rootDir>/.occ/nodes/<nodeId>/{copy,snapshot,context,artifacts}
import { spawn } from 'child_process'
import { basename, join } from 'path'
import { existsSync } from 'fs'
import { mkdir, rm } from 'fs/promises'
import type { BaseRef } from '../../shared/types'
import { copyTree } from './copy'
import { hashDirFast } from './hash'

export interface NodeDirs {
  nodeDir: string
  copyDir: string
  snapshotDir: string
  contextDir: string
  artifactsDir: string
}

/** Pure path computation — creates nothing. */
export function nodeDirs(rootDir: string, nodeId: string): NodeDirs {
  const nodeDir = join(rootDir, '.occ', 'nodes', nodeId)
  return {
    nodeDir,
    copyDir: join(nodeDir, 'copy'),
    snapshotDir: join(nodeDir, 'snapshot'),
    contextDir: join(nodeDir, 'context'),
    artifactsDir: join(nodeDir, 'artifacts')
  }
}

export async function ensureNodeDirs(rootDir: string, nodeId: string): Promise<NodeDirs> {
  const dirs = nodeDirs(rootDir, nodeId)
  await mkdir(dirs.nodeDir, { recursive: true })
  await mkdir(dirs.copyDir, { recursive: true })
  await mkdir(dirs.snapshotDir, { recursive: true })
  await mkdir(dirs.contextDir, { recursive: true })
  await mkdir(dirs.artifactsDir, { recursive: true })
  return dirs
}

export async function createSnapshotForNode(
  rootDir: string,
  nodeId: string,
  srcDir: string
): Promise<BaseRef> {
  const { snapshotDir } = nodeDirs(rootDir, nodeId)
  await rm(snapshotDir, { recursive: true, force: true })
  await copyTree(srcDir, snapshotDir)
  return {
    kind: 'snapshot',
    contentHash: await hashDirFast(snapshotDir),
    label: `${basename(srcDir)}@${new Date().toISOString().slice(0, 16)}`,
    dir: snapshotDir
  }
}

/**
 * Materialize a persisted base into `destDir` (wiped first). snapshot/node
 * kinds copy from `base.dir`; commit kind pipes `git archive` through the
 * Windows-bundled bsdtar (best effort, throws on failure).
 */
export async function materializeBase(base: BaseRef, destDir: string): Promise<void> {
  if ((base.kind === 'snapshot' || base.kind === 'node') && base.dir && existsSync(base.dir)) {
    await rm(destDir, { recursive: true, force: true })
    await copyTree(base.dir, destDir)
    return
  }
  if (base.kind === 'commit') {
    if (base.dir && existsSync(join(base.dir, '.git'))) {
      await rm(destDir, { recursive: true, force: true })
      await mkdir(destDir, { recursive: true })
      await gitArchiveExtract(base.dir, base.contentHash, destDir)
      return
    }
    throw new Error('CLEAN_REPO baseline materialization is not supported yet (planned P4)')
  }
  throw new Error(
    `materializeBase: base dir missing for kind '${base.kind}' (${base.label || base.contentHash})`
  )
}

function gitArchiveExtract(repoDir: string, hash: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const git = spawn('git', ['-C', repoDir, 'archive', hash], { windowsHide: true })
    const tar = spawn('tar', ['-x', '-C', destDir], { windowsHide: true })
    // if tar dies first, swallow EPIPE on its stdin
    tar.stdin.on('error', () => {})
    git.stdout.pipe(tar.stdin)
    let errText = ''
    git.stderr.on('data', (d: Buffer) => {
      errText += d.toString()
    })
    tar.stderr.on('data', (d: Buffer) => {
      errText += d.toString()
    })
    let gitCode: number | null = null
    let tarCode: number | null = null
    const settle = () => {
      if (gitCode === null || tarCode === null) return
      if (gitCode === 0 && tarCode === 0) resolve()
      else {
        reject(
          new Error(
            `materializeBase: git archive | tar failed (git=${gitCode}, tar=${tarCode}): ${errText.trim()}`
          )
        )
      }
    }
    git.on('error', reject)
    tar.on('error', reject)
    git.on('close', (code) => {
      gitCode = code
      settle()
    })
    tar.on('close', (code) => {
      tarCode = code
      settle()
    })
  })
}
