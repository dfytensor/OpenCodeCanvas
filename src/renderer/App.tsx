import { useEffect } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import TopBar from './components/TopBar'
import { GraphCanvas } from './components/GraphCanvas'
import { ChatNode } from './components/ChatNode'
import { InheritWizard } from './components/InheritWizard'
import { OccNode } from './components/OccNode'
import { ChatSidebar } from './components/ChatSidebar'
import { DiffModal } from './components/DiffModal'
import { Toasts } from './components/Toasts'
import { useOccStore } from './store/occStore'
import CanvasHero from './components/CanvasHero'
import Onboarding from './components/Onboarding'

export default function App(): React.ReactElement {
  const subscribe = useOccStore((s) => s.subscribe)
  useEffect(() => { return subscribe() }, [subscribe])

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-canvas-bg">
      <TopBar />
      <main className="relative min-h-0 flex-1">
        <ReactFlowProvider>
          <GraphCanvas />
          <ChatSidebar />
        </ReactFlowProvider>
        <CanvasHero />
      </main>
      <InheritWizard />
      <DiffModal />
      <Toasts />
      <Onboarding />
    </div>
  )
}
