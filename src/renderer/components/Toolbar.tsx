import { useCanvasStore } from '../store/canvasStore'

export type AddMode = 'shell' | 'opencode'

interface ToolbarProps {
  onAdd: (mode: AddMode) => void
}

export function Toolbar({ onAdd }: ToolbarProps): React.ReactElement {
  const defaultCwd = useCanvasStore((s) => s.defaultCwd)
  const ready = defaultCwd.length > 0

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-canvas-border bg-canvas-node/60 px-4">
      <div className="flex items-center gap-2">
        <span className="inline-block h-3 w-3 rounded-full bg-gradient-to-br from-canvas-accent to-canvas-fork" />
        <span className="text-sm font-semibold text-white">OpenCode Canvas</span>
      </div>

      <div className="mx-2 h-5 w-px bg-canvas-border" />

      <button
        onClick={() => onAdd('opencode')}
        disabled={!ready}
        className="rounded-md bg-canvas-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        title={ready ? 'New OpenCode session' : 'Pick a project directory first'}
      >
        + OpenCode
      </button>
      <button
        onClick={() => onAdd('shell')}
        disabled={!ready}
        className="rounded-md border border-canvas-border px-3 py-1.5 text-sm text-gray-200 hover:bg-canvas-border disabled:cursor-not-allowed disabled:opacity-40"
      >
        + Terminal
      </button>

      {!ready && (
        <span className="text-xs text-amber-400/80">Pick a project directory to start →</span>
      )}

      <div className="flex-1" />

      <span className="text-xs text-gray-500">scroll = zoom · drag pane = pan · right-click = menu</span>
    </header>
  )
}
