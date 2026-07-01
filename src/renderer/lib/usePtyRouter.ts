import { useEffect } from 'react'
import { getTerminal } from '../lib/terminalRegistry'

/**
 * Single global router: routes pty output events to the matching Terminal
 * instance via the registry. Mount once at the app root.
 */
export function usePtyRouter(): void {
  useEffect(() => {
    const offOut = window.electronAPI.pty.onOut((ptyId, data) => {
      const term = getTerminal(ptyId)
      if (term) term.write(data)
    })
    return () => {
      offOut()
    }
  }, [])
}
