import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'

interface EditableTitleProps {
  value: string
  editing: boolean
  onEditingChange: (editing: boolean) => void
  onCommit: (next: string) => void
  className?: string
  prefix?: string
}

/** Inline-editable text: double-click (or external trigger) to rename,
 *  Enter/blur to commit, Esc to cancel. */
export function EditableTitle({
  value,
  editing,
  onEditingChange,
  onCommit,
  className,
  prefix
}: EditableTitleProps): React.ReactElement {
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      setDraft(value)
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [editing, value])

  const commit = (): void => {
    const v = draft.trim()
    onEditingChange(false)
    if (v && v !== value) onCommit(v)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onEditingChange(false)
          }
        }}
        className={clsx(
          'min-w-0 flex-1 rounded bg-canvas-bg px-1 py-0.5 text-sm font-medium text-gray-100 outline-none ring-1 ring-canvas-accent',
          className
        )}
      />
    )
  }

  return (
    <span
      onDoubleClick={(e) => {
        e.stopPropagation()
        onEditingChange(true)
      }}
      className={clsx('min-w-0 truncate cursor-text', className)}
      title="Double-click to rename"
    >
      {prefix ? `${prefix} ${value}` : value}
    </span>
  )
}
