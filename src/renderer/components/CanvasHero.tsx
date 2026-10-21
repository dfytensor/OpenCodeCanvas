import { useState } from 'react'
import { useOccStore } from '../store/occStore'

const GOALS = [
  '创建 hello.py：打印当前时间；运行它，并把输出作为验证证据报告',
  '列出这个项目的结构，写一份 README.md 摘要（含文件树）',
  '写一个计算器 calc.py，附 3 个 pytest 测试并全部跑通'
]

/** Persistent empty state over the canvas: no project → pick a workspace;
 *  project with no chats → start the first task. This is what a user sees
 *  whenever the canvas is empty — never a blank grid. */
export default function CanvasHero(): React.ReactElement | null {
  const project = useOccStore((s) => s.project)
  const graph = useOccStore((s) => s.graph)
  const onboardingOpen = useOccStore((s) => s.onboardingOpen)
  const openProject = useOccStore((s) => s.openProject)
  const createChat = useOccStore((s) => s.createChat)
  const sendChat = useOccStore((s) => s.sendChat)
  const info = useOccStore((s) => s.onboardingInfo)
  // unknown (null, pre-probe) must not be treated as "no model"
  const modelReady = !info || !!info.hasProvider

  const [busy, setBusy] = useState(false)
  const [goal, setGoal] = useState(GOALS[0])

  if (onboardingOpen) return null
  if (project) {
    if (!graph) return null
    const hasChats = Object.values(graph.nodes).some((n) => n.kind === 'root' && n.parents.length === 0)
    if (hasChats) return null
  }

  const pickFolder = async (): Promise<void> => {
    const dir = await window.electronAPI.dialog.pickDirectory()
    if (dir) await openProject(dir)
  }

  const createDemo = async (): Promise<void> => {
    setBusy(true)
    try {
      const { dir } = await window.electronAPI.occ.createDemoProject()
      if (dir) await openProject(dir)
    } finally {
      setBusy(false)
    }
  }

  const start = async (): Promise<void> => {
    const id = await createChat()
    if (!id) return
    // bring the camera to the fresh card — on a 100+ chat map a new node
    // created off-screen looks like nothing happened
    useOccStore.getState().requestFocus(id)
    await sendChat(id, goal)
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
      <div
        data-occ="canvas-hero"
        className="pointer-events-auto w-[460px] rounded-2xl border border-canvas-border bg-canvas-node/95 p-6 text-center shadow-2xl backdrop-blur"
      >
        {!project ? (
          <>
            <div className="mb-1 text-2xl">🗂️</div>
            <h2 className="text-sm font-semibold text-white">先选一个工作区</h2>
            <p className="mx-auto mt-1 max-w-[340px] text-[11px] leading-relaxed text-gray-400">
              Agent 的产出都会真实落盘到你选定的项目文件夹里。第一次用，可以创建示例项目直接开跑。
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <button
                data-occ="canvas-hero-open"
                disabled={busy}
                onClick={() => void pickFolder()}
                className="rounded-lg bg-canvas-accent px-4 py-2 text-xs font-medium text-white shadow-sm transition-all hover:brightness-110 active:scale-95 disabled:opacity-40"
              >
                📂 打开文件夹
              </button>
              <button
                data-occ="canvas-hero-demo"
                disabled={busy}
                onClick={() => void createDemo()}
                className="rounded-lg border border-canvas-border px-4 py-2 text-xs text-gray-200 transition-colors hover:border-canvas-accent hover:text-canvas-accent disabled:opacity-40"
              >
                {busy ? '创建中…' : '✨ 创建示例项目'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mb-1 text-2xl">🎯</div>
            <h2 className="text-sm font-semibold text-white">让 Agent 做点什么</h2>
            <p className="mx-auto mt-1 max-w-[360px] text-[11px] leading-relaxed text-gray-400">
              选一个第一个目标——它会规划、执行，并由独立验收员逐条核验后报告证据。
            </p>
            <div className="mt-3 flex flex-col gap-1.5">
              {GOALS.map((g) => (
                <button
                  key={g}
                  data-occ="canvas-hero-chip"
                  onClick={() => setGoal(g)}
                  className={`rounded-lg border px-3 py-2 text-left text-[11px] leading-snug transition-colors ${
                    goal === g ? 'border-canvas-accent/60 bg-canvas-accent/10 text-canvas-accent' : 'border-canvas-border text-gray-300 hover:border-canvas-accent/40'
                  }`}
                >
                  {g}
                </button>
              ))}
            </div>
            {modelReady ? (
              <button
                data-occ="canvas-hero-start"
                onClick={() => void start()}
                className="mt-4 w-full rounded-lg bg-canvas-accent py-2 text-xs font-medium text-white shadow-sm transition-all hover:brightness-110 active:scale-[0.99]"
              >
                🚀 新建聊天并开始
              </button>
            ) : (
              <>
                <p
                  data-occ="hero-need-model"
                  className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[10px] leading-relaxed text-amber-300"
                >
                  还没有可用模型——先配置一个 API Key（或本地引擎），再开始任务。
                </p>
                <button
                  data-occ="hero-configure-model"
                  onClick={() => {
                    useOccStore.getState().openOnboarding()
                    useOccStore.getState().setOnboardingStep(1)
                  }}
                  className="mt-2 w-full rounded-lg bg-canvas-accent py-2 text-xs font-medium text-white shadow-sm transition-all hover:brightness-110 active:scale-[0.99]"
                >
                  ⚙ 去配置模型
                </button>
              </>
            )}
            <p className="mt-2 text-[10px] text-gray-500">写入文件前会弹「允许 / 拒绝」——那是请你把关，不是报错。</p>
          </>
        )}
      </div>
    </div>
  )
}
