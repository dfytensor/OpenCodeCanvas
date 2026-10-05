import { useEffect, useState } from 'react'
import { useOccStore } from '../store/occStore'

export default function TopBar(): React.ReactElement {
  const serverReady = useOccStore((s) => s.serverReady)
  const project = useOccStore((s) => s.project)
  const models = useOccStore((s) => s.models)
  const busy = useOccStore((s) => s.busy)
  const error = useOccStore((s) => s.error)
  const init = useOccStore((s) => s.init)
  const loadModels = useOccStore((s) => s.loadModels)
  const setDefaultModel = useOccStore((s) => s.setDefaultModel)
  const setEngine = useOccStore((s) => s.setEngine)
  const openProject = useOccStore((s) => s.openProject)
  const closeProject = useOccStore((s) => s.closeProject)
  const createChat = useOccStore((s) => s.createChat)
  const [showSettings, setShowSettings] = useState(false)
  const [jevKey, setJevKeyInput] = useState(() => window.localStorage.getItem('occ-jev-key') ?? '')
  const [budgetK, setBudgetK] = useState(() => String(Math.round((project?.policy.budgetTokensPerChat ?? 0) / 1000)))
  const [permMode, setPermMode] = useState<'ask' | 'auto'>(project?.policy.toolPermission ?? 'ask')

  useEffect(() => { void init() }, [init])
  useEffect(() => { if (project && !models) void loadModels() }, [project, models, loadModels])
  useEffect(() => {
    const saved = window.localStorage.getItem('occ-jev-key')
    if (saved) void window.electronAPI.occ.setJevKey(saved)
  }, [])

  const modelValue = project?.policy.defaultModel ?? ''
  const sel = 'rounded-md border border-canvas-border bg-canvas-node px-2 py-1 text-[11px] text-gray-300 outline-none transition-colors focus:border-canvas-accent'

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-canvas-border bg-canvas-node/60 px-4">
      {/* logo */}
      <div className="flex items-center gap-2">
        <span className="inline-block h-3 w-3 rounded-full bg-gradient-to-br from-canvas-accent to-canvas-fork" />
        <span className="text-sm font-semibold text-white">OpenCode Canvas</span>
      </div>

      <div className="mx-1 h-5 w-px bg-canvas-border" />

      {project ? (
        <>
          <span className="max-w-[200px] truncate text-xs text-gray-300" title={project.rootDir}>{project.name}</span>

          <div className="mx-1 h-5 w-px bg-canvas-border" />

          <select className={sel} value={project.policy.engine} onChange={(e) => void setEngine(e.target.value as 'opencode' | 'native')} title="execution engine">
            <option value="native">⚡ native</option>
            <option value="opencode">opencode</option>
          </select>

          <select className={`${sel} max-w-[200px]`} value={modelValue} onChange={(e) => void setDefaultModel(e.target.value)} title="default model">
            <option value="">🤖 default model</option>
            {(models?.providers ?? []).flatMap((p) =>
              p.models.map((m) => (
                <option key={`${p.id}/${m.id}`} value={`${p.id}/${m.id}`}>{p.name} · {m.name}</option>
              ))
            )}
          </select>

          <div className="flex-1" />

          {/* running indicator */}
          <RunningBadge />
          <AwaitingBadge />

          <button
            className="rounded-md border border-canvas-border px-2.5 py-1 text-[11px] text-gray-400 transition-colors hover:border-canvas-accent hover:text-canvas-accent"
            onClick={() => void createChat()}
            title="新建聊天"
          >
            ＋ 聊天
          </button>

          <span className={`inline-block h-2 w-2 rounded-full ${serverReady ? 'bg-emerald-500' : 'bg-red-500 animate-pulse'}`} title={serverReady ? 'engine ready' : 'engine starting…'} />

          <button className="rounded-md border border-canvas-border px-2.5 py-1 text-[11px] text-gray-400 transition-colors hover:border-canvas-border hover:text-gray-300" onClick={() => void closeProject()}>
            close
          </button>
        </>
      ) : (
        <>
          <span className="text-xs text-gray-500">打开一个项目目录开始</span>
          <div className="flex-1" />
          <button
            className="rounded-lg bg-canvas-accent px-4 py-1.5 text-xs font-medium text-white shadow-sm transition-all hover:brightness-110 hover:shadow-md active:scale-95 disabled:opacity-40"
            disabled={busy}
            onClick={async () => {
              const dir = await window.electronAPI.dialog.pickDirectory()
              if (dir) await openProject(dir)
            }}
          >
            {busy ? 'opening…' : '📂 打开项目'}
          </button>
        </>
      )}

      {error && (
        <button
          className="max-w-[240px] truncate rounded-md border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] text-red-300"
          title={`${error}（点击关闭）`}
          onClick={() => useOccStore.setState({ error: null })}
        >
          {error} ✕
        </button>
      )}

      {/* settings gear */}
      <button
        className="ml-1 rounded-md p-1 text-gray-500 transition-colors hover:text-gray-300"
        onClick={() => setShowSettings((v) => !v)}
        title="settings"
      >
        ⚙
      </button>

      {showSettings && (
        <div className="absolute right-3 top-12 z-50 w-72 rounded-lg border border-canvas-border bg-canvas-node p-3 shadow-xl">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Settings</p>
          <label className="mb-2 block text-[10px] text-gray-400">
            OpenRouter API Key
            <input
              type="password"
              className="mt-1 w-full rounded-md border border-canvas-border bg-canvas-bg px-2 py-1 text-[11px] text-gray-300 outline-none focus:border-canvas-accent"
              placeholder="sk-or-... (for Jev cascade)"
              value={jevKey}
              onChange={(e) => setJevKeyInput(e.target.value)}
            />
          </label>
          {project && (
            <>
              <label className="mb-2 block text-[10px] text-gray-400">
                聊天预算（k tokens，0 = 不限，超支时询问）
                <input
                  type="number"
                  min={0}
                  className="mt-1 w-full rounded-md border border-canvas-border bg-canvas-bg px-2 py-1 text-[11px] text-gray-300 outline-none focus:border-canvas-accent"
                  value={budgetK}
                  onChange={(e) => setBudgetK(e.target.value)}
                />
              </label>
              <label className="mb-3 block text-[10px] text-gray-400">
                敏感工具（写文件 / 命令）
                <select
                  className="mt-1 w-full rounded-md border border-canvas-border bg-canvas-bg px-2 py-1 text-[11px] text-gray-300 outline-none focus:border-canvas-accent"
                  value={permMode}
                  onChange={(e) => setPermMode(e.target.value as 'ask' | 'auto')}
                >
                  <option value="ask">每次询问（默认）</option>
                  <option value="auto">自动放行（信任本机环境）</option>
                </select>
              </label>
            </>
          )}
          <button
            className="w-full rounded-md bg-canvas-accent py-1 text-[10px] font-medium text-white hover:brightness-110"
            onClick={() => {
              window.localStorage.setItem('occ-jev-key', jevKey)
              void window.electronAPI.occ.setJevKey(jevKey)
              if (project) {
                void window.electronAPI.occ
                  .updatePolicy({ budgetTokensPerChat: Math.max(0, Number(budgetK) || 0) * 1000, toolPermission: permMode })
                  .then((p) => useOccStore.setState({ project: p }))
                  .catch(() => undefined)
              }
              setShowSettings(false)
            }}
          >
            Save
          </button>
        </div>
      )}
    </header>
  )
}

function RunningBadge(): React.ReactElement | null {
  const graph = useOccStore((s) => s.graph)
  const running = graph ? Object.values(graph.nodes).filter((n) => n.status === 'running').length : 0
  if (running === 0) return null
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-canvas-accent/30 bg-canvas-accent/10 px-2.5 py-0.5 text-[10px] text-canvas-accent">
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-canvas-accent" />
      {running} running
    </span>
  )
}

function AwaitingBadge(): React.ReactElement | null {
  const graph = useOccStore((s) => s.graph)
  const requestFocus = useOccStore((s) => s.requestFocus)
  const waiting = graph ? Object.values(graph.nodes).filter((n) => n.status === 'awaiting_input') : []
  if (waiting.length === 0) return null
  return (
    <button
      className="flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-400/10 px-2.5 py-0.5 text-[10px] text-amber-300 transition-colors hover:bg-amber-400/20"
      onClick={() => requestFocus(waiting[0].id)}
      title="点击定位到等待你回复的聊天"
    >
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
      {waiting.length} 等待回复
    </button>
  )
}
