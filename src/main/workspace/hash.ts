// Content-addressed hash for a directory tree (§3.5): sha256 over the sorted
// manifest of (relative path, file-content hash). Files above the size cap fall
// back to (size, mtime) so huge artifacts cannot stall snapshotting. Skips
// build/dependency/occ internals so the hash reflects source state, not noise.
import { createHash } from 'crypto'
import { join } from 'path'
import { readFile, readdir, stat } from 'fs/promises'

const CONTENT_HASH_CAP = 4 * 1024 * 1024

export const EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  '.occ',
  'node_modules',
  '.git',
  '.cache',
  'dist',
  'out',
  'build',
  '.next',
  '.turbo',
  '.venv',
  'coverage'
])

export const EXCLUDE_FILE_SUFFIXES: readonly string[] = ['.log']

export function isExcludedDir(name: string): boolean {
  return EXCLUDE_DIRS.has(name)
}

export function isExcludedFile(name: string): boolean {
  if (name === '.DS_Store') return true
  return EXCLUDE_FILE_SUFFIXES.some((s) => name.endsWith(s))
}

interface ManifestRecord {
  relPath: string
  size: number
  mtimeMs: number
}

async function walk(absDir: string, rel: string, out: ManifestRecord[]): Promise<void> {
  const entries = await readdir(absDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const abs = join(absDir, entry.name)
    const relPath = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (isExcludedDir(entry.name)) continue
      await walk(abs, relPath, out)
    } else if (entry.isFile()) {
      if (isExcludedFile(entry.name)) continue
      const st = await stat(abs)
      out.push({ relPath, size: st.size, mtimeMs: Math.round(st.mtimeMs) })
    }
  }
}

/** Throws when `dir` does not exist (ENOENT) or is not a directory. */
export async function hashDirFast(dir: string): Promise<string> {
  const st = await stat(dir)
  if (!st.isDirectory()) throw new Error(`hashDirFast: not a directory: ${dir}`)
  const records: ManifestRecord[] = []
  await walk(dir, '', records)
  records.sort((x, y) => (x.relPath < y.relPath ? -1 : x.relPath > y.relPath ? 1 : 0))
  const hash = createHash('sha256')
  for (const r of records) {
    const abs = join(dir, r.relPath)
    if (r.size <= CONTENT_HASH_CAP) {
      // content-addressed: identical bytes → identical hash regardless of timing
      hash.update(`${r.relPath}\0${await hashFile(abs)}\n`)
    } else {
      hash.update(`${r.relPath}\0${r.size}\0${r.mtimeMs}\n`)
    }
  }
  return hash.digest('hex')
}

export async function hashFile(path: string): Promise<string> {
  const buf = await readFile(path)
  return createHash('sha256').update(buf).digest('hex')
}
