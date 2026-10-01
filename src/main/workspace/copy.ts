// Recursive tree copy with §6.0 recursion protection: a copy must never
// swallow an existing .occ store (e.g. when the target resolves inside the
// source tree). Exclusions mirror hash.ts so copy and hash see the same tree.
import { join } from 'path'
import { existsSync } from 'fs'
import { copyFile, mkdir, readdir, rm } from 'fs/promises'
import { isExcludedDir, isExcludedFile } from './hash'

export class CopyAssertionError extends Error {}

export async function assertNoOcc(dir: string): Promise<void> {
  const occ = join(dir, '.occ')
  if (existsSync(occ)) {
    throw new CopyAssertionError(`copy target already contains a .occ store: ${occ}`)
  }
}

async function copyRecursive(src: string, dest: string): Promise<number> {
  await mkdir(dest, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  let files = 0
  for (const e of entries) {
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) {
      if (isExcludedDir(e.name)) continue
      files += await copyRecursive(join(src, e.name), join(dest, e.name))
    } else if (e.isFile()) {
      if (isExcludedFile(e.name)) continue
      await copyFile(join(src, e.name), join(dest, e.name))
      files++
    }
  }
  return files
}

export async function copyTree(src: string, dest: string): Promise<{ files: number }> {
  const files = await copyRecursive(src, dest)
  try {
    await assertNoOcc(dest)
  } catch (e) {
    // §6.0: never leave a half-built copy that contains a .occ store
    await rm(dest, { recursive: true, force: true })
    throw e
  }
  return { files }
}
