import type {
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from 'react'
import { forwardRef, useId } from 'react'

const control =
  'w-full rounded-petal-xs border border-petal-edge-soft bg-wash/45 px-3.5 py-2.5 text-[13.5px] text-fg transition-colors placeholder:text-fg/45 focus:border-rose-light focus:outline-none disabled:opacity-60'

export function PortalLabel({ children }: { children: ReactNode }) {
  return (
    <span className="mb-1.5 block text-[10.5px] font-semibold tracking-[.08em] text-fg/50">
      {children}
    </span>
  )
}

export function PortalField({
  label,
  hint,
  error,
  children,
  className = '',
}: {
  label: string
  hint?: string
  error?: string | null
  children: (id: string) => ReactNode
  className?: string
}) {
  const id = useId()
  return (
    <label htmlFor={id} className={`block ${className}`}>
      <PortalLabel>
        {label}
        {hint ? <span className="opacity-60"> · {hint}</span> : null}
      </PortalLabel>
      {children(id)}
      {error ? (
        <span role="alert" className="mt-1.5 block text-[11.5px] leading-snug text-rose-light">
          {error}
        </span>
      ) : null}
    </label>
  )
}

export const PortalInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function PortalInput({ className = '', ...props }, ref) {
    return <input ref={ref} {...props} className={`${control} ${className}`} />
  },
)

/**
 * A rose tick pinned inside an input's right edge, for a value that has been
 * verified. Wrap the input in `relative` and give it `pr-10`.
 */
export function PortalInputTick() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-rose-light"
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m5 12.5 4.5 4.5L19 7" />
      </svg>
    </span>
  )
}

export { PortalSelect } from './PortalDropdown'

export function PortalTextarea({
  className = '',
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${control} resize-none leading-relaxed ${className}`} />
}

export function PortalCheckRow({
  checked,
  onChange,
  disabled,
  required,
  children,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  required?: boolean
  children: ReactNode
}) {
  return (
    <label className="flex items-start gap-2.5 text-xs leading-relaxed text-fg/70">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        required={required}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 accent-rose"
      />
      <span>{children}</span>
    </label>
  )
}

export function PortalError({
  message,
  reserve = false,
}: {
  message: string | null
  reserve?: boolean
}) {
  if (!message && !reserve) return null
  return (
    <p role="alert" className={`mt-3 text-[12.5px] text-rose-light ${reserve ? 'min-h-[1lh]' : ''}`}>
      {message}
    </p>
  )
}
