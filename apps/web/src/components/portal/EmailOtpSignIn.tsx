import type { Code2CreateAuthClient } from '@code2create/web-auth'
import { useState, type ReactNode } from 'react'
import { CodeInput } from './CodeInput'
import { FadeText } from './FadeText'
import { PortalButton, PortalTickButton } from './PortalButton'
import { PortalField, PortalInput, PortalLabel } from './PortalField'

type EmailStep = 'closed' | 'email' | 'code'

function normalizedEmail(value: string) {
  return value.trim().toLocaleLowerCase('en')
}

function emailIsValid(value: string) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)
}

// Every line below shares the status row with its actions and must stay on
// one line in the 320px sign-in column, so the copy is kept short.
function sendErrorMessage(code: string | undefined) {
  if (code === 'TOO_MANY_REQUESTS') return 'too many codes · wait a minute'
  if (code === 'INVALID_EMAIL') return 'enter a complete email address'
  return "couldn't send it · check the address"
}

function verifyErrorMessage(code: string | undefined) {
  if (code === 'INVALID_OTP') return 'wrong code'
  if (code === 'OTP_EXPIRED') return 'code expired'
  if (code === 'TOO_MANY_ATTEMPTS') return 'too many tries'
  if (code === 'TOO_MANY_REQUESTS') return 'wait a minute'
  return 'try that again'
}

const quietAction =
  'rounded-sm text-rose-light transition-colors hover:underline disabled:cursor-not-allowed disabled:opacity-50'

/** One reserved line under a row: the error in rose, otherwise the note, then the ways out. */
function StatusLine({
  error,
  note,
  children,
}: {
  error: string | null
  note: string
  children?: ReactNode
}) {
  return (
    <p role="status" className="mt-1.5 min-h-[1lh] text-[11.5px] leading-snug text-fg/50">
      {error ? (
        <span role="alert" className="text-rose-light">
          {error}
        </span>
      ) : (
        note
      )}
      {children}
    </p>
  )
}

/** The address step, shaped like the phone field: the input with its send button beside it. */
export function EmailAddressStep({
  email,
  onEmailChange,
  onSend,
  onBack,
  busy,
  error,
}: {
  email: string
  onEmailChange: (next: string) => void
  onSend: () => void
  onBack: () => void
  busy: boolean
  error: string | null
}) {
  const valid = emailIsValid(normalizedEmail(email))
  return (
    <form
      className="w-full text-center"
      data-ph-sensitive
      onSubmit={(event) => {
        event.preventDefault()
        onSend()
      }}
    >
      <PortalField label="email">
        {(id) => (
          <div className="flex items-stretch gap-2">
            <PortalInput
              id={id}
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              required
              maxLength={254}
              autoFocus
              disabled={busy}
              value={email}
              placeholder="you@college.edu"
              className="min-w-0 flex-1"
              onChange={(event) => onEmailChange(event.target.value)}
            />
            <PortalButton type="submit" size="xs" className="shrink-0 px-4" disabled={busy || !valid}>
              {busy ? 'Sending…' : 'Send code'}
            </PortalButton>
          </div>
        )}
      </PortalField>
      <StatusLine error={error} note="we'll email you a six-digit code">
        {' · '}
        <button type="button" disabled={busy} onClick={onBack} className={quietAction}>
          back
        </button>
      </StatusLine>
    </form>
  )
}

/** The code step, shaped like the phone code row: six cells, the tick, one quiet line. */
export function EmailCodeStep({
  email,
  code,
  onCodeChange,
  onVerify,
  onResend,
  onChangeEmail,
  busy,
  error,
  note,
  shakeKey,
}: {
  email: string
  code: string
  onCodeChange: (next: string) => void
  onVerify: (code: string) => void
  onResend: () => void
  onChangeEmail: () => void
  busy: boolean
  error: string | null
  note: string
  shakeKey: number
}) {
  return (
    <form
      className="w-full text-center"
      data-ph-sensitive
      onSubmit={(event) => {
        event.preventDefault()
        onVerify(code)
      }}
    >
      <PortalLabel>
        <FadeText>
          code<span className="opacity-60"> · emailed to {email}</span>
        </FadeText>
      </PortalLabel>
      <div className="flex items-center gap-2.5">
        <CodeInput
          value={code}
          onChange={onCodeChange}
          onComplete={onVerify}
          disabled={busy}
          label="Six-digit email sign-in code"
          autoFocus
          shakeKey={shakeKey}
          enableSmsWebOtp={false}
        />
        <PortalTickButton
          type="submit"
          label={busy ? 'Checking…' : 'Verify and continue'}
          disabled={busy || code.length !== 6}
        />
      </div>
      <StatusLine error={error} note={note}>
        {' · '}
        <button type="button" disabled={busy} onClick={onResend} className={quietAction}>
          send again
        </button>
        {' · '}
        <button type="button" disabled={busy} onClick={onChangeEmail} className={quietAction}>
          change email
        </button>
      </StatusLine>
    </form>
  )
}

/** Sign-in by emailed code for external participants: a button that unfolds into the two steps. */
export function EmailOtpSignIn({
  authClient,
  configured,
  disabled,
  googleOnlyEmailDomain,
}: {
  authClient: Code2CreateAuthClient
  configured: boolean
  disabled: boolean
  googleOnlyEmailDomain: string
}) {
  const [step, setStep] = useState<EmailStep>('closed')
  const [email, setEmail] = useState('')
  const [submittedEmail, setSubmittedEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('check spam too')
  const [shakeKey, setShakeKey] = useState(0)

  const requestCode = async (destination: string, again: boolean) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email: destination,
        type: 'sign-in',
      })
      if (result.error) {
        setError(sendErrorMessage(result.error.code))
        return
      }
      setSubmittedEmail(destination)
      setCode('')
      setNote(again ? 'fresh code sent' : 'check spam too')
      setStep('code')
    } catch {
      setError(sendErrorMessage(undefined))
    } finally {
      setBusy(false)
    }
  }

  const submitEmail = () => {
    const destination = normalizedEmail(email)
    if (!emailIsValid(destination)) {
      setError('enter a complete email address')
      return
    }
    if (destination.endsWith(`@${googleOnlyEmailDomain.toLocaleLowerCase('en')}`)) {
      setError(`${googleOnlyEmailDomain} accounts use Google`)
      return
    }
    setEmail(destination)
    void requestCode(destination, false)
  }

  const verifyCode = async (nextCode: string) => {
    if (busy || nextCode.length !== 6) return
    setBusy(true)
    setError(null)
    try {
      const result = await authClient.signIn.emailOtp({ email: submittedEmail, otp: nextCode })
      if (result.error) {
        setCode('')
        setShakeKey((current) => current + 1)
        setError(verifyErrorMessage(result.error.code))
        return
      }
      authClient.updateSession()
    } catch {
      setCode('')
      setShakeKey((current) => current + 1)
      setError(verifyErrorMessage(undefined))
    } finally {
      setBusy(false)
    }
  }

  if (step === 'closed') {
    return (
      <PortalButton
        type="button"
        disabled={disabled || !configured}
        className="w-full"
        onClick={() => {
          setStep('email')
          setError(null)
        }}
      >
        Continue with email
      </PortalButton>
    )
  }

  if (step === 'email') {
    return (
      <EmailAddressStep
        email={email}
        onEmailChange={(next) => {
          setError(null)
          setEmail(next)
        }}
        onSend={submitEmail}
        onBack={() => {
          setStep('closed')
          setError(null)
        }}
        busy={busy}
        error={error}
      />
    )
  }

  return (
    <EmailCodeStep
      email={submittedEmail}
      code={code}
      onCodeChange={(next) => {
        setError(null)
        setCode(next)
      }}
      onVerify={(entered) => void verifyCode(entered)}
      onResend={() => void requestCode(submittedEmail, true)}
      onChangeEmail={() => {
        setStep('email')
        setCode('')
        setError(null)
      }}
      busy={busy}
      error={error}
      note={note}
      shakeKey={shakeKey}
    />
  )
}
