import type { ReactNode } from 'react'

/**
 * The portal's one surface: a translucent petal-cornered card lit from
 * underneath. Everything the participant reads or types sits on one of these.
 */
export function PetalCard({
  children,
  className = '',
  glow = true,
}: {
  children: ReactNode
  className?: string
  glow?: boolean
}) {
  return (
    <div className="relative w-full">
      {glow ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-[15%] bottom-[-28px] h-14 bg-[radial-gradient(ellipse,rgba(216,132,162,.4),transparent_70%)] blur-[26px]"
        />
      ) : null}
      <div
        className={`relative rounded-tl-[36px] rounded-tr-[8px] rounded-br-[64px] rounded-bl-[8px] border border-petal-edge bg-[linear-gradient(155deg,rgba(255,255,255,.09),rgba(12,0,4,.5)_55%,rgba(160,66,99,.2))] shadow-[0_36px_70px_-22px_rgba(0,0,0,.85),inset_0_1px_0_rgba(255,255,255,.16)] backdrop-blur-md ${className}`}
      >
        {children}
      </div>
    </div>
  )
}

/** The hairline the mockup uses to split a card into stacked rows. */
export function PetalDivider({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`border-t border-petal-line ${className}`} />
}
