import type { ButtonHTMLAttributes, ReactNode } from 'react'

// The updated mockup's two button shapes: an outline that fills rose with ink
// text on hover (the workhorse), and a solid rose slab for the biggest CTAs.
// The design paints solid-button labels rose-light on rose (~1.5:1); the
// mockup's own filled hover state uses ink, so solid labels follow that.
const variants = {
  outline:
    'border-[1.5px] border-rose bg-transparent text-rose-light hover:bg-rose hover:text-wash disabled:border-2 disabled:border-rose/35 disabled:bg-transparent disabled:text-rose/50',
  solid:
    'border-0 bg-rose text-wash shadow-[0_10px_24px_-12px_var(--glow-rose)] hover:brightness-105 disabled:opacity-50',
} as const

const sizes = {
  md: 'rounded-btn px-9 py-3.5 text-[15px] tracking-[.02em]',
  sm: 'rounded-btn px-8 py-[11px] text-sm tracking-[.03em]',
  xs: 'rounded-btn-sm px-[18px] py-2 text-[11.5px] tracking-[.01em]',
  /* A square the height of a portal input, for a lone glyph. */
  icon: 'size-[45px] rounded-btn-sm p-0',
} as const

export function PortalButton({
  children,
  size = 'md',
  variant = 'outline',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode
  size?: keyof typeof sizes
  variant?: keyof typeof variants
}) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2.5 font-ui font-semibold transition-[background,color] duration-250 disabled:cursor-not-allowed motion-safe:disabled:hover:animate-shake ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {children}
    </button>
  )
}

/**
 * The compact confirm beside an inline field: a tick in a square the height
 * of the input, so a short row keeps its room for typing. `label` names the
 * action for assistive tech and the tooltip, since the tick says nothing.
 */
export function PortalTickButton({
  label,
  className = '',
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { label: string }) {
  return (
    <PortalButton
      {...props}
      size="icon"
      aria-label={label}
      title={label}
      className={`flex-none ${className}`}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0"
        aria-hidden
      >
        <path d="m5 12.5 4.5 4.5L19 7" />
      </svg>
    </PortalButton>
  )
}

/** The quiet companion to PortalButton: back, skip, and other exits. */
export function PortalTextButton({
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button
      {...props}
      className={`rounded-sm text-[12.5px] text-fg/55 transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 motion-safe:disabled:hover:animate-shake ${className}`}
    >
      {children}
    </button>
  )
}
