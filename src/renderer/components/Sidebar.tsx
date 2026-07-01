import { useState } from 'react'
import clsx from 'clsx'
import { useCanvasStore } from '../store/canvasStore'

export function Sidebar(): React.ReactElement {
  const canvases = useCanvasStore((s) => s.canvases)
  const activeId = useCanvasStore((s) => s.activeCanvasId)
  const setActive = useCanvasStore((s) => s.setActiveCanvas)
  const addCanvas = useCanvasStore((s) => s.addCanvas)
  const deleteCanvas = useCanvasStore((s) => s.deleteCanvas)
  const renameCanvas = useCanvasStore((s) => s.renameCanvas)
  const duplicateCanvas = useCanvasStore((s) => s.duplicateCanvas)
  const defaultCwd = useCanvasStore((s) => s.defaultCwd)
  const setDefaultCwd = useCanvasStore((s) => s.setDefaultCwd)

  const pickDir = async (): Promise<void> => {
    const d = await window.electronAPI.dialog.pickDirectory()
    if (d) setDefaultCwd(d)
  }

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-canvas-border bg-canvas-node/60">
      <div className="px-4 pb-3 pt-4">
        <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">Project</div>
        <button
          onClick={pickDir}
          className="mt-2 w-full truncate rounded-md border border-canvas-border bg-canvas-bg px-3 py-2 text-left text-sm text-gray-200 hover:border-canvas-accent"
          title={defaultCwd || 'Choose a working directory'}
        >
          {defaultCwd ? defaultCwd : 'Pick directory…'}
        </button>
      </div>

      <div className="flex items-center justify-between px-4 pb-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">Canvases</span>
        <button
          onClick={() => addCanvas()}
          className="rounded px-1.5 text-gray-400 hover:bg-canvas-border hover:text-white"
          title="New canvas"
        >
          +
        </button>
      </div>

      <div className="flex-1 space-y-1 overflow-y-auto px-2">
        {canvases.map((c) => (
          <CanvasRow
            key={c.id}
            name={c.name}
            nodeCount={c.nodes.length}
            active={c.id === activeId}
            canDelete={canvases.length > 1}
            onActivate={() => setActive(c.id)}
            onRename={(n) => renameCanvas(c.id, n)}
            onDuplicate={() => duplicateCanvas(c.id)}
            onDelete={() => deleteCanvas(c.id)}
          />
        ))}
      </div>

      <div className="border-t border-canvas-border px-4 py-3 text-[11px] text-gray-600">
        Right-click canvas to add terminals · drag to pan · scroll to zoom
      </div>
    </aside>
  )
}

interface CanvasRowProps {
  name: string
  nodeCount: number
  active: boolean
  canDelete: boolean
  onActivate: () => void
  onRename: (name: string) => void
  onDuplicate: () => void
  onDelete: () => void
}

function CanvasRow({
  name,
  nodeCount,
  active,
  canDelete,
  onActivate,
  onRename,
  onDuplicate,
  onDelete
}: CanvasRowProps): React.ReactElement {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)

  const commit = (): void => {
    const v = value.trim()
    if (v) onRename(v)
    setEditing(false)
  }

  return (
    <div
      className={clsx(
        'group flex items-center gap-1 rounded-md px-2 py-2 text-sm transition-colors',
        active ? 'bg-canvas-accent/20 text-white' : 'text-gray-300 hover:bg-canvas-border/40'
      )}
    >
      {editing ? (
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setEditing(false)
          }}
          className="w-full rounded bg-canvas-bg px-1 py-0.5 text-sm outline-none ring-1 ring-canvas-accent"
        />
      ) : (
        <button onClick={onActivate} onDoubleClick={() => setEditing(true)} className="flex-1 truncate text-left">
          {name}
          <span className="ml-2 text-[11px] text-gray-500">{nodeCount}</span>
        </button>
      )}

      <button
        onClick={onDuplicate}
        className="hidden rounded px-1 text-gray-500 hover:text-white group-hover:block"
        title="Duplicate"
      >
        ⧉
      </button>
      {canDelete && (
        <button
          onClick={onDelete}
          className="hidden rounded px-1 text-gray-500 hover:text-red-400 group-hover:block"
          title="Delete"
        >
          ✕
        </button>
      )}
    </div>
  )
}
