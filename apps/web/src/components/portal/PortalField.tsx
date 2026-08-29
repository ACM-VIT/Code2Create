import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import { useId } from 'react'

const control =
  'w-full rounded-petal-xs border border-petal-edge-soft bg-[rgb(12_0_4/.45)] px-3.5 py-2.5 text-[13.5px] text-paper transition-colors placeholder:text-[rgb(248_248_248/.45)] focus:border-rose-light focus:outline-none disabled:opacity-60'

export function PortalLabel({ children }: { children: ReactNode }) {
  return (
    <span className="mb-1.5 block text-[10.5px] font-semibold tracking-[.14em] text-[rgb(248_248_248/.5)] uppercase">
      {children}
    </span>
  )
}

/** A labelled control. `hint` renders as the dimmed "· optional" tail. */
export function PortalField({
  label,
  hint,
  children,
  className = '',
}: {
  label: string
  hint?: string
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
    </label>
  )
}

export function PortalInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${control} ${className}`} />
}

export function PortalSelect({
  className = '',
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={`${control} appearance-none pr-9 ${className}`}>
      {children}
    </select>
  )
}

export function PortalTextarea({
  className = '',
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${control} resize-none leading-relaxed ${className}`} />
}

/** The inline consent / acknowledgement row. */
export function PortalCheckRow({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <label className="flex items-start gap-2.5 text-xs leading-relaxed text-[rgb(248_248_248/.7)]">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 accent-rose"
      />
      <span>{children}</span>
    </label>
  )
}

export function PortalError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p role="alert" className="mt-3 text-[12.5px] text-rose-light">
      {message}
    </p>
  )
}
