// §9.2 spatial semantics: X = generation (topological depth, growth axis),
// Y = sibling order within a generation. Existing node positions are FROZEN
// during incremental layout — only unseen nodes get computed coordinates
// (§9.2: never re-layout the whole canvas, the eye must not lose its target).
import type { GraphDoc, NodeID } from '../../shared/types'

export interface XY {
  x: number
  y: number
}

export const GEN_WIDTH = 340
export const SIBLING_HEIGHT = 150

// per-project position cache; positions are frozen once assigned
const cache = new Map<string, Map<NodeID, XY>>()

function cacheFor(projectId: string): Map<NodeID, XY> {
  let m = cache.get(projectId)
  if (!m) {
    m = new Map()
    cache.set(projectId, m)
  }
  return m
}

export function pinnedPosition(projectId: string, nodeId: NodeID): XY | undefined {
  return cacheFor(projectId).get(nodeId)
}

export function pinPosition(projectId: string, nodeId: NodeID, pos: XY): void {
  cacheFor(projectId).set(nodeId, pos)
}

/**
 * Compute positions for every node in the graph. Nodes already in the cache
 * keep their exact coordinates; new nodes are placed at the end of their
 * generation row, ordered by their first parent's Y (so a child grows next
 * to its parent), falling back to creation order.
 */
export function layoutGraph(graph: GraphDoc): Map<NodeID, XY> {
  const positions = cacheFor(graph.projectId || 'default')
  const nodes = Object.values(graph.nodes)
  if (nodes.length === 0) return positions

  // group by generation
  const byGen = new Map<number, typeof nodes>()
  for (const n of nodes) {
    const arr = byGen.get(n.gen) ?? []
    arr.push(n)
    byGen.set(n.gen, arr)
  }

  for (const [gen, siblings] of [...byGen.entries()].sort((a, b) => a[0] - b[0])) {
    const fresh = siblings.filter((n) => !positions.has(n.id))
    if (fresh.length === 0) continue

    // anchor Y = average of parents' Y, else parent-free baseline
    const anchored = fresh.map((n) => {
      const parentYs = n.parents
        .map((p) => positions.get(p)?.y)
        .filter((y): y is number => y !== undefined)
      const anchor = parentYs.length
        ? parentYs.reduce((a, b) => a + b, 0) / parentYs.length
        : gen * SIBLING_HEIGHT
      return { node: n, anchor, createdAt: n.createdAt }
    })
    anchored.sort((a, b) => a.anchor - b.anchor || a.createdAt.localeCompare(b.createdAt))

    // stack below the lowest occupied slot near each anchor
    for (const { node, anchor } of anchored) {
      let y = anchor
      const taken = new Set(
        [...positions.values()].filter((p) => Math.abs(p.x - gen * GEN_WIDTH) < 1).map((p) => Math.round(p.y))
      )
      while (taken.has(Math.round(y))) y += SIBLING_HEIGHT
      positions.set(node.id, { x: gen * GEN_WIDTH, y })
    }
  }

  return positions
}

/** Reset a project's cached layout (e.g. project closed). */
export function resetLayout(projectId: string): void {
  cache.delete(projectId)
}
