import { useCallback } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { Sidebar } from './components/Sidebar'
import { Toolbar, type AddMode } from './components/Toolbar'
import { CanvasView } from './components/CanvasView'
import { usePtyRouter } from './lib/usePtyRouter'

export default function App(): React.ReactElement {
  usePtyRouter()

  const handleAdd = useCallback((mode: AddMode): void => {
    window.dispatchEvent(new CustomEvent('canvas:add', { detail: mode }))
  }, [])

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-canvas-bg">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Toolbar onAdd={handleAdd} />
        <main className="min-h-0 flex-1">
          <ReactFlowProvider>
            <CanvasView />
          </ReactFlowProvider>
        </main>
      </div>
    </div>
  )
}
