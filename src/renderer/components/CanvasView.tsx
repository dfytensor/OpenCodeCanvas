import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useReactFlow,
  BezierEdge,
  type Node,
  type Edge
} from '@xyflow/react'
import { TerminalNode } from './TerminalNode'
import { DiffNode } from './DiffNode'
import { ContextMenu, type MenuEntry } from './ContextMenu'
import { useCanvasStore } from '../store/canvasStore'
import type { AddMode } from './Toolbar'
import type { TerminalNodeData } from '../../shared/types'

const nodeTypes = { terminal: TerminalNode, diff: DiffNode }
const edgeTypes = { 'fork-edge': BezierEdge }

interface PaneMenuState {
  x: number
  y: number
  flow: { x: number; y: number }
}

export function CanvasView(): React.ReactElement {
  const activeCanvasId = useCanvasStore((s) => s.activeCanvasId)
  const active = useCanvasStore(
    (s) => s.canvases.find((c) => c.id === s.activeCanvasId) ?? s.canvases[0]
  )
  const onNodesChange = useCanvasStore((s) => s.onNodesChange)
  const onEdgesChange = useCanvasStore((s) => s.onEdgesChange)
  const setActiveCanvas = useCanvasStore((s) => s.setActiveCanvas)
  const addTerminalNode = useCanvasStore((s) => s.addTerminalNode)
  const mergeNodes = useCanvasStore((s) => s.mergeNodes)
  const defaultCwd = useCanvasStore(
    (s) => (s.canvases.find((c) => c.id === s.activeCanvasId) ?? s.canvases[0])?.cwd ?? ''
  )

  const [menu, setMenu] = useState<PaneMenuState | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const rf = useReactFlow()

  // ensure an active canvas is always set
  useEffect(() => {
    const s = useCanvasStore.getState()
    if (!s.activeCanvasId && s.canvases.length > 0) {
      setActiveCanvas(s.canvases[0].id)
    }
  }, [setActiveCanvas])

  // fit view when switching canvas
  useEffect(() => {
    if (active.nodes.length > 0) {
      const t = setTimeout(() => rf.fitView({ padding: 0.25, duration: 300 }), 50)
      return () => clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCanvasId])

  const addAtCenter = useCallback(
    (mode: AddMode): void => {
      const wrap = wrapperRef.current
      const center = wrap
        ? { x: wrap.clientWidth / 2, y: wrap.clientHeight / 2 }
        : { x: 400, y: 300 }
      const flow = rf.screenToFlowPosition(center)
      addTerminalNode({
        position: { x: flow.x - 310, y: flow.y - 170 },
        mode,
        cwd: defaultCwd
      })
    },
    [addTerminalNode, defaultCwd, rf]
  )

  // toolbar "add" events
  useEffect(() => {
    const handler = (e: Event): void => {
      const mode = (e as CustomEvent<AddMode>).detail
      if (mode) addAtCenter(mode)
    }
    window.addEventListener('canvas:add', handler)
    return () => window.removeEventListener('canvas:add', handler)
  }, [addAtCenter])

  const onPaneContextMenu = useCallback(
    (e: MouseEvent | React.MouseEvent): void => {
      e.preventDefault()
      setMenu({
        x: e.clientX,
        y: e.clientY,
        flow: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      })
    },
    [rf]
  )

  // branches selected on the canvas that are eligible to be merged together
  const mergeable = active.nodes.filter(
    (n) =>
      n.selected &&
      (n.data as TerminalNodeData).kind !== 'main' &&
      !!(n.data as TerminalNodeData).workspaceType &&
      !!(n.data as TerminalNodeData).cwd
  )

  const paneMenuItems = (): MenuEntry[] => [
    {
      id: 'add-oc',
      label: 'Add OpenCode terminal',
      icon: '◉',
      disabled: defaultCwd.length === 0,
      onSelect: () =>
        addTerminalNode({
          position: { x: menu!.flow.x - 310, y: menu!.flow.y - 170 },
          mode: 'opencode',
          cwd: defaultCwd
        })
    },
    {
      id: 'add-shell',
      label: 'Add shell terminal',
      icon: '▢',
      disabled: defaultCwd.length === 0,
      onSelect: () =>
        addTerminalNode({
          position: { x: menu!.flow.x - 310, y: menu!.flow.y - 170 },
          mode: 'shell',
          cwd: defaultCwd
        })
    },
    ...(mergeable.length >= 2
      ? [
          {
            id: 'merge',
            label: `Merge ${mergeable.length} selected branches`,
            icon: 'Ⓜ',
            onSelect: () => {
              void mergeNodes(mergeable.map((n) => n.id)).catch(() => {
                /* validation errors handled in store */
              })
            }
          } as MenuEntry,
          { id: 'sep-merge', separator: true } as MenuEntry
        ]
      : []),
    { id: 'sep', separator: true },
    {
      id: 'fit',
      label: 'Fit view',
      icon: '⤢',
      onSelect: () => rf.fitView({ padding: 0.25, duration: 300 })
    }
  ]

  return (
    <div ref={wrapperRef} className="relative h-full w-full">
      <ReactFlow
        nodes={active.nodes}
        edges={active.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onPaneContextMenu={onPaneContextMenu}
        onMoveStart={() => setMenu(null)}
        onPaneClick={() => setMenu(null)}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.15}
        maxZoom={3}
        defaultEdgeOptions={{ type: 'default' }}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#1b2230" />
        <Controls className="!border !border-canvas-border !rounded-lg" />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => {
            const kind = (n.data as unknown as TerminalNodeData)?.kind
            if (kind === 'merge') return '#22c55e'
            if (kind === 'fork') return '#a371f7'
            return '#2f81f7'
          }}
          maskColor="rgba(13,17,23,0.7)"
        />
      </ReactFlow>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={paneMenuItems()} onClose={() => setMenu(null)} />
      )}

      {active.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <div className="text-lg font-medium text-gray-500">Empty canvas</div>
            <div className="mt-1 text-sm text-gray-600">
              {defaultCwd
                ? 'Right-click anywhere or use the toolbar to add a terminal'
                : 'Pick a project directory in the sidebar to begin'}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
