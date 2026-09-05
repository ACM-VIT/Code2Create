import { ReviewSkip } from "../components/ReviewSkip";
import { LiveNumber } from "../components/LiveNumber";
import { api } from "@code2create/backend/api";
import {
  reviewRoundStatusLabels,
  reviewRoundReserveStatusLabels,
  reviewSessionStatusLabels,
  reviewerClockInStatusLabels,
  reviewerPageChainStateLabels,
  reviewerPageStateLabels,
  reviewerPushDeliveryStateLabels,
  outboundCallDeliveryStateLabels,
  teamRoundStateOperatorLabels,
} from "@code2create/domain";
import type { FunctionReturnType } from "convex/server";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useEffect, useState, type SubmitEvent } from "react";
import { Link, useParams } from "react-router-dom";

import { Icon } from "../components/Icon";
import { ReviewManualRecovery } from "../components/ReviewManualRecovery";
import { ReviewConfirmations } from "../components/ReviewConfirmations";
import { ReviewQuestionSettings } from "../components/ReviewQuestionSettings";
import { ReviewQueueSettings } from "../components/ReviewQueueSettings";
import { ReviewStaffingSettings } from "../components/ReviewStaffingSettings";
import {
  LoadingLabel,
  SkeletonCard,
  SkeletonList,
  SkeletonStats,
} from "../components/Skeleton";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useMutationAttempt } from "../lib/operations";
import { venuePresenceLabel } from "../lib/venue-presence";

type Board = FunctionReturnType<typeof api.reviewOperations.roundBoard>;
type Staffing = FunctionReturnType<typeof api.reviewOperations.roundStaffing>;
type Team = FunctionReturnType<typeof api.reviewOperations.roundTeams>["page"][number];
type Panel = Board["panels"][number] & { reviewers: Staffing["panels"][number]["reviewers"];
};
type OverviewPanel = NonNullable<
  FunctionReturnType<typeof api.reviewOperations.overview>
>["rounds"][number]["panels"][number];
type Substitutions = FunctionReturnType<typeof api.reviewSubstitutions.roundStatus>;
type SubstitutionPanel = Substitutions["panels"][number];
type SubstituteMember = SubstitutionPanel["activeMembers"][number];
type Reserve = Substitutions["reserves"][number];
type ActiveIncident = FunctionReturnType<typeof api.incidents.active>[number];
type Command = "queue" | "call" | "start" | "complete";
type TeamView = "desk" | "in_motion" | "done" | "all";
type RoundPauseResult =
  | FunctionReturnType<typeof api.reviewRoundPauses.pause>
  | FunctionReturnType<typeof api.reviewRoundPauses.resume>;
type TeamReviewCommandResult =
  | FunctionReturnType<typeof api.reviewOperations.queueTeam>
  | FunctionReturnType<typeof api.reviewOperations.callTeam>
  | FunctionReturnType<typeof api.reviewOperations.startReview>
  | FunctionReturnType<typeof api.reviewOperations.completeReview>;
type TeamExceptionResult =
  | FunctionReturnType<typeof api.reviewExceptions.holdTeam>
  | FunctionReturnType<typeof api.reviewExceptions.resumeTeam>
  | FunctionReturnType<typeof api.reviewExceptions.moveQueuedTeam>
  | FunctionReturnType<typeof api.reviewExceptions.recordCallAttempt>
  | FunctionReturnType<typeof api.reviewExceptions.markMissed>;

export function ReviewRoundBoard() {
  const [venueNow, setVenueNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setVenueNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const { roundId } = useParams<{ roundId: string }>();
  const [teamView, setTeamView] = useState<TeamView>("desk");
  const overview = useQuery(api.reviewOperations.overview, { eventSlug });
  const visibleRound = overview?.rounds.find((round) => round.id === roundId);
  const board = useQuery(
    api.reviewOperations.roundBoard,
    visibleRound ? { eventSlug, roundId: visibleRound.id } : "skip",
  );
  const teams = usePaginatedQuery(
    api.reviewOperations.roundTeams,
    visibleRound ? { eventSlug, roundId: visibleRound.id } : "skip",
    { initialNumItems: 30 },
  );
  const staffing = useQuery(
    api.reviewOperations.roundStaffing,
    visibleRound ? { eventSlug, roundId: visibleRound.id } : "skip",
  );
  const substitutions = useQuery(
    api.reviewSubstitutions.roundStatus,
    visibleRound ? { eventSlug, roundId: visibleRound.id } : "skip",
  );
  const incidents = useQuery(api.incidents.active, visibleRound ? { eventSlug } : "skip",
  );

  if (!roundId) return <p className="notice error">Round ID is missing.</p>;
  if (
    overview === undefined ||
    (visibleRound &&
      (board === undefined ||
        teams.status === "LoadingFirstPage" ||
        staffing === undefined ||
        substitutions === undefined ||
        incidents === undefined))
  ) {
    return (
      <section className="review-shell">
        <LoadingLabel>Loading the round board</LoadingLabel>
        <SkeletonStats columns={6} />
        <SkeletonCard lines={4} />
        <SkeletonList rows={4} />
      </section>
    );
  }
  if (!visibleRound) {
    return (
      <p className="notice error">You do not have access to this review round.</p>
    );
  }
  if (!board || !staffing || !substitutions || !incidents)
    return <p className="muted">Loading round board…</p>;
  const boardTeams = teams.results;
  const panels: Panel[] = board.panels.map((panel) => {
    const panelStaffing = staffing.panels.find((candidate) => candidate.panelId === panel.id,
    );
    if (!panelStaffing) throw new Error("The round staffing view is missing a published panel.");
    return { ...panel, reviewers: panelStaffing.reviewers };
  });

  const reviewIncidents = incidents.filter(
    (incident) => incident.affectedService === "review_backend",
  );
  const deskTeams = boardTeams.filter((team) => teamViewForState(team.state) === "desk",
  );
  const movingTeams = boardTeams.filter((team) => teamViewForState(team.state) === "in_motion",
  );
  const doneTeams = boardTeams.filter((team) => teamViewForState(team.state) === "done",
  );
  const visibleTeams =
    teamView === "desk"
      ? deskTeams
      : teamView === "in_motion"
        ? movingTeams
        : teamView === "done"
          ? doneTeams
          : boardTeams;

  return (
    <section className="review-shell">
      <Link className="back-link" to="/reviews">
        ← Reviews
      </Link>
      <header className="page-heading">
        <div>
          <p className="eyebrow">{reviewRoundStatusLabels[board.round.status]}</p>
          <h1>{board.round.name}</h1>
          <p className="muted">Panels, queues, and active reviews stay in sync here.</p>
        </div>
        <span className="state-label">
          {formatWindow(board.round.startsAt, board.round.endsAt)}
        </span>
      </header>

      <dl className="catalog-summary">
        <div>
          <dt>Waiting for the desk</dt>
          <dd><LiveNumber value={visibleRound.stateCounts.unassigned} /></dd>
        </div>
        <div>
          <dt>Queued</dt>
          <dd><LiveNumber value={visibleRound.stateCounts.queued} /></dd>
        </div>
        <div>
          <dt>Called</dt>
          <dd><LiveNumber value={visibleRound.stateCounts.called} /></dd>
        </div>
        <div>
          <dt>In review</dt>
          <dd><LiveNumber value={visibleRound.stateCounts.inReview} /></dd>
        </div>
        <div>
          <dt>Complete</dt>
          <dd><LiveNumber value={visibleRound.stateCounts.completed} /></dd>
        </div>
        <div>
          <dt>Held</dt>
          <dd><LiveNumber value={visibleRound.stateCounts.held} /></dd>
        </div>
      </dl>

      <RoundPauseControl key={board.round.id} incidents={reviewIncidents} round={board.round} />

      <ReviewConfirmations roundId={board.round.id} />
      <ReviewStaffingSettings roundId={board.round.id} />
      <ReviewQueueSettings roundId={board.round.id} />
      <ReviewQuestionSettings roundId={board.round.id} />

      <p className="board-section-label">Panels</p>
      <div className="panel-list">
        {[...panels].sort(byPanelUrgency).map((panel) => (
          <PanelRow
            key={panel.id}
            overviewPanel={visibleRound.panels.find((candidate) => candidate.id === panel.id,
            )}
            panel={panel}
            serverNow={staffing.serverNow}
            venueNow={venueNow}
            substitutions={substitutions}
            teams={boardTeams}
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
                <span>
                  {reviewRoundReserveStatusLabels[reserve.status]} ·{" "}
                  {
                    reviewerClockInStatusLabels[
                      staffing.reserves.find((candidate) => candidate.personId === reserve.personId,
                      )
                        ?.clockInStatus ?? "not_clocked_in"
                    ]
                  }{" "}
                  · {reserve.pageCount} pages
                  {(() => {
                    const venue = staffing.reserves.find(
                      (candidate) => candidate.personId === reserve.personId,
                    )?.venue;
                    return ` · ${venuePresenceLabel(venue?.status ?? "unknown", venue?.sampledAt, venueNow)}${venue?.followUp ? ` · ${venue.followUp}` : ""}`;
                  })()}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="review-team-workspace">
        <div className="section-heading review-team-workspace-heading">
          <div>
            <h2>Teams</h2>
            <p className="muted">Open whichever queue needs attention.</p>
          </div>
          <div
            className="configuration-tabs review-team-tabs"
            role="group"
            aria-label="Team queue view"
          >
            <button
              aria-pressed={teamView === "desk"}
              className={teamView === "desk" ? "active" : ""}
              type="button"
              onClick={() => setTeamView("desk")}
            >
              Desk · <LiveNumber value={deskTeams.length} />
            </button>
            <button
              aria-pressed={teamView === "in_motion"}
              className={teamView === "in_motion" ? "active" : ""}
              type="button"
              onClick={() => setTeamView("in_motion")}
            >
              In motion · <LiveNumber value={movingTeams.length} />
            </button>
            <button
              aria-pressed={teamView === "done"}
              className={teamView === "done" ? "active" : ""}
              type="button"
              onClick={() => setTeamView("done")}
            >
              Done · <LiveNumber value={doneTeams.length} />
            </button>
            <button
              aria-pressed={teamView === "all"}
              className={teamView === "all" ? "active" : ""}
              type="button"
              onClick={() => setTeamView("all")}
            >
              All · <LiveNumber value={boardTeams.length} />
            </button>
          </div>
        </div>
        <div className="review-team-list">
          {[...visibleTeams].sort(byDeskUrgency).map((team) => (
            <TeamRow board={board} key={team.stateId ?? team.teamId} team={team} />
          ))}
        </div>
        {visibleTeams.length === 0 ? (
          <p className="empty">
            {boardTeams.length === 0
              ? "No team is eligible for this round yet."
              : "No team is in this queue state."}
          </p>
        ) : null}
      </section>
      {teams.status !== "Exhausted" ? (
        <button
          className="secondary"
          disabled={teams.status === "LoadingMore"}
          type="button"
          onClick={() => teams.loadMore(30)}
        >
          {teams.status === "LoadingMore" ? "Loading more teams…" : "Load more teams"}
        </button>
      ) : null}

      <details className="board-recovery">
        <summary>If the system goes down: paper recovery</summary>
        <ReviewManualRecovery roundId={board.round.id} />
      </details>
    </section>
  );
}

function teamViewForState(state: Team["state"]): Exclude<TeamView, "all"> {
  if (state === "unassigned" || state === "held" || state === "missed") return "desk";
  if (state === "completed" || state === "withdrawn" || state === "skipped") return "done";
  return "in_motion";
}

const deskOrder: Record<Team["state"], number> = {
  unassigned: 0,
  called: 1,
  held: 2,
  missed: 3,
  queued: 4,
  at_table: 5,
  in_review: 6,
  completed: 7,
  withdrawn: 8,
  skipped: 9,
};

function byDeskUrgency(left: Team, right: Team) {
  return (
    deskOrder[left.state] - deskOrder[right.state] || left.teamName.localeCompare(right.teamName)
  );
}

function panelShortfall(panel: Panel) {
  return (
    panel.reviewers.length -
    panel.reviewers.filter((reviewer) => reviewer.clockInStatus === "present").length
  );
}

function byPanelUrgency(left: Panel, right: Panel) {
  return (
    panelShortfall(right) - panelShortfall(left) || left.name.localeCompare(right.name)
  );
}

function PanelRow({
  overviewPanel,
  panel,
  serverNow,
  venueNow,
  substitutions,
  teams,
}: {
  overviewPanel: OverviewPanel | undefined;
  panel: Panel;
  serverNow: number;
  venueNow: number;
  substitutions: Substitutions;
  teams: Team[];
}) {
  const [open, setOpen] = useState(false);
  const substitutionPanel = substitutions.panels.find(
    (candidate) => candidate.panelId === panel.id,
  );
  const short = panelShortfall(panel);
  const panelTeams = teams.filter((team) => team.panelId === panel.id);
  const waiting = panelTeams.filter(
    (team) => team.state === "queued" || team.state === "called" || team.state === "at_table",
  );
  const live = panelTeams.filter((team) => team.state === "in_review");
  const done = panelTeams.filter((team) => team.state === "completed");

  return (
    <article className={`panel-row ${short > 0 ? "short" : "ready"} ${open ? "open" : ""}`}>
      <button
        aria-expanded={open}
        className="panel-row-summary"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <span className={`row-glyph ${short > 0 ? "attention" : "watch"}`}>
          <Icon name={short > 0 ? "alert" : "seat"} />
        </span>
        <span className="panel-row-text">
          <strong>
            {panel.name}
            {live[0] ? (
              <span className="row-context"> · at {live[0].teamName}</span>
            ) : null}
          </strong>
          <small>
            {panelSummary({
              short,
              total: panel.reviewers.length,
              waiting: overviewPanel?.queuedCount ?? waiting.length,
              reviewing: (overviewPanel?.activeReviewCount ?? live.length) > 0,
            })}
          </small>
        </span>
        <span className="panel-row-chevron" aria-hidden="true">
          {open ? "⌄" : "›"}
        </span>
      </button>

      {open ? (
        <div className="panel-detail">
          <div className="panel-detail-block">
            <p className="board-section-label">Reviewers</p>
            <ul className="panel-reviewers">
              {panel.reviewers.map((reviewer) => (
                <li
                  className={reviewer.clockInStatus === "present" ? "" : "away"}
                  key={reviewer.personId}
                >
                  <span>
                    {reviewer.displayName}
                    {reviewer.isCoordinator ? " · runs this panel" : ""}
                  </span>
                  {reviewer.clockInStatus === "present" ? null : (
                    <small>{reviewerState(reviewer, serverNow)}</small>
                  )}
                  <small>
                    {venuePresenceLabel(
                      reviewer.venue.status,
                      reviewer.venue.sampledAt,
                      venueNow,
                    )}
                  </small>
                  {reviewer.venue.followUp ? <small className={reviewer.venue.needsAttention ? "error-note" : "muted"}>{reviewer.venue.followUp}</small> : null}
                  {reviewer.clockInStatus !== "present" && substitutionPanel ? (
                    <ReviewerNoShow
                      member={substitutionPanel.activeMembers.find(
                        (member) => member.personId === reviewer.personId,
                      )}
                      clockInVersion={reviewer.clockInVersion}
                      panelVersion={substitutionPanel.panelVersion}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          </div>

          <div className="panel-detail-block">
            <p className="board-section-label">Teams sent to this panel</p>
            {panelTeams.length === 0 ? (
              <p className="muted">No team has been sent here yet.</p>
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
  );
}

function panelSummary(counts: {
  short: number;
  total: number;
  waiting: number;
  reviewing: boolean;
}) {
  if (counts.short > 0) {
    const seats =
      counts.short === 1 ? "One reviewer is missing" : `${counts.short} reviewers are missing`;
    return `${seats}. This panel cannot start a review.`;
  }
  if (counts.reviewing) {
    return `All ${counts.total} reviewers present. Reviewing now.`;
  }
  if (counts.waiting > 0) {
    return `All ${counts.total} reviewers present. ${counts.waiting} ${counts.waiting === 1 ? "team is" : "teams are"} waiting for it.`;
  }
  return `All ${counts.total} reviewers present. Nothing waiting.`;
}

function RoundPauseControl({
  round,
  incidents,
}: {
  round: Board["round"];
  incidents: ActiveIncident[];
}) {
  const pauseRound = useMutation(api.reviewRoundPauses.pause);
  const resumeRound = useMutation(api.reviewRoundPauses.resume);
  const [mode, setMode] = useState<"pause" | "resume" | null>(null);
  const [incidentId, setIncidentId] = useState(incidents[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationAttempt = useMutationAttempt<RoundPauseResult>();
  const pauseSlot = `round-pause:${round.id}`;
  const resumeSlot = `round-resume:${round.id}`;
  const pausePending = operationAttempt.hasPending(pauseSlot);
  const resumePending = operationAttempt.hasPending(resumeSlot);
  const commandPending = pausePending || resumePending;

  const open = (nextMode: "pause" | "resume") => {
    if (commandPending) return;
    setMode(nextMode);
    setReason("");
    setError(null);
  };

  const retryPendingCommand = async (slot: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await operationAttempt.retryPending(slot);
      setMode(null);
      setReason("");
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy || reason.trim().length < 5) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "pause") {
        const incident = incidents.find((candidate) => candidate.id === incidentId,
        );
        if (!incident) {
          setError("Choose an active review incident.");
          return;
        }
        await operationAttempt.run(pauseSlot, () => {
          const args = {
            eventSlug,
            roundId: round.id,
            incidentId: incident.id,
            expectedRoundVersion: round.version,
            reason,
            clientOperationId: crypto.randomUUID(),
          };
          return () => pauseRound(args);
        });
      } else if (mode === "resume" && round.pause) {
        const pause = round.pause;
        await operationAttempt.run(resumeSlot, () => {
          const args = {
            eventSlug,
            pauseId: pause.id,
            expectedPauseVersion: pause.version,
            expectedRoundVersion: round.version,
            reason,
            clientOperationId: crypto.randomUUID(),
          };
          return () => resumeRound(args);
        });
      }
      setMode(null);
      setReason("");
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  if (round.pause) {
    return (
      <section className="round-pause" aria-live="polite">
        <div>
          <strong>New review calls and starts are paused.</strong>
          <span>
            {round.pause.incidentTitle ?? "An active review incident"}
            {round.pause.reason ? ` · ${round.pause.reason}` : ""}
          </span>
          <small>Reviews already underway can still save and finish.</small>
        </div>
        {pausePending ? (
          <button
            className="secondary"
            disabled={busy}
            type="button"
            onClick={() => void retryPendingCommand(pauseSlot)}
          >
            {busy ? "Confirming…" : "Confirm earlier pause"}
          </button>
        ) : round.pause.canResume && mode !== "resume" ? (
          <button className="secondary" type="button" onClick={() => open("resume")}>
            Resume new reviews
          </button>
        ) : null}
        {!pausePending && round.pause.canResume && mode === "resume" ? (
          <form className="round-pause-form" onSubmit={submit}>
            <label className="field">
              <span>Why it is safe to resume</span>
              <textarea
                disabled={resumePending}
                required
                minLength={5}
                value={reason}
                onChange={(event) => {
                  setError(null);
                  setReason(event.target.value);
                }}
              />
            </label>
            <div className="button-row">
              <button className="primary" disabled={busy || reason.trim().length < 5} type="submit">
                {busy ? "Resuming…" : resumePending ? "Confirm earlier resume" : "Resume"}
              </button>
              <button
                className="secondary"
                disabled={busy || commandPending}
                type="button"
                onClick={() => setMode(null)}
              >
                Cancel
              </button>
            </div>
            {error ? (
              <p className="notice error" role="alert">
                {error}
              </p>
            ) : null}
          </form>
        ) : null}
        {mode !== "resume" && error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    );
  }

  if (resumePending) {
    return (
      <>
        <button
          className="text-button round-pause-open"
          disabled={busy}
          type="button"
          onClick={() => void retryPendingCommand(resumeSlot)}
        >
          {busy ? "Confirming…" : "Confirm earlier resume"}
        </button>
        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}
      </>
    );
  }

  if (!round.canPause) return null;

  if (mode !== "pause") {
    return (
      <>
        <button
          className="text-button round-pause-open"
          type="button"
          onClick={() => open("pause")}
        >
          Pause new review calls and starts
        </button>
        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}
      </>
    );
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
            <select
              disabled={pausePending}
              value={incidentId}
              onChange={(event) => {
                setError(null);
                setIncidentId(event.target.value);
              }}
            >
              {incidents.map((incident) => (
                <option key={incident.id} value={incident.id}>
                  {incident.title}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Reason</span>
            <textarea
              disabled={pausePending}
              required
              minLength={5}
              value={reason}
              onChange={(event) => {
                setError(null);
                setReason(event.target.value);
              }}
            />
          </label>
          <div className="button-row">
            <button className="primary" disabled={busy || reason.trim().length < 5} type="submit">
              {busy ? "Pausing…" : pausePending ? "Confirm earlier pause" : "Pause new reviews"}
            </button>
            <button
              className="secondary"
              disabled={busy || commandPending}
              type="button"
              onClick={() => setMode(null)}
            >
              Cancel
            </button>
          </div>
          {error ? (
            <p className="notice error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      ) : (
        <p className="notice">Open a review incident below before pausing the round.</p>
      )}
    </section>
  );
}

function ReviewerNoShow({
  member,
  clockInVersion,
  panelVersion,
}: {
  member: SubstituteMember | undefined;
  clockInVersion: number;
  panelVersion: number;
}) {
  const markNoShow = useMutation(api.reviewSubstitutions.markNoShow);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.reviewSubstitutions.markNoShow>>();
  const operationSlot = `reviewer-no-show:${member?.panelMemberId ?? "missing"}`;
  const operationPending = operationAttempt.hasPending(operationSlot);

  if (!member?.canMarkNoShow) return null;

  const submit = async () => {
    if (busy || !confirmed || reason.trim().length < 5) return;
    setBusy(true);
    setError(null);
    try {
      await operationAttempt.run(operationSlot, () => {
        const args = {
          eventSlug,
          panelMemberId: member.panelMemberId,
          expectedPanelVersion: panelVersion,
          expectedClockInVersion: clockInVersion,
          reason,
          clientOperationId: crypto.randomUUID(),
        };
        return () => markNoShow(args);
      });
      setOpen(false);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="inline-text-button" type="button" onClick={() => setOpen(true)}>
        Mark no-show
      </button>
    );
  }
  return (
    <div className="inline-command">
      <label className="field">
        <span>Reason</span>
        <input
          disabled={operationPending}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setConfirmed(false);
            setError(null);
          }}
        />
      </label>
      <label className="check-filter">
        <input
          checked={confirmed}
          disabled={operationPending}
          type="checkbox"
          onChange={(event) => {
            setConfirmed(event.target.checked);
          }}
        />
        I confirm this reviewer cannot take the seat. A running review is never interrupted.
      </label>
      <div className="button-row">
        <button
          className="primary"
          disabled={busy || !confirmed || reason.trim().length < 5}
          type="button"
          onClick={() => void submit()}
        >
          {busy ? "Saving…" : operationPending ? "Confirm earlier vacancy" : "Create vacancy"}
        </button>
        <button
          className="secondary compact-link"
          disabled={busy || operationPending}
          type="button"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
      {error ? <small className="notice error">{error}</small> : null}
    </div>
  );
}

function SubstitutionControl({
  panel,
  serverNow,
}: {
  panel: SubstitutionPanel;
  serverNow: number;
}) {
  const startPageChain = useMutation(api.reviewSubstitutions.startPageChain);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.reviewSubstitutions.startPageChain>>();
  const operationSlot = `review-page-chain:${panel.panelId}`;
  const operationPending = operationAttempt.hasPending(operationSlot);

  if (!panel.vacancy && !panel.pageChain) return null;

  const submit = async () => {
    if (!panel.vacancy || busy || reason.trim().length < 5) return;
    const vacancy = panel.vacancy;
    setBusy(true);
    setError(null);
    try {
      await operationAttempt.run(operationSlot, () => {
        const args = {
          eventSlug,
          missingPanelMemberId: vacancy.panelMemberId,
          expectedPanelVersion: panel.panelVersion,
          reason,
          clientOperationId: crypto.randomUUID(),
        };
        return () => startPageChain(args);
      });
      setOpen(false);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel-command substitution-command">
      {panel.vacancy ? (
        <p className="notice">
          Seat open: {panel.vacancy.displayName}
          {panel.vacancy.isCoordinator ? " · coordinator" : ""} ·{" "}
          {panel.vacancy.criterionLabels.join(", ")}
        </p>
      ) : null}
      {panel.pageChain ? (
        <p className="muted exception-policy">
          {reviewerPageChainStateLabels[panel.pageChain.state]} · attempt{" "}
          {panel.pageChain.currentRank}
          {panel.pageChain.currentPage
            ? ` · ${panel.pageChain.currentPage.targetName} ${reviewerPageStateLabels[panel.pageChain.currentPage.state]} until ${formatMoment(panel.pageChain.currentPage.expiresAt)}`
            : ""}
          {panel.pageChain.currentPage?.push
            ? ` · ${reviewerPushDeliveryStateLabels[panel.pageChain.currentPage.push.state]}`
            : panel.pageChain.currentPage
              ? " · push unavailable"
              : ""}
          {panel.pageChain.currentPage?.call
            ? ` · ${outboundCallDeliveryStateLabels[panel.pageChain.currentPage.call.state]}`
            : ""}
          {panel.pageChain.currentPage && panel.pageChain.currentPage.expiresAt <= serverNow
            ? " · expiry processing"
            : ""}
        </p>
      ) : null}
      {panel.canStartPage && panel.vacancy && !open ? (
        <button className="secondary compact-link" type="button" onClick={() => setOpen(true)}>
          Call the next suitable reserve
        </button>
      ) : null}
      {open && panel.vacancy ? (
        <div className="exception-form">
          <label className="field">
            <span>Why the swap</span>
            <textarea
              disabled={operationPending}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setError(null);
              }}
            />
          </label>
          <p className="muted">
            One present, qualified reserve is notified at a time. If they don’t respond, they get a
            call on their verified phone number.
          </p>
          <div className="button-row">
            <button
              className="primary"
              disabled={busy || reason.trim().length < 5}
              type="button"
              onClick={() => void submit()}
            >
              {busy
                ? "Paging…"
                : operationPending
                  ? "Confirm earlier page chain"
                  : "Start page chain"}
            </button>
            <button
              className="secondary compact-link"
              disabled={busy || operationPending}
              type="button"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {error ? <p className="notice error">{error}</p> : null}
    </div>
  );
}

function PanelMembership({ panel, reserves,
}: { panel: SubstitutionPanel; reserves: Reserve[];
}) {
  const swapPanelMember = useMutation(api.reviewPanelMembership.swapPanelMember,
  );
  const [open, setOpen] = useState(false);
  const [leavingPersonId, setLeavingPersonId] = useState("");
  const [joiningPersonId, setJoiningPersonId] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.reviewPanelMembership.swapPanelMember>>();
  const operationSlot = `review-panel-membership:${panel.panelId}`;
  const operationPending = operationAttempt.hasPending(operationSlot);

  if (!panel.canSwapMembers) return null;

  const candidates = reserves.filter((reserve) => reserve.status === "available",
  );
  const leaving = panel.activeMembers.find((member) => member.personId === leavingPersonId,
  );
  const joining = candidates.find((reserve) => reserve.personId === joiningPersonId,
  );

  const changed = () => {
    setConfirmed(false);
    setError(null);
  };

  const submit = async () => {
    if (busy || !confirmed || reason.trim().length < 5 || (!leaving && !joining)) return;
    setBusy(true);
    setError(null);
    try {
      await operationAttempt.run(operationSlot, () => {
        const args = {
          eventSlug,
          panelId: panel.panelId,
          ...(leaving ? { leavingPersonId: leaving.personId } : {}),
          ...(joining ? { joiningPersonId: joining.personId } : {}),
          expectedPanelVersion: panel.panelVersion,
          reason,
          clientOperationId: crypto.randomUUID(),
        };
        return () => swapPanelMember(args);
      });
      setOpen(false);
      setLeavingPersonId("");
      setJoiningPersonId("");
      setReason("");
      setConfirmed(false);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="text-button" type="button" onClick={() => setOpen(true)}>
        Swap a reviewer
      </button>
    );
  }
  return (
    <div className="panel-command">
      <label className="field compact-select">
        <span>Reviewer leaving</span>
        <select
          disabled={operationPending}
          value={leavingPersonId}
          onChange={(event) => {
            setLeavingPersonId(event.target.value);
            changed();
          }}
        >
          <option value="">Nobody leaves</option>
          {panel.activeMembers.map((member) => (
            <option key={member.personId} value={member.personId}>
              {member.displayName}
              {member.isCoordinator ? " · runs this panel" : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="field compact-select">
        <span>Reviewer joining</span>
        <select
          disabled={operationPending}
          value={joiningPersonId}
          onChange={(event) => {
            setJoiningPersonId(event.target.value);
            changed();
          }}
        >
          <option value="">Nobody joins</option>
          {candidates.map((reserve) => (
            <option key={reserve.personId} value={reserve.personId}>
              {reserve.displayName}
            </option>
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
        <span>Reason</span>
        <input
          disabled={operationPending}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            changed();
          }}
        />
      </label>
      <label className="check-filter">
        <input
          checked={confirmed}
          disabled={operationPending}
          type="checkbox"
          onChange={(event) => {
            setConfirmed(event.target.checked);
          }}
        />
        I confirm this seat change with the panel. A running review is never interrupted.
      </label>
      <div className="button-row">
        <button
          className="primary"
          disabled={busy || !confirmed || reason.trim().length < 5 || (!leaving && !joining)}
          type="button"
          onClick={() => void submit()}
        >
          {busy
            ? "Saving…"
            : operationPending
              ? "Confirm earlier panel change"
              : "Change the panel"}
        </button>
        <button
          className="secondary compact-link"
          disabled={busy || operationPending}
          type="button"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
      {error ? <p className="notice error">{error}</p> : null}
    </div>
  );
}

function TeamRow({ board, team }: { board: Board; team: Team }) {
  const queueTeam = useMutation(api.reviewOperations.queueTeam);
  const callTeam = useMutation(api.reviewOperations.callTeam);
  const startReview = useMutation(api.reviewOperations.startReview);
  const completeReview = useMutation(api.reviewOperations.completeReview);
  const manageablePanels = board.panels.filter(
    (panel) => panel.status === "ready" && panel.canManageQueue,
  );
  const [selectedPanelId, setSelectedPanelId] = useState("");
  const [busy, setBusy] = useState<Command | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [availabilityOverrideReason, setAvailabilityOverrideReason] = useState("");
  const [availabilityOverrideConfirmed, setAvailabilityOverrideConfirmed] = useState(false);
  const operationAttempt = useMutationAttempt<TeamReviewCommandResult>();
  const queueSlot = `review-queue:${team.teamId}`;
  const callSlot = `review-call:${team.teamId}`;
  const startSlot = `review-start:${team.review?.id ?? team.teamId}`;
  const completeSlot = `review-complete:${team.review?.id ?? team.teamId}`;
  const queuePending = operationAttempt.hasPending(queueSlot);
  const callPending = operationAttempt.hasPending(callSlot);
  const startPending = operationAttempt.hasPending(startSlot);
  const completePending = operationAttempt.hasPending(completeSlot);
  const selectedPanel =
    manageablePanels.find((panel) => panel.id === selectedPanelId,
  );
  const assignedPanel = team.panelId
    ? board.panels.find((panel) => panel.id === team.panelId)
    : undefined;

  const runQueue = async () => {
    if (busy || (selectedPanelId && !selectedPanel)) return;
    setBusy("queue");
    setError(null);
    try {
      await operationAttempt.run(queueSlot, () => {
        const args = {
          eventSlug,
          roundId: board.round.id,
          ...(selectedPanel ? { panelId: selectedPanel.id } : {}),
          teamId: team.teamId,
          expectedTeamRoundVersion: team.version,
          reason: "Placed by the live review board",
          clientOperationId: crypto.randomUUID(),
        };
        return () => queueTeam(args);
      });
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(null);
    }
  };

  const runCall = async (participantAvailabilityOverrideReason?: string) => {
    if (!assignedPanel || busy) return;
    const overrideReason = participantAvailabilityOverrideReason?.trim();
    setBusy("call");
    setError(null);
    try {
      await operationAttempt.run(callSlot, () => {
        const args = {
          eventSlug,
          roundId: board.round.id,
          panelId: assignedPanel.id,
          teamId: team.teamId,
          expectedTeamRoundVersion: team.version,
          reason: "Called from the live review board",
          ...(overrideReason ? { participantAvailabilityOverrideReason: overrideReason } : {}),
          clientOperationId: crypto.randomUUID(),
        };
        return () => callTeam(args);
      });
      setAvailabilityOverrideReason("");
      setAvailabilityOverrideConfirmed(false);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(null);
    }
  };

  const runStart = async () => {
    if (!team.review || busy) return;
    const review = team.review;
    setBusy("start");
    setError(null);
    try {
      await operationAttempt.run(startSlot, () => {
        const args = {
          eventSlug,
          reviewSessionId: review.id,
          expectedVersion: review.version,
          reason: "Started from the live review board",
          clientOperationId: crypto.randomUUID(),
        };
        return () => startReview(args);
      });
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(null);
    }
  };

  const runComplete = async () => {
    if (!team.review || busy) return;
    const review = team.review;
    setBusy("complete");
    setError(null);
    try {
      await operationAttempt.run(completeSlot, () => {
        const args = {
          eventSlug,
          reviewSessionId: review.id,
          expectedVersion: review.version,
          reason: "Completed after all fixed scorecards were submitted",
          clientOperationId: crypto.randomUUID(),
        };
        return () => completeReview(args);
      });
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(null);
    }
  };

  const review = team.review;
  const allReviewersPresent = review
    ? review.reviewerPresenceCount === review.reviewerCount
    : false;
  const allScorecardsSubmitted = review
    ? review.submittedScorecardCount === review.reviewerCount
    : false;
  const participantAvailabilityReady =
    team.participantAvailability.isMet || team.participantAvailability.isWaived;
  const blocker =
    review?.status === "awaiting_presence" && !allReviewersPresent
      ? <>Waiting for reviewers to scan in · <LiveNumber value={review.reviewerPresenceCount} /> of <LiveNumber value={review.reviewerCount} /> done</>
      : review?.status === "awaiting_presence" && !participantAvailabilityReady
        ? "Waiting for the team to regroup"
        : (review?.status === "active" || review?.status === "scoring") && !allScorecardsSubmitted
          ? <>Waiting for scorecards · <LiveNumber value={review.submittedScorecardCount} /> of <LiveNumber value={review.reviewerCount} /> submitted</>
          : (review?.status === "active" || review?.status === "scoring") &&
              !review.sharedNotesComplete
            ? "Waiting for the panel to agree shared notes"
            : null;

  return (
    <article className="review-team-row">
      <div className="review-team-heading">
        <div>
          <strong>{team.teamName}</strong>
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

      {team.skipReason ? <p className="muted">{team.skipReason}</p> : null}
      <ReviewSkip team={team} round={board.round} />

      {team.state === "skipped" || participantAvailabilityReady && !team.participantAvailability.isWaived ? null : (
        <p className="muted">
          {team.participantAvailability.isWaived
            ? `Called with an exception · ${team.participantAvailability.availableCount} of ${team.participantAvailability.requiredCount} needed were inside`
            : `Only ${team.participantAvailability.availableCount} of the team is in the hall; this round needs ${team.participantAvailability.requiredCount}.`}
        </p>
      )}

      {review ? (
        <dl className="review-progress">
          <div>
            <dt>Reviewer presence</dt>
            <dd>
              <LiveNumber value={review.reviewerPresenceCount} />/<LiveNumber value={review.reviewerCount} />
            </dd>
          </div>
          <div>
            <dt>Scorecards</dt>
            <dd>
              <LiveNumber value={review.submittedScorecardCount} />/<LiveNumber value={review.reviewerCount} />
            </dd>
          </div>
          {review.requiresSharedCommitments ? (
            <div>
              <dt>Shared notes</dt>
              <dd>{review.sharedNotesComplete ? "Ready" : "Missing"}</dd>
            </div>
          ) : null}
          <div>
            <dt>Session</dt>
            <dd>{reviewSessionStatusLabels[review.status]}</dd>
          </div>
        </dl>
      ) : null}

      {team.state === "unassigned" && manageablePanels.length > 0 ? (
        <div className="review-team-actions">
          <label className="field compact-select">
            <span className="visually-hidden">Panel</span>
            <select
              disabled={queuePending}
              value={selectedPanel?.id ?? ""}
              onChange={(event) => setSelectedPanelId(event.target.value)}
            >
              <option value="">Automatic panel selection</option>
              {manageablePanels.map((panel) => (
                <option key={panel.id} value={panel.id}>
                  {panel.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary"
            type="button"
            disabled={busy !== null || Boolean(selectedPanelId && !selectedPanel)
            }
            onClick={() => void runQueue()}
          >
            {busy === "queue"
              ? "Placing…"
              : queuePending
                ? "Confirm earlier placement"
                : "Place in queue"}
          </button>
        </div>
      ) : null}
      {team.state === "queued" &&
      assignedPanel?.canPrepareReview &&
      team.participantAvailability.isMet ? (
        <button
          className="primary"
          type="button"
          disabled={busy !== null}
          onClick={() => void runCall()}
        >
          {busy === "call" ? "Calling…" : callPending ? "Confirm earlier call" : "Call team"}
        </button>
      ) : null}
      {team.state === "queued" &&
      assignedPanel?.canPrepareReview &&
      !team.participantAvailability.isMet ? (
        team.participantAvailability.canWaive ? (
          <details className="team-exceptions">
            <summary>Review without the whole team</summary>
            <div className="exception-form destructive-command">
              <p className="muted">
                Keep the team queued unless staff have confirmed that this review should proceed
                with fewer people.
              </p>
              <label className="field">
                <span>Reason</span>
                <textarea
                  disabled={callPending}
                  value={availabilityOverrideReason}
                  onChange={(event) => {
                    setAvailabilityOverrideReason(event.target.value);
                    setAvailabilityOverrideConfirmed(false);
                    setError(null);
                  }}
                />
              </label>
              <label className="check-filter">
                <input
                  checked={availabilityOverrideConfirmed}
                  disabled={callPending}
                  type="checkbox"
                  onChange={(event) => {
                    setAvailabilityOverrideConfirmed(event.target.checked);
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
                {busy === "call"
                  ? "Calling…"
                  : callPending
                    ? "Confirm earlier exception and call"
                    : "Record exception and call"}
              </button>
            </div>
          </details>
        ) : (
          <p className="notice">The team needs to regroup before it can be called.</p>
        )
      ) : null}
      {review?.status === "awaiting_presence" && review.canStart && !blocker ? (
        <button
          className="primary"
          type="button"
          disabled={busy !== null}
          onClick={() => void runStart()}
        >
          {busy === "start" ? "Starting…" : startPending ? "Confirm earlier start" : "Start review"}
        </button>
      ) : null}
      {(review?.status === "active" || review?.status === "scoring") &&
      review.canComplete &&
      !blocker ? (
        <button
          className="primary"
          type="button"
          disabled={busy !== null}
          onClick={() => void runComplete()}
        >
          {busy === "complete"
            ? "Completing…"
            : completePending
              ? "Confirm earlier completion"
              : "Complete review"}
        </button>
      ) : null}
      {review?.status === "active" && review.canComplete ? (
        <EndDiscussion review={review} />
      ) : null}
      {blocker ? <p className="review-blocked">{blocker}</p> : null}
      {review?.status === "awaiting_presence" && review.canWaivePresence ? (
        <PresenceWaiver review={review} />
      ) : null}
      {review?.status === "awaiting_presence" &&
      !team.participantAvailability.isMet &&
      !team.participantAvailability.isWaived &&
      team.participantAvailability.canWaive ? (
        <ParticipantAvailabilityWaiver review={review} />
      ) : null}
      <TeamExceptions board={board} team={team} />
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}

function PanelAvailability({ panel }: { panel: Panel }) {
  const setPanelAvailability = useMutation(api.reviewExceptions.setPanelAvailability,
  );
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextStatus: "ready" | "paused" = panel.status === "paused" ? "ready" : "paused";
  const operationAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.reviewExceptions.setPanelAvailability>>();
  const operationSlot = `review-panel-availability:${panel.id}:${nextStatus}`;
  const operationPending = operationAttempt.hasPending(operationSlot);

  const submit = async () => {
    if (busy || reason.trim().length < 5) return;
    setBusy(true);
    setError(null);
    try {
      await operationAttempt.run(operationSlot, () => {
        const args = {
          eventSlug,
          panelId: panel.id,
          expectedVersion: panel.version,
          status: nextStatus,
          reason,
          clientOperationId: crypto.randomUUID(),
        };
        return () => setPanelAvailability(args);
      });
      setOpen(false);
      setReason("");
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="text-button" type="button" onClick={() => setOpen(true)}>
        {nextStatus === "paused" ? "Pause panel" : "Resume panel"}
      </button>
    );
  }
  return (
    <div className="panel-command">
      <label className="field">
        <span>{nextStatus === "paused" ? "Pause reason" : "Resume reason"}</span>
        <input
          disabled={operationPending}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setError(null);
          }}
        />
      </label>
      <div className="button-row">
        <button
          className="primary"
          disabled={busy || reason.trim().length < 5}
          type="button"
          onClick={() => void submit()}
        >
          {busy
            ? "Saving…"
            : operationPending
              ? `Confirm earlier ${nextStatus === "paused" ? "pause" : "resume"}`
              : nextStatus === "paused"
                ? "Pause"
                : "Resume"}
        </button>
        <button
          className="secondary compact-link"
          disabled={busy || operationPending}
          type="button"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
      {error ? <p className="notice error">{error}</p> : null}
    </div>
  );
}

type ExceptionCommand = "hold" | "resume" | "move" | "call" | "miss";

function TeamExceptions({ board, team }: { board: Board; team: Team }) {
  const holdTeam = useMutation(api.reviewExceptions.holdTeam);
  const resumeTeam = useMutation(api.reviewExceptions.resumeTeam);
  const moveQueuedTeam = useMutation(api.reviewExceptions.moveQueuedTeam);
  const recordCallAttempt = useMutation(api.reviewExceptions.recordCallAttempt);
  const markMissed = useMutation(api.reviewExceptions.markMissed);
  const [command, setCommand] = useState<ExceptionCommand | null>(null);
  const [targetPanelId, setTargetPanelId] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stateId = team.stateId;
  const operationAttempt = useMutationAttempt<TeamExceptionResult>();
  const moveTargets = board.panels.filter(
    (panel) => panel.id !== team.panelId && panel.status === "ready" && panel.canManageQueue,
  );
  const canHold =
    team.canHold && ["unassigned", "queued", "called", "at_table"].includes(team.state);
  const canResume = team.canResume && (team.state === "held" || team.state === "missed");
  const canMove = team.canMove && team.state === "queued" && moveTargets.length > 0;
  const canCall = team.canMarkMissed && (team.state === "called" || team.state === "at_table");
  const missedPolicyMet =
    canCall &&
    team.callAttemptCount >= board.round.requiredCallAttempts &&
    team.missedEligibleAt !== undefined &&
    board.serverNow >= team.missedEligibleAt;

  if (!stateId || (!canHold && !canResume && !canMove && !canCall)) return null;

  const operationSlot = `review-team-exception:${stateId ?? team.teamId}:${command ?? "none"}`;
  const operationPending = operationAttempt.hasPending(operationSlot);

  const changed = () => {
    setConfirmed(false);
    setError(null);
  };

  const choose = (next: ExceptionCommand) => {
    if (operationPending) return;
    setCommand(next);
    setTargetPanelId(moveTargets[0]?.id ?? "");
    setReason("");
    changed();
  };

  const submit = async () => {
    if (!command || busy || reason.trim().length < 3 || (command === "miss" && !confirmed)) return;
    setBusy(true);
    setError(null);
    try {
      if (command === "hold") {
        await operationAttempt.run(operationSlot, () => {
          const args = {
            eventSlug,
            teamRoundStateId: stateId,
            expectedVersion: team.version,
            reason,
            clientOperationId: crypto.randomUUID(),
          };
          return () => holdTeam(args);
        });
      } else if (command === "resume") {
        await operationAttempt.run(operationSlot, () => {
          const args = {
            eventSlug,
            teamRoundStateId: stateId,
            expectedVersion: team.version,
            reason,
            clientOperationId: crypto.randomUUID(),
          };
          return () => resumeTeam(args);
        });
      } else if (command === "move") {
        const panel = moveTargets.find((candidate) => candidate.id === targetPanelId,
        );
        if (!panel) throw new Error("Choose a current target panel.");
        await operationAttempt.run(operationSlot, () => {
          const args = {
            eventSlug,
            teamRoundStateId: stateId,
            targetPanelId: panel.id,
            expectedVersion: team.version,
            reason,
            clientOperationId: crypto.randomUUID(),
          };
          return () => moveQueuedTeam(args);
        });
      } else if (command === "call") {
        await operationAttempt.run(operationSlot, () => {
          const args = {
            eventSlug,
            teamRoundStateId: stateId,
            expectedVersion: team.version,
            reason,
            clientOperationId: crypto.randomUUID(),
          };
          return () => recordCallAttempt(args);
        });
      } else {
        await operationAttempt.run(operationSlot, () => {
          const args = {
            eventSlug,
            teamRoundStateId: stateId,
            expectedVersion: team.version,
            reason,
            clientOperationId: crypto.randomUUID(),
          };
          return () => markMissed(args);
        });
      }
      setCommand(null);
      setReason("");
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="team-exceptions" open={command !== null}>
      <summary>Something went wrong</summary>
      <div className="exception-choice-row items-center">
        {canHold ? (
          <button
            className="secondary compact-link"
            disabled={operationPending}
            type="button"
            onClick={() => choose("hold")}
          >
            Hold
          </button>
        ) : null}
        {canResume ? (
          <button
            className="secondary compact-link"
            disabled={operationPending}
            type="button"
            onClick={() => choose("resume")}
          >
            Return to queue
          </button>
        ) : null}
        {canMove ? (
          <button
            className="secondary compact-link"
            disabled={operationPending}
            type="button"
            onClick={() => choose("move")}
          >
            Move panel
          </button>
        ) : null}
        {canCall ? (
          <button
            className="secondary compact-link"
            disabled={operationPending}
            type="button"
            onClick={() => choose("call")}
          >
            Record another call
          </button>
        ) : null}
        {missedPolicyMet ? (
          <button
            className="secondary compact-link"
            disabled={operationPending}
            type="button"
            onClick={() => choose("miss")}
          >
            Mark missed
          </button>
        ) : null}
      </div>
      {canCall ? (
        <p className="muted exception-policy">
          <LiveNumber value={team.callAttemptCount} />/{board.round.requiredCallAttempts} calls · missed eligible{" "}
          {team.missedEligibleAt
            ? formatMoment(team.missedEligibleAt)
            : "after the next recorded call"}
        </p>
      ) : null}
      {command ? (
        <div className="exception-form">
          {command === "move" ? (
            <label className="field compact-select">
              <span>Target panel</span>
              <select
                disabled={operationPending}
                value={targetPanelId}
                onChange={(event) => {
                  setTargetPanelId(event.target.value);
                  changed();
                }}
              >
                {moveTargets.map((panel) => (
                  <option key={panel.id} value={panel.id}>
                    {panel.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="field">
            <span>Reason</span>
            <textarea
              disabled={operationPending}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                changed();
              }}
            />
          </label>
          {command === "miss" ? (
            <label className="check-filter">
              <input
                checked={confirmed}
                disabled={operationPending}
                type="checkbox"
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              I confirm the team was called the published number of times and the grace period has
              passed.
            </label>
          ) : null}
          <div className="button-row">
            <button
              className="primary"
              disabled={busy || reason.trim().length < 3 || (command === "miss" && !confirmed)}
              type="button"
              onClick={() => void submit()}
            >
              {busy
                ? "Saving…"
                : operationPending
                  ? `Confirm earlier ${commandLabel(command).toLowerCase()}`
                  : commandLabel(command)}
            </button>
            <button
              className="secondary"
              disabled={busy || operationPending}
              type="button"
              onClick={() => setCommand(null)}
            >
              Cancel
            </button>
          </div>
          {error ? <p className="notice error">{error}</p> : null}
        </div>
      ) : null}
    </details>
  );
}

function PresenceWaiver({ review }: { review: NonNullable<Team["review"]> }) {
  const waivePresence = useMutation(api.reviewExceptions.waivePresence);
  const missing = review.reviewers.filter((reviewer) => reviewer.presenceMethod === undefined,
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.reviewExceptions.waivePresence>>();
  const operationSlot = `review-presence-waiver:${review.id}`;
  const operationPending = operationAttempt.hasPending(operationSlot);

  if (missing.length === 0) return null;

  const changed = () => {
    setConfirmed(false);
    setError(null);
  };

  const submit = async () => {
    const selectedReviewers = missing.filter((reviewer) => selected.includes(reviewer.personId),
    );
    if (busy || !confirmed || selectedReviewers.length === 0 || reason.trim().length < 5) return;
    setBusy(true);
    setError(null);
    try {
      await operationAttempt.run(operationSlot, () => {
        const args = {
          eventSlug,
          reviewSessionId: review.id,
          reviewerPersonIds: selectedReviewers.map((reviewer) => reviewer.personId,
          ),
          expectedVersion: review.version,
          reason,
          clientOperationId: crypto.randomUUID(),
        };
        return () => waivePresence(args);
      });
      setSelected([]);
      setReason("");
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="team-exceptions">
      <summary>Start without every reviewer</summary>
      <div className="exception-form destructive-command">
        <p className="muted">
          Use only after staff physically confirm the named reviewer is with this team.
        </p>
        {missing.map((reviewer) => (
          <label className="check-filter" key={reviewer.personId}>
            <input
              checked={selected.includes(reviewer.personId)}
              disabled={operationPending}
              type="checkbox"
              onChange={(event) => {
                setSelected((current) =>
                  event.target.checked
                    ? [...current, reviewer.personId]
                    : current.filter((personId) => personId !== reviewer.personId,
                      ),
                );
                changed();
              }}
            />
            {reviewer.displayName}
          </label>
        ))}
        <label className="field">
          <span>Reason</span>
          <textarea
            disabled={operationPending}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              changed();
            }}
          />
        </label>
        <label className="check-filter">
          <input
            checked={confirmed}
            disabled={operationPending}
            type="checkbox"
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          I personally confirmed these reviewers are present.
        </label>
        <button
          className="primary"
          disabled={busy || !confirmed || selected.length === 0 || reason.trim().length < 5}
          type="button"
          onClick={() => void submit()}
        >
          {busy ? "Recording…" : operationPending ? "Confirm earlier waiver" : "Record waiver"}
        </button>
        {error ? <p className="notice error">{error}</p> : null}
      </div>
    </details>
  );
}

function ParticipantAvailabilityWaiver({ review,
}: { review: NonNullable<Team["review"]>;
}) {
  const waiveParticipantAvailability = useMutation(
    api.reviewExceptions.waiveParticipantAvailability,
  );
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationAttempt =
    useMutationAttempt<
      FunctionReturnType<typeof api.reviewExceptions.waiveParticipantAvailability>
    >();
  const operationSlot = `review-participant-waiver:${review.id}`;
  const operationPending = operationAttempt.hasPending(operationSlot);

  const changed = () => {
    setConfirmed(false);
    setError(null);
  };

  const submit = async () => {
    if (busy || !confirmed || reason.trim().length < 5) return;
    setBusy(true);
    setError(null);
    try {
      await operationAttempt.run(operationSlot, () => {
        const args = {
          eventSlug,
          reviewSessionId: review.id,
          expectedVersion: review.version,
          reason,
          clientOperationId: crypto.randomUUID(),
        };
        return () => waiveParticipantAvailability(args);
      });
      setReason("");
      setConfirmed(false);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="team-exceptions">
      <summary>Review without the whole team</summary>
      <div className="exception-form destructive-command">
        <p className="muted">
          Use this only after staff confirm the review should begin with fewer participants than the
          published minimum.
        </p>
        <label className="field">
          <span>Reason</span>
          <textarea
            disabled={operationPending}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              changed();
            }}
          />
        </label>
        <label className="check-filter">
          <input
            checked={confirmed}
            disabled={operationPending}
            type="checkbox"
            onChange={(event) => {
              setConfirmed(event.target.checked);
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
          {busy
            ? "Recording…"
            : operationPending
              ? "Confirm earlier exception"
              : "Record exception"}
        </button>
        {error ? <p className="notice error">{error}</p> : null}
      </div>
    </details>
  );
}

function commandLabel(command: ExceptionCommand) {
  if (command === "hold") return "Place on hold";
  if (command === "resume") return "Return team";
  if (command === "move") return "Move team";
  if (command === "call") return "Record call";
  return "Mark missed";
}

function formatMoment(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

function formatWindow(startsAt: number, endsAt: number) {
  const formatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit",
  });
  return `${formatter.format(startsAt)} – ${formatter.format(endsAt)}`;
}

function reviewerState(reviewer: Panel["reviewers"][number], serverNow: number,
) {
  if (reviewer.clockInStatus === "temporarily_unavailable") {
    const returnCopy = reviewer.expectedReturnAt
      ? ` · expected ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(reviewer.expectedReturnAt)}`
      : "";
    return `Temporarily unavailable${returnCopy}`;
  }
  if (reviewer.clockInStatus !== "present") return "Not clocked in";
  if (reviewer.encryptedDraftReady === false) return "Present · encrypted drafts unavailable";
  if (!reviewer.lastHeartbeatAt || serverNow - reviewer.lastHeartbeatAt > 90_000) {
    return "Present · connection stale";
  }
  return `Present · build ${reviewer.appBuild ?? "unknown"}`;
}

function EndDiscussion({ review }: { review: NonNullable<Team["review"]> }) {
  const end = useMutation(api.reviewOperations.endDiscussion);
  const attempt =
    useMutationAttempt<
      FunctionReturnType<typeof api.reviewOperations.endDiscussion>
    >();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await attempt.run("discussion-end", () => {
        const args = {
          eventSlug,
          reviewSessionId: review.id,
          expectedVersion: review.version,
          clientOperationId: crypto.randomUUID(),
        };
        return () => end(args);
      });
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={() => void run()}
      >
        {busy ? "Ending…" : "End discussion and enter scores"}
      </button>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
