import { useEffect, useRef } from 'react'
import clsx from 'clsx'

export interface MenuItem {
  id: string
  label: string
  icon?: string
  danger?: boolean
  disabled?: boolean
  separator?: false
  onSelect?: () => void
}
export interface MenuSeparator {
  id: string
  separator: true
}

export type MenuEntry = MenuItem | MenuSeparator

interface ContextMenuProps {
  x: number
  y: number
  items: MenuEntry[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // keep menu within viewport
  const maxX = window.innerWidth - 220
  const maxY = window.innerHeight - items.length * 34 - 12
  const left = Math.min(x, Math.max(8, maxX))
  const top = Math.min(y, Math.max(8, maxY))

  return (
    <div
      ref={ref}
      className="fixed z-[60] min-w-[200px] rounded-lg border border-canvas-border bg-canvas-node py-1 shadow-2xl"
      style={{ left, top }}
    >
      {items.map((entry) =>
        'separator' in entry && entry.separator ? (
          <div key={entry.id} className="my-1 h-px bg-canvas-border" />
        ) : (
          <button
            key={entry.id}
            disabled={(entry as MenuItem).disabled}
            onClick={() => {
              const it = entry as MenuItem
              it.onSelect?.()
              onClose()
            }}
            className={clsx(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors',
              (entry as MenuItem).danger
                ? 'text-red-400 hover:bg-red-500/10'
                : 'text-gray-200 hover:bg-canvas-accent/20',
              (entry as MenuItem).disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent'
            )}
          >
            {((entry as MenuItem).icon ?? '›') && (
              <span className="w-4 text-center text-xs text-gray-500">
                {(entry as MenuItem).icon ?? '›'}
              </span>
            )}
            <span>{(entry as MenuItem).label}</span>
          </button>
        )
      )}
    </div>
  )
}
