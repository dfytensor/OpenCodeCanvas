import { useEffect, useState } from 'react'
import { useOccStore } from '../store/occStore'

// the first-run promise: workspace → model → first task, in one card
const GOALS = [
  '创建 hello.py：打印当前时间；运行它，并把输出作为验证证据报告',
  '列出这个项目的结构，写一份 README.md 摘要（含文件树）',
  '写一个计算器 calc.py，附 3 个 pytest 测试并全部跑通'
]

const PROVIDERS = [
  { id: 'zhipuai-coding-plan', name: 'GLM Coding Plan（智谱）' },
  { id: 'deepseek', name: 'DeepSeek' }
]

export default function Onboarding(): React.ReactElement | null {
  const open = useOccStore((s) => s.onboardingOpen)
  const step = useOccStore((s) => s.onboardingStep)
  const info = useOccStore((s) => s.onboardingInfo)
  const project = useOccStore((s) => s.project)
  const openProject = useOccStore((s) => s.openProject)
  const createChat = useOccStore((s) => s.createChat)
  const sendChat = useOccStore((s) => s.sendChat)
  const setStep = useOccStore((s) => s.setOnboardingStep)
  const closeOnboarding = useOccStore((s) => s.closeOnboarding)

  const [busy, setBusy] = useState(false)
  const [provId, setProvId] = useState('deepseek')
  const [provKey, setProvKey] = useState('')
  const [testMsg, setTestMsg] = useState('')
  const [ready, setReady] = useState(false)
  const [localMsg, setLocalMsg] = useState('')
  const [goal, setGoal] = useState(GOALS[0])
  const [needModel, setNeedModel] = useState(false)

  useEffect(() => { setReady(info?.hasProvider ?? false) }, [info])

  if (!open) return null

  const pickFolder = async (): Promise<void> => {
    const dir = await window.electronAPI.dialog.pickDirectory()
    if (dir) {
      setBusy(true)
      try {
        await openProject(dir)
        if (useOccStore.getState().project) setStep(1)
      } finally {
        setBusy(false)
      }
    }
  }

  const createDemo = async (): Promise<void> => {
    setBusy(true)
    try {
      const { dir } = await window.electronAPI.occ.createDemoProject()
      if (dir) {
        await openProject(dir)
        if (useOccStore.getState().project) setStep(1)
      }
    } finally {
      setBusy(false)
    }
  }

  const saveKey = async (): Promise<void> => {
    if (!provKey.trim()) return
    setTestMsg('保存并测试中…')
    try {
      await window.electronAPI.occ.setProviderKey(provId, provKey.trim())
      const r = await window.electronAPI.occ.testProvider(provId)
      if (r.ok) {
        setReady(true)
        setNeedModel(false)
        useOccStore.getState().refreshOnboardingInfo()
        setTestMsg(`✅ 连通（${r.model}，${r.ms}ms）`)
      } else {
        setReady(false)
        setTestMsg(`❌ ${r.error ?? '测试失败——检查 Key 或网络'}`)
      }
    } catch (e) {
      setTestMsg(`❌ ${String(e).slice(0, 120)}`)
    }
  }

  const startLocal = async (): Promise<void> => {
    setLocalMsg('启动中…（首次加载模型可能要十几秒）')
    try {
      const r = await window.electronAPI.occ.localJevStart()
      if (r.ok) useOccStore.getState().refreshOnboardingInfo()
      setLocalMsg(r.ok ? '✅ 本地引擎已就绪（Jev 决策 $0）' : `❌ ${r.error ?? '启动失败'}`)
    } catch (e) {
      setLocalMsg(`❌ ${String(e).slice(0, 120)}`)
    }
  }

  const finish = async (): Promise<void> => {
    if (!project) {
      setStep(0)
      return
    }
    // no model yet → sending now would start a doomed run; guide back to step ②
    if (!ready) {
      setNeedModel(true)
      setStep(1)
      return
    }
    setBusy(true)
    try {
      const id = await createChat()
      if (id) {
        useOccStore.getState().requestFocus(id)
        await sendChat(id, goal)
      }
    } finally {
      setBusy(false)
    }
    await closeOnboarding()
  }

  const input = 'w-full rounded-lg border border-canvas-border bg-canvas-bg px-3 py-2 text-xs text-gray-200 outline-none transition-colors focus:border-canvas-accent'

  return (
    <div className="absolute inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-[2px]" data-occ="onboarding">
      <div className="w-[480px] rounded-2xl border border-canvas-border bg-canvas-node p-6 shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {[0, 1, 2].map((i) => (
              <span key={i} className={`h-1.5 rounded-full transition-all ${i === step ? 'w-6 bg-canvas-accent' : 'w-1.5 bg-canvas-border'}`} />
            ))}
          </div>
          <button data-occ="onboarding-skip" className="text-[10px] text-gray-500 transition-colors hover:text-gray-300" onClick={() => void closeOnboarding()}>
            跳过引导 ✕
          </button>
        </div>

        {step === 0 && (
          <>
            <h2 className="text-sm font-semibold text-white">① 选择工作区</h2>
            <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
              Agent 的一切产出都真实落盘到你选定的项目文件夹——先给它一个工作区。
            </p>
            {project && (
              <p className="mt-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300">
                ✅ 已打开：{project.name}
              </p>
            )}
            <div className="mt-3 flex gap-2">
              <button
                data-occ="onboarding-open-folder"
                disabled={busy}
                onClick={() => void pickFolder()}
                className="flex-1 rounded-lg border border-canvas-border py-2 text-xs text-gray-200 transition-colors hover:border-canvas-accent hover:text-canvas-accent disabled:opacity-40"
              >
                📂 打开已有文件夹
              </button>
              <button
                data-occ="onboarding-demo"
                disabled={busy}
                onClick={() => void createDemo()}
                className="flex-1 rounded-lg border border-canvas-border py-2 text-xs text-gray-200 transition-colors hover:border-canvas-accent hover:text-canvas-accent disabled:opacity-40"
              >
                {busy ? '处理中…' : '✨ 创建示例项目'}
              </button>
            </div>
            <p className="mt-2 text-[10px] text-gray-500">示例项目 = 一个空文件夹 + 说明，适合先跑通第一个任务。</p>
          </>
        )}

        {step === 1 && (
          <>
            <h2 className="text-sm font-semibold text-white">② 配置模型</h2>
            {needModel && (
              <p
                data-occ="onboarding-need-model"
                className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300"
              >
                先配置模型（保存 API Key 或启动本地引擎），再开始第一个任务。
              </p>
            )}
            {ready ? (
              <p className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-2 text-[11px] text-emerald-300">
                ✅ 已检测到可用的模型配置——直接下一步。
              </p>
            ) : (
              <>
                <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
                  还没有可用模型。贴一个 API Key（推荐 DeepSeek / GLM），或启动本地引擎（零成本、离线可用）。
                </p>
                <div className="mt-3 flex gap-2">
                  <select className={`${input} w-40 shrink-0`} value={provId} onChange={(e) => { setProvId(e.target.value); setTestMsg('') }}>
                    {PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <input
                    data-occ="onboarding-provider-key"
                    type="password"
                    className={input}
                    placeholder="API Key"
                    value={provKey}
                    onChange={(e) => setProvKey(e.target.value)}
                  />
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    data-occ="onboarding-provider-save"
                    disabled={!provKey.trim() || testMsg === '保存并测试中…'}
                    onClick={() => void saveKey()}
                    className="rounded-lg bg-canvas-accent px-4 py-1.5 text-xs font-medium text-white transition-all hover:brightness-110 active:scale-95 disabled:opacity-40"
                  >
                    保存并测试
                  </button>
                  {info?.localEngineConfigured && (
                    <button
                      onClick={() => void startLocal()}
                      className="rounded-lg border border-canvas-border px-3 py-1.5 text-[11px] text-gray-300 transition-colors hover:border-canvas-accent hover:text-canvas-accent"
                    >
                      ▶ 启动本地引擎（$0）
                    </button>
                  )}
                </div>
                {testMsg && (
                  <p className={`mt-2 text-[10px] ${testMsg.startsWith('✅') ? 'text-emerald-400' : testMsg.includes('中…') ? 'text-gray-500' : 'text-red-400'}`}>
                    {testMsg}
                  </p>
                )}
                {localMsg && <p className="mt-1 text-[10px] text-gray-400">{localMsg}</p>}
              </>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <h2 className="text-sm font-semibold text-white">③ 跑通第一个任务</h2>
            <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
              选一个目标——你将看到：规划 → 执行 → 独立验收，最后给出证据。
            </p>
            <div className="mt-3 flex flex-col gap-1.5">
              {GOALS.map((g) => (
                <button
                  key={g}
                  data-occ="onboarding-goal-chip"
                  onClick={() => setGoal(g)}
                  className={`rounded-lg border px-3 py-2 text-left text-[11px] leading-snug transition-colors ${
                    goal === g ? 'border-canvas-accent/60 bg-canvas-accent/10 text-canvas-accent' : 'border-canvas-border text-gray-300 hover:border-canvas-accent/40'
                  }`}
                >
                  {g}
                </button>
              ))}
            </div>
            <button
              data-occ="onboarding-start"
              disabled={busy || !project}
              onClick={() => void finish()}
              className="mt-4 w-full rounded-lg bg-canvas-accent py-2 text-xs font-medium text-white shadow-sm transition-all hover:brightness-110 active:scale-[0.99] disabled:opacity-40"
            >
              🚀 开始第一个任务
            </button>
            {!project && <p className="mt-1 text-center text-[10px] text-amber-300">还没选工作区——回到第 1 步选一个。</p>}
            <p className="mt-2 text-center text-[10px] text-gray-500">写文件/跑命令前会弹「允许 / 全部允许 / 拒绝」——那是请你把关，不是报错。</p>
          </>
        )}

        <div className="mt-5 flex items-center justify-between">
          <button
            data-occ="onboarding-back"
            className={`text-[10px] text-gray-500 transition-colors hover:text-gray-300 ${step === 0 ? 'invisible' : ''}`}
            onClick={() => setStep(step - 1)}
          >
            ← 上一步
          </button>
          {step < 2 && (
            <button
              data-occ="onboarding-next"
              className="rounded-lg bg-canvas-accent px-4 py-1.5 text-xs font-medium text-white transition-all hover:brightness-110 active:scale-95"
              onClick={() => setStep(step + 1)}
            >
              下一步 →
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
