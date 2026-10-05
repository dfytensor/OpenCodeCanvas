// .occ layout + append-only graph store.
// §4.6: single source of truth is <rootDir>/.occ/graph.json; in-memory cache is write-through.
// §14: nodes are never deleted -?only status transitions (freeze/archive).
import { promises as fs } from 'fs'
import * as path from 'path'
import { nanoid } from '../ids'
import type { GraphDoc, GraphEdge, NodeID, NodeStatus, SessionNode } from '../../shared/types'
import { emitOccEvent } from './events'
import { GraphError, assertTransition } from './stateMachine'

export interface OccPaths {
  occDir: string
  projectJson: string
  graphJson: string
  nodesDir: string
  serverJson: string
  summariesDir: string
  orchestratorDir: string
}

export function occPaths(rootDir: string): OccPaths {
  const occDir = path.join(rootDir, '.occ')
  return {
    occDir,
    projectJson: path.join(occDir, 'project.json'),
    graphJson: path.join(occDir, 'graph.json'),
    nodesDir: path.join(occDir, 'nodes'),
    serverJson: path.join(occDir, 'server.json'),
    summariesDir: path.join(occDir, 'summaries'),
    orchestratorDir: path.join(occDir, 'orchestrator')
  }
}

export async function ensureOccDirs(rootDir: string): Promise<OccPaths> {
  const paths = occPaths(rootDir)
  await fs.mkdir(paths.occDir, { recursive: true })
  await Promise.all([
    fs.mkdir(paths.nodesDir, { recursive: true }),
    fs.mkdir(paths.summariesDir, { recursive: true }),
    fs.mkdir(paths.orchestratorDir, { recursive: true })
  ])
  return paths
}

async function writeFileAtomicRetry(file: string, data: string): Promise<void> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    const tmp = `${file}.${nanoid(6)}.tmp`
    try {
      await fs.writeFile(tmp, data, 'utf8')
      try {
        await fs.rename(tmp, file)
      } catch (e) {
        await fs.unlink(tmp).catch(() => undefined)
        throw e
      }
      return
    } catch (e) {
      lastErr = e
      // Windows: concurrent MoveFileEx to the same target and AV/indexer
      // scans cause transient EPERM — back off and retry
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1) * (attempt + 1)))
    }
  }
  throw lastErr
}

// per-project write serialization — concurrent saveGraph on one root otherwise
// races their rename steps against each other
const saveLocks = new Map<string, Promise<unknown>>()

// cache key: rootDir
const cache = new Map<string, GraphDoc>()

export async function loadGraph(rootDir: string): Promise<GraphDoc | null> {
  try {
    const raw = await fs.readFile(occPaths(rootDir).graphJson, 'utf8')
    return JSON.parse(raw) as GraphDoc
  } catch {
    return null
  }
}

export async function saveGraph(rootDir: string, graph: GraphDoc): Promise<void> {
  graph.updatedAt = new Date().toISOString()
  cache.set(rootDir, graph)
  await ensureOccDirs(rootDir)
  const prev = saveLocks.get(rootDir) ?? Promise.resolve()
  const task = prev.then(() =>
    writeFileAtomicRetry(occPaths(rootDir).graphJson, JSON.stringify(graph, null, 2))
  )
  saveLocks.set(rootDir, task.catch(() => undefined))
  await task
}

export async function getGraph(rootDir: string): Promise<GraphDoc> {
  const cached = cache.get(rootDir)
  if (cached) return cached
  const loaded = await loadGraph(rootDir)
  if (loaded) {
    cache.set(rootDir, loaded)
    return loaded
  }
  const graph: GraphDoc = {
    projectId: '',
    nodes: {},
    edges: [],
    updatedAt: new Date().toISOString()
  }
  await saveGraph(rootDir, graph)
  return graph
}

export async function getNode(rootDir: string, id: NodeID): Promise<SessionNode | null> {
  const graph = await getGraph(rootDir)
  return graph.nodes[id] ?? null
}

export async function upsertNode(rootDir: string, node: SessionNode): Promise<SessionNode> {
  const graph = await getGraph(rootDir)
  node.updatedAt = new Date().toISOString()
  graph.nodes[node.id] = node
  await saveGraph(rootDir, graph)
  emitOccEvent({ type: 'node.changed', node })
  return node
}

export async function patchNode(
  rootDir: string,
  id: NodeID,
  patch: Partial<SessionNode>
): Promise<SessionNode> {
  const graph = await getGraph(rootDir)
  const node = graph.nodes[id]
  if (!node) throw new GraphError('NOT_FOUND', `node not found: ${id}`)
  Object.assign(node, patch)
  return upsertNode(rootDir, node)
}

export async function transitionNode(
  rootDir: string,
  id: NodeID,
  to: NodeStatus,
  extra?: Partial<SessionNode>
): Promise<SessionNode> {
  const graph = await getGraph(rootDir)
  const node = graph.nodes[id]
  if (!node) throw new GraphError('NOT_FOUND', `node not found: ${id}`)
  if (node.status === to) {
    // idempotent: the native agent loop and the executor may race to set the
    // same status — that is not an error
    return patchNode(rootDir, id, { ...extra })
  }
  assertTransition(node.status, to)
  return patchNode(rootDir, id, { ...extra, status: to })
}

export async function addEdge(rootDir: string, edge: GraphEdge): Promise<GraphEdge> {
  const graph = await getGraph(rootDir)
  const dup = graph.edges.find(
    (e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind
  )
  if (dup) return dup
  graph.edges.push(edge)
  await saveGraph(rootDir, graph)
  emitOccEvent({ type: 'edge.added', edge })
  return edge
}

export function computeGen(graph: GraphDoc, parents: NodeID[]): number {
  if (parents.length === 0) return 0
  let max = -1
  for (const pid of parents) {
    const parent = graph.nodes[pid]
    if (!parent) throw new GraphError('NOT_FOUND', `parent node not found: ${pid}`)
    if (parent.gen > max) max = parent.gen
  }
  return max + 1
}

// walk up the parents chain from every parent; CYCLE if newNodeId is reachable
export function assertAcyclic(graph: GraphDoc, parents: NodeID[], newNodeId: NodeID): void {
  const stack = [...parents]
  const seen = new Set<NodeID>()
  while (stack.length > 0) {
    const cur = stack.pop() as NodeID
    if (cur === newNodeId) {
      throw new GraphError('CYCLE', `edge would create a cycle through node ${newNodeId}`)
    }
    if (seen.has(cur)) continue
    seen.add(cur)
    const node = graph.nodes[cur]
    if (node) stack.push(...node.parents)
  }
}

export function listChildren(graph: GraphDoc, id: NodeID): SessionNode[] {
  return Object.values(graph.nodes).filter((n) => n.parents.includes(id))
}

export function listDescendants(graph: GraphDoc, id: NodeID): SessionNode[] {
  const out: SessionNode[] = []
  const seen = new Set<NodeID>([id])
  const queue: NodeID[] = [id]
  while (queue.length > 0) {
    const cur = queue.shift() as NodeID
    for (const child of listChildren(graph, cur)) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      out.push(child)
      queue.push(child.id)
    }
  }
  return out
}

/**
 * Create an in-memory node (not yet persisted -?call upsertNode).
 * Signature: newSessionNode(graph, init) -?gen is derived from init.parents via
 * computeGen, or use init.gen to override explicitly.
 */
export function newSessionNode(
  graph: GraphDoc,
  init: Partial<SessionNode> & { projectId: string; title: string }
): SessionNode {
  const now = new Date().toISOString()
  return {
    ...init,
    id: init.id ?? nanoid(10),
    status: init.status ?? 'draft',
    kind: init.kind ?? 'inherit',
    gen: init.gen ?? computeGen(graph, init.parents ?? []),
    parents: init.parents ?? [],
    taint: init.taint ?? 'none',
    tokenUsage: init.tokenUsage ?? { input: 0, output: 0, cached: 0 },
    viewMode: init.viewMode ?? 'headless',
    createdAt: init.createdAt ?? now,
    updatedAt: now
  }
}

// §14.1: set taint on source; descendants become 'suspicious' (never downgrade 'confirmed')
export async function propagateTaint(
  rootDir: string,
  sourceId: NodeID,
  level: 'suspicious' | 'confirmed'
): Promise<number> {
  const graph = await getGraph(rootDir)
  const source = graph.nodes[sourceId]
  if (!source) throw new GraphError('NOT_FOUND', `node not found: ${sourceId}`)

  let affected = 0
  if (source.taint !== level) {
    await patchNode(rootDir, sourceId, { taint: level })
    affected++
  }
  for (const desc of listDescendants(graph, sourceId)) {
    if (desc.taint === 'confirmed' || desc.taint === 'suspicious') continue
    await patchNode(rootDir, desc.id, { taint: 'suspicious' })
    affected++
  }
  return affected
}

// §4.6 (1): compact projection for tool queries / UI lists
export function summarizeNodes(
  graph: GraphDoc
): Array<{ id: NodeID; title: string; status: NodeStatus; gen: number }> {
  return Object.values(graph.nodes).map((n) => ({
    id: n.id,
    title: n.title,
    status: n.status,
    gen: n.gen
  }))
}
