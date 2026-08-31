import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement

type ValidationIssue = {
  control: FormControl
  message: string
  left: number
  top: number
  width: number
}

const messageId = 'code2create-form-validation-message'

function isFormControl(target: EventTarget | null): target is FormControl {
  return target instanceof HTMLInputElement
    || target instanceof HTMLSelectElement
    || target instanceof HTMLTextAreaElement
}

function fieldName(control: FormControl) {
  const label = control.labels?.[0]?.textContent
    ?.split('·')[0]
    ?.replace(/\s+/gu, ' ')
    .trim()
  return label || control.getAttribute('aria-label') || control.name || 'This field'
}

export function formControlValidationMessage(control: FormControl) {
  const name = fieldName(control)
  const validity = control.validity
  if (validity.customError) return control.validationMessage
  if (validity.valueMissing) {
    if (control instanceof HTMLInputElement && control.type === 'checkbox') {
      return 'Confirm this before continuing.'
    }
    if (control instanceof HTMLInputElement && control.type === 'radio') {
      return `Choose ${name.toLowerCase()}.`
    }
    if (control instanceof HTMLInputElement && control.type === 'file') {
      return `Choose a file for ${name.toLowerCase()}.`
    }
    if (control instanceof HTMLSelectElement) return `Choose ${name.toLowerCase()}.`
    return `${name} is required.`
  }
  if (validity.typeMismatch) {
    if (control instanceof HTMLInputElement && control.type === 'email') {
      return `Enter a complete email address for ${name.toLowerCase()}.`
    }
    if (control instanceof HTMLInputElement && control.type === 'url') {
      return `Enter a complete link beginning with https:// for ${name.toLowerCase()}.`
    }
    return `Enter a valid value for ${name.toLowerCase()}.`
  }
  if (validity.tooShort && !(control instanceof HTMLSelectElement)) {
    return `${name} needs at least ${control.minLength} characters.`
  }
  if (validity.tooLong && !(control instanceof HTMLSelectElement)) {
    return `${name} must stay under ${control.maxLength} characters.`
  }
  if (validity.rangeUnderflow && control instanceof HTMLInputElement) {
    return `${name} must be ${control.min} or more.`
  }
  if (validity.rangeOverflow && control instanceof HTMLInputElement) {
    return `${name} must be ${control.max} or less.`
  }
  if (validity.stepMismatch || validity.badInput) {
    return `Enter a valid value for ${name.toLowerCase()}.`
  }
  if (validity.patternMismatch) return `${name} is not in the expected format.`
  return `Check ${name.toLowerCase()} and try again.`
}

function positionedIssue(control: FormControl, message: string): ValidationIssue {
  const rect = control.getBoundingClientRect()
  const viewportPadding = 12
  const width = Math.min(Math.max(rect.width, 220), 360)
  const left = Math.min(
    Math.max(rect.left, viewportPadding),
    Math.max(viewportPadding, window.innerWidth - width - viewportPadding),
  )
  const estimatedHeight = 52
  const below = rect.bottom + 8
  const top = below + estimatedHeight <= window.innerHeight - viewportPadding
    ? below
    : Math.max(viewportPadding, rect.top - estimatedHeight - 8)
  return { control, message, left, top, width }
}

function markInvalid(control: FormControl) {
  control.setAttribute('aria-invalid', 'true')
  control.setAttribute('aria-errormessage', messageId)
}

function clearInvalidMark(control: FormControl) {
  control.removeAttribute('aria-invalid')
  if (control.getAttribute('aria-errormessage') === messageId) {
    control.removeAttribute('aria-errormessage')
  }
}

export function FormValidationBoundary({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const activeControlRef = useRef<FormControl | null>(null)
  const [issue, setIssue] = useState<ValidationIssue | null>(null)

  const clearIssue = useCallback((control?: FormControl) => {
    const active = activeControlRef.current
    if (!active || (control && active !== control)) return
    clearInvalidMark(active)
    activeControlRef.current = null
    setIssue(null)
  }, [])

  const refreshPosition = useCallback(() => {
    const control = activeControlRef.current
    if (!control || !document.contains(control)) {
      clearIssue()
      return
    }
    setIssue(positionedIssue(control, formControlValidationMessage(control)))
  }, [clearIssue])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    const handleInvalid = (event: Event) => {
      if (!isFormControl(event.target) || !root.contains(event.target)) return
      event.preventDefault()
      const control = event.target
      const active = activeControlRef.current
      if (active && active !== control && active.form === control.form && !active.validity.valid) return
      if (active && active !== control) clearInvalidMark(active)
      activeControlRef.current = control
      markInvalid(control)
      setIssue(positionedIssue(control, formControlValidationMessage(control)))
      queueMicrotask(() => control.focus({ preventScroll: false }))
    }

    const handleInput = (event: Event) => {
      if (!isFormControl(event.target) || event.target !== activeControlRef.current) return
      const control = event.target
      queueMicrotask(() => {
        if (control.validity.valid) clearIssue(control)
        else setIssue(positionedIssue(control, formControlValidationMessage(control)))
      })
    }

    root.addEventListener('invalid', handleInvalid, true)
    root.addEventListener('input', handleInput)
    window.addEventListener('resize', refreshPosition)
    window.addEventListener('scroll', refreshPosition, true)
    return () => {
      root.removeEventListener('invalid', handleInvalid, true)
      root.removeEventListener('input', handleInput)
      window.removeEventListener('resize', refreshPosition)
      window.removeEventListener('scroll', refreshPosition, true)
    }
  }, [clearIssue, refreshPosition])

  return (
    <div ref={rootRef} style={{ display: 'contents' }}>
      {children}
      {issue
        ? createPortal(
            <div
              id={messageId}
              role="alert"
              style={{
                position: 'fixed',
                zIndex: 2_147_483_646,
                left: issue.left,
                top: issue.top,
                width: issue.width,
                pointerEvents: 'none',
                border: '1px solid color-mix(in srgb, var(--rose-light, #f29ab6) 56%, transparent)',
                borderRadius: 10,
                background: 'color-mix(in srgb, var(--bg, #16060c) 94%, transparent)',
                boxShadow: '0 14px 40px rgb(0 0 0 / 28%)',
                color: 'var(--fg, #fff7fa)',
                fontFamily: 'inherit',
                fontSize: 12.5,
                lineHeight: 1.4,
                padding: '9px 11px',
              }}
            >
              {issue.message}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
