import type { ReactNode } from "react";
import { LiveNumber } from "../components/LiveNumber";
import { api } from "@code2create/backend/api";
import {
  reviewEvaluationStateLabels,
  reviewRoundStatusLabels,
  reviewSessionStatusLabels,
  roundExportStateLabels,
  scorecardCorrectionCategoryLabels,
  scorecardCorrectionKindLabels,
  scorecardCorrectionStateLabels,
  scorecardStatusLabels,
} from "@code2create/domain";
import type { FunctionReturnType } from "convex/server";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { eventSlug } from "../lib/config";
import { formatMonthDayTime as formatTime } from "../lib/dateTime";
import { readableError } from "../lib/errors";
import { useMutationAttempt } from "../lib/operations";
import { useEstimatedServerNow } from "../lib/useEstimatedServerNow";
import { LoadingLabel, SkeletonList, SkeletonStats,
} from "../components/Skeleton";
import { RoundExportControl } from "../components/RoundExportControl";
import { ReviewProgression } from "../components/ReviewProgression";

type Completeness = FunctionReturnType<typeof api.scoreGovernance.completeness>;
type Review = FunctionReturnType<typeof api.scoreGovernance.completenessReviews>["page"][number];
type Scorecard = Review["scorecards"][number];
type CorrectionCase = NonNullable<Scorecard["currentCase"]>;
type Standings = FunctionReturnType<typeof api.scoreGovernance.roundStandings>;
type StandingsRow = Standings["rows"][number];
type StandingsCriterion = Standings["criteria"][number];
type ReviewDetailData = FunctionReturnType<typeof api.scoreGovernance.reviewDetail>;
type ReviewView = "needs_action" | "settled" | "all";
type ResultView = "all" | "scored" | "unscored" | "far_apart" | "short";

const scoreGovernancePageSize = 30;
const resultViews: ResultView[] = ["all", "scored", "unscored", "far_apart", "short"];
const isResultView = (value: string): value is ResultView =>
  (resultViews as string[]).includes(value);
const resultViewLabels: Record<ResultView, string> = {
  all: "Every review",
  scored: "Scored",
  unscored: "Not scored yet",
  far_apart: "Reviewers far apart",
  short: "Short of scorers",
};
const fixedSortLabels = {
  score: "Highest total first",
  score_asc: "Lowest total first",
  team: "Team A to Z",
  panel: "By panel",
  recent: "Most recently finished",
} as const;
type FixedSort = keyof typeof fixedSortLabels;
const isFixedSort = (value: string): value is FixedSort => value in fixedSortLabels;

function useResultFilters() {
  const [params, setParams] = useSearchParams();
  const rawResult = params.get("result") ?? "all";
  const filters = {
    search: params.get("q") ?? "",
    panelId: params.get("panel") ?? "",
    result: isResultView(rawResult) ? rawResult : "all",
    sort: params.get("sort") ?? "score",
    openReviewId: params.get("open") ?? "",
  };
  const update = (patch: Partial<Record<"q" | "panel" | "result" | "sort" | "open", string>>) => {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(patch)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true },
    );
  };
  return { filters, update };
}

export function ScoreRound() {
  const { roundId } = useParams<{ roundId: string }>();
  const rounds = useQuery(api.scoreGovernance.rounds, { eventSlug });
  const visibleRound = rounds?.find((round) => round.id === roundId);
  const completeness = useQuery(
    api.scoreGovernance.completeness,
    visibleRound ? { eventSlug, roundId: visibleRound.id } : "skip",
  );
  const reviews = usePaginatedQuery(
    api.scoreGovernance.completenessReviews,
    visibleRound ? { eventSlug, roundId: visibleRound.id } : "skip",
    { initialNumItems: scoreGovernancePageSize },
  );
  const [showValues, setShowValues] = useState(true);
  const [reviewView, setReviewView] = useState<ReviewView>("needs_action");
  const [loadEverything, setLoadEverything] = useState(false);
  const estimatedServerNow = useEstimatedServerNow(completeness?.serverNow);
  const { filters, update } = useResultFilters();
  const standings = useQuery(
    api.scoreGovernance.roundStandings,
    visibleRound && completeness?.canReadValues && showValues
      ? { eventSlug, roundId: visibleRound.id }
      : "skip",
  );
  const canLoadMore = reviews.status === "CanLoadMore";
  useEffect(() => {
    if (loadEverything && canLoadMore) reviews.loadMore(scoreGovernancePageSize);
  }, [loadEverything, canLoadMore, reviews]);

  if (!roundId) return <p className="notice error">Round ID is missing.</p>;
  if (
    rounds === undefined ||
    (visibleRound && (completeness === undefined || reviews.status === "LoadingFirstPage"))
  ) {
    return (
      <section className="review-shell">
        <LoadingLabel>Loading this round’s results</LoadingLabel>
        <SkeletonStats columns={4} />
        <SkeletonList rows={5} />
      </section>
    );
  }
  if (!visibleRound) {
    return (
      <p className="notice error">This results round is not visible to you.</p>
    );
  }
  if (!completeness) {
    return (
      <section className="review-shell">
        <LoadingLabel>Loading this round’s results</LoadingLabel>
        <SkeletonStats columns={4} />
        <SkeletonList rows={5} />
      </section>
    );
  }

  const searchText = filters.search.trim().toLowerCase();
  const panelName = standings?.panels.find((panel) => panel.id === filters.panelId)?.name;
  const ordered = [...reviews.results].sort(
    (left, right) =>
      reviewRank(left) - reviewRank(right) || left.teamName.localeCompare(right.teamName),
  );
  const narrowed = ordered.filter(
    (review) =>
      (searchText.length === 0 || review.teamName.toLowerCase().includes(searchText)) &&
      (!panelName || review.panelName === panelName),
  );
  const needsActionCount = narrowed.filter(reviewNeedsAction).length;
  const settledCount = narrowed.length - needsActionCount;
  const visibleReviews = narrowed.filter((review) => {
    if (reviewView === "needs_action") return reviewNeedsAction(review);
    if (reviewView === "settled") return !reviewNeedsAction(review);
    return true;
  });
  const correctionRequestsOpen =
    completeness.round.status === "open" &&
    estimatedServerNow <= completeness.round.correctionRequestsCloseAt;

  return (
    <section className="review-shell">
      <Link className="back-link" to="/scores">
        ← Results
      </Link>
      <header className="page-heading">
        <div>
          <p className="eyebrow">{reviewRoundStatusLabels[completeness.round.status]}</p>
          <h1>{completeness.round.name}</h1>
          <p className="muted">
            {completeness.unresolvedTeamCount === 0
              ? "Every team in this round has a countable result."
              : `${completeness.unresolvedTeamCount} ${completeness.unresolvedTeamCount === 1 ? "team has" : "teams have"} no countable result, so this round cannot close.`}{" "}
            Correction requests close{" "}
            {formatTime(completeness.round.correctionRequestsCloseAt)}.
          </p>
        </div>
        {completeness.canReadValues ? (
          <button
            className="secondary"
            type="button"
            onClick={() => setShowValues((current) => !current)}
          >
            {showValues ? "Hide standings" : "Open standings"}
          </button>
        ) : null}
      </header>

      <dl className="score-summary-grid governance-summary">
        <Summary
          label="Sessions loaded"
          value={<><LiveNumber value={reviews.results.length} />{reviews.status === "CanLoadMore" ? "+" : ""}</>}
        />
        <Summary label="Teams with no result" value={completeness.unresolvedTeamCount} />
        <Summary label="Paper sheets to enter" value={completeness.pendingManualReviewCount} />
        <Summary label="Corrections to decide" value={completeness.unresolvedCorrectionCount} />
        <Summary
          label="Round export"
          value={
            completeness.exportState
              ? roundExportStateLabels[completeness.exportState]
              : "Not started"
          }
        />
      </dl>

      {completeness.canReadValues && showValues ? (
        standings === undefined ? (
          <>
            <LoadingLabel>Opening the standings</LoadingLabel>
            <SkeletonList rows={4} />
          </>
        ) : (
          <StandingsBoard
            filters={filters}
            minimumScorers={completeness.round.minimumScorersPerCriterion}
            standings={standings}
            update={update}
          />
        )
      ) : null}

      <section className="score-team-workspace">
        <div className="section-heading score-team-workspace-heading">
          <div>
            <h2>Team results</h2>
            <p className="muted">
              Start with missing scores, disagreements, and correction requests.
            </p>
          </div>
          <div
            className="configuration-tabs score-team-tabs"
            role="group"
            aria-label="Team result view"
          >
            <button
              aria-pressed={reviewView === "needs_action"}
              className={reviewView === "needs_action" ? "active" : ""}
              type="button"
              onClick={() => setReviewView("needs_action")}
            >
              Needs action · <LiveNumber value={needsActionCount} />
            </button>
            <button
              aria-pressed={reviewView === "settled"}
              className={reviewView === "settled" ? "active" : ""}
              type="button"
              onClick={() => setReviewView("settled")}
            >
              Settled · <LiveNumber value={settledCount} />
            </button>
            <button
              aria-pressed={reviewView === "all"}
              className={reviewView === "all" ? "active" : ""}
              type="button"
              onClick={() => setReviewView("all")}
            >
              All · <LiveNumber value={narrowed.length} />
            </button>
          </div>
        </div>
        {!showValues || !completeness.canReadValues ? (
          <div className="standings-toolbar">
            <label className="compact-search">
              <span className="visually-hidden">Search teams</span>
              <input
                type="search"
                placeholder="Search team name"
                value={filters.search}
                onChange={(event) => update({ q: event.target.value })}
              />
            </label>
          </div>
        ) : null}
        <div className="score-review-list">
          {visibleReviews.map((review) => (
            <ReviewCompleteness
              criteria={completeness.criteria}
              key={review.id}
              review={review}
              correctionRequestsOpen={correctionRequestsOpen}
              roundStatus={completeness.round.status}
            />
          ))}
        </div>
        {visibleReviews.length === 0 && ordered.length > 0 ? (
          <p className="empty">No team matches this result view.</p>
        ) : null}
      </section>

      {reviews.status === "CanLoadMore" || reviews.status === "LoadingMore" ? (
        <div className="button-row">
          <button
            className="secondary"
            type="button"
            disabled={reviews.status === "LoadingMore"}
            onClick={() => reviews.loadMore(scoreGovernancePageSize)}
          >
            {reviews.status === "LoadingMore" ? "Loading sessions…" : "Load more review sessions"}
          </button>
          <button
            className="secondary"
            type="button"
            disabled={loadEverything}
            onClick={() => setLoadEverything(true)}
          >
            {loadEverything ? "Loading every session…" : "Load every session"}
          </button>
        </div>
      ) : null}

      {reviews.results.length === 0 ? (
        <p className="empty">No panel has been given a team to judge in this round.</p>
      ) : null}

      <RoundExportControl roundId={completeness.round.id} />
      <ReviewProgression roundId={completeness.round.id} />
    </section>
  );
}

function StandingsBoard({
  filters,
  minimumScorers,
  standings,
  update,
}: {
  filters: ReturnType<typeof useResultFilters>["filters"];
  minimumScorers: number;
  standings: Standings;
  update: ReturnType<typeof useResultFilters>["update"];
}) {
  const criteria = useMemo(
    () => [...standings.criteria].sort((left, right) => left.displayOrder - right.displayOrder),
    [standings.criteria],
  );
  const ranks = useMemo(() => rankByTotal(standings.rows), [standings.rows]);
  const searchText = filters.search.trim().toLowerCase();
  const matching = standings.rows.filter(
    (row) =>
      (searchText.length === 0 ||
        row.teamName.toLowerCase().includes(searchText) ||
        row.teamCode.toLowerCase().includes(searchText)) &&
      (!filters.panelId || row.panelId === filters.panelId) &&
      matchesResultView(row, filters.result, minimumScorers),
  );
  const sorted = sortRows(matching, filters.sort, ranks);
  const scored = matching.filter((row) => row.evaluation?.state === "complete");
  const average =
    scored.length > 0
      ? scored.reduce((total, row) => total + (row.evaluation?.totalPoints ?? 0), 0) /
        scored.length
      : null;
  const top = scored.reduce<StandingsRow | null>(
    (best, row) =>
      best === null || (row.evaluation?.totalPoints ?? 0) > (best.evaluation?.totalPoints ?? 0)
        ? row
        : best,
    null,
  );
  const hasFilters =
    filters.search.length > 0 || filters.panelId.length > 0 || filters.result !== "all";
  const columnCount = 7 + criteria.length;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [detailWidth, setDetailWidth] = useState<number | undefined>(undefined);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => setDetailWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const sortByCriterion = filters.sort.startsWith("criterion:")
    ? filters.sort.slice("criterion:".length)
    : null;

  return (
    <section className="standings">
      <div className="section-heading score-team-workspace-heading">
        <div>
          <h2>Standings</h2>
          <p className="muted">
            Scores are out of {standings.totalWeight} points. Each criterion shows the panel
            average on the {standings.scoreMinimum} to {standings.scoreMaximum} scale. Open a
            team to see every reviewer’s scores and notes.
          </p>
        </div>
      </div>

      <div className="standings-toolbar">
        <label className="compact-search">
          <span className="visually-hidden">Search teams</span>
          <input
            type="search"
            placeholder="Search team name or code"
            value={filters.search}
            onChange={(event) => update({ q: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Panel</span>
          <select
            value={filters.panelId}
            onChange={(event) => update({ panel: event.target.value })}
          >
            <option value="">All panels</option>
            {standings.panels.map((panel) => (
              <option key={panel.id} value={panel.id}>
                {panel.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Show</span>
          <select
            value={filters.result}
            onChange={(event) => update({ result: event.target.value })}
          >
            {resultViews.map((view) => (
              <option key={view} value={view}>
                {resultViewLabels[view]} ·{" "}
                {standings.rows.filter(
                  (row) =>
                    (!filters.panelId || row.panelId === filters.panelId) &&
                    matchesResultView(row, view, minimumScorers),
                ).length}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Order</span>
          <select
            value={isFixedSort(filters.sort) || sortByCriterion ? filters.sort : "score"}
            onChange={(event) => update({ sort: event.target.value })}
          >
            {Object.entries(fixedSortLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
            {criteria.map((criterion) => (
              <option key={criterion.id} value={`criterion:${criterion.id}`}>
                Best {criterion.label} first
              </option>
            ))}
          </select>
        </label>
        {hasFilters ? (
          <button
            className="secondary"
            type="button"
            onClick={() => update({ q: "", panel: "", result: "" })}
          >
            Clear filters
          </button>
        ) : null}
      </div>

      <p className="muted standings-status" role="status">
        Showing <LiveNumber value={sorted.length} /> of <LiveNumber value={standings.rows.length} />{" "}
        reviews · <LiveNumber value={scored.length} /> scored
        {average !== null ? (
          <>
            {" "}· average <LiveNumber value={average} format={{ maximumFractionDigits: 1 }} />
          </>
        ) : null}
        {top?.evaluation ? (
          <>
            {" "}· highest{" "}
            <LiveNumber value={top.evaluation.totalPoints} format={{ maximumFractionDigits: 1 }} />{" "}
            by {top.teamName}
          </>
        ) : null}
        {standings.truncated ? " · only the first 1,000 reviews are listed" : ""}
      </p>

      <div className="standings-scroll" ref={scrollRef}>
        <table className="standings-table">
          <thead>
            <tr>
              <th scope="col" className="numeric">#</th>
              <th scope="col">Team</th>
              <th scope="col">Panel</th>
              <th scope="col" className="numeric">
                <button
                  className={`standings-sort${filters.sort === "score" ? " active" : ""}`}
                  type="button"
                  onClick={() => update({ sort: "score" })}
                >
                  Total
                </button>
              </th>
              {criteria.map((criterion) => (
                <th scope="col" className="numeric" key={criterion.id}>
                  <button
                    className={`standings-sort${sortByCriterion === criterion.id ? " active" : ""}`}
                    type="button"
                    title={`${criterion.label} · weight ${criterion.weight}`}
                    onClick={() => update({ sort: `criterion:${criterion.id}` })}
                  >
                    {criterion.label}
                  </button>
                </th>
              ))}
              <th scope="col" className="numeric">Scorers</th>
              <th scope="col">Finished</th>
              <th scope="col"><span className="visually-hidden">Project</span></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const open = filters.openReviewId === row.reviewSessionId;
              const rank = ranks.get(row.reviewSessionId);
              return (
                <StandingsRowView
                  columnCount={columnCount}
                  criteria={criteria}
                  detailWidth={detailWidth}
                  key={row.reviewSessionId}
                  minimumScorers={minimumScorers}
                  open={open}
                  rank={rank}
                  row={row}
                  toggle={() => update({ open: open ? "" : row.reviewSessionId })}
                />
              );
            })}
          </tbody>
        </table>
      </div>
      {sorted.length === 0 ? (
        <p className="empty">
          {standings.rows.length === 0
            ? "No panel has been given a team to judge in this round."
            : "No review matches these filters."}
        </p>
      ) : null}
    </section>
  );
}

function StandingsRowView({
  columnCount,
  criteria,
  detailWidth,
  minimumScorers,
  open,
  rank,
  row,
  toggle,
}: {
  columnCount: number;
  criteria: StandingsCriterion[];
  detailWidth: number | undefined;
  minimumScorers: number;
  open: boolean;
  rank: number | undefined;
  row: StandingsRow;
  toggle: () => void;
}) {
  const complete = row.evaluation?.state === "complete";
  const scorerCounts = row.evaluation?.criterionResults.map((result) => result.scoreCount) ?? [];
  const fewest = scorerCounts.length > 0 ? Math.min(...scorerCounts) : null;
  const most = scorerCounts.length > 0 ? Math.max(...scorerCounts) : null;
  return (
    <>
      <tr className={`standings-row${open ? " open" : ""}`}>
        <td className="numeric standings-rank">{rank ?? "–"}</td>
        <td>
          <button
            aria-expanded={open}
            className="standings-team"
            type="button"
            onClick={toggle}
          >
            <strong>{row.teamName}</strong>
            <small>
              {row.teamCode}
              {row.manualReviewRecordId ? " · entered from paper" : ""}
            </small>
          </button>
        </td>
        <td>{row.panelName}</td>
        <td className="numeric standings-total">
          {complete && row.evaluation ? (
            <LiveNumber value={row.evaluation.totalPoints} format={{ maximumFractionDigits: 1 }} />
          ) : (
            <span className="muted">
              {row.evaluation
                ? reviewEvaluationStateLabels[row.evaluation.state]
                : reviewSessionStatusLabels[row.status]}
            </span>
          )}
        </td>
        {criteria.map((criterion) => {
          const result = row.evaluation?.criterionResults.find(
            (candidate) => candidate.criterionId === criterion.id,
          );
          return (
            <td
              className={`numeric${result?.spreadFlag ? " spread" : ""}`}
              key={criterion.id}
              title={
                result
                  ? `${result.weightedPoints.toFixed(1)} of ${criterion.weight} points${result.spreadFlag ? " · reviewers far apart" : ""}`
                  : undefined
              }
            >
              {complete && result ? (
                <LiveNumber value={result.meanScore} format={{ maximumFractionDigits: 1 }} />
              ) : (
                <span className="muted">–</span>
              )}
            </td>
          );
        })}
        <td className={`numeric${fewest !== null && fewest < minimumScorers ? " spread" : ""}`}>
          {fewest === null ? <span className="muted">–</span> : fewest === most ? fewest : `${fewest}–${most}`}
        </td>
        <td className="standings-time">
          {row.completedAt
            ? formatTime(row.completedAt)
            : row.startedAt
              ? `Started ${formatTime(row.startedAt)}`
              : `Called ${formatTime(row.calledAt)}`}
        </td>
        <td className="standings-actions">
          {row.applicationId ? (
            <Link className="row-action" to={`/admissions/${row.applicationId}`}>
              Project
            </Link>
          ) : null}
        </td>
      </tr>
      {open ? (
        <tr className="standings-detail-row">
          <td colSpan={columnCount}>
            <div className="review-detail-frame" style={{ width: detailWidth }}>
              <ReviewDetail reviewSessionId={row.reviewSessionId} />
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function ReviewDetail({ reviewSessionId }: { reviewSessionId: StandingsRow["reviewSessionId"] }) {
  const detail = useQuery(api.scoreGovernance.reviewDetail, { eventSlug, reviewSessionId });
  if (detail === undefined) {
    return (
      <div className="review-detail">
        <LoadingLabel>Opening this review</LoadingLabel>
        <SkeletonList rows={3} />
      </div>
    );
  }
  return <ReviewDetailView detail={detail} />;
}

function ReviewDetailView({ detail }: { detail: ReviewDetailData }) {
  const criteria = [...detail.criteria].sort((left, right) => left.displayOrder - right.displayOrder);
  const submitted = detail.scorecards
    .filter((scorecard) => scorecard.status === "submitted")
    .sort((left, right) => left.reviewerName.localeCompare(right.reviewerName));
  const others = detail.scorecards.filter((scorecard) => scorecard.status !== "submitted");
  const missing = detail.reviewers.filter(
    (reviewer) =>
      reviewer.assignmentStatus === "assigned" &&
      !detail.scorecards.some((scorecard) => scorecard.reviewerPersonId === reviewer.personId),
  );
  const notes = submitted.flatMap((scorecard) =>
    scorecard.ratings
      .filter((rating) => rating.evidenceNote)
      .map((rating) => ({
        reviewerName: scorecard.reviewerName,
        criterion: criteria.find((criterion) => criterion.id === rating.criterionId)?.label ?? "Criterion",
        score: rating.score,
        note: rating.evidenceNote ?? "",
      })),
  );
  const comments = submitted.filter((scorecard) => scorecard.finalComment);
  const timeline = [
    `Called ${formatTime(detail.calledAt)}`,
    detail.startedAt ? `started ${formatTime(detail.startedAt)}` : null,
    detail.completedAt ? `finished ${formatTime(detail.completedAt)}` : null,
    detail.cancelledAt ? `cancelled ${formatTime(detail.cancelledAt)}` : null,
    detail.extensionCount > 0
      ? `${detail.extensionCount} ${detail.extensionCount === 1 ? "extension" : "extensions"} (${Math.round(detail.extensionSeconds / 60)} min)`
      : null,
  ].filter((entry): entry is string => entry !== null);

  return (
    <div className="review-detail">
      <div className="review-detail-head">
        <div>
          <strong>{detail.team.name}</strong>
          <p className="muted">
            {detail.team.code} · {detail.panel.name} · {reviewSessionStatusLabels[detail.status]}
            {detail.manualReviewRecordId ? " · entered from paper" : ""}
          </p>
          <p className="muted">{timeline.join(" · ")}</p>
        </div>
        <div className="review-detail-links">
          {detail.team.applicationId ? (
            <Link className="secondary" to={`/admissions/${detail.team.applicationId}`}>
              Open the project
            </Link>
          ) : null}
          {detail.project.repositories.map((repository) => (
            <a
              className="secondary"
              href={repository.url}
              key={repository.url}
              rel="noreferrer"
              target="_blank"
            >
              {repository.fullName}
            </a>
          ))}
        </div>
      </div>

      <section className="review-detail-section">
        <h3>Project idea</h3>
        <p className="prewrap">{detail.project.initialIdea}</p>
        {detail.project.additionalInformation ? (
          <details className="case-history">
            <summary>More from the team</summary>
            <p className="prewrap">{detail.project.additionalInformation}</p>
          </details>
        ) : null}
      </section>

      <section className="review-detail-section">
        <h3>Scores</h3>
        {submitted.length === 0 ? (
          <p className="muted">No scorecard has been submitted for this review.</p>
        ) : (
          <div className="standings-scroll">
            <table className="score-matrix">
              <thead>
                <tr>
                  <th scope="col">Reviewer</th>
                  {criteria.map((criterion) => (
                    <th scope="col" className="numeric" key={criterion.id} title={criterion.question}>
                      {criterion.label}
                      <small>weight {criterion.weight}</small>
                    </th>
                  ))}
                  <th scope="col" className="numeric">Weighted</th>
                </tr>
              </thead>
              <tbody>
                {submitted.map((scorecard) => (
                  <tr key={scorecard.id}>
                    <th scope="row">
                      {scorecard.reviewerName}
                      <small>
                        submission {scorecard.version}
                        {scorecard.submittedAt ? ` · ${formatTime(scorecard.submittedAt)}` : ""}
                        {scorecard.manualReviewRecordId ? " · from paper" : ""}
                      </small>
                    </th>
                    {criteria.map((criterion) => {
                      const rating = scorecard.ratings.find(
                        (candidate) => candidate.criterionId === criterion.id,
                      );
                      return (
                        <td className="numeric" key={criterion.id}>
                          {rating ? rating.score : <span className="muted">–</span>}
                        </td>
                      );
                    })}
                    <td className="numeric">
                      {weightedTotal(scorecard.ratings, criteria, detail.rubric.scoreMaximum).toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Panel average</th>
                  {criteria.map((criterion) => {
                    const result = detail.evaluation?.criterionResults.find(
                      (candidate) => candidate.criterionId === criterion.id,
                    );
                    return (
                      <td className={`numeric${result?.spreadFlag ? " spread" : ""}`} key={criterion.id}>
                        {result ? result.meanScore.toFixed(2) : "–"}
                        {result?.spreadFlag ? <small>far apart</small> : null}
                      </td>
                    );
                  })}
                  <td className="numeric">
                    {detail.evaluation?.state === "complete"
                      ? `${detail.evaluation.totalPoints.toFixed(2)} / ${detail.rubric.totalWeight}`
                      : detail.evaluation
                        ? reviewEvaluationStateLabels[detail.evaluation.state]
                        : "No result"}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Points</th>
                  {criteria.map((criterion) => {
                    const result = detail.evaluation?.criterionResults.find(
                      (candidate) => candidate.criterionId === criterion.id,
                    );
                    return (
                      <td className="numeric" key={criterion.id}>
                        {result ? `${result.weightedPoints.toFixed(1)} / ${criterion.weight}` : "–"}
                      </td>
                    );
                  })}
                  <td className="numeric" />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {others.length > 0 || missing.length > 0 ? (
          <p className="muted">
            {[
              ...others.map(
                (scorecard) =>
                  `${scorecard.reviewerName}: ${scorecardStatusLabels[scorecard.status].toLowerCase()}`,
              ),
              ...missing.map((reviewer) => `${reviewer.name}: no scorecard`),
            ].join(" · ")}
          </p>
        ) : null}
      </section>

      {notes.length > 0 || comments.length > 0 ? (
        <section className="review-detail-section">
          <h3>Reviewer notes</h3>
          <div className="review-notes">
            {comments.map((scorecard) => (
              <div className="review-note" key={`comment-${scorecard.id}`}>
                <strong>{scorecard.reviewerName}</strong>
                <p className="prewrap">{scorecard.finalComment}</p>
              </div>
            ))}
            {notes.map((note, index) => (
              <div className="review-note" key={`note-${index}`}>
                <strong>
                  {note.reviewerName} · {note.criterion} · {note.score}
                </strong>
                <p className="prewrap">{note.note}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {detail.sharedNotes.findings || detail.sharedNotes.commitments ? (
        <section className="review-detail-section">
          <h3>Panel notes</h3>
          <div className="review-notes">
            {detail.sharedNotes.findings ? (
              <div className="review-note">
                <strong>What the panel found</strong>
                <p className="prewrap">{detail.sharedNotes.findings}</p>
              </div>
            ) : null}
            {detail.sharedNotes.commitments ? (
              <div className="review-note">
                <strong>What the team committed to</strong>
                <p className="prewrap">{detail.sharedNotes.commitments}</p>
              </div>
            ) : null}
          </div>
          {detail.sharedNotes.authorName ? (
            <p className="muted">Written by {detail.sharedNotes.authorName}.</p>
          ) : null}
        </section>
      ) : null}

      {detail.questions.length > 0 ? (
        <section className="review-detail-section">
          <h3>Questions prepared for the panel</h3>
          <ol className="review-questions">
            {detail.questions.map((question, index) => (
              <li key={index}>
                <span>{question.question}</span>
                <small>{question.reason}</small>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {detail.cases.length > 0 ? (
        <section className="review-detail-section">
          <h3>Corrections</h3>
          <ul className="review-questions">
            {detail.cases.map((entry) => (
              <li key={entry.id}>
                <span>
                  {scorecardCorrectionKindLabels[entry.kind]} ·{" "}
                  {scorecardCorrectionStateLabels[entry.state]} ·{" "}
                  {scorecardCorrectionCategoryLabels[entry.category]}
                </span>
                <small>
                  {entry.reason} · {formatTime(entry.requestedAt)}
                </small>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function weightedTotal(
  ratings: ReviewDetailData["scorecards"][number]["ratings"],
  criteria: ReviewDetailData["criteria"],
  scoreMaximum: number,
) {
  if (scoreMaximum <= 0) return 0;
  return ratings.reduce((total, rating) => {
    const criterion = criteria.find((candidate) => candidate.id === rating.criterionId);
    return criterion ? total + (rating.score / scoreMaximum) * criterion.weight : total;
  }, 0);
}

function rankByTotal(rows: StandingsRow[]) {
  const totals = rows.flatMap((row) =>
    row.evaluation?.state === "complete" ? [row.evaluation.totalPoints] : [],
  );
  const ranks = new Map<StandingsRow["reviewSessionId"], number>();
  for (const row of rows) {
    if (row.evaluation?.state !== "complete") continue;
    const total = row.evaluation.totalPoints;
    ranks.set(row.reviewSessionId, 1 + totals.filter((candidate) => candidate > total).length);
  }
  return ranks;
}

function matchesResultView(row: StandingsRow, view: ResultView, minimumScorers: number) {
  const complete = row.evaluation?.state === "complete";
  switch (view) {
    case "all":
      return true;
    case "scored":
      return complete;
    case "unscored":
      return !complete;
    case "far_apart":
      return row.evaluation?.criterionResults.some((result) => result.spreadFlag) ?? false;
    case "short":
      return (
        row.evaluation?.criterionResults.some((result) => result.scoreCount < minimumScorers) ??
        false
      );
  }
}

function sortRows(
  rows: StandingsRow[],
  sort: string,
  ranks: Map<StandingsRow["reviewSessionId"], number>,
) {
  const total = (row: StandingsRow) =>
    row.evaluation?.state === "complete" ? row.evaluation.totalPoints : null;
  const byTotal = (left: StandingsRow, right: StandingsRow, direction: 1 | -1) => {
    const leftTotal = total(left);
    const rightTotal = total(right);
    if (leftTotal === null && rightTotal === null) return left.teamName.localeCompare(right.teamName);
    if (leftTotal === null) return 1;
    if (rightTotal === null) return -1;
    return (rightTotal - leftTotal) * direction || left.teamName.localeCompare(right.teamName);
  };
  const sorted = [...rows];
  if (sort.startsWith("criterion:")) {
    const criterionId = sort.slice("criterion:".length);
    const mean = (row: StandingsRow) =>
      row.evaluation?.state === "complete"
        ? (row.evaluation.criterionResults.find((result) => result.criterionId === criterionId)
            ?.meanScore ?? null)
        : null;
    return sorted.sort((left, right) => {
      const leftMean = mean(left);
      const rightMean = mean(right);
      if (leftMean === null && rightMean === null) return byTotal(left, right, 1);
      if (leftMean === null) return 1;
      if (rightMean === null) return -1;
      return rightMean - leftMean || byTotal(left, right, 1);
    });
  }
  switch (sort) {
    case "score_asc":
      return sorted.sort((left, right) => byTotal(left, right, -1));
    case "team":
      return sorted.sort((left, right) => left.teamName.localeCompare(right.teamName));
    case "panel":
      return sorted.sort(
        (left, right) =>
          left.panelName.localeCompare(right.panelName, undefined, { numeric: true }) ||
          byTotal(left, right, 1),
      );
    case "recent":
      return sorted.sort(
        (left, right) =>
          (right.completedAt ?? right.startedAt ?? right.calledAt) -
          (left.completedAt ?? left.startedAt ?? left.calledAt),
      );
    default:
      return sorted.sort((left, right) => byTotal(left, right, 1) || (ranks.get(left.reviewSessionId) ?? 0) - (ranks.get(right.reviewSessionId) ?? 0));
  }
}

function ReviewCompleteness({
  review,
  criteria,
  correctionRequestsOpen,
  roundStatus,
}: {
  review: Review;
  criteria: Completeness["criteria"];
  correctionRequestsOpen: boolean;
  roundStatus: Completeness["round"]["status"];
}) {
  const short = review.coverage.filter(
    (coverage) => coverage.submittedCount < coverage.requiredCount,
  );
  const disagreeing = review.coverage.filter((coverage) => coverage.spreadFlag);
  const scorecards = [...review.scorecards].sort(
    (left, right) => Number(left.status !== "draft") - Number(right.status !== "draft"),
  );
  const hasDecision = scorecards.some(
    (scorecard) => scorecard.currentCase?.state === "requested" && scorecard.canDecideCorrection,
  );
  const [open, setOpen] = useState(hasDecision);
  const resultLabel = review.evaluationState
    ? reviewEvaluationStateLabels[review.evaluationState]
    : "No result yet";
  const shortfall =
    short.length === 0
      ? disagreeing.length > 0
        ? `Reviewers are far apart on ${listNames(disagreeing.map((coverage) => criterionLabel(criteria, coverage.criterionId)))}.`
        : "Every criterion has the scores it needs."
      : `${listNames(short.map((coverage) => criterionLabel(criteria, coverage.criterionId)))} ${short.length === 1 ? "is" : "are"} short of the ${short[0]?.requiredCount ?? 0} scores needed.`;
  return (
    <article className="score-review-row">
      <button
        aria-expanded={open}
        className="score-review-summary"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="score-review-summary-copy">
          <strong>{review.teamName}</strong>
          <small>
            {review.panelName} · {reviewSessionStatusLabels[review.status]} · {" "}
            {resultLabel}
            {review.manualReviewRecordId ? " · entered from paper" : ""}
          </small>
          <span className={reviewNeedsAction(review) ? "needs-attention" : ""}>{shortfall}</span>
        </span>
        <span className="panel-row-chevron" aria-hidden="true">
          {open ? "⌄" : "›"}
        </span>
      </button>

      {open ? (
        <div className="score-review-body">
          <div className="coverage-strip">
            {review.coverage.map((coverage) => (
              <span
                className={
                  coverage.submittedCount < coverage.requiredCount ? "needs-attention" : ""
                }
                key={coverage.criterionId}
              >
                {criterionLabel(criteria, coverage.criterionId)} · {" "}
                <LiveNumber value={coverage.submittedCount} /> of <LiveNumber value={coverage.requiredCount} />
                {coverage.spreadFlag ? " · far apart" : ""}
              </span>
            ))}
          </div>

          <div className="scorecard-list">
            {scorecards.map((scorecard) => (
              <div className="scorecard-row" key={scorecard.id}>
                <div>
                  <strong>{scorecard.reviewerName}</strong>
                  <span>
                    {scorecardStatusLabels[scorecard.status]}
                    {scorecard.submittedAt ? ` · ${formatTime(scorecard.submittedAt)}` : ""}
                  </span>
                </div>
                <div className="scorecard-actions">
                  {scorecard.currentCase?.state === "requested" && scorecard.canDecideCorrection ? (
                    <CorrectionDecision
                      canOpen={scorecard.canOpenCorrection}
                      correctionRequestsOpen={correctionRequestsOpen}
                      correctionCase={scorecard.currentCase}
                      scorecard={scorecard}
                    />
                  ) : null}
                  {scorecard.status === "submitted" &&
                  scorecard.canVoid &&
                  !scorecard.currentCase &&
                  roundStatus === "open" ? (
                    <VoidScorecard scorecard={scorecard} />
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          {review.cases.length > 0 ? (
            <details className="case-history">
              <summary>
                {review.cases.length === 1
                  ? "One scorecard was corrected or voided"
                  : `${review.cases.length} scorecards were corrected or voided`}
              </summary>
              <ul>
                {review.cases.map((entry) => (
                  <li key={entry.id}>
                    <strong>
                      {scorecardCorrectionKindLabels[entry.kind]} ·{" "}
                      {scorecardCorrectionStateLabels[entry.state]}
                    </strong>
                    <span>
                      {scorecardCorrectionCategoryLabels[entry.category]} ·{" "}
                      {entry.reason}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function CorrectionDecision({
  canOpen,
  correctionRequestsOpen,
  correctionCase,
  scorecard,
}: {
  canOpen: boolean;
  correctionRequestsOpen: boolean;
  correctionCase: CorrectionCase;
  scorecard: Scorecard;
}) {
  const decideCorrection = useMutation(api.scoreGovernance.decideCorrection);
  const [open, setOpen] = useState(false);
  const openDecisionAvailable = canOpen && correctionRequestsOpen;
  const [decision, setDecision] = useState<"open" | "reject">(
    openDecisionAvailable ? "open" : "reject",
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.scoreGovernance.decideCorrection>>();
  const operationSlot = `score-correction-decision:${correctionCase.id}`;
  const operationPending = operationAttempt.hasPending(operationSlot);
  const effectiveDecision = openDecisionAvailable ? decision : "reject";

  const submit = async () => {
    if (busy || reason.trim().length < 5) return;
    setBusy(true);
    setError(null);
    try {
      await operationAttempt.run(operationSlot, () => {
        const args = {
          eventSlug,
          correctionCaseId: correctionCase.id,
          expectedCaseVersion: correctionCase.version,
          expectedScorecardVersion: scorecard.version,
          decision: effectiveDecision,
          reason,
          clientOperationId: crypto.randomUUID(),
        };
        return () => decideCorrection(args);
      });
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="secondary compact-link" type="button" onClick={() => setOpen(true)}>
        Review request
      </button>
    );
  }
  return (
    <div className="score-command">
      <p>{correctionCase.reason}</p>
      <label className="field">
        <span>Decision</span>
        <select
          disabled={busy || operationPending}
          value={effectiveDecision}
          onChange={(event) => {
            setDecision(event.target.value === "reject" ? "reject" : "open");
            setError(null);
          }}
        >
          {openDecisionAvailable ? (
            <option value="open">Open correction</option>
          ) : null}
          <option value="reject">Decline request</option>
        </select>
      </label>
      <label className="field">
        <span>Reason</span>
        <textarea
          disabled={busy || operationPending}
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
              ? "Confirm earlier decision"
              : effectiveDecision === "open"
                ? "Open correction"
                : "Decline"}
        </button>
        <button
          className="secondary"
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

function VoidScorecard({ scorecard }: { scorecard: Scorecard }) {
  const voidScorecard = useMutation(api.scoreGovernance.voidScorecard);
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<
    | "wrong_team"
    | "duplicate_review"
    | "confirmed_conflict"
    | "judge_ineligible"
    | "technical_error"
    | "other"
  >("technical_error");
  const [disposition, setDisposition] = useState<"exclude" | "replacement_review">(
    "replacement_review");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.scoreGovernance.voidScorecard>>();
  const operationSlot = `scorecard-void:${scorecard.id}`;
  const operationPending = operationAttempt.hasPending(operationSlot);

  const changed = () => setError(null);

  const submit = async () => {
    if (busy || !confirmed || evidenceReference.trim().length < 3 || reason.trim().length < 5)
      return;
    setBusy(true);
    setError(null);
    try {
      await operationAttempt.run(operationSlot, () => {
        const args = {
          eventSlug,
          scorecardId: scorecard.id,
          expectedScorecardVersion: scorecard.version,
          category,
          disposition,
          evidenceReference,
          reason,
          clientOperationId: crypto.randomUUID(),
        };
        return () => voidScorecard(args);
      });
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="text-button" type="button" onClick={() => setOpen(true)}>
        Void
      </button>
    );
  }
  return (
    <div className="score-command destructive-command">
      <p>Voiding throws out this review’s result.</p>
      <div className="form-grid">
        <label className="field">
          <span>Category</span>
          <select
            disabled={busy || operationPending}
            value={category}
            onChange={(event) => {
              const value = event.target.value;
              if (
                value === "wrong_team" ||
                value === "duplicate_review" ||
                value === "confirmed_conflict" ||
                value === "judge_ineligible" ||
                value === "technical_error" ||
                value === "other"
              )
                setCategory(value);
              changed();
            }}
          >
            <option value="technical_error">Technical error</option>
            <option value="wrong_team">Wrong team</option>
            <option value="duplicate_review">Duplicate review</option>
            <option value="confirmed_conflict">Confirmed conflict</option>
            <option value="judge_ineligible">Reviewer not allowed</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className="field">
          <span>Outcome</span>
          <select
            disabled={busy || operationPending}
            value={disposition}
            onChange={(event) => {
              setDisposition(event.target.value === "exclude" ? "exclude" : "replacement_review",
              );
              changed();
            }}
          >
            <option value="replacement_review">Replacement review required</option>
            <option value="exclude">Exclude this review from the round</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span>Where the evidence is</span>
        <input
          disabled={busy || operationPending}
          value={evidenceReference}
          onChange={(event) => {
            setEvidenceReference(event.target.value);
            changed();
          }}
        />
      </label>
      <label className="field">
        <span>Reason</span>
        <textarea
          disabled={busy || operationPending}
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
          disabled={busy || operationPending}
          type="checkbox"
          onChange={(event) => {
            setConfirmed(event.target.checked);
            changed();
          }}
        />
        I confirm the evidence and replacement decision are correct.
      </label>
      <div className="button-row">
        <button
          className="primary"
          disabled={
            busy || !confirmed || evidenceReference.trim().length < 3 || reason.trim().length < 5
          }
          type="button"
          onClick={() => void submit()}
        >
          {busy ? "Voiding…" : operationPending ? "Confirm earlier void" : "Void scorecard"}
        </button>
        <button
          className="secondary"
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

function Summary({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{typeof value === "number" ? <LiveNumber value={value} /> : value}</dd>
    </div>
  );
}

function reviewRank(review: Review) {
  if (review.evaluationState !== "complete") return 0;
  if (review.cases.some((entry) => entry.state === "requested" || entry.state === "open",
    )) return 1;
  return 2;
}

function reviewNeedsAction(review: Review) {
  return (
    review.evaluationState !== "complete" ||
    review.coverage.some(
      (coverage) => coverage.submittedCount < coverage.requiredCount || coverage.spreadFlag,
    ) ||
    review.cases.some((entry) => entry.state === "requested" || entry.state === "open",
    )
  );
}

function criterionLabel(criteria: Completeness["criteria"], criterionId: string,
) {
  return (
    criteria.find((candidate) => candidate.id === criterionId)?.label ?? "A criterion"
  );
}

function listNames(values: string[]) {
  if (values.length <= 1) return values[0] ?? "Nothing";
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}
