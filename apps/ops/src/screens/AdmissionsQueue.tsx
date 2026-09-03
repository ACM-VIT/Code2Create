import { api } from "@code2create/backend/api";
import { useProductAnalytics } from "@code2create/client-observability";
import {
  applicationDecisionLabels,
  applicationStateLabels,
  type ApplicationState,
} from "@code2create/domain";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useState, type SubmitEvent } from "react";
import { Link } from "react-router-dom";

import { LoadingLabel, SkeletonLine, SkeletonList } from "../components/Skeleton";
import {
  aiStateTag,
  assignmentOutcomeSummary,
  busiestStage,
  completedReviewCountQueryArgs,
  needsAssignment,
  ownReviewLine,
  queueLeadSentence,
  reviewStatus,
  reviewerLeadSentence,
  reviewerWorkloadLabel,
  stageAcceptsReviews,
  stageCountMap,
  teamLine,
  visibleStages,
  type AssignmentOutcome,
  type QueueApplication,
  type QueueAssignment,
  type ReviewerWorkload,
} from "../lib/admissionsPresentation";
import { eventSlug } from "../lib/config";
import { isConvexErrorCode, readableError } from "../lib/errors";
import { useOperationRunner } from "../lib/operations";

type AssignmentState = "active" | "completed";
type QueueView = "all" | "mine";

export function AdmissionsQueue({
  canAssign,
  canReadApplications,
  canReadAssignments,
  isSupreme,
}: {
  canAssign: boolean;
  canReadApplications: boolean;
  canReadAssignments: boolean;
  isSupreme: boolean;
}) {
  const [selectedView, setSelectedView] = useState<QueueView>(canReadApplications ? "all" : "mine");
  const view =
    selectedView === "all"
      ? canReadApplications
        ? "all"
        : "mine"
      : canReadAssignments
        ? "mine"
        : "all";

  return (
    <section className="queue-shell admissions-shell">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Before the event</p>
          <h1>Applications</h1>
        </div>
      </header>
      {isSupreme ? <AdmissionResultsRelease /> : null}
      {canReadApplications && canReadAssignments ? (
        <div
          className="configuration-tabs admissions-views"
          role="tablist"
          aria-label="Admission queue view"
        >
          <button
            aria-selected={view === "all"}
            className={view === "all" ? "active" : ""}
            role="tab"
            type="button"
            onClick={() => setSelectedView("all")}
          >
            All applications
          </button>
          <button
            aria-selected={view === "mine"}
            className={view === "mine" ? "active" : ""}
            role="tab"
            type="button"
            onClick={() => setSelectedView("mine")}
          >
            Assigned to me
          </button>
        </div>
      ) : null}
      {view === "all" && canReadApplications ? <ApplicationList canAssign={canAssign} /> : null}
      {view === "mine" && canReadAssignments ? <AssignmentList /> : null}
    </section>
  );
}

function AdmissionResultsRelease() {
  const status = useQuery(api.admissions.admissionResultsReleaseStatus, { eventSlug });
  const release = useMutation(api.admissions.releaseAdmissionResults);
  const operations = useOperationRunner();
  const { capture } = useProductAnalytics();
  const [armed, setArmed] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = operations.hasPending("admission-results-release");
  if (status === undefined) {
    return (
      <section className="catalog-review">
        <LoadingLabel>Checking recorded decisions</LoadingLabel>
      </section>
    );
  }
  if (!status.isSupreme) return null;
  const ready =
    status.serverNow >= status.applicationsCloseAt &&
    status.releasedAt === undefined &&
    status.total > 0 &&
    status.unrecorded === 0;

  const releaseResults = async () => {
    setError(null);
    setBusy(true);
    try {
      if (pending) {
        await operations.retryPending("admission-results-release");
      } else {
        await operations.run(
          "admission-results-release",
          (clientOperationId) => () =>
            release({
              eventSlug,
              expectedEventVersion: status.eventVersion,
              reason,
              clientOperationId,
            }),
        );
      }
      capture("c2c_admission_results_released", {
        c2c_application_count: status.total,
      });
      setArmed(false);
      setReason("");
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="catalog-review admissions-release-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Supreme review</p>
          <h2>{status.releasedAt ? "Admission results released" : "Release admission results"}</h2>
          <p className="muted">
            {status.releasedAt
              ? `${status.releasedByName ?? "Supreme"} released the results. Participant portals and emails use the same decision set.`
              : "Releasing makes every final result visible at once and sends the configured emails."}
          </p>
        </div>
        {!status.releasedAt && !armed ? (
          <button
            className="primary"
            type="button"
            disabled={!ready}
            onClick={() => setArmed(true)}
          >
            Review release
          </button>
        ) : null}
      </div>
      <dl className="catalog-summary">
        <div>
          <dt>Applications</dt>
          <dd>{status.total}</dd>
        </div>
        <div>
          <dt>Decisions ready</dt>
          <dd>{status.recorded + status.released}</dd>
        </div>
        <div>
          <dt>Still needed</dt>
          <dd>{status.unrecorded}</dd>
        </div>
        <div>
          <dt>Selected</dt>
          <dd>{status.accepted}</dd>
        </div>
        <div>
          <dt>Waitlisted</dt>
          <dd>{status.waitlisted}</dd>
        </div>
        <div>
          <dt>Not selected</dt>
          <dd>{status.declined}</dd>
        </div>
      </dl>
      {status.decisions.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Team</th>
                <th>Decision</th>
                <th>Reason</th>
                <th>Recorded by</th>
              </tr>
            </thead>
            <tbody>
              {status.decisions.map((row) => (
                <tr key={row.applicationId}>
                  <td>
                    <Link to={`/admissions/${row.applicationId}`}>{row.teamName}</Link>
                  </td>
                  <td>{applicationDecisionLabels[row.decision]}</td>
                  <td>{row.reasonLabel}</td>
                  <td>{row.decidedByName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {!status.releasedAt && status.unrecorded > 0 ? (
        <p className="notice">
          Record a final decision for all {status.unrecorded} remaining applications before release.
        </p>
      ) : null}
      {!status.releasedAt && armed ? (
        <div className="publish-confirmation">
          <h3>Release all {status.total} results?</h3>
          <p className="muted">
            This is the participant-visible boundary. It cannot be rolled back.
          </p>
          <label className="field">
            <span>Release note</span>
            <textarea
              required
              minLength={5}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.currentTarget.value)}
            />
          </label>
          <div className="button-row">
            <button
              className="primary"
              type="button"
              disabled={busy || reason.trim().length < 5}
              onClick={() => void releaseResults()}
            >
              {busy ? "Releasing…" : pending ? "Confirm earlier release" : "Release all results"}
            </button>
            <button
              className="secondary"
              type="button"
              disabled={busy || pending}
              onClick={() => setArmed(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ApplicationList({ canAssign }: { canAssign: boolean }) {
  const [oneReviewOnly, setOneReviewOnly] = useState(false);
  const reviewCountArgs = completedReviewCountQueryArgs(oneReviewOnly);
  const counts = useQuery(api.admissions.stageCounts, { eventSlug, ...reviewCountArgs });
  const countByState = stageCountMap(counts ?? []);
  const [chosen, setChosen] = useState<ApplicationState | null>(null);
  const stage = chosen ?? busiestStage(countByState) ?? "submitted";
  const [search, setSearch] = useState("");
  const searchQuery = search.trim().replace(/\s+/g, " ");
  const searching = searchQuery.length > 0;
  const applicationPage = usePaginatedQuery(
    api.admissions.list,
    searching ? "skip" : { eventSlug, state: stage, ...reviewCountArgs },
    { initialNumItems: 30 },
  );
  const searchResult = useQuery(
    api.admissions.searchApplications,
    searching ? { eventSlug, state: stage, search: searchQuery, ...reviewCountArgs } : "skip",
  );
  const [assigning, setAssigning] = useState(false);
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const reviewable = stageAcceptsReviews(stage);
  const selecting = canAssign && assigning && reviewable;
  const applications = searching ? (searchResult?.applications ?? []) : applicationPage.results;
  const shown =
    unassignedOnly && reviewable ? applications.filter(needsAssignment) : applications;
  const chosenApplications = shown.filter((application) => selected.has(application.id));
  const loading = searching
    ? searchResult === undefined
    : applicationPage.status === "LoadingFirstPage";

  const toggle = (applicationId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(applicationId)) next.delete(applicationId);
      else next.add(applicationId);
      return next;
    });
  };

  return (
    <>
      {counts === undefined ? (
        <SkeletonLine width="48%" />
      ) : (
        <p className="muted admissions-lead">
          {queueLeadSentence(countByState, oneReviewOnly)}
        </p>
      )}
      <div className="admissions-toolbar">
        <div className="stage-filter admissions-stages">
          {visibleStages(countByState, stage).map((candidate) => (
            <button
              aria-pressed={candidate === stage}
              className={candidate === stage ? "stage-chip active" : "stage-chip"}
              key={candidate}
              type="button"
              onClick={() => {
                setChosen(candidate);
                setSelected(new Set());
              }}
            >
              {applicationStateLabels[candidate]}
              <span>{countByState.get(candidate) ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="admissions-toolbar-actions">
          <label className="compact-search admissions-search">
            <span className="visually-hidden">Find a team</span>
            <input
              maxLength={80}
              placeholder="Find a team"
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setSelected(new Set());
              }}
            />
          </label>
          <label className="check-filter">
            <input
              checked={oneReviewOnly}
              type="checkbox"
              onChange={(event) => {
                setOneReviewOnly(event.target.checked);
                setChosen(null);
                setSelected(new Set());
              }}
            />
            Only 1 review in
          </label>
          {reviewable ? (
            <>
              <label className="check-filter">
                <input
                  checked={unassignedOnly}
                  type="checkbox"
                  onChange={(event) => {
                    setUnassignedOnly(event.target.checked);
                    setSelected(new Set());
                  }}
                />
                Only nobody assigned
              </label>
              {canAssign ? (
                <button
                  className={selecting ? "secondary active" : "secondary"}
                  type="button"
                  onClick={() => {
                    setAssigning(!assigning);
                    setSelected(new Set());
                  }}
                >
                  {selecting ? "Done assigning" : "Assign reviewers"}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      {selecting ? (
        <AssignBar
          applications={chosenApplications}
          pageSize={shown.length}
          onAssigned={(applicationIds) =>
            setSelected((current) => {
              const next = new Set(current);
              for (const applicationId of applicationIds) next.delete(applicationId);
              return next;
            })
          }
          onClear={() => setSelected(new Set())}
          onSelectAll={() => setSelected(new Set(shown.map((application) => application.id)))}
        />
      ) : null}
      <div className="queue-list admissions-list">
        {shown.map((application) => (
          <ApplicationRow
            application={application}
            key={application.id}
            selectable={selecting}
            selected={selected.has(application.id)}
            onToggle={() => toggle(application.id)}
          />
        ))}
        {loading ? (
          <>
            <LoadingLabel>{searching ? "Searching teams" : "Loading applications"}</LoadingLabel>
            <SkeletonList rows={5} />
          </>
        ) : null}
        {!loading && shown.length === 0 ? (
          <p className="empty">
            {searching
              ? applications.length > 0
                ? "Every matching team already has a reviewer."
                : `No teams match “${searchQuery}” at ${applicationStateLabels[stage]}.`
              : countByState.size === 0
                ? oneReviewOnly
                  ? "No team has exactly 1 review in."
                  : "No team has applied yet."
                : applications.length > 0
                  ? "Everyone shown here has a reviewer."
                  : `Nothing at ${applicationStateLabels[stage]} right now.`}
          </p>
        ) : null}
      </div>
      {searchResult?.truncated ? (
        <p className="muted admissions-search-limit">More teams match. Refine your search.</p>
      ) : null}
      {!searching && applicationPage.status === "CanLoadMore" ? (
        <button className="secondary" type="button" onClick={() => applicationPage.loadMore(30)}>
          Load more
        </button>
      ) : null}
    </>
  );
}

function ApplicationRow({
  application,
  selectable,
  selected,
  onToggle,
}: {
  application: QueueApplication;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const reviews = reviewStatus(application);
  const ai = aiStateTag(application.aiState, application.aiRecommendation);
  const content = (
    <>
      <span className="admission-row-main">
        <strong>{application.teamName}</strong>
        <span>{teamLine(application.memberCount, application.cohort)}</span>
      </span>
      <span className="admission-row-meta">
        <span className={`admission-reviews ${reviews.tone}`}>{reviews.text}</span>
        {application.decisionStage === "recorded" && application.humanDecision ? (
          <span>Recorded · {applicationDecisionLabels[application.humanDecision]}</span>
        ) : null}
        {ai ? <span className={`admission-tag ${ai.tone}`}>{ai.text}</span> : null}
      </span>
    </>
  );
  if (selectable) {
    return (
      <label
        className={selected ? "admission-row selectable selected" : "admission-row selectable"}
      >
        <span className="admission-check">
          <input
            aria-label={`Select ${application.teamName}`}
            checked={selected}
            type="checkbox"
            onChange={onToggle}
          />
        </span>
        <span className="admission-row-link">{content}</span>
      </label>
    );
  }
  return (
    <div className="admission-row">
      <Link className="admission-row-link" to={`/admissions/${application.id}`}>
        {content}
      </Link>
    </div>
  );
}

function AssignBar({
  applications,
  pageSize,
  onAssigned,
  onClear,
  onSelectAll,
}: {
  applications: QueueApplication[];
  pageSize: number;
  onAssigned: (applicationIds: string[]) => void;
  onClear: () => void;
  onSelectAll: () => void;
}) {
  const assignReview = useMutation(api.admissions.assignReview);
  const workload = useQuery(api.admissions.reviewerWorkload, { eventSlug });
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ email: string; results: AssignmentOutcome[] } | null>(
    null,
  );
  const reviewerEmail = email.trim().toLowerCase();
  const ready = reviewerEmail.length > 0 && applications.length > 0;

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    const results: AssignmentOutcome[] = [];
    const assignedIds: string[] = [];
    for (const application of applications) {
      try {
        await assignReview({
          eventSlug,
          applicationId: application.id,
          expectedApplicationVersion: application.version,
          reviewerEmail,
          clientOperationId: crypto.randomUUID(),
        });
        results.push({ teamName: application.teamName, ok: true });
        assignedIds.push(application.id);
      } catch (caught) {
        results.push({ teamName: application.teamName, ok: false, message: readableError(caught) });
        // A reviewer nobody can find fails the same way for every application, so stop at the first.
        if (isConvexErrorCode(caught, "REVIEWER_NOT_ACTIVE")) break;
      }
    }
    setOutcome({ email: reviewerEmail, results });
    onAssigned(assignedIds);
    setBusy(false);
  };

  const failures = outcome?.results.filter((result) => !result.ok) ?? [];

  return (
    <form className="admission-assign-bar" onSubmit={(event) => void submit(event)}>
      <div className="admission-assign-selection">
        <strong>{applications.length} selected</strong>
        <button className="text-button" disabled={busy} type="button" onClick={onSelectAll}>
          Select all {pageSize} shown
        </button>
        <button
          className="text-button"
          disabled={busy || applications.length === 0}
          type="button"
          onClick={onClear}
        >
          Clear
        </button>
      </div>
      <label className="field admission-assign-email">
        Reviewer Google email
        <input
          disabled={busy}
          placeholder="name@vit.ac.in"
          required
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <button className="primary" disabled={busy || !ready} type="submit">
        {busy
          ? "Assigning…"
          : applications.length === 0
            ? "Assign"
            : `Assign ${applications.length === 1 ? "1 application" : `${applications.length} applications`}`}
      </button>
      {workload !== undefined && workload.length > 0 ? (
        <div className="admission-assign-reviewers">
          <span>Reviewers so far</span>
          {workload.map((reviewer: ReviewerWorkload) => (
            <button
              aria-pressed={reviewer.email === reviewerEmail}
              className={reviewer.email === reviewerEmail ? "stage-chip active" : "stage-chip"}
              disabled={busy}
              key={reviewer.personId}
              title={reviewer.email}
              type="button"
              onClick={() => setEmail(reviewer.email)}
            >
              {reviewer.displayName}
              <span>{reviewerWorkloadLabel(reviewer)}</span>
            </button>
          ))}
        </div>
      ) : null}
      {outcome ? (
        <div className="admission-assign-outcomes" role="status">
          <p>{assignmentOutcomeSummary(outcome.results, outcome.email)}</p>
          {failures.length > 0 ? (
            <ul>
              {failures.map((result) => (
                <li key={result.teamName}>
                  {result.teamName}: {result.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

function AssignmentList() {
  const counts = useQuery(api.admissions.myReviewAssignmentCounts, { eventSlug });
  const [state, setState] = useState<AssignmentState>("active");
  const { results, status, loadMore } = usePaginatedQuery(
    api.admissions.myReviewAssignments,
    { eventSlug, state },
    { initialNumItems: 30 },
  );

  return (
    <>
      {counts === undefined ? (
        <SkeletonLine width="40%" />
      ) : (
        <p className="muted admissions-lead">{reviewerLeadSentence(counts)}</p>
      )}
      <div className="stage-filter admissions-stages">
        <button
          aria-pressed={state === "active"}
          className={state === "active" ? "stage-chip active" : "stage-chip"}
          type="button"
          onClick={() => setState("active")}
        >
          To review
          {counts === undefined ? null : <span>{counts.active}</span>}
        </button>
        <button
          aria-pressed={state === "completed"}
          className={state === "completed" ? "stage-chip active" : "stage-chip"}
          type="button"
          onClick={() => setState("completed")}
        >
          Done
          {counts === undefined ? null : <span>{counts.completed}</span>}
        </button>
      </div>
      <div className="queue-list admissions-list">
        {results.map((assignment) => (
          <AssignmentRow assignment={assignment} key={assignment.assignmentId} />
        ))}
        {status === "LoadingFirstPage" ? (
          <>
            <LoadingLabel>Loading your review work</LoadingLabel>
            <SkeletonList rows={5} />
          </>
        ) : null}
        {status !== "LoadingFirstPage" && results.length === 0 ? (
          <p className="empty">
            {state === "active" ? "Nothing to review right now." : "No completed reviews yet."}
          </p>
        ) : null}
      </div>
      {status === "CanLoadMore" ? (
        <button className="secondary" type="button" onClick={() => loadMore(30)}>
          Load more
        </button>
      ) : null}
    </>
  );
}

function AssignmentRow({ assignment }: { assignment: QueueAssignment }) {
  const own = ownReviewLine(assignment);
  const ai = aiStateTag(assignment.aiState, assignment.aiRecommendation);
  return (
    <div className="admission-row">
      <Link className="admission-row-link" to={`/admissions/${assignment.applicationId}`}>
        <span className="admission-row-main">
          <strong>{assignment.teamName}</strong>
          <span>{teamLine(assignment.memberCount, assignment.cohort)}</span>
        </span>
        <span className="admission-row-meta">
          <span className={own.done ? "admission-reviews done" : "admission-reviews waiting"}>
            {own.text}
          </span>
          <span>{applicationStateLabels[assignment.applicationState]}</span>
          {ai ? <span className={`admission-tag ${ai.tone}`}>{ai.text}</span> : null}
        </span>
      </Link>
    </div>
  );
}
