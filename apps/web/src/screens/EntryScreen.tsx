import { useState } from 'react'
import type { Code2CreateAuthClient } from '@code2create/web-auth'
import { PortalScene } from '../components/portal/PortalScene'
import { PortalButton } from '../components/portal/PortalButton'
import { PortalError } from '../components/portal/PortalField'
import type { ParticipantClass, PublicState } from '../types'

/**
 * The mockup renders the edition ("7.0") in rose italic beside the name. The
 * event name already carries it, so split the trailing version off instead of
 * appending one.
 */
function splitEventTitle(name: string): { name: string; edition: string | null } {
  const match = /^(.*?)\s+(v?\d+(?:\.\d+)*)$/.exec(name.trim())
  if (!match?.[1] || !match[2]) return { name: name.trim(), edition: null }
  return { name: match[1], edition: match[2] }
}

export const participantClassStorageKey = 'code2create.participant-class'

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
          ? 'border-[1.5px] border-rose-light bg-[linear-gradient(155deg,rgba(255,255,255,.1),rgba(12,0,4,.55)_60%)] shadow-[0_24px_50px_-18px_rgba(0,0,0,.8),0_0_26px_rgba(216,132,162,.25)]'
          : 'border border-petal-edge-soft bg-[linear-gradient(155deg,rgba(255,255,255,.06),rgba(12,0,4,.48)_60%)] shadow-[0_24px_50px_-18px_rgba(0,0,0,.8)] hover:border-[rgb(254_180_203/.6)]'
      }`}
    >
      <p
        className={`mb-1 font-display text-[19px] ${
          selected ? 'text-rose-light' : 'text-[rgb(248_248_248/.85)]'
        }`}
      >
        {title}
      </p>
      <p className="text-xs text-[rgb(248_248_248/.55)]">{detail}</p>
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

  if (!publicState.event) {
    return (
      <PortalScene tree="both">
        <div className="text-center">
          <p className="mb-2 font-display text-[19px] italic text-rose-light">Code2Create</p>
          <h1 className="mb-4 font-display text-5xl leading-none">Event setup is not complete</h1>
          <p className="text-[13px] text-[rgb(248_248_248/.5)]">
            An organizer with event setup access needs to finish setup.
          </p>
        </div>
      </PortalScene>
    )
  }

  const eventTitle = splitEventTitle(publicState.event.name)
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
      const result = await authClient.signIn.social({
        provider: 'google',
        callbackURL: window.location.href,
      })
      if (result.error) setError('Google sign-in could not start. Try again.')
    } catch {
      setError('Google sign-in could not start. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <PortalScene tree="both" logo="none">
      <div className="flex w-full max-w-[640px] flex-col items-center text-center">
        <img
          src="/assets/logo.svg"
          alt="Code2Create"
          className="mb-3.5 w-11 drop-shadow-[0_0_20px_rgba(216,132,162,.55)] lg:mb-[18px] lg:w-[52px]"
        />
        <p className="mb-2 font-display text-[15px] italic text-rose-light lg:text-[19px]">
          welcome to
        </p>
        <h1 className="mb-8 font-display text-[40px] leading-none text-shadow-[0_8px_50px_rgba(0,0,0,.6)] lg:mb-10 lg:text-[76px]">
          {eventTitle.name}
          {eventTitle.edition ? (
            <> <span className="italic text-rose-light">{eventTitle.edition}</span></>
          ) : null}
        </h1>

        <div
          className="mb-7 flex w-full flex-col gap-3 sm:flex-row sm:justify-center sm:gap-4"
          role="group"
          aria-label="Participant type"
        >
          <ClassCard
            title="VIT student"
            detail="on-campus, with a VIT ID card"
            disabled={!vitOpen}
            selected={participantClass === 'vit_student'}
            onSelect={() => choose('vit_student')}
          />
          <ClassCard
            title="external participant"
            detail={externalOpen ? 'visiting from another campus' : 'applications have closed'}
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
        <p className="mt-4 text-[11.5px] text-[rgb(248_248_248/.4)]">
          the server verifies your account class · nothing else to type yet
        </p>
      </div>
    </PortalScene>
  )
}
