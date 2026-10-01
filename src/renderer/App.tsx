import { useEffect } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { TopBar } from './components/TopBar'
import { GraphCanvas } from './components/GraphCanvas'
import { InheritWizard } from './components/InheritWizard'
import { useOccStore } from './store/occStore'

export default function App(): React.ReactElement {
  const subscribe = useOccStore((s) => s.subscribe)

  useEffect(() => {
    // single live-event subscription for the whole app (graph + chats)
    return subscribe()
  }, [subscribe])

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-canvas-bg">
      <TopBar />
      <main className="min-h-0 flex-1">
        <ReactFlowProvider>
          <GraphCanvas />
        </ReactFlowProvider>
      </main>
      <InheritWizard />
    </div>
  )
}
