// Project open/bootstrap flow: project record + graph binding + mainline root node.
import type { GraphDoc, Project, SessionNode } from '../../shared/types'
import { openProject, saveProject } from './registry'
import { getGraph, newSessionNode, patchNode, saveGraph, upsertNode } from '../graph/store'
import { hashDirFast } from '../workspace/hash'

export async function openProjectWithGraph(
  rootDir: string
): Promise<{ project: Project; graph: GraphDoc }> {
  const project = await openProject(rootDir)
  const graph = await getGraph(rootDir)
  if (!graph.projectId) {
    graph.projectId = project.id
    await saveGraph(rootDir, graph)
  }
  return { project, graph }
}

export async function ensureMainline(
  rootDir: string
): Promise<{ project: Project; rootNode: SessionNode }> {
  const { project, graph } = await openProjectWithGraph(rootDir)
  const existing = project.mainlineNodeId ? graph.nodes[project.mainlineNodeId] : undefined
  if (existing) return { project, rootNode: existing }

  // floating baseRef until hashed — snapshot + hash is backfilled below (§3.5)
  let rootNode = newSessionNode(graph, {
    projectId: project.id,
    title: project.name,
    kind: 'root',
    status: 'completed',
    workDir: rootDir,
    parents: [],
    baseRef: {
      kind: 'snapshot',
      contentHash: 'pending',
      label: `mainline@${new Date().toISOString()}`
    }
  })
  rootNode = await upsertNode(rootDir, rootNode)

  // lazy backfill: hashDirFast skips .occ, so graph writes during hashing are stable
  const contentHash = await hashDirFast(rootDir)
  if (rootNode.baseRef) {
    rootNode = await patchNode(rootDir, rootNode.id, {
      baseRef: { ...rootNode.baseRef, contentHash }
    })
  }

  const updated: Project = { ...project, mainlineNodeId: rootNode.id }
  await saveProject(rootDir, updated)
  return { project: updated, rootNode }
}

// completed/frozen nodes whose updatedAt is older than `days` — candidates only, no side effects
export function staleArchiveCandidates(
  graph: GraphDoc,
  days: number,
  now: number = Date.now()
): SessionNode[] {
  const cutoff = now - days * 86_400_000
  return Object.values(graph.nodes).filter(
    (n) =>
      (n.status === 'completed' || n.status === 'frozen') && Date.parse(n.updatedAt) < cutoff
  )
}
