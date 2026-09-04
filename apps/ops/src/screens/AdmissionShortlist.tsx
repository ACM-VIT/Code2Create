import { api } from "@code2create/backend/api";
import type { Id } from "../../../backend/convex/_generated/dataModel";
import {
  shortlistCandidateInputSchema,
  shortlistPairSchema,
  shortlistProfileSchema,
  shortlistSuggestionSchema,
  shortlistSummarySchema,
  shortlistTaskSchema,
} from "@code2create/domain";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";

export function AdmissionShortlist({ canRun }: { canRun: boolean }) {
  const latest = useQuery(api.admissionShortlist.latest, { eventSlug });
  const start = useMutation(api.admissionShortlist.start);
  const retry = useMutation(api.admissionShortlist.retry);
  const [acceptPeople, setAcceptPeople] = useState(700);
  const [waitlistPeople, setWaitlistPeople] = useState(300);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summary = latest?.summaryJson
    ? shortlistSummarySchema.parse(JSON.parse(latest.summaryJson))
    : null;
  return (
    <section className="queue-shell admissions-shell">
      <header className="page-heading">
        <div>
          <Link to="/admissions">← Applications</Link>
          <h1>Admissions shortlist</h1>
          <p>
            AI suggestions only. Whole teams, evidence-first selection, and one
            preferred representative for substantially overlapping ideas.
          </p>
        </div>
      </header>
      <form
        className="configuration-card"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await start({
              eventSlug,
              acceptPeople,
              waitlistPeople,
              operationId,
            });
            setOperationId(crypto.randomUUID());
          } catch (e) {
            setError(readableError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Accept people{" "}
          <input
            type="number"
            min={1}
            max={100000}
            value={acceptPeople}
            onChange={(e) => {
              setAcceptPeople(Number(e.target.value));
              setOperationId(crypto.randomUUID());
            }}
            required
          />
        </label>
        <label>
          Waitlist people{" "}
          <input
            type="number"
            min={0}
            max={100000}
            value={waitlistPeople}
            onChange={(e) => {
              setWaitlistPeople(Number(e.target.value));
              setOperationId(crypto.randomUUID());
            }}
            required
          />
        </label>
        <p className="muted">
          Targets allow ±5 people. Existing commitments consume venue capacity.
          Missing evidence never becomes an automatic rejection. Dating /
          romantic-matchmaking products are excluded under shortlist policy v1.
        </p>
        <button
          type="submit"
          disabled={
            !canRun ||
            busy ||
            (!!latest &&
              !["complete", "failed", "stale", "waiting"].includes(
                latest.state,
              ))
          }
        >
          {busy ? "Starting…" : "Create frozen shortlist"}
        </button>
        {error ? <p role="alert">{error}</p> : null}
      </form>
      {latest === undefined ? (
        <p>Loading shortlist…</p>
      ) : latest === null ? (
        <p>No shortlist has been generated.</p>
      ) : (
        <>
          <h2>Run: {latest.state}</h2>
          <p>
            {latest.candidateCount} candidate teams · {latest.pendingJobs}{" "}
            pending tasks · {latest.failedJobs} failed tasks ·{" "}
            {latest.committedPeople} already committed people
          </p>
          <p className="muted">
            Snapshot created {new Date(latest.createdAt).toLocaleString()}.
            Individual assessments are preserved. Final decisions still require
            the existing review workflow.
          </p>
          {latest.error ? <p role="status">{latest.error}</p> : null}
          {canRun && ["failed", "waiting"].includes(latest.state) ? (
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await retry({ runId: latest._id });
                } catch (e) {
                  setError(readableError(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Retry unfinished work
            </button>
          ) : null}
          {summary ? (
            <>
              <h2>People and teams</h2>
              <ul>
                {Object.entries(summary.totals).map(([kind, count]) => (
                  <li key={kind}>
                    {kind}: {count.people} people / {count.teams} teams
                    {kind === "accept" || kind === "waitlist"
                      ? ` (target ${summary.targets[kind]})`
                      : ""}
                  </li>
                ))}
              </ul>
              {Math.abs(
                (summary.totals.accept?.people ?? 0) - summary.targets.accept,
              ) > 5 ? (
                <p role="status">
                  Accept target was not reached. Quality, overlap, whole-team
                  ordering, or remaining venue capacity limited this selection.
                </p>
              ) : null}
              <h3>Accepted domain mix</h3>
              <ul>
                {Object.entries(summary.domains)
                  .filter(([, count]) => count > 0)
                  .map(([domain, count]) => (
                    <li key={domain}>
                      {domain.replaceAll("_", " ")}: {count} people
                    </li>
                  ))}
              </ul>
              <p>
                {summary.comparedPairs} direct comparisons. {summary.retrieval}
              </p>
              {summary.auditWarnings.length ? (
                <>
                  <h3>Independent audit warnings</h3>
                  <ul>
                    {summary.auditWarnings.map((w, i) => (
                      <li key={i}>
                        {w.explanation}{" "}
                        {w.applicationIds.map((id) => (
                          <Link key={id} to={`/admissions/${id}`}>
                            Open application{" "}
                          </Link>
                        ))}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p>
                  No issues flagged by the bounded audit; this is not proof that
                  every possible overlap was found.
                </p>
              )}
            </>
          ) : null}
          <ShortlistResults
            key={latest._id}
            runId={latest._id}
            complete={latest.state === "complete"}
          />
          <details>
            <summary>Inspect direct comparisons and their evidence</summary>
            <ShortlistComparisons runId={latest._id} />
          </details>
        </>
      )}
    </section>
  );
}

function ShortlistResults({
  runId,
  complete,
}: {
  runId: Id<"admissionShortlistRuns">;
  complete: boolean;
}) {
  const filters = [
    "all",
    "accept",
    "waitlist",
    "reject",
    "unresolved",
  ] as const;
  const [filter, setFilter] = useState<(typeof filters)[number]>("all");
  const { results, status, loadMore } = usePaginatedQuery(
    api.admissionShortlist.results,
    { runId, ...(filter === "all" ? {} : { suggestion: filter }) },
    { initialNumItems: 25 },
  );
  return (
    <section>
      <h2>
        {complete
          ? "Suggestions"
          : "Candidate evidence — results are provisional until the run completes"}
      </h2>
      <label>
        Show{" "}
        <select
          value={filter}
          onChange={(e) => {
            const selected = filters.find((f) => f === e.target.value);
            if (selected) setFilter(selected);
          }}
        >
          {filters.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <p className="muted">
        Showing {results.length} matching records. Filters search the entire
        frozen snapshot.
      </p>
      {results
        .filter((r) => !r.committed)
        .map((row) => {
          const result = row.resultJson
            ? shortlistSuggestionSchema.parse(JSON.parse(row.resultJson))
            : null;
          const profile = row.profileJson
            ? shortlistProfileSchema.parse(JSON.parse(row.profileJson))
            : null;
          const input = row.inputJson
            ? shortlistCandidateInputSchema.parse(JSON.parse(row.inputJson))
            : null;
          return (
            <article key={row._id} className="configuration-card">
              <h3>
                <Link to={`/admissions/${row.applicationId}`}>
                  {row.teamName || "Preparing team"}
                </Link>{" "}
                · {row.teamSize} people
              </h3>
              <p>
                Individual quality: {input?.quality ?? "pending"} · Shortlist:{" "}
                {result?.suggestion ?? "unresolved"} · Reason:{" "}
                {result?.reason ?? "analysis pending"}
              </p>
              {row.stale ? (
                <p role="alert">
                  Source changed since this snapshot. Do not use this suggestion
                  as current.
                </p>
              ) : null}
              {result?.uncertainComparison ? (
                <p>
                  Comparison tie or cycle: ordering is uncertain, not an
                  established superiority finding.
                </p>
              ) : null}
              {result?.preferredApplicationIds.length ? (
                <p>
                  Selected overlapping alternative:{" "}
                  {result.preferredApplicationIds.map((id) => (
                    <Link key={id} to={`/admissions/${id}`}>
                      View team{" "}
                    </Link>
                  ))}
                </p>
              ) : null}
              {profile ? (
                <>
                  <p>{profile.problem}</p>
                  <p>
                    Premise: {profile.premise.assessment} —{" "}
                    {profile.premise.explanation} (
                    {profile.premise.sourceRefs.join(", ")})
                  </p>
                  <details>
                    <summary>Concept and submitted evidence</summary>
                    <p>User: {profile.user}</p>
                    <p>Workflow: {profile.workflow}</p>
                    <p>Mechanism: {profile.mechanism}</p>
                    <p>Distinction: {profile.distinction}</p>
                    <p>Deliverable: {profile.deliverable}</p>
                    <p>
                      Domain: {profile.domain} · AI role: {profile.aiRole}
                    </p>
                    {profile.category.datingOrRomanticMatchmaking ? (
                      <p>Category exclusion: {profile.category.explanation}</p>
                    ) : null}
                    <ul>
                      {profile.criteria.map((c) => (
                        <li key={c.criterionKey}>
                          {c.criterionKey}: {c.evidence} (
                          {c.sourceRefs.join(", ")})
                        </li>
                      ))}
                    </ul>
                    {input?.sources.map((s) => (
                      <div key={s.sourceRef}>
                        <h4>
                          {s.sourceRef}: {s.question}
                        </h4>
                        <p>{s.answer}</p>
                      </div>
                    ))}
                  </details>
                </>
              ) : null}
            </article>
          );
        })}
      {status === "CanLoadMore" ? (
        <button onClick={() => loadMore(25)}>Load more teams</button>
      ) : null}
    </section>
  );
}
function ShortlistComparisons({
  runId,
}: {
  runId: Id<"admissionShortlistRuns">;
}) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.admissionShortlist.comparisons,
    { runId },
    { initialNumItems: 25 },
  );
  return (
    <div>
      {results.map((job) => {
        const task = shortlistTaskSchema.parse(JSON.parse(job.inputJson));
        if (task.kind !== "pair") return null;
        const pair = job.resultJson
          ? shortlistPairSchema.parse(JSON.parse(job.resultJson))
          : null;
        return (
          <details key={job._id}>
            <summary>
              {pair?.overlap ?? job.state} · preference:{" "}
              {pair?.preferred ?? "pending"}
            </summary>
            <p>{pair?.explanation}</p>
            {([task.left, task.right] as const).map((candidate, i) => (
              <section key={candidate.applicationId}>
                <h4>
                  {i === 0 ? "Left" : "Right"}:{" "}
                  <Link to={`/admissions/${candidate.applicationId}`}>
                    Open application
                  </Link>
                </h4>
                <p>
                  Citations:{" "}
                  {(i === 0
                    ? pair?.leftSourceRefs
                    : pair?.rightSourceRefs
                  )?.join(", ")}
                </p>
                {candidate.sources.map((s) => (
                  <p key={s.sourceRef}>
                    <strong>
                      {s.sourceRef} · {s.question}
                    </strong>
                    <br />
                    {s.answer}
                  </p>
                ))}
              </section>
            ))}
          </details>
        );
      })}
      {status === "CanLoadMore" ? (
        <button onClick={() => loadMore(25)}>
          Load more comparison records
        </button>
      ) : null}
    </div>
  );
}
