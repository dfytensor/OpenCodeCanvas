import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import '@xterm/xterm/css/xterm.css'
import './index.css'
import App from './App'

const el = document.getElementById('root')
if (!el) throw new Error('root element not found')

createRoot(el).render(<App />)
