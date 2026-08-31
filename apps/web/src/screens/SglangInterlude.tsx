import { api } from '@code2create/backend/api'
import { useAction } from 'convex/react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { DaybreakToggle } from '../components/portal/DaybreakToggle'
import { Petals } from '../components/portal/Petals'
import { PortalButton } from '../components/portal/PortalButton'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import type { GitHubStarConnectionResult, GitHubStarGateState } from '../types'

const callbackAttempts = new Map<string, Promise<GitHubStarConnectionResult>>()

export function SglangInterlude({
  state,
  callback,
}: {
  state: GitHubStarGateState
  callback: boolean
}) {
  const beginConnection = useAction(api.githubStarActions.beginConnection)
  const completeConnection = useAction(api.githubStarActions.completeConnection)
  const starRepository = useAction(api.githubStarActions.star)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const callbackValues = useMemo(() => {
    if (!callback) return null
    const oauthError = searchParams.get('error')
    if (oauthError) return { kind: 'error' as const }
    const code = searchParams.get('code')
    const oauthState = searchParams.get('state')
    if (!code || !oauthState) return { kind: 'invalid' as const }
    return { kind: 'complete' as const, code, oauthState }
  }, [callback, searchParams])
  const [busy, setBusy] = useState(callbackValues?.kind === 'complete')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (callbackValues?.kind !== 'complete') return
    const key = `${callbackValues.oauthState}:${callbackValues.code}`
    let attempt = callbackAttempts.get(key)
    if (!attempt) {
      attempt = completeConnection({
        eventSlug,
        state: callbackValues.oauthState,
        code: callbackValues.code,
      })
      callbackAttempts.set(key, attempt)
    }
    let active = true
    attempt.then(
      () => {
        if (!active) return
        setBusy(false)
        navigate('/', { replace: true, viewTransition: true })
      },
      (reason: unknown) => {
        if (!active) return
        setBusy(false)
        setError(readableError(reason))
      },
    )
    return () => {
      active = false
    }
  }, [callbackValues, completeConnection, navigate])

  const callbackMessage = callbackValues?.kind === 'error'
    ? 'GitHub did not authorize this connection. Try again.'
    : callbackValues?.kind === 'invalid'
      ? 'This GitHub callback is incomplete. Connect GitHub again.'
      : null
  const displayedError = error ?? callbackMessage

  const connect = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await beginConnection({ eventSlug })
      window.location.assign(result.authorizationUrl)
    } catch (reason) {
      setBusy(false)
      setError(readableError(reason))
    }
  }

  const star = async () => {
    setBusy(true)
    setError(null)
    try {
      await starRepository({ eventSlug })
    } catch (reason) {
      setBusy(false)
      setError(readableError(reason))
    }
  }

  return (
    <div
      data-portal-scene
      className="relative flex min-h-dvh flex-col items-center overflow-hidden bg-wash bg-[image:var(--note-bg)] px-5 font-ui text-fg"
    >
      <Petals className="opacity-25" />
      <img
        src="/assets/logo.svg"
        alt="Code2Create"
        className="absolute top-9 left-6 w-[26px] drop-shadow-[0_0_14px_var(--logo-glow)] lg:left-11 lg:w-[30px]"
      />
      <div className="absolute top-9 right-6 lg:right-11">
        <DaybreakToggle />
      </div>
      <div className="relative mx-auto flex w-full max-w-[660px] flex-1 flex-col justify-center pt-16 pb-14 text-center">
        <h1 className="mb-6 font-display font-light tracking-[-.01em] text-balance text-[28px] leading-[1.25] lg:text-[38px]">
          Star SGLang to continue.
        </h1>
        <p className="m-0 text-pretty text-[15px] leading-[1.8] text-fg/70">
          It serves trillions of tokens a day across 400,000+ GPUs, at xAI, NVIDIA, AMD, LinkedIn,
          and Cursor. ACM-VIT contributes to it, and our alum{' '}
          <a
            href="https://github.com/adarshxs"
            target="_blank"
            rel="noreferrer"
            className="text-rose-light underline underline-offset-[3px]"
          >
            Adarsh Shriwalmath ↗
          </a>{' '}
          went from contributor to maintainer to MLE at Hugging Face.
        </p>
        <p className="mt-4 mb-0 text-pretty text-[15px] leading-[1.8] text-fg/70">
          Connect GitHub here, then star{' '}
          <a
            href="https://github.com/sgl-project/sglang"
            target="_blank"
            rel="noreferrer"
            className="text-rose-light underline underline-offset-[3px]"
          >
            sgl-project/sglang ↗
          </a>
          .
        </p>

        <div className="mt-[38px] flex min-h-[78px] flex-col items-center gap-3.5">
          {state.connected && state.githubLogin ? (
            <p className="m-0 text-[13px] text-fg/55">connected as @{state.githubLogin}</p>
          ) : null}
          <PortalButton
            type="button"
            disabled={busy || state.completed}
            onClick={state.connected ? () => void star() : () => void connect()}
            className="min-w-[190px]"
          >
            {busy
              ? callbackValues?.kind === 'complete'
                ? 'Connecting…'
                : state.connected
                  ? 'Starring…'
                  : 'Opening GitHub…'
              : state.connected
                ? 'Star SGLang'
                : 'Connect GitHub'}
          </PortalButton>
          {displayedError ? (
            <p role="alert" className="m-0 max-w-[440px] text-[13px] leading-relaxed text-rose-light">
              {displayedError}
            </p>
          ) : null}
        </div>

        <div className="mt-[54px] flex items-center justify-center gap-[26px] opacity-55">
          <span className="inline-flex items-center gap-[7px]">
            <img src="/assets/sglang-logo.png" alt="" className="w-5" />
            <span className="text-sm font-bold">SGLang</span>
          </span>
          <span aria-hidden className="h-3.5 w-px bg-fg/30" />
          <span className="inline-flex items-center gap-[7px]">
            <img src="/assets/lmsys-logo.svg" alt="" className="w-[17px] [filter:var(--mark-filter)]" />
            <span className="text-sm font-semibold tracking-[.1em]">LMSYS</span>
          </span>
          <span aria-hidden className="h-3.5 w-px bg-fg/30" />
          <span className="inline-flex items-center gap-1.5">
            <img src="/assets/logo.svg" alt="" className="w-[15px]" />
            <span className="text-sm font-semibold tracking-[.06em]">ACM-VIT</span>
          </span>
        </div>
      </div>
    </div>
  )
}
