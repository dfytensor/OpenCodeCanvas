// Directory diff via `git diff --no-index` (no repo required). Logic borrowed
// from legacy.ts (1.0) and extended with glob post-filtering.
import { execFile } from 'child_process'
import { promisify } from 'util'
import { relative } from 'path'

const run = promisify(execFile)

export async function diffDirs(a: string, b: string, pathFilters?: string[]): Promise<string> {
  let raw = ''
  try {
    const r = await run('git', ['diff', '--no-index', '--no-color', a, b])
    raw = r.stdout
  } catch (e: unknown) {
    // exit code 1 = differences found, output is on stdout
    const err = e as { stdout?: string }
    raw = err.stdout ?? ''
  }
  if (pathFilters && pathFilters.length > 0) {
    raw = splitDiffChunks(raw)
      .filter((chunk) => {
        const paths = chunkPaths(chunk)
        return paths.length > 0 && paths.some((p) => pathMatchesGlob(toRel(p, a, b), pathFilters))
      })
      .join('')
  }
  return raw.split(a).join('').split(b).join('').replace(/\/{2,}/g, '/')
}

export async function diffNameStatus(
  a: string,
  b: string,
  pathFilters?: string[]
): Promise<Array<{ status: 'A' | 'M' | 'D'; rel: string }>> {
  let out = ''
  try {
    const r = await run('git', ['diff', '--no-index', '--name-status', a, b])
    out = r.stdout
  } catch (e: unknown) {
    const err = e as { stdout?: string }
    out = err.stdout ?? ''
  }
  const changes = parseNameStatus(out, a, b)
  if (!pathFilters || pathFilters.length === 0) return changes
  return changes.filter((c) => pathMatchesGlob(c.rel, pathFilters))
}

/** Minimal glob: `**` → `.*`, `*` → `[^/]*`, `?` → `.`, rest escaped; case-insensitive (Windows). */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '.'
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`, 'i')
}

export function pathMatchesGlob(p: string, globs: string[]): boolean {
  const norm = p.replace(/\\/g, '/')
  return globs.some((g) => globToRegExp(g).test(norm))
}

interface FileChange {
  status: 'A' | 'M' | 'D'
  rel: string
}

/** Turn one `git diff --no-index` path token into a project-relative path. */
function toRel(token: string, baseRef: string, copyPath: string): string {
  // git may emit either `a/<abspath>` (unified diff) or a bare `<abspath>`
  // (--name-status). Strip the optional a//b/ prefix, then the known
  // snapshot/copy directory prefix, to recover the relative path.
  const t = token.replace(/^"|"$/g, '').replace(/^[ab]\//, '')
  const aP = baseRef + '/'
  const bP = copyPath + '/'
  if (t.startsWith(aP)) return t.slice(aP.length).replace(/\\/g, '/')
  if (t.startsWith(bP)) return t.slice(bP.length).replace(/\\/g, '/')
  const rb = relative(baseRef, t)
  if (rb && !rb.startsWith('..')) return rb.replace(/\\/g, '/')
  const rp = relative(copyPath, t)
  if (rp && !rp.startsWith('..')) return rp.replace(/\\/g, '/')
  return t.replace(/\\/g, '/')
}

function parseNameStatus(out: string, baseRef: string, copyPath: string): FileChange[] {
  const changes: FileChange[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const status = line[0] as 'A' | 'M' | 'D'
    if (status !== 'A' && status !== 'M' && status !== 'D') continue
    // rename lines look like: R100\told\tnew — take the last token
    const tokens = line.slice(1).trim().split('\t')
    const rel = toRel(tokens[tokens.length - 1], baseRef, copyPath)
    if (rel) changes.push({ status, rel })
  }
  return changes
}

function splitDiffChunks(raw: string): string[] {
  const chunks: string[] = []
  let cur: string[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git') && cur.length > 0) {
      chunks.push(cur.join('\n'))
      cur = [line]
    } else {
      cur.push(line)
    }
  }
  if (cur.length > 0) chunks.push(cur.join('\n'))
  return chunks
}

function chunkPaths(chunk: string): string[] {
  const paths: string[] = []
  for (const line of chunk.split('\n')) {
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const t = line.slice(4).trim()
      if (!t || t === '/dev/null') continue
      paths.push(t.replace(/^"|"$/g, ''))
    }
  }
  return paths
}
