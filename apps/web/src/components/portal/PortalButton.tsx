import type { ButtonHTMLAttributes, ReactNode } from 'react'

const base =
  'portal-primary-button inline-flex items-center justify-center gap-2.5 rounded-btn border-[2.5px] border-rose bg-ink font-ui font-semibold tracking-[.02em] text-paper-warm shadow-[0_10px_24px_-10px_rgba(0,0,0,.7)] disabled:cursor-not-allowed disabled:border-[rgb(216_132_162/.35)] disabled:text-[rgb(254_253_254/.4)] disabled:opacity-70'

const sizes = {
  md: 'px-9 py-3.5 text-[15px]',
  sm: 'px-8 py-2.5 text-sm',
} as const

/** The bordered slab button — the portal's only primary action shape. */
export function PortalButton({
  children,
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode; size?: keyof typeof sizes }) {
  return (
    <button {...props} className={`${base} ${sizes[size]} ${className}`}>
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
      className={`rounded-sm text-[12.5px] text-[rgb(248_248_248/.55)] transition-colors hover:text-paper disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  )
}
