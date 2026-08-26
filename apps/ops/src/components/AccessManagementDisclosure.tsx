import type { ReactNode } from 'react'

export function AccessManagementDisclosure({
  children,
  description,
  onToggle,
  open,
  title,
  tone = 'default',
}: {
  children: ReactNode
  description: string
  onToggle?: (open: boolean) => void
  open?: boolean
  title: string
  tone?: 'default' | 'danger'
}) {
  return (
    <details
      className={`access-management-tool ${tone}`}
      open={open}
      onToggle={(event) => onToggle?.(event.currentTarget.open)}
    >
      <summary>
        <span>
          <strong>{title}</strong>
          <small>{description}</small>
        </span>
        <span className="access-management-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="access-management-content">{children}</div>
    </details>
  )
}
