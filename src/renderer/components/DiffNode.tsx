import { useCallback, useEffect, useState } from 'react'
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import clsx from 'clsx'
import { useCanvasStore } from '../store/canvasStore'
import { EditableTitle } from './EditableTitle'
import type { DiffNodeData, ForkWorkspace, TerminalNodeData } from '../../shared/types'

type DiffNode = Node<DiffNodeData, 'diff'>

function findSourceData(sourceNodeId: string): TerminalNodeData | null {
  const { canvases } = useCanvasStore.getState()
  for (const c of canvases) {
    const n = c.nodes.find((x) => x.id === sourceNodeId)
    if (n) return n.data as TerminalNodeData
  }
  return null
}

export function DiffNode({ id, data }: NodeProps<DiffNode>): React.ReactElement {
  const updateNodeData = useCanvasStore((s) => s.updateNodeData)
  const removeNode = useCanvasStore((s) => s.removeNode)
  const [loading, setLoading] = useState(false)
  const [renaming, setRenaming] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const d = findSourceData(data.sourceNodeId)
    if (!d) {
      updateNodeData(id, { error: 'source node removed', diff: '', loading: false })
      return
    }
    if (!d.workspaceType || !d.cwd) {
      updateNodeData(id, {
        error: 'source branch has no isolated workspace',
        diff: '',
        loading: false
      })
      return
    }
    const ws: ForkWorkspace = {
      path: d.cwd,
      type: d.workspaceType,
      branchName: d.branchName,
      mainRepoPath: d.mainRepoPath ?? d.cwd,
      baseRef: d.baseSnapshotPath
    }
    setLoading(true)
    updateNodeData(id, { loading: true })
    try {
      const diff = await window.electronAPI.workspace.diff(ws)
      updateNodeData(id, {
        diff,
        error: diff.trim() ? '' : 'no changes since fork',
        loading: false
      })
    } catch (e) {
      updateNodeData(id, { error: String(e), diff: '', loading: false })
    } finally {
      setLoading(false)
    }
  }, [data.sourceNodeId, id, updateNodeData])

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const lines = (data.diff ?? '').split('\n').filter((l) => l.length > 0)

  return (
    <div
      className="terminal-node flex flex-col"
      style={{ width: '100%', height: '100%' }}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-canvas-accent/70" />

      <div className="terminal-node__header flex select-none items-center gap-2 border-b border-canvas-border bg-canvas-node px-2.5 py-1.5">
        <EditableTitle
          value={data.title}
          editing={renaming}
          onEditingChange={setRenaming}
          onCommit={(t) => updateNodeData(id, { title: t })}
          prefix="⌗"
          className="text-sm font-medium text-gray-100"
        />
        <div className="flex-1" />
        <button
          onClick={() => void load()}
          disabled={loading}
          title="Refresh diff"
          className="rounded px-1.5 text-xs text-gray-400 hover:bg-canvas-border hover:text-white"
        >
          {loading ? '…' : '↻'}
        </button>
        <button
          onClick={() => removeNode(id)}
          title="Close"
          className="rounded px-1.5 text-xs text-gray-400 hover:bg-red-500/20 hover:text-red-400"
        >
          ✕
        </button>
      </div>

      <div className="terminal-node__body overflow-auto bg-[#010409] p-2 font-mono text-xs leading-relaxed">
        {data.error ? (
          <div className="text-gray-500">{data.error}</div>
        ) : lines.length === 0 ? (
          <div className="text-gray-600">loading…</div>
        ) : (
          lines.map((line, i) => (
            <div
              key={i}
              className={clsx(
                'whitespace-pre-wrap break-all',
                line.startsWith('+++') || line.startsWith('---')
                  ? 'text-canvas-accent font-semibold'
                  : line.startsWith('+')
                  ? 'text-green-400'
                  : line.startsWith('-')
                  ? 'text-red-400'
                  : line.startsWith('@@')
                  ? 'text-cyan-400'
                  : 'text-gray-500'
              )}
            >
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
