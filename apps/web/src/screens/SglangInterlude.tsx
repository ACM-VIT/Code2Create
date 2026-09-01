import { api } from '@code2create/backend/api'
import { useAction, useMutation } from 'convex/react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { DaybreakToggle } from '../components/portal/DaybreakToggle'
import { Petals } from '../components/portal/Petals'
import { PortalButton, PortalTextButton } from '../components/portal/PortalButton'
import { SignOutCircle } from '../components/portal/SignOutCircle'
import { eventSlug } from '../lib/config'
import { convexErrorCode, readableError } from '../lib/errors'
import type { GitHubStarConnectionResult, GitHubStarGateState } from '../types'

const callbackAttempts = new Map<string, Promise<GitHubStarConnectionResult>>()

type InterludeFailure = {
  code: string | null
  message: string
}

export function SglangInterlude({
  state,
  callback,
  onSignOut,
}: {
  state: GitHubStarGateState
  callback: boolean
  onSignOut: () => void
}) {
  const beginConnection = useAction(api.githubStarActions.beginConnection)
  const completeConnection = useAction(api.githubStarActions.completeConnection)
  const starRepository = useAction(api.githubStarActions.star)
  const disconnectGitHub = useMutation(api.githubStarGate.disconnect)
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
  const [busy, setBusy] = useState<'callback' | 'connect' | 'disconnect' | 'star' | null>(
    callbackValues?.kind === 'complete' ? 'callback' : null,
  )
  const [failure, setFailure] = useState<InterludeFailure | null>(null)

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
        setBusy(null)
        navigate('/', { replace: true, viewTransition: true })
      },
      (reason: unknown) => {
        if (!active) return
        setBusy(null)
        setFailure({ code: convexErrorCode(reason), message: readableError(reason) })
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
  const displayedError = failure?.message ?? callbackMessage
  const accountInUse = failure?.code === 'GITHUB_ACCOUNT_IN_USE'

  const connect = async () => {
    setBusy('connect')
    setFailure(null)
    try {
      const result = await beginConnection({ eventSlug })
      window.location.assign(result.authorizationUrl)
    } catch (reason) {
      setBusy(null)
      setFailure({ code: convexErrorCode(reason), message: readableError(reason) })
    }
  }

  const star = async () => {
    setBusy('star')
    setFailure(null)
    try {
      await starRepository({ eventSlug })
      setBusy(null)
    } catch (reason) {
      setBusy(null)
      setFailure({ code: convexErrorCode(reason), message: readableError(reason) })
    }
  }

  const disconnect = async () => {
    setBusy('disconnect')
    setFailure(null)
    try {
      await disconnectGitHub({ eventSlug })
      setBusy(null)
      navigate('/', { replace: true, viewTransition: true })
    } catch (reason) {
      setBusy(null)
      setFailure({ code: convexErrorCode(reason), message: readableError(reason) })
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
        className="absolute top-7 left-6 size-10 drop-shadow-[0_0_14px_var(--logo-glow)] lg:top-9 lg:left-11 lg:size-12"
      />
      <div className="absolute top-7 right-6 z-10 flex items-start gap-2.5 lg:top-9 lg:right-11">
        <SignOutCircle onSignOut={onSignOut} />
        <DaybreakToggle />
      </div>
      <div className="relative mx-auto flex w-full max-w-[760px] flex-1 flex-col justify-center pt-20 pb-14 text-center">
        <h1 className="mb-6 font-display font-light tracking-[-.01em] text-balance text-[28px] leading-[1.25] lg:text-[38px]">
          Star SGLang to continue
        </h1>
        {/* Centred copy only reads evenly when each paragraph is short enough
            to balance, so the measure stays tight and every one is three
            lines at most. */}
        <div className="mx-auto flex max-w-[620px] flex-col gap-5 text-[15px] leading-[1.7] text-fg/70">
          <p className="m-0 text-balance">
            SGLang is the leading open-source inference engine, outperforming vLLM across many
            workloads and serving{' '}
            <strong className="font-semibold text-fg/90">
              trillions of tokens daily across 400,000+ GPUs
            </strong>{' '}
            at companies like{' '}
            <strong className="font-semibold text-fg/90">
              xAI, NVIDIA, AMD, LinkedIn, and Cursor
            </strong>
            .
          </p>
          <p className="m-0 text-balance">
            ACM-VIT contributes to SGLang, and our alum{' '}
            <a
              href="https://github.com/adarshxs"
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-rose-light underline underline-offset-[3px]"
            >
              Adarsh Shriwalmath ↗
            </a>{' '}
            went from contributor to maintainer to{' '}
            <strong className="font-semibold text-fg/90">ML Engineer at Hugging Face</strong>.
          </p>
          <p className="m-0 text-balance">
            The SGLang team also generously sponsors{' '}
            <strong className="font-semibold text-fg/90">Code2Create</strong>, and all they ask is
            that you take a few seconds to star the project.
          </p>
        </div>

        <div className="mt-8 flex min-h-[96px] flex-col items-center gap-3.5">
          {state.connected && state.githubLogin ? (
            <p className="m-0 text-[13px] text-fg/55">connected as @{state.githubLogin}</p>
          ) : null}
          {displayedError ? (
            <p role="alert" className="m-0 max-w-[440px] text-[13px] leading-relaxed text-rose-light">
              {displayedError}
            </p>
          ) : null}
          {accountInUse ? (
            <PortalButton
              type="button"
              disabled={busy !== null}
              onClick={() => void disconnect()}
              className="min-w-[190px]"
            >
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect GitHub'}
            </PortalButton>
          ) : (
            <>
              <PortalButton
                type="button"
                disabled={busy !== null || state.completed}
                onClick={state.connected ? () => void star() : () => void connect()}
                className="min-w-[190px]"
              >
                {busy === 'callback'
                  ? 'Connecting…'
                  : busy === 'connect'
                    ? 'Opening GitHub…'
                    : busy === 'star'
                      ? 'Starring…'
                      : state.connected
                        ? 'Star SGLang'
                        : 'Connect GitHub'}
              </PortalButton>
              {state.connected ? (
                <PortalTextButton
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void disconnect()}
                >
                  {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect GitHub'}
                </PortalTextButton>
              ) : null}
            </>
          )}
        </div>

        <div className="mt-10 flex items-center justify-center gap-[26px] opacity-55">
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
          <a
            href="https://acmvit.in"
            target="_blank"
            rel="noreferrer"
            aria-label="ACM-VIT"
            className="inline-flex items-center transition-opacity hover:opacity-80"
          >
            <img
              src="/assets/acm-mark.svg"
              alt=""
              className="h-7 w-auto [filter:var(--mark-filter)]"
            />
          </a>
        </div>
      </div>
    </div>
  )
}
