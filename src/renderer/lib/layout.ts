// §9.2 spatial semantics: X = generation (topological depth, growth axis),
// Y = sibling order within a generation. Existing node positions are FROZEN
// during incremental layout — only unseen nodes get computed coordinates
// (§9.2: never re-layout the whole canvas, the eye must not lose its target).
// Positions persist per project (localStorage) so manual arrangement — drags
// and the explicit tidy — survives restarts; layout only fills what's missing.
import type { GraphDoc, NodeID } from '../../shared/types'

export interface XY {
  x: number
  y: number
}

export const GEN_WIDTH = 340
export const SIBLING_HEIGHT = 150

// chat cards are 380px wide; a grid slot leaves room for a child generation
// (resolve worker) before the next chat column
const CHAT_SLOT_W = 420
const CHAT_SLOT_H = 340
const CHAT_COLS = 5

const LS_PREFIX = 'occ-pins:'
const MAX_PINS = 4000

// per-project position cache, hydrated from localStorage on first use
const cache = new Map<string, Map<NodeID, XY>>()
let saveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSave(): void {
  if (saveTimer !== null) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    for (const [pid, m] of cache) {
      try {
        if (m.size === 0) {
          localStorage.removeItem(LS_PREFIX + pid)
          continue
        }
        const obj: Record<string, XY> = {}
        let i = 0
        for (const [id, xy] of m) {
          obj[id] = { x: Math.round(xy.x), y: Math.round(xy.y) }
          if (++i >= MAX_PINS) break
        }
        localStorage.setItem(LS_PREFIX + pid, JSON.stringify(obj))
      } catch {
        /* quota exceeded — positions stay in memory only */
      }
    }
  }, 500)
}

function cacheFor(projectId: string): Map<NodeID, XY> {
  let m = cache.get(projectId)
  if (!m) {
    m = new Map()
    try {
      const raw = localStorage.getItem(LS_PREFIX + projectId)
      if (raw) {
        const obj = JSON.parse(raw) as Record<string, XY>
        for (const [id, xy] of Object.entries(obj)) {
          if (xy && Number.isFinite(xy.x) && Number.isFinite(xy.y)) m.set(id, { x: xy.x, y: xy.y })
        }
      }
    } catch {
      /* corrupted store — start fresh */
    }
    cache.set(projectId, m)
  }
  return m
}

export function pinnedPosition(projectId: string, nodeId: NodeID): XY | undefined {
  return cacheFor(projectId).get(nodeId)
}

export function pinPosition(projectId: string, nodeId: NodeID, pos: XY): void {
  cacheFor(projectId).set(nodeId, pos)
  scheduleSave()
}

/** card-level overlap test against every known position */
function clash(all: XY[], x: number, y: number, dx: number, dy: number): boolean {
  for (const p of all) {
    if (Math.abs(p.x - x) < dx && Math.abs(p.y - y) < dy) return true
  }
  return false
}

function findSlotIn(positions: Map<NodeID, XY>, startIndex = 0): XY {
  const occupied = [...positions.values()]
  let i = Math.max(0, Math.floor(startIndex))
  for (let step = 0; step < 800; step++, i++) {
    const x = 40 + (i % CHAT_COLS) * CHAT_SLOT_W
    const y = 40 + Math.floor(i / CHAT_COLS) * CHAT_SLOT_H
    if (!clash(occupied, x, y, 380, 260)) return { x, y }
  }
  return { x: 40, y: 40 + Math.ceil((i + 1) / CHAT_COLS) * CHAT_SLOT_H }
}

/**
 * First free slot for a new top-level chat. Scans a row-major grid from
 * `startIndex`, checking every candidate against ALL existing positions, so
 * chats and the workers hanging off them can never pile up (the old
 * modulo-6 cascade stacked every 7th chat exactly on top of the first).
 */
export function findFreeSlot(projectId: string, startIndex = 0): XY {
  return findSlotIn(cacheFor(projectId), startIndex)
}

/**
 * Compute positions for every node in the graph. Nodes already in the cache
 * keep their exact coordinates; new nodes are placed relative to their
 * parents — one generation to the right, stacked down until they clear every
 * existing card. Chats (parentless roots) go into the first free grid slot,
 * so a fresh project spreads out instead of collapsing into one column.
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
      const parentX = n.parents.map((p) => positions.get(p)?.x).find((x): x is number => x !== undefined)
      const anchor = parentYs.length
        ? parentYs.reduce((a, b) => a + b, 0) / parentYs.length
        : 40
      return { node: n, anchor, parentX, createdAt: n.createdAt }
    })
    anchored.sort((a, b) => a.anchor - b.anchor || a.createdAt.localeCompare(b.createdAt))

    for (const { node, anchor, parentX } of anchored) {
      if (parentX === undefined) {
        // top-level chat: first free grid slot
        positions.set(node.id, findSlotIn(positions))
        continue
      }
      // child: one generation to the right, stacked down until it clears
      // every existing card (dx 320 < GEN_WIDTH so the parent never blocks
      // its own child, but other chats' cards do)
      const x = parentX + GEN_WIDTH
      let y = anchor
      let tries = 0
      while (tries < 12 && clash([...positions.values()], x, y, 320, 150)) {
        y += SIBLING_HEIGHT
        tries++
      }
      if (clash([...positions.values()], x, y, 320, 150)) {
        // right side too crowded — hang below the parent instead
        const bx = parentX + 60
        let by = anchor + 260
        for (let step = 0; step < 30 && clash([...positions.values()], bx, by, 320, 150); step++) by += SIBLING_HEIGHT
        positions.set(node.id, { x: bx, y: by })
        continue
      }
      positions.set(node.id, { x, y })
    }
  }

  scheduleSave()
  return positions
}

/**
 * Full re-arrange, user-invoked from the canvas toolbar ("整理"). Each chat
 * and its whole subtree becomes one block: generations stack rightward,
 * nodes within a generation stack down; blocks flow left-to-right and wrap
 * into rows. Manual drags are respected until the next tidy. Positions are
 * written to the pin cache (and persisted).
 */
export function tidyLayout(graph: GraphDoc): Map<NodeID, XY> {
  const positions = cacheFor(graph.projectId || 'default')
  const nodes = Object.values(graph.nodes)
  if (nodes.length === 0) return positions

  const byId = new Map<NodeID, (typeof nodes)[number]>()
  const children = new Map<NodeID, NodeID[]>()
  for (const n of nodes) {
    byId.set(n.id, n)
    for (const p of n.parents) {
      const arr = children.get(p) ?? []
      arr.push(n.id)
      children.set(p, arr)
    }
  }

  // clusters: BFS from each root (creation order); multi-parent nodes join
  // the first cluster that reaches them
  const roots = nodes
    .filter((n) => n.parents.length === 0 || n.parents.every((p) => !byId.has(p)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const clusterOf = new Set<NodeID>()
  const clusters: NodeID[][] = []
  const depths: Array<Map<NodeID, number>> = []
  for (const r of roots) {
    if (clusterOf.has(r.id)) continue
    const list: NodeID[] = []
    const depth = new Map<NodeID, number>([[r.id, 0]])
    const q = [r.id]
    while (q.length) {
      const id = q.shift()!
      if (clusterOf.has(id)) continue
      clusterOf.add(id)
      list.push(id)
      for (const c of children.get(id) ?? []) {
        if (!depth.has(c)) depth.set(c, (depth.get(id) ?? 0) + 1)
        q.push(c)
      }
    }
    clusters.push(list)
    depths.push(depth)
  }
  // orphans (broken parent chains) — each becomes its own cluster
  for (const n of nodes) {
    if (clusterOf.has(n.id)) continue
    clusterOf.add(n.id)
    clusters.push([n.id])
    depths.push(new Map([[n.id, 0]]))
  }

  // prune pins of nodes that no longer exist
  for (const id of [...positions.keys()]) if (!byId.has(id)) positions.delete(id)

  // pack blocks into wrapping rows
  const T_X0 = 40
  const T_Y0 = 40
  const TCOL_W = 400
  const TROW_H = 260
  const TBAND_W = 2600
  const TGAP_Y = 80

  let cursorX = T_X0
  let bandY = T_Y0
  let bandH = 0
  for (let ci = 0; ci < clusters.length; ci++) {
    const list = clusters[ci]
    const depth = depths[ci]
    const maxD = Math.max(0, ...[...depth.values()])
    const width = 420 + maxD * TCOL_W
    if (cursorX > T_X0 && cursorX - T_X0 + width > TBAND_W) {
      cursorX = T_X0
      bandY += bandH + TGAP_Y
      bandH = 0
    }
    // column stacks, ordered by creation time
    const cols = new Map<number, NodeID[]>()
    for (const id of [...list].sort((a, b) => byId.get(a)!.createdAt.localeCompare(byId.get(b)!.createdAt))) {
      const d = depth.get(id) ?? 0
      const arr = cols.get(d) ?? []
      arr.push(id)
      cols.set(d, arr)
    }
    let colMax = 1
    for (const [d, ids] of cols) {
      colMax = Math.max(colMax, ids.length)
      ids.forEach((id, i) => {
        positions.set(id, { x: cursorX + d * TCOL_W, y: bandY + i * TROW_H })
      })
    }
    cursorX += width
    bandH = Math.max(bandH, colMax * TROW_H)
  }

  scheduleSave()
  return positions
}

/** Reset a project's cached layout (e.g. project closed). Persisted pins
 *  survive in localStorage and re-hydrate on the next open. */
export function resetLayout(projectId: string): void {
  cache.delete(projectId)
}
