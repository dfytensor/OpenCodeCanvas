// §10 apply: project the node's changes onto a target dir file-by-file.
// No merge algorithm — IO failures are recorded as conflicts and left for
// agent arbitration (onConflict: 'agent').
import { dirname, join } from 'path'
import { copyFile, mkdir, rm, writeFile } from 'fs/promises'
import { diffNameStatus } from './diff'

export interface ApplyResult {
  applied: string[]
  deleted: string[]
  skipped: string[]
  conflictFiles: string[]
}

export async function applyCopyChanges(
  base: string,
  copy: string,
  destDir: string,
  opts?: { paths?: string[] }
): Promise<ApplyResult> {
  const result: ApplyResult = { applied: [], deleted: [], skipped: [], conflictFiles: [] }
  const changes = await diffNameStatus(base, copy, opts?.paths)
  for (const ch of changes) {
    const dest = join(destDir, ch.rel)
    try {
      if (ch.status === 'D') {
        await rm(dest, { force: true })
        result.deleted.push(ch.rel)
      } else {
        await mkdir(dirname(dest), { recursive: true })
        await copyFile(join(copy, ch.rel), dest)
        result.applied.push(ch.rel)
      }
    } catch {
      // keep going; the agent resolves conflicts from CONFLICT.md
      result.conflictFiles.push(ch.rel)
    }
  }
  return result
}

/** Write CONFLICT.md into destDir; returns its path, or '' when nothing to report. */
export async function writeConflictReport(
  destDir: string,
  result: ApplyResult,
  planLabel: string
): Promise<string> {
  if (result.conflictFiles.length === 0 && result.skipped.length === 0) return ''
  const lines: string[] = []
  lines.push('# Conflict Report', '', `Plan: ${planLabel}`, `Generated: ${new Date().toISOString()}`, '')
  if (result.conflictFiles.length > 0) {
    lines.push('## Files that could not be applied (resolve manually)', '')
    for (const f of result.conflictFiles) lines.push(`- \`${f}\``)
    lines.push('')
  }
  if (result.skipped.length > 0) {
    lines.push('## Files skipped (outside the planned path set)', '')
    for (const f of result.skipped) lines.push(`- \`${f}\``)
    lines.push('')
  }
  lines.push(
    '## Summary',
    '',
    `- applied: ${result.applied.length}`,
    `- deleted: ${result.deleted.length}`,
    `- conflicts: ${result.conflictFiles.length}`,
    `- skipped: ${result.skipped.length}`,
    ''
  )
  const reportPath = join(destDir, 'CONFLICT.md')
  await mkdir(destDir, { recursive: true })
  await writeFile(reportPath, lines.join('\n'), 'utf8')
  return reportPath
}
