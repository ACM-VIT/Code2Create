import { useEffect, useRef, useState } from 'react'

/**
 * A one-time code typed into a row of cells. One real input sits invisibly
 * over the cells, so SMS autofill, paste, and assistive tech all see a single
 * field while the eye gets a digit per box. The input stays fully opaque but
 * transparent, which is what keeps iOS's "From Messages" suggestion and
 * keyboard clipboard hints working; on Android the WebOTP API is asked for
 * the code as well.
 */
export function CodeInput({
  value,
  onChange,
  onComplete,
  length = 6,
  disabled = false,
  label,
  autoFocus = false,
  shakeKey = 0,
  enableSmsWebOtp = true,
}: {
  value: string
  onChange: (next: string) => void
  /** Fires as the last digit lands, so the common path needs no extra tap. */
  onComplete?: (code: string) => void
  length?: number
  disabled?: boolean
  label: string
  autoFocus?: boolean
  /** Bump to replay the shake, for a code that came back wrong. */
  shakeKey?: number
  /** Email codes should disable the Android SMS-only WebOTP request. */
  enableSmsWebOtp?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  const latest = useRef({ onChange, onComplete })
  latest.current = { onChange, onComplete }

  const accept = (raw: string) => {
    const next = raw.replace(/\D/gu, '').slice(0, length)
    latest.current.onChange(next)
    if (next.length === length) latest.current.onComplete?.(next)
  }

  useEffect(() => {
    if (autoFocus && !disabled) inputRef.current?.focus()
  }, [autoFocus, disabled])

  // WebOTP: Android Chrome offers the code straight from the text message when
  // its last line reads "@<host> #<code>". Unsupported browsers skip this.
  useEffect(() => {
    if (
      !enableSmsWebOtp ||
      disabled ||
      typeof window === 'undefined' ||
      !('OTPCredential' in window)
    ) return
    const credentials = navigator.credentials as
      | { get: (options: { otp: { transport: string[] }; signal: AbortSignal }) => Promise<unknown> }
      | undefined
    if (!credentials) return
    const controller = new AbortController()
    credentials
      .get({ otp: { transport: ['sms'] }, signal: controller.signal })
      .then((credential) => {
        const code = (credential as { code?: unknown } | null)?.code
        if (typeof code === 'string') accept(code)
      })
      .catch(() => {})
    return () => controller.abort()
    // `accept` reads the latest callbacks through a ref.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, enableSmsWebOtp, length])

  const digits = value.replace(/\D/gu, '').slice(0, length)
  const activeIndex = Math.min(digits.length, length - 1)

  return (
    <div
      className={`relative flex min-w-0 flex-1 ${disabled ? 'opacity-60' : ''}`}
      data-ph-sensitive
    >
      <div
        key={shakeKey}
        aria-hidden
        className={`flex min-w-0 flex-1 gap-1.5 ${shakeKey > 0 ? 'motion-safe:animate-shake' : ''}`}
      >
        {Array.from({ length }, (_, index) => {
          const digit = digits[index] ?? ''
          const active = focused && !disabled && index === activeIndex && digits.length < length
          return (
            <span
              key={index}
              className={`flex h-[45px] min-w-0 max-w-[46px] flex-1 basis-0 items-center justify-center rounded-petal-xs border bg-wash/45 font-mono text-[18px] font-semibold text-fg transition-colors ${
                active ? 'border-rose-light' : 'border-petal-edge-soft'
              }`}
            >
              {digit || (active ? <span className="h-5 w-px bg-rose-light motion-safe:animate-caret" /> : null)}
            </span>
          )
        })}
      </div>
      <input
        ref={inputRef}
        aria-label={label}
        autoComplete="one-time-code"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={length}
        disabled={disabled}
        value={digits}
        onChange={(event) => accept(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        // Inline so the app's global input styling (colour, focus ring) cannot
        // paint the overlay; the cells behind it are the whole visual.
        style={{
          color: 'transparent',
          WebkitTextFillColor: 'transparent',
          background: 'transparent',
          caretColor: 'transparent',
          outline: 'none',
          boxShadow: 'none',
          border: 0,
          padding: 0,
          textShadow: 'none',
          // Chrome paints autofilled fields with its own colours at UA priority;
          // a never-ending transition keeps that background from appearing.
          transition: 'background-color 999999s',
        }}
        className="absolute inset-0 h-full w-full cursor-text text-base selection:bg-transparent selection:text-transparent disabled:cursor-not-allowed"
      />
    </div>
  )
}
