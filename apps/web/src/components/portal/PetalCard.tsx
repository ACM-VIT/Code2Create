import type { ReactNode } from 'react'

/**
 * The portal's one surface: a translucent rounded card. Everything the
 * participant reads or types sits on one of these.
 */
export function PetalCard({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className="relative w-full">
      <div
        className={`relative rounded-petal border border-petal-edge bg-[image:var(--petal-card-bg)] shadow-[0_36px_70px_-22px_var(--shade-2),inset_0_1px_0_var(--card-topline)] backdrop-blur-md ${className}`}
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
