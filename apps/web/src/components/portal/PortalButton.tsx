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
      className={`inline-flex items-center justify-center gap-2.5 font-ui font-semibold transition-[background,color] duration-250 disabled:cursor-not-allowed ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {children}
    </button>
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
      className={`rounded-sm text-[12.5px] text-fg/55 transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  )
}
