// Internal OCC event bus (main-process side). Renderer gets these via IPC relay.
import { EventEmitter } from 'events'
import type { OccEvent } from '../../shared/types'

const EVENT_NAME = 'occ'

const emitter = new EventEmitter()
emitter.setMaxListeners(100)

export function emitOccEvent(e: OccEvent): void {
  emitter.emit(EVENT_NAME, e)
}

export function onOccEvent(cb: (e: OccEvent) => void): () => void {
  emitter.on(EVENT_NAME, cb)
  return () => {
    emitter.off(EVENT_NAME, cb)
  }
}
