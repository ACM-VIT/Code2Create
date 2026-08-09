import { api } from '@code2create/backend/api'
import {
  reviewRoundStatusLabels,
  reviewSessionStatusLabels,
  teamRoundStateOperatorLabels,
} from '@code2create/domain'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useRef, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'

import { Icon } from '../components/Icon'
import { ReviewManualRecovery } from '../components/ReviewManualRecovery'
import { LoadingLabel, SkeletonCard, SkeletonList, SkeletonStats } from '../components/Skeleton'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'

type Board = FunctionReturnType<typeof api.reviewOperations.roundBoard>
type Team = Board['teams'][number]
type Panel = Board['panels'][number]
type Substitutions = FunctionReturnType<typeof api.reviewSubstitutions.roundStatus>
type SubstitutionPanel = Substitutions['panels'][number]
type SubstituteMember = SubstitutionPanel['activeMembers'][number]
type Reserve = Substitutions['reserves'][number]
type ActiveIncident = FunctionReturnType<typeof api.incidents.active>[number]
type Command = 'queue' | 'call' | 'start' | 'complete'
type Attempt = {
  command: Command
  expectedVersion: number
  requestKey: string
  clientOperationId: string
}

export function ReviewRoundBoard() {
  const { roundId } = useParams<{ roundId: string }>()
  const overview = useQuery(api.reviewOperations.overview, { eventSlug })
  const visibleRound = overview?.rounds.find((round) => round.id === roundId)
  const board = useQuery(
    api.reviewOperations.roundBoard,
    visibleRound ? { eventSlug, roundId: visibleRound.id } : 'skip',
  )
  const substitutions = useQuery(
    api.reviewSubstitutions.roundStatus,
    visibleRound ? { eventSlug, roundId: visibleRound.id } : 'skip',
  )
  const incidents = useQuery(
    api.incidents.active,
    visibleRound ? { eventSlug } : 'skip',
  )

  if (!roundId) return <p className="notice error">Round ID is missing.</p>
  if (
    overview === undefined ||
    (visibleRound && (board === undefined || substitutions === undefined || incidents === undefined))
  ) {
    return (
      <section className="review-shell">
        <LoadingLabel>Loading the round board</LoadingLabel>
        <SkeletonStats columns={6} />
        <SkeletonCard lines={4} />
        <SkeletonList rows={4} />
      </section>
    )
  }
  if (!visibleRound) {
    return <p className="notice error">This round is not visible to your permission scope.</p>
  }
  if (!board || !substitutions || !incidents) return <p className="muted">Loading round board…</p>

  const reviewIncidents = incidents.filter(
    (incident) => incident.affectedService === 'review_backend',
  )

  return (
    <section className="review-shell">
      <Link className="back-link" to="/reviews">← Reviews</Link>
      <header className="page-heading">
        <div>
          <p className="eyebrow">{reviewRoundStatusLabels[board.round.status]}</p>
          <h1>{board.round.name}</h1>
          <p className="muted">Panels, queues, and active reviews stay in sync here.</p>
        </div>
        <span className="state-label">{formatWindow(board.round.startsAt, board.round.endsAt)}</span>
      </header>

      <dl className="catalog-summary">
        <div><dt>Waiting for the desk</dt><dd>{countTeams(board, 'unassigned')}</dd></div>
        <div><dt>Queued</dt><dd>{countTeams(board, 'queued')}</dd></div>
        <div><dt>Called</dt><dd>{countTeams(board, 'called')}</dd></div>
        <div><dt>In review</dt><dd>{countTeams(board, 'in_review')}</dd></div>
        <div><dt>Complete</dt><dd>{countTeams(board, 'completed')}</dd></div>
        <div><dt>Held</dt><dd>{countTeams(board, 'held')}</dd></div>
      </dl>

      <RoundPauseControl
        key={`${board.round.version}:${board.round.pause?.version ?? 0}`}
        incidents={reviewIncidents}
        round={board.round}
      />

      <p className="board-section-label">Panels</p>
      <div className="panel-list">
        {[...board.panels].sort(byPanelUrgency).map((panel) => (
          <PanelRow
            board={board}
            key={panel.id}
            panel={panel}
            substitutions={substitutions}
          />
        ))}
      </div>

      {substitutions.reserves.length > 0 ? (
        <section className="setup-section reserve-status-block">
          <h2>Reserve reviewers</h2>
          <div className="published-rounds">
            {substitutions.reserves.map((reserve) => (
              <div key={reserve.reserveId}>
                <strong>{reserve.displayName}</strong>
                <span>{stateName(reserve.status)} · {stateName(reserve.clockInStatus)} · {reserve.pageCount} pages</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="review-team-list">
        {[...board.teams].sort(byDeskUrgency).map((team) => (
          <TeamRow board={board} key={team.stateId ?? team.teamId} team={team} />
        ))}
      </div>
      {board.teams.length === 0 ? (
        <p className="empty">No team is eligible for this round yet.</p>
      ) : null}

      <details className="board-recovery">
        <summary>If the system goes down: paper recovery</summary>
        <ReviewManualRecovery roundId={board.round.id} />
      </details>
    </section>
  )
}

/** Order the desk works in: things it must act on, then live, then done. */
const deskOrder: Record<Team['state'], number> = {
  unassigned: 0,
  called: 1,
  held: 2,
  missed: 3,
  queued: 4,
  at_table: 5,
  in_review: 6,
  completed: 7,
  withdrawn: 8,
}

function byDeskUrgency(left: Team, right: Team) {
  return (
    deskOrder[left.state] - deskOrder[right.state] ||
    left.teamName.localeCompare(right.teamName)
  )
}

/** Panels missing people come first; a full panel needs nothing from you. */
function panelShortfall(panel: Panel) {
  return (
    panel.reviewers.length -
    panel.reviewers.filter((reviewer) => reviewer.clockInStatus === 'present').length
  )
}

function byPanelUrgency(left: Panel, right: Panel) {
  return (
    panelShortfall(right) - panelShortfall(left) ||
    left.name.localeCompare(right.name)
  )
}

function countTeams(board: Board, state: Team['state']) {
  return board.teams.filter((team) => team.state === state).length
}

/**
 * One panel, closed to a single line until you ask for it.
 *
 * The board listed every reviewer of every panel at once, so four panels filled
 * the screen before the desk queue below them was visible. Closed, a row answers
 * "can this table review?"; opened, it answers everything else about that table.
 */
function PanelRow({
  board,
  panel,
  substitutions,
}: {
  board: Board
  panel: Panel
  substitutions: Substitutions
}) {
  const [open, setOpen] = useState(false)
  const substitutionPanel = substitutions.panels.find(
    (candidate) => candidate.panelId === panel.id,
  )
  const short = panelShortfall(panel)
  const teams = board.teams.filter((team) => team.panelId === panel.id)
  const waiting = teams.filter(
    (team) => team.state === 'queued' || team.state === 'called' || team.state === 'at_table',
  )
  const live = teams.filter((team) => team.state === 'in_review')
  const done = teams.filter((team) => team.state === 'completed')

  return (
    <article className={`panel-row ${short > 0 ? 'short' : 'ready'} ${open ? 'open' : ''}`}>
      <button
        aria-expanded={open}
        className="panel-row-summary"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <span className={`row-glyph ${short > 0 ? 'attention' : 'watch'}`}>
          <Icon name={short > 0 ? 'alert' : 'seat'} />
        </span>
        <span className="panel-row-text">
          <strong>
            {panel.name}
            {live[0] ? <span className="row-context"> · at {live[0].teamName}</span> : null}
          </strong>
          <small>
            {panelSummary({
              short,
              total: panel.reviewers.length,
              waiting: waiting.length,
              reviewing: live[0]?.teamName,
            })}
          </small>
        </span>
        <span className="panel-row-chevron" aria-hidden="true">{open ? '⌄' : '›'}</span>
      </button>

      {open ? (
        <div className="panel-detail">
          <div className="panel-detail-block">
            <p className="board-section-label">Reviewers</p>
            <ul className="panel-reviewers">
              {panel.reviewers.map((reviewer) => (
                <li className={reviewer.clockInStatus === 'present' ? '' : 'away'} key={reviewer.personId}>
                  <span>
                    {reviewer.displayName}
                    {reviewer.isCoordinator ? ' · runs this panel' : ''}
                  </span>
                  {/* A reviewer who is at the table needs no commentary; a
                      stale heartbeat is already a system check. */}
                  {reviewer.clockInStatus === 'present' ? null : (
                    <small>{reviewerState(reviewer, board.serverNow)}</small>
                  )}
                  {reviewer.clockInStatus !== 'present' && substitutionPanel ? (
                    <ReviewerNoShow
                      member={substitutionPanel.activeMembers.find(
                        (member) => member.personId === reviewer.personId,
                      )}
                      panelVersion={substitutionPanel.panelVersion}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          </div>

          <div className="panel-detail-block">
            <p className="board-section-label">Teams routed to this panel</p>
            {teams.length === 0 ? (
              <p className="muted">Nothing routed here yet.</p>
            ) : (
              <ul className="panel-team-list">
                {[...live, ...waiting, ...done].map((team) => (
                  <li key={team.stateId ?? team.teamId}>
                    <span>{team.teamName}</span>
                    <small>{teamRoundStateOperatorLabels[team.state]}</small>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="panel-row-actions">
            {substitutionPanel ? (
              <SubstitutionControl panel={substitutionPanel} serverNow={substitutions.serverNow} />
            ) : null}
            {substitutionPanel ? (
              <PanelMembership
                key={substitutionPanel.panelVersion}
                panel={substitutionPanel}
                reserves={substitutions.reserves}
              />
            ) : null}
            {panel.canPause ? <PanelAvailability panel={panel} /> : null}
          </div>
        </div>
      ) : null}
    </article>
  )
}

/**
 * The one line a closed panel gets: can it review, and what is it doing.
 *
 * A panel is people, not a place. It walks to whichever team's table it is
 * reviewing, so its location is the team it is with, never a table of its own.
 */
function panelSummary(counts: {
  short: number
  total: number
  waiting: number
  reviewing: string | undefined
}) {
  if (counts.short > 0) {
    const seats = counts.short === 1 ? 'One reviewer is missing' : `${counts.short} reviewers are missing`
    return `${seats}. This panel cannot start a review.`
  }
  if (counts.reviewing) {
    return `All ${counts.total} reviewers present. Reviewing now.`
  }
  if (counts.waiting > 0) {
    return `All ${counts.total} reviewers present. ${counts.waiting} ${counts.waiting === 1 ? 'team is' : 'teams are'} waiting for it.`
  }
  return `All ${counts.total} reviewers present. Nothing waiting.`
}

function RoundPauseControl({ round, incidents }: { round: Board['round']; incidents: ActiveIncident[] }) {
  const pauseRound = useMutation(api.reviewRoundPauses.pause)
  const resumeRound = useMutation(api.reviewRoundPauses.resume)
  const [mode, setMode] = useState<'pause' | 'resume' | null>(null)
  const [incidentId, setIncidentId] = useState(incidents[0]?.id ?? '')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)
  const expectedRoundVersionRef = useRef(round.version)
  const expectedPauseVersionRef = useRef(round.pause?.version)

  const changed = () => {
    operationRef.current = null
    setError(null)
  }

  const open = (nextMode: 'pause' | 'resume') => {
    expectedRoundVersionRef.current = round.version
    expectedPauseVersionRef.current = round.pause?.version
    operationRef.current = null
    setMode(nextMode)
    setReason('')
    setError(null)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || reason.trim().length < 5) return
    const clientOperationId = operationRef.current ?? crypto.randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      if (mode === 'pause') {
        const incident = incidents.find((candidate) => candidate.id === incidentId)
        if (!incident) {
          setError('Choose an active review incident.')
          return
        }
        await pauseRound({
          eventSlug,
          roundId: round.id,
          incidentId: incident.id,
          expectedRoundVersion: expectedRoundVersionRef.current,
          reason,
          clientOperationId,
        })
      } else if (mode === 'resume' && round.pause && expectedPauseVersionRef.current !== undefined) {
        await resumeRound({
          eventSlug,
          pauseId: round.pause.id,
          expectedPauseVersion: expectedPauseVersionRef.current,
          expectedRoundVersion: expectedRoundVersionRef.current,
          reason,
          clientOperationId,
        })
      }
      operationRef.current = null
      setMode(null)
      setReason('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  if (round.pause) {
    return (
      <section className="round-pause" aria-live="polite">
        <div>
          <strong>New review calls and starts are paused.</strong>
          <span>
            {round.pause.incidentTitle ?? 'An active review incident'}
            {round.pause.reason ? ` · ${round.pause.reason}` : ''}
          </span>
          <small>Reviews already underway can still save and finish.</small>
        </div>
        {round.pause.canResume && mode !== 'resume' ? (
          <button className="secondary" type="button" onClick={() => open('resume')}>Resume new reviews</button>
        ) : null}
        {round.pause.canResume && mode === 'resume' ? (
          <form className="round-pause-form" onSubmit={submit}>
            <label className="field">
              <span>Why it is safe to resume</span>
              <textarea required minLength={5} value={reason} onChange={(event) => { changed(); setReason(event.target.value) }} />
            </label>
            <div className="button-row">
              <button className="primary" disabled={busy || reason.trim().length < 5} type="submit">
                {busy ? 'Resuming…' : 'Resume'}
              </button>
              <button className="secondary" disabled={busy} type="button" onClick={() => setMode(null)}>Cancel</button>
            </div>
            {error ? <p className="notice error" role="alert">{error}</p> : null}
          </form>
        ) : null}
      </section>
    )
  }

  if (!round.canPause) return null

  if (mode !== 'pause') {
    return (
      <button className="text-button round-pause-open" type="button" onClick={() => open('pause')}>
        Pause new review calls and starts
      </button>
    )
  }

  return (
    <section className="round-pause command" aria-label="Pause this review round">
      <div>
        <strong>Pause new reviews</strong>
        <small>Teams may stay in queue. Reviews already underway are not interrupted.</small>
      </div>
      {incidents.length > 0 ? (
        <form className="round-pause-form" onSubmit={submit}>
          <label className="field">
            <span>Review incident</span>
            <select value={incidentId} onChange={(event) => { changed(); setIncidentId(event.target.value) }}>
              {incidents.map((incident) => <option key={incident.id} value={incident.id}>{incident.title}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Operational reason</span>
            <textarea required minLength={5} value={reason} onChange={(event) => { changed(); setReason(event.target.value) }} />
          </label>
          <div className="button-row">
            <button className="primary" disabled={busy || reason.trim().length < 5} type="submit">
              {busy ? 'Pausing…' : 'Pause new reviews'}
            </button>
            <button className="secondary" disabled={busy} type="button" onClick={() => setMode(null)}>Cancel</button>
          </div>
          {error ? <p className="notice error" role="alert">{error}</p> : null}
        </form>
      ) : (
        <p className="notice">Open a review incident below before pausing the round.</p>
      )}
    </section>
  )
}

function ReviewerNoShow({ member, panelVersion }: { member: SubstituteMember | undefined; panelVersion: number }) {
  const markNoShow = useMutation(api.reviewSubstitutions.markNoShow)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)

  if (!member?.canMarkNoShow) return null

  const changed = () => {
    operationRef.current = null
    setConfirmed(false)
    setError(null)
  }

  const submit = async () => {
    if (busy || !confirmed || reason.trim().length < 5) return
    const clientOperationId = operationRef.current ?? crypto.randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await markNoShow({
        eventSlug,
        panelMemberId: member.panelMemberId,
        expectedPanelVersion: panelVersion,
        expectedClockInVersion: member.clockInVersion,
        reason,
        clientOperationId,
      })
      operationRef.current = null
      setOpen(false)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return <button className="inline-text-button" type="button" onClick={() => setOpen(true)}>Mark no-show</button>
  }
  return (
    <div className="inline-command">
      <label className="field">
        <span>Operational reason</span>
        <input value={reason} onChange={(event) => { setReason(event.target.value); changed() }} />
      </label>
      <label className="check-filter">
        <input checked={confirmed} type="checkbox" onChange={(event) => {
          setConfirmed(event.target.checked)
          operationRef.current = null
        }} />
        I confirm this reviewer cannot take the seat. A running review is never interrupted.
      </label>
      <div className="button-row">
        <button className="primary" disabled={busy || !confirmed || reason.trim().length < 5} type="button" onClick={() => void submit()}>
          {busy ? 'Saving…' : 'Create vacancy'}
        </button>
        <button className="secondary compact-link" disabled={busy} type="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {error ? <small className="notice error">{error}</small> : null}
    </div>
  )
}

function SubstitutionControl({ panel, serverNow }: { panel: SubstitutionPanel; serverNow: number }) {
  const startPageChain = useMutation(api.reviewSubstitutions.startPageChain)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)

  if (!panel.vacancy && !panel.pageChain) return null

  const changed = () => {
    operationRef.current = null
    setError(null)
  }

  const submit = async () => {
    if (!panel.vacancy || busy || reason.trim().length < 5) return
    const clientOperationId = operationRef.current ?? crypto.randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await startPageChain({
        eventSlug,
        missingPanelMemberId: panel.vacancy.panelMemberId,
        expectedPanelVersion: panel.panelVersion,
        reason,
        clientOperationId,
      })
      operationRef.current = null
      setOpen(false)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel-command substitution-command">
      {panel.vacancy ? (
        <p className="notice">
          Seat open: {panel.vacancy.displayName}{panel.vacancy.isCoordinator ? ' · coordinator' : ''} · {panel.vacancy.criterionLabels.join(', ')}
        </p>
      ) : null}
      {panel.pageChain ? (
        <p className="muted exception-policy">
          Page chain {stateName(panel.pageChain.state)} · attempt {panel.pageChain.currentRank}
          {panel.pageChain.currentPage
            ? ` · ${panel.pageChain.currentPage.targetName} ${stateName(panel.pageChain.currentPage.state)} until ${formatMoment(panel.pageChain.currentPage.expiresAt)}`
            : ''}
          {panel.pageChain.currentPage?.push
            ? ` · ${pushStateName(panel.pageChain.currentPage.push.state)}${panel.pageChain.currentPage.push.providerErrorCode ? ` (${stateName(panel.pageChain.currentPage.push.providerErrorCode)})` : ''}`
            : panel.pageChain.currentPage
              ? ' · push unavailable'
              : ''}
          {panel.pageChain.currentPage && panel.pageChain.currentPage.expiresAt <= serverNow ? ' · expiry processing' : ''}
        </p>
      ) : null}
      {panel.canStartPage && panel.vacancy && !open ? (
        <button className="secondary compact-link" type="button" onClick={() => setOpen(true)}>
          Page next compatible reserve
        </button>
      ) : null}
      {open && panel.vacancy ? (
        <div className="exception-form">
          <label className="field">
            <span>Substitution reason</span>
            <textarea value={reason} onChange={(event) => { setReason(event.target.value); changed() }} />
          </label>
          <p className="muted">The server pages one present, qualified reserve at a time using the published response window.</p>
          <div className="button-row">
            <button className="primary" disabled={busy || reason.trim().length < 5} type="button" onClick={() => void submit()}>
              {busy ? 'Paging…' : 'Start page chain'}
            </button>
            <button className="secondary compact-link" disabled={busy} type="button" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      ) : null}
      {error ? <p className="notice error">{error}</p> : null}
    </div>
  )
}

function PanelMembership({ panel, reserves }: { panel: SubstitutionPanel; reserves: Reserve[] }) {
  const swapPanelMember = useMutation(api.reviewPanelMembership.swapPanelMember)
  const [open, setOpen] = useState(false)
  const [leavingPersonId, setLeavingPersonId] = useState('')
  const [joiningPersonId, setJoiningPersonId] = useState('')
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)

  if (!panel.canSwapMembers) return null

  // A reserve who is out on a page or already seated cannot take this seat.
  const candidates = reserves.filter((reserve) => reserve.status === 'available')
  const leaving = panel.activeMembers.find((member) => member.personId === leavingPersonId)
  const joining = candidates.find((reserve) => reserve.personId === joiningPersonId)

  const changed = () => {
    operationRef.current = null
    setConfirmed(false)
    setError(null)
  }

  const submit = async () => {
    if (busy || !confirmed || reason.trim().length < 5 || (!leaving && !joining)) return
    const clientOperationId = operationRef.current ?? crypto.randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await swapPanelMember({
        eventSlug,
        panelId: panel.panelId,
        ...(leaving ? { leavingPersonId: leaving.personId } : {}),
        ...(joining ? { joiningPersonId: joining.personId } : {}),
        expectedPanelVersion: panel.panelVersion,
        reason,
        clientOperationId,
      })
      operationRef.current = null
      setOpen(false)
      setLeavingPersonId('')
      setJoiningPersonId('')
      setReason('')
      setConfirmed(false)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button className="text-button" type="button" onClick={() => setOpen(true)}>
        Swap a reviewer
      </button>
    )
  }
  return (
    <div className="panel-command">
      <label className="field compact-select">
        <span>Reviewer leaving</span>
        <select value={leavingPersonId} onChange={(event) => { setLeavingPersonId(event.target.value); changed() }}>
          <option value="">Nobody leaves</option>
          {panel.activeMembers.map((member) => (
            <option key={member.personId} value={member.personId}>
              {member.displayName}{member.isCoordinator ? ' · runs this panel' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="field compact-select">
        <span>Reviewer joining</span>
        <select value={joiningPersonId} onChange={(event) => { setJoiningPersonId(event.target.value); changed() }}>
          <option value="">Nobody joins</option>
          {candidates.map((reserve) => (
            <option key={reserve.personId} value={reserve.personId}>{reserve.displayName}</option>
          ))}
        </select>
      </label>
      {candidates.length === 0 ? (
        <p className="muted">No reserve reviewer is free for this round right now.</p>
      ) : null}
      {leaving?.isCoordinator ? (
        <p className="muted">Whoever takes this seat runs the panel.</p>
      ) : null}
      <label className="field">
        <span>Operational reason</span>
        <input value={reason} onChange={(event) => { setReason(event.target.value); changed() }} />
      </label>
      <label className="check-filter">
        <input checked={confirmed} type="checkbox" onChange={(event) => {
          setConfirmed(event.target.checked)
          operationRef.current = null
        }} />
        I confirm this seat change with the panel. A running review is never interrupted.
      </label>
      <div className="button-row">
        <button
          className="primary"
          disabled={busy || !confirmed || reason.trim().length < 5 || (!leaving && !joining)}
          type="button"
          onClick={() => void submit()}
        >
          {busy ? 'Saving…' : 'Change the panel'}
        </button>
        <button className="secondary compact-link" disabled={busy} type="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {error ? <p className="notice error">{error}</p> : null}
    </div>
  )
}

function TeamRow({ board, team }: { board: Board; team: Team }) {
  const queueTeam = useMutation(api.reviewOperations.queueTeam)
  const callTeam = useMutation(api.reviewOperations.callTeam)
  const startReview = useMutation(api.reviewOperations.startReview)
  const completeReview = useMutation(api.reviewOperations.completeReview)
  const manageablePanels = board.panels.filter(
    (panel) => panel.status === 'ready' && panel.canManageQueue,
  )
  const [selectedPanelId, setSelectedPanelId] = useState(manageablePanels[0]?.id ?? '')
  const [busy, setBusy] = useState<Command | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [availabilityOverrideReason, setAvailabilityOverrideReason] = useState('')
  const [availabilityOverrideConfirmed, setAvailabilityOverrideConfirmed] = useState(false)
  const attemptRef = useRef<Attempt | null>(null)
  const selectedPanel = manageablePanels.find((panel) => panel.id === selectedPanelId) ?? manageablePanels[0]
  const assignedPanel = team.panelId
    ? board.panels.find((panel) => panel.id === team.panelId)
    : undefined

  const operationId = (
    command: Command,
    expectedVersion: number,
    requestKey: string = command,
  ) => {
    const prior = attemptRef.current
    if (
      prior?.command === command &&
      prior.expectedVersion === expectedVersion &&
      prior.requestKey === requestKey
    ) {
      return prior.clientOperationId
    }
    const attempt = {
      command,
      expectedVersion,
      requestKey,
      clientOperationId: crypto.randomUUID(),
    }
    attemptRef.current = attempt
    return attempt.clientOperationId
  }

  const runQueue = async () => {
    if (!selectedPanel || busy) return
    setBusy('queue')
    setError(null)
    try {
      await queueTeam({
        eventSlug,
        roundId: board.round.id,
        panelId: selectedPanel.id,
        teamId: team.teamId,
        expectedTeamRoundVersion: team.version,
        reason: 'Placed by the live review board',
        clientOperationId: operationId('queue', team.version),
      })
      attemptRef.current = null
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  const runCall = async (participantAvailabilityOverrideReason?: string) => {
    if (!assignedPanel || busy) return
    const overrideReason = participantAvailabilityOverrideReason?.trim()
    setBusy('call')
    setError(null)
    try {
      await callTeam({
        eventSlug,
        roundId: board.round.id,
        panelId: assignedPanel.id,
        teamId: team.teamId,
        expectedTeamRoundVersion: team.version,
        reason: 'Called from the live review board',
        ...(overrideReason
          ? { participantAvailabilityOverrideReason: overrideReason }
          : {}),
        clientOperationId: operationId(
          'call',
          team.version,
          overrideReason ?? 'no_availability_exception',
        ),
      })
      attemptRef.current = null
      setAvailabilityOverrideReason('')
      setAvailabilityOverrideConfirmed(false)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  const runStart = async () => {
    if (!team.review || busy) return
    setBusy('start')
    setError(null)
    try {
      await startReview({
        eventSlug,
        reviewSessionId: team.review.id,
        expectedVersion: team.review.version,
        reason: 'Started from the live review board',
        clientOperationId: operationId('start', team.review.version),
      })
      attemptRef.current = null
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  const runComplete = async () => {
    if (!team.review || busy) return
    setBusy('complete')
    setError(null)
    try {
      await completeReview({
        eventSlug,
        reviewSessionId: team.review.id,
        expectedVersion: team.review.version,
        reason: 'Completed after all fixed scorecards were submitted',
        clientOperationId: operationId('complete', team.review.version),
      })
      attemptRef.current = null
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  const review = team.review
  const allReviewersPresent = review
    ? review.reviewerPresenceCount === review.reviewerCount
    : false
  const allScorecardsSubmitted = review
    ? review.submittedScorecardCount === review.reviewerCount
    : false
  const participantAvailabilityReady =
    team.participantAvailability.isMet || team.participantAvailability.isWaived
  // What is standing between this team and its next step, said once.
  const blocker =
    review?.status === 'awaiting_presence' && !allReviewersPresent
      ? `Waiting for reviewers to scan in · ${review.reviewerPresenceCount} of ${review.reviewerCount} done`
      : review?.status === 'awaiting_presence' && !participantAvailabilityReady
        ? 'Waiting for the team to regroup at the table'
        : (review?.status === 'active' || review?.status === 'overdue') && !allScorecardsSubmitted
          ? `Waiting for scorecards · ${review.submittedScorecardCount} of ${review.reviewerCount} submitted`
          : (review?.status === 'active' || review?.status === 'overdue') &&
              !review.sharedNotesComplete
            ? 'Waiting for the panel to agree shared notes'
            : null

  return (
    <article className="review-team-row">
      <div className="review-team-heading">
        <div>
          <strong>{team.teamName}</strong>
          <span>
            {team.trackName}
            {team.tableLabel ? ` · ${team.tableLabel}` : ''}
          </span>
        </div>
        <div className="review-team-meta">
          {team.applicationId ? (
            <Link className="row-action" to={`/admissions/${team.applicationId}`}>
              See the project
            </Link>
          ) : null}
          <span className={`state-label ${team.state}`}>
            {teamRoundStateOperatorLabels[team.state]}
          </span>
        </div>
      </div>

      {/* Attendance only matters when it is blocking the call, or when someone
          has already waived it; otherwise it is the same line on every row. */}
      {participantAvailabilityReady && !team.participantAvailability.isWaived ? null : (
        <p className="muted">
          {team.participantAvailability.isWaived
            ? `Called with an exception · ${team.participantAvailability.availableCount} of ${team.participantAvailability.requiredCount} needed were inside`
            : `Only ${team.participantAvailability.availableCount} of the team is in the hall; this round needs ${team.participantAvailability.requiredCount}.`}
        </p>
      )}

      {review ? (
        <dl className="review-progress">
          <div><dt>Reviewer presence</dt><dd>{review.reviewerPresenceCount}/{review.reviewerCount}</dd></div>
          <div><dt>Scorecards</dt><dd>{review.submittedScorecardCount}/{review.reviewerCount}</dd></div>
          {review.requiresSharedCommitments ? (
            <div><dt>Shared notes</dt><dd>{review.sharedNotesComplete ? 'Ready' : 'Missing'}</dd></div>
          ) : null}
          <div><dt>Session</dt><dd>{reviewSessionStatusLabels[review.status]}</dd></div>
        </dl>
      ) : null}

      {team.state === 'unassigned' && manageablePanels.length > 0 ? (
        <div className="review-team-actions">
          <label className="field compact-select">
            <span className="visually-hidden">Panel</span>
            <select value={selectedPanel?.id ?? ''} onChange={(event) => setSelectedPanelId(event.target.value)}>
              {manageablePanels.map((panel) => (
                <option key={panel.id} value={panel.id}>{panel.name}</option>
              ))}
            </select>
          </label>
          <button className="primary" type="button" disabled={busy !== null || !selectedPanel} onClick={() => void runQueue()}>
            {busy === 'queue' ? 'Placing…' : 'Place in queue'}
          </button>
        </div>
      ) : null}
      {team.state === 'queued' && assignedPanel?.canPrepareReview && team.participantAvailability.isMet ? (
        <button className="primary" type="button" disabled={busy !== null} onClick={() => void runCall()}>
          {busy === 'call' ? 'Calling…' : 'Call team'}
        </button>
      ) : null}
      {team.state === 'queued' && assignedPanel?.canPrepareReview && !team.participantAvailability.isMet ? (
        team.participantAvailability.canWaive ? (
          <details className="team-exceptions">
            <summary>Review without the whole team</summary>
            <div className="exception-form destructive-command">
              <p className="muted">
                Keep the team queued unless staff have confirmed that this review should proceed with fewer people.
              </p>
              <label className="field">
                <span>Reason</span>
                <textarea
                  value={availabilityOverrideReason}
                  onChange={(event) => {
                    setAvailabilityOverrideReason(event.target.value)
                    setAvailabilityOverrideConfirmed(false)
                    attemptRef.current = null
                    setError(null)
                  }}
                />
              </label>
              <label className="check-filter">
                <input
                  checked={availabilityOverrideConfirmed}
                  type="checkbox"
                  onChange={(event) => {
                    setAvailabilityOverrideConfirmed(event.target.checked)
                    attemptRef.current = null
                  }}
                />
                I confirmed the team can be called with the current attendance state.
              </label>
              <button
                className="primary"
                disabled={
                  busy !== null ||
                  !availabilityOverrideConfirmed ||
                  availabilityOverrideReason.trim().length < 5
                }
                type="button"
                onClick={() => void runCall(availabilityOverrideReason)}
              >
                {busy === 'call' ? 'Calling…' : 'Record exception and call'}
              </button>
            </div>
          </details>
        ) : (
          <p className="notice">The team needs to regroup before it can be called.</p>
        )
      ) : null}
      {review?.status === 'awaiting_presence' && review.canStart && !blocker ? (
        <button
          className="primary"
          type="button"
          disabled={busy !== null}
          onClick={() => void runStart()}
        >
          {busy === 'start' ? 'Starting…' : 'Start review'}
        </button>
      ) : null}
      {(review?.status === 'active' || review?.status === 'overdue') &&
      review.canComplete &&
      !blocker ? (
        <button
          className="primary"
          type="button"
          disabled={busy !== null}
          onClick={() => void runComplete()}
        >
          {busy === 'complete' ? 'Completing…' : 'Complete review'}
        </button>
      ) : null}
      {blocker ? <p className="review-blocked">{blocker}</p> : null}
      {review?.status === 'awaiting_presence' && review.canWaivePresence ? (
        <PresenceWaiver review={review} />
      ) : null}
      {review?.status === 'awaiting_presence' &&
      !team.participantAvailability.isMet &&
      !team.participantAvailability.isWaived &&
      team.participantAvailability.canWaive ? (
        <ParticipantAvailabilityWaiver review={review} />
      ) : null}
      <TeamExceptions board={board} team={team} />
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </article>
  )
}

function PanelAvailability({ panel }: { panel: Panel }) {
  const setPanelAvailability = useMutation(api.reviewExceptions.setPanelAvailability)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)
  const nextStatus = panel.status === 'paused' ? 'ready' : 'paused'

  const changed = () => {
    operationRef.current = null
    setError(null)
  }

  const submit = async () => {
    if (busy || reason.trim().length < 5) return
    const clientOperationId = operationRef.current ?? crypto.randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await setPanelAvailability({
        eventSlug,
        panelId: panel.id,
        expectedVersion: panel.version,
        status: nextStatus,
        reason,
        clientOperationId,
      })
      operationRef.current = null
      setOpen(false)
      setReason('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button className="text-button" type="button" onClick={() => setOpen(true)}>
        {nextStatus === 'paused' ? 'Pause panel' : 'Resume panel'}
      </button>
    )
  }
  return (
    <div className="panel-command">
      <label className="field">
        <span>{nextStatus === 'paused' ? 'Pause reason' : 'Resume reason'}</span>
        <input value={reason} onChange={(event) => { setReason(event.target.value); changed() }} />
      </label>
      <div className="button-row">
        <button className="primary" disabled={busy || reason.trim().length < 5} type="button" onClick={() => void submit()}>
          {busy ? 'Saving…' : nextStatus === 'paused' ? 'Pause' : 'Resume'}
        </button>
        <button className="secondary compact-link" disabled={busy} type="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {error ? <p className="notice error">{error}</p> : null}
    </div>
  )
}

type ExceptionCommand = 'hold' | 'resume' | 'move' | 'call' | 'miss'

function TeamExceptions({ board, team }: { board: Board; team: Team }) {
  const holdTeam = useMutation(api.reviewExceptions.holdTeam)
  const resumeTeam = useMutation(api.reviewExceptions.resumeTeam)
  const moveQueuedTeam = useMutation(api.reviewExceptions.moveQueuedTeam)
  const recordCallAttempt = useMutation(api.reviewExceptions.recordCallAttempt)
  const markMissed = useMutation(api.reviewExceptions.markMissed)
  const [command, setCommand] = useState<ExceptionCommand | null>(null)
  const [targetPanelId, setTargetPanelId] = useState('')
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)
  const stateId = team.stateId
  const moveTargets = board.panels.filter(
    (panel) =>
      panel.id !== team.panelId &&
      panel.status === 'ready' &&
      panel.canManageQueue,
  )
  const canHold = team.canHold && ['unassigned', 'queued', 'called', 'at_table'].includes(team.state)
  const canResume = team.canResume && (team.state === 'held' || team.state === 'missed')
  const canMove = team.canMove && team.state === 'queued' && moveTargets.length > 0
  const canCall = team.canMarkMissed && (team.state === 'called' || team.state === 'at_table')
  const missedPolicyMet =
    canCall &&
    team.callAttemptCount >= board.round.requiredCallAttempts &&
    team.missedEligibleAt !== undefined &&
    board.serverNow >= team.missedEligibleAt

  if (!stateId || (!canHold && !canResume && !canMove && !canCall)) return null

  const changed = () => {
    operationRef.current = null
    setConfirmed(false)
    setError(null)
  }

  const choose = (next: ExceptionCommand) => {
    setCommand(next)
    setTargetPanelId(moveTargets[0]?.id ?? '')
    setReason('')
    changed()
  }

  const submit = async () => {
    if (!command || busy || reason.trim().length < 3 || (command === 'miss' && !confirmed)) return
    const clientOperationId = operationRef.current ?? crypto.randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      if (command === 'hold') {
        await holdTeam({
          eventSlug,
          teamRoundStateId: stateId,
          expectedVersion: team.version,
          reason,
          clientOperationId,
        })
      } else if (command === 'resume') {
        await resumeTeam({
          eventSlug,
          teamRoundStateId: stateId,
          expectedVersion: team.version,
          reason,
          clientOperationId,
        })
      } else if (command === 'move') {
        const panel = moveTargets.find((candidate) => candidate.id === targetPanelId)
        if (!panel) throw new Error('Choose a current target panel.')
        await moveQueuedTeam({
          eventSlug,
          teamRoundStateId: stateId,
          targetPanelId: panel.id,
          expectedVersion: team.version,
          reason,
          clientOperationId,
        })
      } else if (command === 'call') {
        await recordCallAttempt({
          eventSlug,
          teamRoundStateId: stateId,
          expectedVersion: team.version,
          reason,
          clientOperationId,
        })
      } else {
        await markMissed({
          eventSlug,
          teamRoundStateId: stateId,
          expectedVersion: team.version,
          reason,
          clientOperationId,
        })
      }
      operationRef.current = null
      setCommand(null)
      setReason('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="team-exceptions" open={command !== null}>
      <summary>Something went wrong</summary>
      <div className="exception-choice-row">
        {canHold ? <button className="secondary compact-link" type="button" onClick={() => choose('hold')}>Hold</button> : null}
        {canResume ? <button className="secondary compact-link" type="button" onClick={() => choose('resume')}>Return to queue</button> : null}
        {canMove ? <button className="secondary compact-link" type="button" onClick={() => choose('move')}>Move panel</button> : null}
        {canCall ? <button className="secondary compact-link" type="button" onClick={() => choose('call')}>Record another call</button> : null}
        {missedPolicyMet ? <button className="secondary compact-link" type="button" onClick={() => choose('miss')}>Mark missed</button> : null}
      </div>
      {canCall ? (
        <p className="muted exception-policy">
          {team.callAttemptCount}/{board.round.requiredCallAttempts} calls · missed eligible {team.missedEligibleAt ? formatMoment(team.missedEligibleAt) : 'after the next recorded call'}
        </p>
      ) : null}
      {command ? (
        <div className="exception-form">
          {command === 'move' ? (
            <label className="field compact-select">
              <span>Target panel</span>
              <select value={targetPanelId} onChange={(event) => { setTargetPanelId(event.target.value); changed() }}>
                {moveTargets.map((panel) => (
                  <option key={panel.id} value={panel.id}>{panel.name}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="field">
            <span>Reason</span>
            <textarea value={reason} onChange={(event) => { setReason(event.target.value); changed() }} />
          </label>
          {command === 'miss' ? (
            <label className="check-filter">
              <input checked={confirmed} type="checkbox" onChange={(event) => { setConfirmed(event.target.checked); operationRef.current = null }} />
              I confirm the published call count and grace period elapsed.
            </label>
          ) : null}
          <div className="button-row">
            <button
              className="primary"
              disabled={busy || reason.trim().length < 3 || (command === 'miss' && !confirmed)}
              type="button"
              onClick={() => void submit()}
            >
              {busy ? 'Saving…' : commandLabel(command)}
            </button>
            <button className="secondary" disabled={busy} type="button" onClick={() => setCommand(null)}>Cancel</button>
          </div>
          {error ? <p className="notice error">{error}</p> : null}
        </div>
      ) : null}
    </details>
  )
}

function PresenceWaiver({ review }: { review: NonNullable<Team['review']> }) {
  const waivePresence = useMutation(api.reviewExceptions.waivePresence)
  const missing = review.reviewers.filter((reviewer) => reviewer.presenceMethod === undefined)
  const [selected, setSelected] = useState<string[]>([])
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)

  if (missing.length === 0) return null

  const changed = () => {
    operationRef.current = null
    setConfirmed(false)
    setError(null)
  }

  const submit = async () => {
    const selectedReviewers = missing.filter((reviewer) => selected.includes(reviewer.personId))
    if (busy || !confirmed || selectedReviewers.length === 0 || reason.trim().length < 5) return
    const clientOperationId = operationRef.current ?? crypto.randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await waivePresence({
        eventSlug,
        reviewSessionId: review.id,
        reviewerPersonIds: selectedReviewers.map((reviewer) => reviewer.personId),
        expectedVersion: review.version,
        reason,
        clientOperationId,
      })
      operationRef.current = null
      setSelected([])
      setReason('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="team-exceptions">
      <summary>Start without every reviewer</summary>
      <div className="exception-form destructive-command">
        <p className="muted">Use only after staff physically confirm the named reviewer at this table.</p>
        {missing.map((reviewer) => (
          <label className="check-filter" key={reviewer.personId}>
            <input
              checked={selected.includes(reviewer.personId)}
              type="checkbox"
              onChange={(event) => {
                setSelected((current) => event.target.checked
                  ? [...current, reviewer.personId]
                  : current.filter((personId) => personId !== reviewer.personId))
                changed()
              }}
            />
            {reviewer.displayName}
          </label>
        ))}
        <label className="field"><span>Reason</span><textarea value={reason} onChange={(event) => { setReason(event.target.value); changed() }} /></label>
        <label className="check-filter">
          <input checked={confirmed} type="checkbox" onChange={(event) => { setConfirmed(event.target.checked); operationRef.current = null }} />
          I personally confirmed these reviewers are present.
        </label>
        <button
          className="primary"
          disabled={busy || !confirmed || selected.length === 0 || reason.trim().length < 5}
          type="button"
          onClick={() => void submit()}
        >
          {busy ? 'Recording…' : 'Record waiver'}
        </button>
        {error ? <p className="notice error">{error}</p> : null}
      </div>
    </details>
  )
}

function ParticipantAvailabilityWaiver({
  review,
}: {
  review: NonNullable<Team['review']>
}) {
  const waiveParticipantAvailability = useMutation(
    api.reviewExceptions.waiveParticipantAvailability,
  )
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)

  const changed = () => {
    operationRef.current = null
    setConfirmed(false)
    setError(null)
  }

  const submit = async () => {
    if (busy || !confirmed || reason.trim().length < 5) return
    const clientOperationId = operationRef.current ?? crypto.randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await waiveParticipantAvailability({
        eventSlug,
        reviewSessionId: review.id,
        expectedVersion: review.version,
        reason,
        clientOperationId,
      })
      operationRef.current = null
      setReason('')
      setConfirmed(false)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="team-exceptions">
      <summary>Review without the whole team</summary>
      <div className="exception-form destructive-command">
        <p className="muted">
          Use this only after staff confirm the review should begin with fewer participants than the published minimum.
        </p>
        <label className="field">
          <span>Reason</span>
          <textarea
            value={reason}
            onChange={(event) => {
              setReason(event.target.value)
              changed()
            }}
          />
        </label>
        <label className="check-filter">
          <input
            checked={confirmed}
            type="checkbox"
            onChange={(event) => {
              setConfirmed(event.target.checked)
              operationRef.current = null
            }}
          />
          I confirmed the team can start with the current attendance state.
        </label>
        <button
          className="primary"
          disabled={busy || !confirmed || reason.trim().length < 5}
          type="button"
          onClick={() => void submit()}
        >
          {busy ? 'Recording…' : 'Record exception'}
        </button>
        {error ? <p className="notice error">{error}</p> : null}
      </div>
    </details>
  )
}

function commandLabel(command: ExceptionCommand) {
  if (command === 'hold') return 'Place on hold'
  if (command === 'resume') return 'Return team'
  if (command === 'move') return 'Move team'
  if (command === 'call') return 'Record call'
  return 'Mark missed'
}

function formatMoment(value: number) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(value)
}

function stateName(value: string) {
  return value.replaceAll('_', ' ')
}

function pushStateName(value: string) {
  if (value === 'provider_accepted') return 'push accepted by APNs/FCM'
  if (value === 'unavailable') return 'push unavailable'
  if (value === 'retry_wait') return 'push retry waiting'
  if (value === 'failed') return 'push failed'
  if (value === 'superseded') return 'push no longer needed'
  return `push ${stateName(value)}`
}

function formatWindow(startsAt: number, endsAt: number) {
  const formatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${formatter.format(startsAt)} – ${formatter.format(endsAt)}`
}

function reviewerState(
  reviewer: Board['panels'][number]['reviewers'][number],
  serverNow: number,
) {
  if (reviewer.clockInStatus === 'temporarily_unavailable') {
    const returnCopy = reviewer.expectedReturnAt
      ? ` · expected ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(reviewer.expectedReturnAt)}`
      : ''
    return `Temporarily unavailable${returnCopy}`
  }
  if (reviewer.clockInStatus !== 'present') return 'Not clocked in'
  if (reviewer.encryptedDraftReady === false) return 'Present · encrypted drafts unavailable'
  if (!reviewer.lastHeartbeatAt || serverNow - reviewer.lastHeartbeatAt > 90_000) {
    return 'Present · connection stale'
  }
  return `Present · build ${reviewer.appBuild ?? 'unknown'}`
}
