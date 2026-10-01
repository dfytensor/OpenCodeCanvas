import { useEffect } from 'react'
import { useOccStore } from '../store/occStore'

// Minimal top bar: open project, engine/model selection, server status.
// Nothing else — the canvas and its chat nodes are the app.
export function TopBar(): React.ReactElement {
  const {
    serverReady,
    project,
    models,
    busy,
    error,
    init,
    loadModels,
    setDefaultModel,
    setDefaultAgent,
    setEngine,
    openProject,
    closeProject
  } = useOccStore()

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (project && !models) void loadModels()
  }, [project, models, loadModels])

  const modelValue = project?.policy.defaultModel ?? ''
  const agentValue = project?.policy.defaultAgent ?? ''
  const sel =
    'rounded-md border border-canvas-border bg-canvas-node px-2 py-1 text-[11px] text-gray-300 outline-none focus:border-canvas-accent'

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-canvas-border bg-canvas-node/60 px-4">
      <div className="flex items-center gap-2">
        <span className="inline-block h-3 w-3 rounded-full bg-gradient-to-br from-canvas-accent to-canvas-fork" />
        <span className="text-sm font-semibold text-white">OpenCode Canvas</span>
      </div>

      <div className="mx-1 h-5 w-px bg-canvas-border" />

      {project ? (
        <>
          <span className="max-w-[220px] truncate text-xs text-gray-300" title={project.rootDir}>
            {project.name}
          </span>
          <select
            className={sel}
            value={project.policy.engine}
            onChange={(e) => void setEngine(e.target.value as 'opencode' | 'native')}
            title="execution engine"
          >
            <option value="opencode">engine: opencode</option>
            <option value="native">engine: native</option>
          </select>
          <select className={`${sel} max-w-[210px]`} value={modelValue} onChange={(e) => void setDefaultModel(e.target.value)} title="default model">
            <option value="">model: default</option>
            {(models?.providers ?? []).flatMap((p) =>
              p.models.map((m) => (
                <option key={`${p.id}/${m.id}`} value={`${p.id}/${m.id}`}>
                  {p.name} · {m.name}
                </option>
              ))
            )}
          </select>
          {project.policy.engine === 'opencode' && (
            <select className={sel} value={agentValue} onChange={(e) => void setDefaultAgent(e.target.value)} title="default agent">
              <option value="">agent: default</option>
              {(models?.agents ?? []).map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          <div className="flex-1" />
          <span className={`inline-block h-2 w-2 rounded-full ${serverReady ? 'bg-emerald-500' : 'bg-red-500'}`} title={serverReady ? 'engine ready' : 'engine down'} />
          <button
            className="rounded-md border border-canvas-border px-2.5 py-1 text-[11px] text-gray-300 hover:bg-canvas-border"
            onClick={() => void closeProject()}
          >
            close project
          </button>
        </>
      ) : (
        <>
          <span className="text-xs text-gray-500">open a project directory to begin</span>
          <div className="flex-1" />
          <button
            className="rounded-md bg-canvas-accent px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={busy}
            onClick={async () => {
              const dir = await window.electronAPI.dialog.pickDirectory()
              if (dir) await openProject(dir)
            }}
          >
            {busy ? 'opening…' : '打开项目'}
          </button>
        </>
      )}
      {error && <span className="max-w-[280px] truncate text-[10px] text-red-400" title={error}>{error}</span>}
    </header>
  )
}
