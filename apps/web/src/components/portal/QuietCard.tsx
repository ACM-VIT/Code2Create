import type { ReactNode } from 'react'

export function QuietCard({
  label,
  children,
  grow = false,
}: {
  label: string
  children: ReactNode
  grow?: boolean
}) {
  return (
    <div
      className={`rounded-petal-sm glass-tile px-5 py-4 ${
        grow ? 'flex-[1.4]' : 'flex-1'
      }`}
    >
      <p className="mb-[5px] text-[10.5px] font-semibold tracking-[.08em] text-fg/50">
        {label}
      </p>
      {children}
    </div>
  )
}
