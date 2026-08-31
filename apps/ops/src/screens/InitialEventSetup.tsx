import { api } from '@code2create/backend/api'
import { defaultVitHostelResidenceCatalog } from '@code2create/domain'
import type { Code2CreateAuthClient } from '@code2create/web-auth'
import { useMutation, useQuery } from 'convex/react'
import { useState, type FormEvent, type ReactNode } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import {
  indiaDateTimeToTimestamp,
  optionalIndiaDateTimeToTimestamp,
} from '../lib/indiaDateTime'

export function InitialEventSetup({ authClient }: { authClient: Code2CreateAuthClient }) {
  const eligibility = useQuery(api.system.bootstrapEligibility, { eventSlug })
  const bootstrap = useMutation(api.system.bootstrapEvent)
  const [eventName, setEventName] = useState('Code2Create 7.0')
  const [startsAtLocal, setStartsAtLocal] = useState('2026-09-07T14:00')
  const [endsAtLocal, setEndsAtLocal] = useState('2026-09-09T15:00')
  const [externalApplicationsCloseAtLocal, setExternalApplicationsCloseAtLocal] = useState('')
  const [vitApplicationsCloseAtLocal, setVitApplicationsCloseAtLocal] = useState('')
  const [venueName, setVenueName] = useState('Anna Auditorium, VIT Vellore')
  const [venueAddress, setVenueAddress] = useState(
    'Anna Auditorium, VIT Vellore, Vellore, Tamil Nadu 632014',
  )
  const [discordUrl, setDiscordUrl] = useState('https://discord.gg/code2create')
  const [vitEmailDomain, setVitEmailDomain] = useState('vitstudent.ac.in')
  const [privacyNoticeUrl, setPrivacyNoticeUrl] = useState('https://code2create.in/privacy')
  const [teamMinimumSize, setTeamMinimumSize] = useState('2')
  const [teamMaximumSize, setTeamMaximumSize] = useState('5')
  const [participantCapacity, setParticipantCapacity] = useState('1000')
  const [integrationPolicyVersion, setIntegrationPolicyVersion] = useState('integrations-v1')
  const [requiredGitHubTopic, setRequiredGitHubTopic] = useState('code2create-7-0')
  const [maximumGitHubRepositories, setMaximumGitHubRepositories] = useState('10')
  const [maximumFigmaFiles, setMaximumFigmaFiles] = useState('10')
  const [githubFreezeAtLocal, setGithubFreezeAtLocal] = useState('2026-09-09T15:00')
  const [figmaFreezeAtLocal, setFigmaFreezeAtLocal] = useState('2026-09-09T15:00')
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

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const startsAt = indiaDateTimeToTimestamp(startsAtLocal)
    const endsAt = indiaDateTimeToTimestamp(endsAtLocal)
    const externalApplicationsCloseAt = indiaDateTimeToTimestamp(externalApplicationsCloseAtLocal)
    const applicationsCloseAt = indiaDateTimeToTimestamp(vitApplicationsCloseAtLocal)
    if (
      startsAt === null ||
      endsAt === null ||
      externalApplicationsCloseAt === null ||
      applicationsCloseAt === null ||
      endsAt <= startsAt ||
      externalApplicationsCloseAt > applicationsCloseAt ||
      applicationsCloseAt > startsAt
    ) {
      setError('Choose a valid application deadline, event start, and event end.')
      return
    }
    const githubFreezeAt = optionalIndiaDateTimeToTimestamp(githubFreezeAtLocal)
    const figmaFreezeAt = optionalIndiaDateTimeToTimestamp(figmaFreezeAtLocal)
    if (githubFreezeAt === null || figmaFreezeAt === null) {
      setError('Choose valid GitHub and Figma freeze times, or leave them empty.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await bootstrap({
        eventSlug,
        eventName,
        timezone: 'Asia/Kolkata',
        externalApplicationsCloseAt,
        applicationsCloseAt,
        vitEmailDomains: [vitEmailDomain],
        participantPolicy: {
          label: 'Participant policy · 1',
          teamMinimumSize: Number(teamMinimumSize),
          teamMaximumSize: Number(teamMaximumSize),
          mixedParticipantClassesAllowed: false,
          vitHostelResidenceCatalog: defaultVitHostelResidenceCatalog,
          profileNotice:
            'We use these details to establish event eligibility, contact you about operations, and run Code2Create.',
          projectTextNotice:
            'Project answers may be processed by the published intake and novelty services. Do not include contact details, credentials, or other unnecessary personal information.',
          privacyNoticeUrl,
          freshProjectAttestation:
            "We will begin project-specific implementation and design after Code2Create's official start.",
          finalSubmissionWarning:
            'Submitting locks this exact team. You can edit the proposal until the application deadline.',
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
          minimumFollowUpCount: 2,
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
          version: integrationPolicyVersion,
          requiredGitHubTopic,
          maxActiveGitHubRepositoriesPerTeam: Number(maximumGitHubRepositories),
          maxActiveFigmaFilesPerTeam: Number(maximumFigmaFiles),
          ...(githubFreezeAt !== undefined ? { githubFreezeAt } : {}),
          ...(figmaFreezeAt !== undefined ? { figmaFreezeAt } : {}),
        },
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
                <span>External applications close · India time</span>
                <input required type="datetime-local" value={externalApplicationsCloseAtLocal} onChange={(event) => setExternalApplicationsCloseAtLocal(event.currentTarget.value)} />
              </label>
              <label className="field">
                <span>VIT applications close · India time</span>
                <input required type="datetime-local" value={vitApplicationsCloseAtLocal} onChange={(event) => setVitApplicationsCloseAtLocal(event.currentTarget.value)} />
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
                <input required type="number" min="1" max={participantCapacity} value={teamMinimumSize} onChange={(event) => setTeamMinimumSize(event.currentTarget.value)} />
              </label>
              <label className="field">
                <span>Largest team</span>
                <input required type="number" min="1" max={participantCapacity} value={teamMaximumSize} onChange={(event) => setTeamMaximumSize(event.currentTarget.value)} />
              </label>
              <label className="field span-two">
                <span>Participant places</span>
                <input required type="number" min="4" max="5000" value={participantCapacity} onChange={(event) => setParticipantCapacity(event.currentTarget.value)} />
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend>Code and design evidence</legend>
            <p className="muted">
              These values are published with the event and can be changed later through Event setup.
            </p>
            <div className="form-grid four-columns">
              <label className="field span-two">
                <span>Policy release</span>
                <input required minLength={1} maxLength={80} value={integrationPolicyVersion} onChange={(event) => setIntegrationPolicyVersion(event.currentTarget.value)} />
              </label>
              <label className="field span-two">
                <span>Required GitHub topic</span>
                <input required maxLength={50} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={requiredGitHubTopic} onChange={(event) => setRequiredGitHubTopic(event.currentTarget.value)} />
              </label>
              <label className="field">
                <span>GitHub repositories per team</span>
                <input required type="number" min="1" max="20" step="1" value={maximumGitHubRepositories} onChange={(event) => setMaximumGitHubRepositories(event.currentTarget.value)} />
              </label>
              <label className="field">
                <span>Figma files per team</span>
                <input required type="number" min="1" max="10" step="1" value={maximumFigmaFiles} onChange={(event) => setMaximumFigmaFiles(event.currentTarget.value)} />
              </label>
              <label className="field">
                <span>GitHub freeze · India time</span>
                <input type="datetime-local" value={githubFreezeAtLocal} onChange={(event) => setGithubFreezeAtLocal(event.currentTarget.value)} />
              </label>
              <label className="field">
                <span>Figma freeze · India time</span>
                <input type="datetime-local" value={figmaFreezeAtLocal} onChange={(event) => setFigmaFreezeAtLocal(event.currentTarget.value)} />
              </label>
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

function CenteredStatus({ children }: { children: ReactNode }) {
  return <main className="centered"><p className="muted" role="status">{children}</p></main>
}
