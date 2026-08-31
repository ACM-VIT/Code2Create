import { useState } from 'react'
import { signInWithGooglePopup, type Code2CreateAuthClient } from '@code2create/web-auth'
import {
  restrictGoogleAuthorizationToVitStudents,
  vitStudentEmailDomain,
} from '../lib/googleAuthorization'
import { PortalScene } from '../components/portal/PortalScene'
import { PortalButton } from '../components/portal/PortalButton'
import { PortalError } from '../components/portal/PortalField'
import type { ParticipantClass, PublicState } from '../types'

export const participantClassStorageKey = 'code2create.participant-class'

function popupErrorMessage(code: string | undefined) {
  if (code === 'POPUP_BLOCKED') return 'Allow pop-ups for this site, then try again.'
  if (code === 'POPUP_CLOSED') return 'Google sign-in was closed before it finished.'
  if (code === 'POPUP_TIMEOUT') return 'Google sign-in took too long. Try again.'
  return 'Google sign-in could not start. Try again.'
}

function ClassCard({
  title,
  detail,
  selected,
  disabled,
  onSelect,
}: {
  title: string
  detail: string
  selected: boolean
  disabled: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onSelect}
      className={`w-full rounded-petal-sm px-6 py-5 text-left backdrop-blur-md transition-all duration-250 hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-45 sm:w-[250px] ${
        selected
          ? 'border-[1.5px] border-ring-lead bg-[image:var(--tile-bg-active)] shadow-[0_24px_50px_-18px_var(--shade-2),0_0_26px_var(--glow-rose-soft)]'
          : 'border border-petal-edge-soft bg-[image:var(--tile-bg)] shadow-[0_24px_50px_-18px_var(--shade-2)] hover:border-ring-lead/70'
      }`}
    >
      <p
        className={`mb-1 font-display font-light tracking-[-.01em] text-[19px] ${
          selected ? 'text-rose-light' : 'text-fg/85'
        }`}
      >
        {title}
      </p>
      <p className="text-xs text-fg/55">{detail}</p>
    </button>
  )
}

export function EntryScreen({
  publicState,
  authClient,
}: {
  publicState: PublicState
  authClient: Code2CreateAuthClient
}) {
  const [participantClass, setParticipantClass] = useState<ParticipantClass | null>(() => {
    const stored = sessionStorage.getItem(participantClassStorageKey)
    return stored === 'vit_student' || stored === 'external_participant' ? stored : null
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Before the event is published there is nothing to sign into — tease,
  // don't explain.
  if (!publicState.event) {
    return (
      <PortalScene tree="both" logo="none">
        <a
          href="https://acmvit.in"
          target="_blank"
          rel="noreferrer"
          className="absolute top-7 left-6 z-[6] opacity-85 transition-opacity hover:opacity-100 lg:top-9 lg:left-11"
        >
          <img
            src="/assets/acm-mark.svg"
            alt="ACM-VIT"
            className="size-8 [filter:var(--mark-filter)] lg:size-9"
          />
        </a>
        <div className="flex w-full max-w-[640px] flex-col items-center text-center">
          <img
            src="/assets/logo.svg"
            alt=""
            className="mb-3.5 w-11 drop-shadow-[0_0_20px_var(--logo-glow)] lg:mb-[18px] lg:w-[52px]"
          />
          <h1 className="mb-8 flex justify-center lg:mb-10">
            <img
              src="/assets/wordmark.svg"
              alt="Code2Create"
              className="h-9 w-auto [filter:var(--wordmark-filter)] sm:h-12 lg:h-[68px]"
            />
          </h1>
          <p className="mb-2 font-display font-light tracking-[-.01em] text-[26px] text-rose-light lg:text-[32px]">
            it’s cooking.
          </p>
          <p className="text-[13px] text-fg/50">come back in a little while</p>
        </div>
      </PortalScene>
    )
  }

  const vitOpen = publicState.event.registrationOpen && publicState.serverNow < publicState.event.applicationsCloseAt
  const externalOpen = publicState.event.registrationOpen && publicState.serverNow < publicState.event.externalApplicationsCloseAt
  const selectedClassOpen = participantClass === 'vit_student' ? vitOpen : externalOpen

  const choose = (value: ParticipantClass) => {
    sessionStorage.setItem(participantClassStorageKey, value)
    setParticipantClass(value)
    setError(null)
  }

  const signIn = async () => {
    if (!participantClass || !publicState.auth.googleConfigured) return
    setBusy(true)
    setError(null)
    try {
      const result = await signInWithGooglePopup(
        authClient,
        window.location.href,
        participantClass === 'vit_student'
          ? restrictGoogleAuthorizationToVitStudents
          : undefined,
      )
      if (result.error) setError(popupErrorMessage(result.error.code))
    } catch {
      setError(popupErrorMessage(undefined))
    } finally {
      setBusy(false)
    }
  }

  return (
    <PortalScene tree="both" logo="none">
      {/* The organising club's mark, top-left — the portal's only ACM branding. */}
      <a
        href="https://acmvit.in"
        target="_blank"
        rel="noreferrer"
        className="absolute top-7 left-6 z-[6] opacity-85 transition-opacity hover:opacity-100 lg:top-9 lg:left-11"
      >
        <img
          src="/assets/acm-mark.svg"
          alt="ACM-VIT"
          className="size-8 [filter:var(--mark-filter)] lg:size-9"
        />
      </a>
      <div className="flex w-full max-w-[640px] flex-col items-center text-center">
        <img
          src="/assets/logo.svg"
          alt="Code2Create"
          className="mb-3.5 w-11 drop-shadow-[0_0_20px_var(--logo-glow)] lg:mb-[18px] lg:w-[52px]"
        />
        {/* The landing page's lettered wordmark. */}
        <h1 className="mb-8 flex justify-center lg:mb-10">
          <img
            src="/assets/wordmark.svg"
            alt={publicState.event.name}
            className="h-9 w-auto [filter:var(--wordmark-filter)] sm:h-12 lg:h-[68px]"
          />
        </h1>

        <div
          className="mb-7 flex w-full flex-col gap-3 sm:flex-row sm:justify-center sm:gap-4"
          role="group"
          aria-label="Participant type"
          >
            <ClassCard
              title="VIT student"
              detail={`only @${vitStudentEmailDomain} Google accounts are accepted`}
              disabled={!vitOpen}
              selected={participantClass === 'vit_student'}
            onSelect={() => choose('vit_student')}
          />
            <ClassCard
              title="external participant"
              detail={externalOpen ? 'use your regular Google account' : 'applications have closed'}
              disabled={!externalOpen}
              selected={participantClass === 'external_participant'}
            onSelect={() => choose('external_participant')}
          />
        </div>

        <PortalButton
          type="button"
          disabled={!participantClass || !selectedClassOpen || busy || !publicState.auth.googleConfigured}
          onClick={signIn}
          className="w-full sm:w-auto"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
            <path
              d="M21.6 12.2c0-.7-.06-1.4-.18-2H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.4z"
              fill="currentColor"
            />
            <path
              d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z"
              fill="currentColor"
              opacity=".75"
            />
            <path d="M6.4 14a6 6 0 0 1 0-3.9V7.5H3.1a10 10 0 0 0 0 9z" fill="currentColor" opacity=".55" />
            <path
              d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 0 0 3.1 7.5l3.3 2.6c.8-2.4 3-4.2 5.6-4.2z"
              fill="currentColor"
              opacity=".9"
            />
          </svg>
          {busy ? 'Opening Google…' : 'Continue with Google'}
        </PortalButton>

        {!publicState.auth.googleConfigured ? (
          <p className="mt-4 text-[11.5px] text-rose-light">
            Google sign-in is unavailable right now. Ask an organizer for help.
          </p>
        ) : null}
        <PortalError message={error} />
      </div>
    </PortalScene>
  )
}
