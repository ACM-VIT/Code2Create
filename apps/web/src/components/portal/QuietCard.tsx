import type { ReactNode } from 'react'

export function QuietCard({
  label,
  children,
  grow = false,
  className = '',
}: {
  label: string
  children: ReactNode
  grow?: boolean
  className?: string
}) {
  return (
    <div
      className={`rounded-petal-sm glass-tile px-5 py-4 ${
        grow ? 'flex-[1.4]' : 'flex-1'
      } ${className}`}
    >
      <p className="mb-[5px] text-[10.5px] font-semibold tracking-[.08em] text-fg/50">
        {label}
      </p>
      {children}
    </div>
  )
}
