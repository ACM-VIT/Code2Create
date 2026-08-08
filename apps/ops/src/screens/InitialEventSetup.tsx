import { api } from '@code2create/backend/api'
import type { Code2CreateAuthClient } from '@code2create/web-auth'
import { useMutation, useQuery } from 'convex/react'
import { useState, type FormEvent, type ReactNode } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type TrackDraft = {
  name: string
  description: string
}

type CoreTrack = {
  stableKey: string
  slug: string
  displayName: string
  description: string
  examples: string[]
  displayOrder: number
  type: 'core'
}

const initialTracks: readonly TrackDraft[] = [
  {
    name: 'Open innovation',
    description: 'Useful technology for everyday problems and overlooked opportunities.',
  },
  {
    name: 'Health and wellbeing',
    description: 'Thoughtful technology for physical, mental, or community wellbeing.',
  },
  {
    name: 'Future of learning',
    description: 'New ways for people to learn, teach, practise, and collaborate.',
  },
  {
    name: 'Sustainable systems',
    description: 'More resilient places, services, and ways to use resources.',
  },
  {
    name: 'AI for people',
    description: 'Responsible intelligence that extends human capability and access.',
  },
]

export function InitialEventSetup({ authClient }: { authClient: Code2CreateAuthClient }) {
  const eligibility = useQuery(api.system.bootstrapEligibility, { eventSlug })
  const bootstrap = useMutation(api.system.bootstrapEvent)
  const [eventName, setEventName] = useState('Code2Create 7.0')
  const [startsAtLocal, setStartsAtLocal] = useState('')
  const [endsAtLocal, setEndsAtLocal] = useState('')
  const [venueName, setVenueName] = useState('VIT Chennai')
  const [venueAddress, setVenueAddress] = useState('')
  const [discordUrl, setDiscordUrl] = useState('')
  const [vitEmailDomain, setVitEmailDomain] = useState('vitstudent.ac.in')
  const [privacyNoticeUrl, setPrivacyNoticeUrl] = useState('https://code2create.in/privacy')
  const [teamMinimumSize, setTeamMinimumSize] = useState('1')
  const [teamMaximumSize, setTeamMaximumSize] = useState('4')
  const [participantCapacity, setParticipantCapacity] = useState('1000')
  const [tracks, setTracks] = useState<TrackDraft[]>(() => initialTracks.map((track) => ({ ...track })))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (eligibility === undefined) {
    return <CenteredStatus>Checking event ownership…</CenteredStatus>
  }
  if (eligibility.eventExists) {
    return <CenteredStatus>Opening operations…</CenteredStatus>
  }
  if (!eligibility.allowed) {
    return (
      <main className="centered">
        <section className="sign-in">
          <h1>This account cannot create the event</h1>
          <p className="muted">
            {eligibility.email} is not the Google account selected for initial event setup.
          </p>
          <button className="text-button" type="button" onClick={() => void authClient.signOut()}>
            Use another Google account
          </button>
        </section>
      </main>
    )
  }

  const updateTrack = (index: number, key: keyof TrackDraft, value: string) => {
    setTracks((current) => current.map((track, trackIndex) => (
      trackIndex === index ? { ...track, [key]: value } : track
    )))
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const startsAt = indiaDateTimeToTimestamp(startsAtLocal)
    const endsAt = indiaDateTimeToTimestamp(endsAtLocal)
    if (startsAt === null || endsAt === null || endsAt <= startsAt) {
      setError('Choose a valid event start and end time.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await bootstrap({
        eventSlug,
        eventName,
        timezone: 'Asia/Kolkata',
        vitEmailDomains: [vitEmailDomain],
        participantPolicy: {
          label: 'Participant policy · 1',
          teamMinimumSize: Number(teamMinimumSize),
          teamMaximumSize: Number(teamMaximumSize),
          mixedParticipantClassesAllowed: true,
          phoneField: 'optional',
          vitRegistrationNumberField: 'required',
          vitProgrammeField: 'required',
          vitCampusField: 'required',
          externalCityField: 'optional',
          externalCountryField: 'required',
          profileNotice:
            'We use these details to establish event eligibility, contact you about operations, and run Code2Create.',
          projectTextNotice:
            'Project answers may be processed by the published intake and novelty services. Do not include contact details, credentials, or other unnecessary personal information.',
          privacyNoticeUrl,
          freshProjectAttestation:
            "We will begin project-specific implementation and design after Code2Create's official start.",
          finalSubmissionWarning:
            'Submitting locks this exact team, core track, and selected sponsor tracks. Review every item before you continue.',
        },
        admissionPolicyVersion: 'admission-v1',
        admissionParticipantCapacity: Number(participantCapacity),
        admissionMinimumHumanReviews: 2,
        intakePolicy: {
          openingText: 'Hello.',
          initialPrompt: 'What is your project about?',
          initialHelpText: 'A rough description is enough. Tell us what it does and who it helps.',
          initialIdeaMinLength: 20,
          initialIdeaMaxLength: 4_000,
          followUpAnswerMinLength: 5,
          followUpAnswerMaxLength: 1_200,
          minimumFollowUpCount: 1,
          maximumFollowUpCount: 2,
          deterministicFollowUpCount: 2,
          questionMaxLength: 140,
          allowedPurposeKeys: [
            'user',
            'problem',
            'experience',
            'event_goal',
            'tradeoff',
            'risk',
            'track_fit',
          ],
          fallbackQuestions: [
            {
              ordinal: 1,
              text: 'Who would use this first?',
              purposeKey: 'user',
              answerLength: 'short',
            },
            {
              ordinal: 2,
              text: 'What would you most like to finish during Code2Create?',
              purposeKey: 'event_goal',
              answerLength: 'medium',
            },
          ],
          blockedTerms: [
            'unoriginal',
            'overdone',
            'bad idea',
            'reject',
            'decline',
            'score',
            'judging',
            'winner',
            'why should you win',
          ],
          commonIdeaPatterns: [
            {
              stableKey: 'civic_issue_reporting',
              description: 'A tool for reporting potholes, waste, damage, or another civic issue.',
              supportiveQuestionGuidance:
                'Ask what useful action or feedback should happen after someone submits a report.',
            },
          ],
          model: { mode: 'deterministic' },
        },
        communicationsPolicy: {
          venueName,
          venueAddress,
          startsAt,
          endsAt,
          nextSteps: [
            {
              stableKey: 'join_discord',
              title: 'Join Discord',
              detail: 'Use the event server for announcements and participant support.',
              actionUrl: discordUrl,
            },
          ],
          discordUrl,
          discordLabel: 'Open event Discord',
          notificationProvider: 'cloudflare_email',
          notificationSubject: 'Code2Create event update',
          notificationIntro: 'There is a new Code2Create event update in your portal.',
        },
        integrationPolicy: {
          version: 'integrations-v1',
          requiredGitHubTopic: 'code2create-7',
          maxActiveGitHubRepositoriesPerTeam: 10,
          maxActiveFigmaFilesPerTeam: 10,
        },
        tracks: tracks.map(toCoreTrack),
      })
    } catch (caught) {
      setError(readableError(caught))
      setBusy(false)
    }
  }

  return (
    <main className="first-event-setup-page">
      <section className="first-event-setup">
        <header>
          <h1>Create the event</h1>
          <p className="muted">Applications stay closed until you open them from Event setup.</p>
        </header>

        <form onSubmit={(event) => void submit(event)}>
          <fieldset>
            <legend>Event</legend>
            <div className="form-grid two-columns">
              <label className="field span-two">
                <span>Name</span>
                <input required minLength={3} maxLength={80} value={eventName} onChange={(event) => setEventName(event.currentTarget.value)} />
              </label>
              <label className="field">
                <span>Starts · India time</span>
                <input required type="datetime-local" value={startsAtLocal} onChange={(event) => setStartsAtLocal(event.currentTarget.value)} />
              </label>
              <label className="field">
                <span>Ends · India time</span>
                <input required type="datetime-local" value={endsAtLocal} onChange={(event) => setEndsAtLocal(event.currentTarget.value)} />
              </label>
              <label className="field">
                <span>Venue</span>
                <input required minLength={2} maxLength={120} value={venueName} onChange={(event) => setVenueName(event.currentTarget.value)} />
              </label>
              <label className="field">
                <span>Address</span>
                <input required minLength={3} maxLength={300} value={venueAddress} onChange={(event) => setVenueAddress(event.currentTarget.value)} />
              </label>
              <label className="field">
                <span>Discord invite</span>
                <input required type="url" placeholder="https://discord.gg/…" value={discordUrl} onChange={(event) => setDiscordUrl(event.currentTarget.value)} />
              </label>
              <label className="field">
                <span>Privacy notice</span>
                <input required type="url" value={privacyNoticeUrl} onChange={(event) => setPrivacyNoticeUrl(event.currentTarget.value)} />
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend>Participants</legend>
            <div className="form-grid four-columns">
              <label className="field span-two">
                <span>VIT email domain</span>
                <input required minLength={3} maxLength={120} value={vitEmailDomain} onChange={(event) => setVitEmailDomain(event.currentTarget.value)} />
              </label>
              <label className="field">
                <span>Smallest team</span>
                <input required type="number" min="1" max="12" value={teamMinimumSize} onChange={(event) => setTeamMinimumSize(event.currentTarget.value)} />
              </label>
              <label className="field">
                <span>Largest team</span>
                <input required type="number" min="1" max="12" value={teamMaximumSize} onChange={(event) => setTeamMaximumSize(event.currentTarget.value)} />
              </label>
              <label className="field span-two">
                <span>Participant places</span>
                <input required type="number" min="4" max="5000" value={participantCapacity} onChange={(event) => setParticipantCapacity(event.currentTarget.value)} />
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend>Five starting tracks</legend>
            <div className="bootstrap-tracks">
              {tracks.map((track, index) => (
                <div className="bootstrap-track" key={index}>
                  <label className="field">
                    <span>Track {index + 1}</span>
                    <input required minLength={2} maxLength={80} value={track.name} onChange={(event) => updateTrack(index, 'name', event.currentTarget.value)} />
                  </label>
                  <label className="field">
                    <span>Description</span>
                    <textarea required minLength={10} maxLength={500} value={track.description} onChange={(event) => updateTrack(index, 'description', event.currentTarget.value)} />
                  </label>
                </div>
              ))}
            </div>
          </fieldset>

          {error ? <p className="notice error" role="alert">{error}</p> : null}
          <div className="button-row">
            <button className="primary" type="submit" disabled={busy}>
              {busy ? 'Creating event…' : 'Create event'}
            </button>
            <button className="text-button" type="button" disabled={busy} onClick={() => void authClient.signOut()}>
              Use another account
            </button>
          </div>
        </form>
      </section>
    </main>
  )
}

function toCoreTrack(track: TrackDraft, index: number): CoreTrack {
  const slugPart = track.name
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 45)
  return {
    stableKey: `core_track_${index + 1}`,
    slug: `track-${index + 1}-${slugPart || 'core'}`,
    displayName: track.name,
    description: track.description,
    examples: [track.name],
    displayOrder: index,
    type: 'core',
  }
}

function indiaDateTimeToTimestamp(value: string) {
  const timestamp = Date.parse(`${value}:00+05:30`)
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null
}

function CenteredStatus({ children }: { children: ReactNode }) {
  return <main className="centered"><p className="muted" role="status">{children}</p></main>
}
