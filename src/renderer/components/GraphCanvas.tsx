import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useReactFlow,
  type Edge,
  type Node
} from '@xyflow/react'
import { OccNode } from './OccNode'
import { ChatNode } from './ChatNode'
import { EventStream } from './EventStream'
import { ContextMenu, type MenuEntry } from './ContextMenu'
import { useOccStore } from '../store/occStore'
import { layoutGraph, pinnedPosition, pinPosition } from '../lib/layout'
import type { GraphEdge, SessionNode } from '../../shared/types'

const nodeTypes = { occ: OccNode, chat: ChatNode }

// §9.6 edge semantics: fork = violet dashed lineage, inherit = blue flowing,
// merge = green convergence
function edgeStyle(e: GraphEdge): Edge {
  const base: Edge = { id: e.id, source: e.source, target: e.target, label: e.label }
  if (e.kind === 'fork') {
    return { ...base, animated: false, style: { stroke: '#a371f7', strokeWidth: 2, strokeDasharray: '6 4' } }
  }
  if (e.kind === 'inherit') {
    return { ...base, animated: true, style: { stroke: '#2f81f7', strokeWidth: 1.5 } }
  }
  return { ...base, animated: true, style: { stroke: '#22c55e', strokeWidth: 2.5 } }
}

export function GraphCanvas(): React.ReactElement {
  const graph = useOccStore((s) => s.graph)
  const project = useOccStore((s) => s.project)
  const createChat = useOccStore((s) => s.createChat)
  const rf = useReactFlow()
  const prevCount = useRef(0)
  const menuPos = useRef({ x: 400, y: 300 })
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const { flowNodes, flowEdges } = useMemo(() => {
    if (!graph) return { flowNodes: [] as Node[], flowEdges: [] as Edge[] }
    const positions = layoutGraph(graph)
    const flowNodes: Node[] = Object.values(graph.nodes).map((n: SessionNode) => {
      const pinned = pinnedPosition(graph.projectId, n.id) ?? positions.get(n.id)!
      pinPosition(graph.projectId, n.id, pinned)
      return {
        id: n.id,
        type: n.parents.length === 0 && n.kind === 'root' ? 'chat' : 'occ',
        position: pinned,
        data: { node: n }
      }
    })
    const flowEdges: Edge[] = graph.edges.map(edgeStyle)
    return { flowNodes, flowEdges }
  }, [graph])

  useEffect(() => {
    if (!graph) return
    const count = Object.keys(graph.nodes).length
    if (count > prevCount.current) {
      const t = setTimeout(() => rf.fitView({ padding: 0.3, duration: 400, maxZoom: 1 }), 60)
      prevCount.current = count
      return () => clearTimeout(t)
    }
    prevCount.current = count
  }, [graph, rf])

  if (!graph || !project) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="text-lg font-medium text-gray-500">No project open</div>
          <div className="mt-1 text-sm text-gray-600">点击顶部「打开项目」选择工作目录</div>
        </div>
      </div>
    )
  }

  const running = Object.values(graph.nodes).filter(
    (n) => n.status === 'running' || n.status === 'awaiting_input'
  ).length

  const paneMenuItems = (): MenuEntry[] => [
    {
      id: 'new-chat',
      label: 'New chat window',
      icon: '💬',
      onSelect: () => {
        const screen = menuPos.current
        const pos = rf.screenToFlowPosition({ x: screen.x, y: screen.y })
        void createChat().then((id) => {
          if (!id) return
          pinPosition(graph.projectId, id, { x: pos.x - 180, y: pos.y - 160 })
          void useOccStore.getState().refresh()
        })
      }
    }
  ]

  return (
    <div
      className="relative h-full w-full"
      onContextMenu={(e) => {
        e.preventDefault()
        menuPos.current = { x: e.clientX, y: e.clientY }
        setMenu({ x: e.clientX, y: e.clientY })
      }}
      onClick={() => setMenu(null)}
    >
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodeDragStop={(_e, node) => pinPosition(graph.projectId, node.id, node.position)}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.08}
        maxZoom={2.5}
        nodesConnectable={false}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={26} size={1.2} color="#1b2230" />
        <Controls className="!border !border-canvas-border !rounded-lg" showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => {
            const node = (n.data as { node?: SessionNode })?.node
            if (!node) return '#2f81f7'
            if (node.kind === 'root') return '#a371f7'
            if (node.status === 'running') return '#2f81f7'
            if (node.status === 'awaiting_input') return '#fbbf24'
            if (node.status === 'completed') return '#10b981'
            if (node.status === 'failed') return '#ef4444'
            if (node.status === 'frozen') return '#94a3b8'
            if (node.status === 'archived') return '#475569'
            return '#6b7280'
          }}
          maskColor="rgba(13,17,23,0.7)"
        />
      </ReactFlow>

      <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-2 rounded-md border border-canvas-border bg-canvas-node/80 px-3 py-1.5 backdrop-blur">
        <span className="text-xs font-semibold text-gray-200">{project.name}</span>
        {running > 0 ? (
          <span className="flex items-center gap-1 text-[10px] text-canvas-accent">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-canvas-accent occ-breathe" />
            frontier · {running} running
          </span>
        ) : (
          <span className="text-[10px] text-gray-500">idle · {Object.keys(graph.nodes).length} nodes · right-click to add a chat</span>
        )}
      </div>

      <EventStream />

      {menu !== null && (
        <ContextMenu x={menu.x} y={menu.y} items={paneMenuItems()} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
