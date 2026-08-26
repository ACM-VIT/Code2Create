import { useState, type ReactNode } from 'react'

export function ConfigurationEditorDisclosure({
  children,
  defaultOpen,
  description,
  title,
}: {
  children: ReactNode
  defaultOpen: boolean
  description: string
  title: string
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <details
      className="configuration-editor-disclosure"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>
          <strong>{title}</strong>
          <small>{description}</small>
        </span>
        <span aria-hidden="true" className="configuration-editor-toggle" />
      </summary>
      <div className="configuration-editor-body">{children}</div>
    </details>
  )
}
