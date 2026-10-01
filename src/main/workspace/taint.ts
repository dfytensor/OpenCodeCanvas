// §14.1 taint scan (P0 heuristic): flag nodes whose diff touches well-known
// secret-bearing files. Placeholder scope — confirmed-taint analysis comes later.
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { diffNameStatus } from './diff'

const SENSITIVE_FILE = /(^|\/)(\.env|secrets?\.|credentials|id_rsa|\.npmrc)/i

/**
 * The snapshot dir is a sibling of the work dir inside .occ/nodes/<id>/,
 * so it is derived from workDir rather than passed in.
 */
export async function scanNodeForTaintSignals(workDir: string): Promise<'none' | 'suspicious'> {
  if (!workDir || !existsSync(workDir)) return 'none'
  const snapshotDir = join(dirname(workDir), 'snapshot')
  if (!existsSync(snapshotDir)) return 'none'
  const changes = await diffNameStatus(snapshotDir, workDir)
  return changes.some((c) => SENSITIVE_FILE.test(c.rel)) ? 'suspicious' : 'none'
}
