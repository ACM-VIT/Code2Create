import { LiveNumber } from "../components/LiveNumber";
import { api } from "@code2create/backend/api";
import { useProductAnalytics } from "@code2create/client-observability";
import {
  applicationDecisionLabels,
  applicationStateLabels,
} from "@code2create/domain";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { Link } from "react-router-dom";

import { LoadingLabel, SkeletonLine, SkeletonList } from "../components/Skeleton";
import { QueuePagination } from "../components/QueuePagination";
import { AdmissionStat } from "../components/AdmissionStat";
import {
  aiStateTag,
  applicationQueueStageLabels,
  assignmentOutcomeSummary,
  ownReviewLine,
  prioritizeReviewQueue,
  recommendationFilterLabel,
  recommendationOutcomeLabels,
  reviewProgressLabels,
  reviewProgressLeadSentence,
  reviewProgresses,
  reviewStatus,
  reviewerLeadSentence,
  reviewerWorkloadLabel,
  stageAcceptsReviews,
  stageCountMap,
  teamLine,
  teamOriginFilterLabels,
  teamOriginFilters,
  teamOriginNoun,
  teamOriginQueryArgs,
  visibleStages,
  type AssignmentOutcome,
  type ApplicationQueueStage,
  type QueueApplication,
  type QueueAssignment,
  type ReviewerWorkload,
  type RecommendationFilter,
  type ReviewProgress,
  type TeamOriginFilter,
} from "../lib/admissionsPresentation";
import { eventSlug } from "../lib/config";
import { isConvexErrorCode, readableError } from "../lib/errors";
import { useOperationRunner } from "../lib/operations";
import { useReviewAssignmentCounts } from "../lib/useReviewAssignmentCounts";
import { admissionPageSize, useQueuePagination } from "../lib/useQueuePagination";

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
  const [origin, setOrigin] = useState<TeamOriginFilter>("all");
  const [recommendationFilter, setRecommendationFilter] = useState<RecommendationFilter | null>(null);
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
      {isSupreme ? (
        <AdmissionResultsRelease
          recommendationFilter={recommendationFilter}
          onFilter={canReadApplications ? (filter) => {
            setSelectedView("all");
            setOrigin("all");
            setRecommendationFilter((current) => current?.source === filter.source && current.outcome === filter.outcome ? null : filter);
          } : undefined}
        />
      ) : null}
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
            onClick={() => {
              setSelectedView("mine");
              setRecommendationFilter(null);
            }}
          >
            Assigned to me
          </button>
        </div>
      ) : null}
      <div className="admissions-scope">
        <span className="admissions-control-label">Team type</span>
        <div
          className="stage-filter admissions-origins"
          role="group"
          aria-label="Team type"
        >
          {teamOriginFilters.map((candidate) => (
            <button
              aria-pressed={candidate === origin}
              className={candidate === origin ? "stage-chip active" : "stage-chip"}
              key={candidate}
              type="button"
              onClick={() => setOrigin(candidate)}
            >
              {teamOriginFilterLabels[candidate]}
            </button>
          ))}
        </div>
      </div>
      {view === "all" && canReadApplications ? (
        <ApplicationList
          key={recommendationFilter ? recommendationFilterLabel(recommendationFilter) : "queue"}
          canAssign={canAssign}
          origin={origin}
          recommendationFilter={recommendationFilter}
          onClearRecommendationFilter={() => setRecommendationFilter(null)}
        />
      ) : null}
      {view === "mine" && canReadAssignments ? <AssignmentList origin={origin} /> : null}
    </section>
  );
}

function AdmissionResultsRelease({ recommendationFilter, onFilter }: {
  recommendationFilter: RecommendationFilter | null;
  onFilter: ((filter: RecommendationFilter) => void) | undefined;
}) {
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
  const ideaAgent = status.ideaAgent;
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
      <dl className="catalog-summary" aria-label="Human review progress">
        <AdmissionStat label="Applications" value={status.total} people={status.people.total} />
        <AdmissionStat label="Reviews complete" value={status.reviewsComplete} people={status.people.reviewsComplete} />
        <AdmissionStat label="Reviews needed" value={status.reviewsNeeded} people={status.people.reviewsNeeded} />
      </dl>
      <dl className="catalog-summary" aria-label="Final admission decisions">
        <AdmissionStat label="Final decisions ready" value={status.recorded + status.released} people={status.people.recorded + status.people.released} />
        <AdmissionStat label="Final decisions needed" value={status.unrecorded} people={status.people.unrecorded} />
        <AdmissionStat label="Selected" value={status.accepted} people={status.people.accepted} />
        <AdmissionStat label="Waitlisted" value={status.waitlisted} people={status.people.waitlisted} />
        <AdmissionStat label="Not selected" value={status.declined} people={status.people.declined} />
      </dl>
      {ideaAgent ? (
        <section aria-labelledby="idea-agent-breakdown">
          <div className="section-heading">
            <div>
              <h3 id="idea-agent-breakdown">Idea agent</h3>
            </div>
          </div>
          <dl className="catalog-summary" aria-label="Idea agent recommendations">
            {(["accepted", "waitlisted", "rejected", "unavailable"] as const).map((outcome) => (
              <AdmissionStat
                key={outcome}
                label={recommendationOutcomeLabels[outcome]}
                value={ideaAgent[outcome]}
                people={ideaAgent.people[outcome]}
                selected={recommendationFilter?.source === "idea" && recommendationFilter.outcome === outcome}
                onSelect={onFilter ? () => onFilter({ source: "idea", outcome }) : undefined}
              />
            ))}
          </dl>
        </section>
      ) : null}
      <section aria-labelledby="human-review-breakdown">
        <div className="section-heading">
          <div>
            <h3 id="human-review-breakdown">Human reviews</h3>
          </div>
        </div>
        <dl className="catalog-summary" aria-label="Human recommendations">
          {(["accepted", "waitlisted", "rejected", "split", "needed"] as const).map((outcome) => (
            <AdmissionStat
              key={outcome}
              label={recommendationOutcomeLabels[outcome]}
              value={status.humanReviews[outcome]}
              people={status.humanReviews.people[outcome]}
              selected={recommendationFilter?.source === "human" && recommendationFilter.outcome === outcome}
              onSelect={onFilter ? () => onFilter({ source: "human", outcome }) : undefined}
            />
          ))}
        </dl>
      </section>
      {!status.releasedAt && status.unrecorded > 0 ? (
        <p className="notice">
          Record a final decision for all <LiveNumber value={status.unrecorded} /> remaining applications before release.
        </p>
      ) : null}
      {!status.releasedAt && armed ? (
        <div className="publish-confirmation">
          <h3>Release all <LiveNumber value={status.total} /> results?</h3>
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

function ApplicationList({
  canAssign,
  origin,
  recommendationFilter,
  onClearRecommendationFilter,
}: {
  canAssign: boolean;
  origin: TeamOriginFilter;
  recommendationFilter: RecommendationFilter | null;
  onClearRecommendationFilter: () => void;
}) {
  const originArgs = teamOriginQueryArgs(origin);
  const stageCounts = useQuery(api.admissions.stageCounts, { eventSlug, ...originArgs });
  const progressCounts = useQuery(api.admissions.reviewProgressCounts, {
    eventSlug,
    ...originArgs,
  });
  const countByState = stageCountMap(stageCounts ?? []);
  const totalApplications = [...countByState.values()].reduce((sum, count) => sum + count, 0);
  const [stage, setStage] = useState<ApplicationQueueStage | null>(null);
  const [reviewProgress, setReviewProgress] = useState<ReviewProgress | null>("unreviewed");
  const reviewable = recommendationFilter === null && (
    reviewProgress === "unreviewed" ||
    reviewProgress === "partial" ||
    (reviewProgress === null && stage !== null && stageAcceptsReviews(stage))
  );
  const [search, setSearch] = useState("");
  const searchQuery = search.trim().replace(/\s+/g, " ");
  const searching = searchQuery.length > 0;
  const scopeArgs = recommendationFilter
    ? { recommendationFilter }
    : reviewProgress !== null
      ? { reviewProgress }
      : stage !== null
        ? { state: stage }
        : {};
  const applicationPage = usePaginatedQuery(
    api.admissions.list,
    searching
      ? "skip"
      : { eventSlug, ...scopeArgs, ...originArgs },
    { initialNumItems: admissionPageSize },
  );
  const searchResult = useQuery(
    api.admissions.searchApplications,
    searching
      ? {
          eventSlug,
          ...scopeArgs,
          search: searchQuery,
          ...originArgs,
        }
      : "skip",
  );
  const [assigning, setAssigning] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const selecting = canAssign && assigning && reviewable;
  const applications = searching ? (searchResult?.applications ?? []) : applicationPage.results;
  const pagination = useQueuePagination(
    applications,
    searching ? searchResult === undefined ? "LoadingFirstPage" : "Exhausted" : applicationPage.status,
    applicationPage.loadMore,
    JSON.stringify([stage, reviewProgress, origin, searchQuery, recommendationFilter]),
  );
  const shown = reviewable ? prioritizeReviewQueue(pagination.items) : pagination.items;
  const chosenApplications = shown.filter((application) => selected.has(application.id));
  const loading = pagination.loading;
  const filtersActive = searching || reviewProgress !== null || stage !== null || recommendationFilter !== null;

  useEffect(() => {
    setSelected(new Set());
  }, [origin, pagination.page]);

  const toggle = (applicationId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(applicationId)) next.delete(applicationId);
      else next.add(applicationId);
      return next;
    });
  };

  const clearFilters = () => {
    setSearch("");
    setReviewProgress(null);
    setStage(null);
    setSelected(new Set());
    onClearRecommendationFilter();
  };

  return (
    <>
      <div className="admissions-overview">
        <div>
          <span className="admissions-control-label">Queue summary</span>
          {progressCounts === undefined ? (
            <SkeletonLine width="48%" />
          ) : (
            <p className="muted admissions-lead">
              {reviewProgressLeadSentence(progressCounts, origin)}
            </p>
          )}
        </div>
        {reviewable ? (
          <p className="admissions-lease-note">
            <strong>30-minute review window</strong>
            <span>Unfinished assignments release automatically.</span>
          </p>
        ) : null}
      </div>
      <div className="admissions-controls">
        {recommendationFilter ? (
          <div className="admissions-stage-control">
            <p>{recommendationFilterLabel(recommendationFilter)}</p>
          </div>
        ) : (
          <>
            <div className="admissions-stage-control">
              <span className="admissions-control-label">Review coverage</span>
              <div className="stage-filter admissions-stages">
                <button
                  aria-pressed={reviewProgress === null && stage === null}
                  className={
                    reviewProgress === null && stage === null
                      ? "stage-chip active"
                      : "stage-chip"
                  }
                  type="button"
                  onClick={() => {
                    setReviewProgress(null);
                    setStage(null);
                    setSelected(new Set());
                  }}
                >
                  All applications
                  {stageCounts === undefined ? null : (
                    <span><LiveNumber value={totalApplications} /></span>
                  )}
                </button>
                {reviewProgresses.map((progress) => (
                  <button
                    aria-pressed={reviewProgress === progress}
                    className={reviewProgress === progress ? "stage-chip active" : "stage-chip"}
                    key={progress}
                    type="button"
                    onClick={() => {
                      setReviewProgress(progress);
                      setStage(null);
                      setSelected(new Set());
                    }}
                  >
                    {reviewProgressLabels[progress]}
                    {progressCounts === undefined ? null : (
                      <span><LiveNumber value={progressCounts[progress]} /></span>
                    )}
                  </button>
                ))}
              </div>
            </div>
            <div className="admissions-stage-control">
              <span className="admissions-control-label">Application lifecycle</span>
              <div className="stage-filter admissions-stages">
                {visibleStages(countByState, stage).map((candidate) => (
                  <button
                    aria-pressed={reviewProgress === null && candidate === stage}
                    className={
                      reviewProgress === null && candidate === stage
                        ? "stage-chip active"
                        : "stage-chip"
                    }
                    key={candidate}
                    type="button"
                    onClick={() => {
                      setStage(candidate);
                      setReviewProgress(null);
                      setSelected(new Set());
                    }}
                  >
                    {applicationQueueStageLabels[candidate]}
                    <span><LiveNumber value={countByState.get(candidate) ?? 0} /></span>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
        <div className="admissions-toolbar">
          <label className="field compact-search admissions-search">
            <span>Search teams</span>
            <input
              maxLength={80}
              placeholder="Enter a team name"
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setSelected(new Set());
              }}
            />
          </label>
          <div className="admissions-toolbar-buttons">
            {filtersActive ? (
              <button className="text-button" type="button" onClick={clearFilters}>
                Clear filters
              </button>
            ) : null}
            {reviewable && canAssign ? (
              <button
                className={selecting ? "secondary active" : "secondary"}
                type="button"
                onClick={() => {
                  setAssigning(!assigning);
                  setSelected(new Set());
                }}
              >
                {selecting ? "Finish assigning" : "Assign review work"}
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {selecting ? (
        <AssignBar
          applications={chosenApplications}
          onAssigned={(applicationIds) =>
            setSelected((current) => {
              const next = new Set(current);
              for (const applicationId of applicationIds) next.delete(applicationId);
              return next;
            })
          }
          onClear={() => setSelected(new Set())}
        />
      ) : null}
      <div className="queue-list admissions-list" ref={listRef} tabIndex={-1} aria-busy={loading}>
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
            {recommendationFilter
              ? "No matching teams."
              : searching
                ? `No ${teamOriginNoun(origin)} match “${searchQuery}” in this view.`
                : reviewProgress !== null
                  ? reviewProgress === "unreviewed"
                    ? `No ${teamOriginNoun(origin)} have zero completed reviews.`
                    : reviewProgress === "partial"
                      ? `No ${teamOriginNoun(origin)} are partially reviewed.`
                      : `No ${teamOriginNoun(origin)} have met the review minimum.`
                  : stage !== null
                    ? `No ${teamOriginNoun(origin)} are at ${applicationQueueStageLabels[stage]}.`
                    : origin === "all"
                      ? "No applications right now."
                      : `No ${teamOriginNoun(origin)} have applied.`}
          </p>
        ) : null}
      </div>
      {searchResult?.truncated ? (
        <p className="muted admissions-search-limit">More teams match. Refine your search.</p>
      ) : null}
      <QueuePagination {...pagination} listRef={listRef} total={searchResult?.truncated ? undefined : pagination.total} />
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
      <span
        className="admission-row-score"
        role="group"
        aria-label={`Human review score: ${application.humanReviewScore.accept} accept, ${application.humanReviewScore.waitlist} waitlist, ${application.humanReviewScore.reject} reject`}
      >
        <span>Human review score</span>
        <strong>
          <LiveNumber value={application.humanReviewScore.accept} /> / <LiveNumber value={application.humanReviewScore.waitlist} /> /{" "}
          <LiveNumber value={application.humanReviewScore.reject} />
        </strong>
        <small>Accept / Waitlist / Reject</small>
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
  onAssigned,
  onClear,
}: {
  applications: QueueApplication[];
  onAssigned: (applicationIds: string[]) => void;
  onClear: () => void;
}) {
  const assignReview = useMutation(api.admissions.assignReview);
  const workload = useQuery(api.admissions.reviewerWorkload, { eventSlug });
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmedBulkAssignmentKey, setConfirmedBulkAssignmentKey] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ email: string; results: AssignmentOutcome[] } | null>(
    null,
  );
  const reviewerEmail = email.trim().toLowerCase();
  const ready = reviewerEmail.length > 0 && applications.length > 0;
  const selectionKey = applications.map((application) => application.id).join(":");
  const bulkAssignmentKey = `${reviewerEmail}:${selectionKey}`;
  const confirmingBulkAssignment = confirmedBulkAssignmentKey === bulkAssignmentKey;

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy || !ready) return;
    if (applications.length > 1 && !confirmingBulkAssignment) {
      setConfirmedBulkAssignmentKey(bulkAssignmentKey);
      return;
    }
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
    setConfirmedBulkAssignmentKey(null);
    setBusy(false);
  };

  const failures = outcome?.results.filter((result) => !result.ok) ?? [];

  return (
    <form className="admission-assign-bar" onSubmit={(event) => void submit(event)}>
      <div className="admission-assign-selection">
        <strong><LiveNumber value={applications.length} /> selected</strong>
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
      {confirmingBulkAssignment ? (
        <div className="admission-assign-confirmation" role="alert">
          <div>
            <strong>Assign <LiveNumber value={applications.length} /> applications to one reviewer?</strong>
            <p>
              Confirm the count and email. Every assignment remains open for up to 30 minutes.
            </p>
          </div>
          <div className="button-row">
            <button className="primary" disabled={busy} type="submit">
              {busy ? "Assigning…" : `Confirm ${applications.length} assignments`}
            </button>
            <button
              className="secondary"
              disabled={busy}
              type="button"
              onClick={() => setConfirmedBulkAssignmentKey(null)}
            >
              Go back
            </button>
          </div>
        </div>
      ) : (
        <button className="primary" disabled={busy || !ready} type="submit">
          {busy
            ? "Assigning…"
            : applications.length === 0
              ? "Choose a team"
              : applications.length === 1
                ? "Assign 1 application"
                : `Review ${applications.length} assignments`}
        </button>
      )}
      <p className="admission-assign-rule">
        Select teams individually. Unfinished assignments expire after 30 minutes.
      </p>
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

function AssignmentList({ origin }: { origin: TeamOriginFilter }) {
  const originArgs = teamOriginQueryArgs(origin);
  const listRef = useRef<HTMLDivElement>(null);
  const counts = useReviewAssignmentCounts(origin);
  const [state, setState] = useState<AssignmentState>("active");
  const { results, status, loadMore } = usePaginatedQuery(
    api.admissions.myReviewAssignments,
    { eventSlug, state, ...originArgs },
    { initialNumItems: admissionPageSize },
  );
  const pagination = useQueuePagination(results, status, loadMore, JSON.stringify([state, origin]));

  return (
    <>
      {counts === undefined ? (
        <SkeletonLine width="40%" />
      ) : (
        <p className="muted admissions-lead">{reviewerLeadSentence(counts, origin)}</p>
      )}
      <div className="stage-filter admissions-stages">
        <button
          aria-pressed={state === "active"}
          className={state === "active" ? "stage-chip active" : "stage-chip"}
          type="button"
          onClick={() => setState("active")}
        >
          To review
          {counts === undefined ? null : <span><LiveNumber value={counts.active} /></span>}
        </button>
        <button
          aria-pressed={state === "completed"}
          className={state === "completed" ? "stage-chip active" : "stage-chip"}
          type="button"
          onClick={() => setState("completed")}
        >
          Done
          {counts === undefined ? null : <span><LiveNumber value={counts.completed} /></span>}
        </button>
      </div>
      <div className="queue-list admissions-list" ref={listRef} tabIndex={-1} aria-busy={pagination.loading}>
        {pagination.items.map((assignment) => (
          <AssignmentRow assignment={assignment} key={assignment.assignmentId} />
        ))}
        {pagination.loading ? (
          <>
            <LoadingLabel>Loading your review work</LoadingLabel>
            <SkeletonList rows={5} />
          </>
        ) : null}
        {!pagination.loading && pagination.items.length === 0 ? (
          <p className="empty">
            {state === "active"
              ? origin === "all"
                ? "Nothing to review right now."
                : `No ${teamOriginNoun(origin)} to review right now.`
              : origin === "all"
                ? "No completed reviews yet."
                : `No completed reviews of ${teamOriginNoun(origin)} yet.`}
          </p>
        ) : null}
      </div>
      <QueuePagination {...pagination} listRef={listRef} />
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
          {assignment.claimExpiresAt === undefined ? null : (
            <span className="admission-claim-deadline">
              Review by{" "}
              <time dateTime={new Date(assignment.claimExpiresAt).toISOString()}>
                {new Date(assignment.claimExpiresAt).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </time>
            </span>
          )}
          {ai ? <span className={`admission-tag ${ai.tone}`}>{ai.text}</span> : null}
        </span>
      </Link>
    </div>
  );
}
