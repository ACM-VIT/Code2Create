import { type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'

import { tileAreaClass, type TileKey } from './dashboardLayout'

export function Tile({
  area,
  focused,
  onFocus,
  onRelease,
  backdrop,
  className = '',
  children,
}: {
  area: TileKey
  focused: boolean
  onFocus: () => void
  onRelease: () => void
  backdrop?: ReactNode
  className?: string
  children: ReactNode
}) {
  const interactive = !focused
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive || event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onFocus()
  }
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!interactive) return
    if ((event.target as HTMLElement).closest('button, a, input, textarea, select')) return
    onFocus()
  }
  return (
    <div
      className={`relative z-10 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[18px] border border-petal-edge/70 bg-fg/5 shadow-[0_20px_44px_-30px_var(--shade-2),inset_0_1px_0_color-mix(in_srgb,var(--color-fg)_14%,transparent)] backdrop-blur-[22px] backdrop-saturate-[1.35] transition-[border-color,background-color] duration-300 ${
        interactive
          ? 'cursor-pointer hover:border-rose-light/70 hover:bg-fg/8 focus-visible:border-rose-light focus-visible:outline-none'
          : 'border-rose-light/60 bg-fg/7'
      } ${tileAreaClass[area]} ${className}`}
      style={{ viewTransitionName: `dash-${area}` } as CSSProperties}
      {...(interactive
        ? { role: 'button', tabIndex: 0, onClick, onKeyDown, 'aria-expanded': false }
        : { 'aria-expanded': true })}
    >
      {backdrop}
      <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
      {focused ? (
        <button
          type="button"
          onClick={onRelease}
          aria-label="Close"
          className="absolute top-3 right-3 z-20 flex size-8 items-center justify-center rounded-full border border-rose/50 bg-wash/60 text-fg/80 backdrop-blur-md transition-colors hover:border-rose-light hover:text-fg"
        >
          <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
            <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      ) : null}
    </div>
  )
}

export function TileEyebrow({ children }: { children: ReactNode }) {
  return <p className="m-0 font-ui text-[15px] text-rose-light">{children}</p>
}
