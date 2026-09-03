import { api } from "@code2create/backend/api";
import { usePaginatedQuery, useQuery } from "convex/react";
import { lazy, Suspense, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { FunctionReturnType } from "convex/server";

import { AttendanceRemedy } from "../components/AttendanceRemedy";
import { AttendanceReconciliation } from "../components/AttendanceReconciliation";
import { AttendanceRollCall } from "../components/AttendanceRollCall";
import { eventSlug } from "../lib/config";
import { useEstimatedServerNow } from "../lib/useEstimatedServerNow";

const AttendanceExport = lazy(() => import("../components/AttendanceExport"));
const AttendanceManualRecovery = lazy(() => import("../components/AttendanceManualRecovery"));

type PresenceFilter =
  | "all"
  | "confirmation_due"
  | "present"
  | "temporarily_out"
  | "complete"
  | "excused"
  | "needs_review";

type AttendanceRosterItem = FunctionReturnType<
  typeof api.attendanceOperations.sessionRoster
>["page"][number];

const presenceStateLabels: Record<AttendanceRosterItem["state"], string> = {
  not_expected: "Not expected",
  confirmation_due: "Waiting",
  present: "Present",
  temporarily_out: "Temporarily out",
  complete: "Complete",
  excused: "Excused",
  needs_review: "Needs review",
};

const expectationLabels: Record<AttendanceRosterItem["expectation"], string> = {
  required: "Required",
  optional: "Optional",
  not_expected: "Not expected",
  excused: "Excused",
};

const resultLabels: Record<NonNullable<AttendanceRosterItem["result"]>, string> = {
  attended: "Attended",
  absent: "Absent",
  partial: "Partial attendance",
  excused: "Excused",
  not_expected: "Not expected",
  needs_review: "Needs review",
};

export function AttendanceSession() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [filter, setFilter] = useState<PresenceFilter>("all");
  const overview = useQuery(api.attendanceOperations.overview, { eventSlug });
  const serverNow = useEstimatedServerNow(overview?.serverNow);
  const session = overview?.sessions.find((candidate) => candidate.id === sessionId);
  const roster = usePaginatedQuery(
    api.attendanceOperations.sessionRoster,
    sessionId && session?.canReadRoster
      ? {
          eventSlug,
          sessionId,
          ...(filter === "all" ? {} : { state: filter }),
        }
      : "skip",
    { initialNumItems: 50 },
  );

  if (!sessionId) return <p className="notice error">Session ID is missing.</p>;
  if (overview === undefined || (session?.canReadRoster && roster.status === "LoadingFirstPage")) {
    return <p className="muted">Loading session…</p>;
  }
  if (!session) return <p className="notice error">You do not have access to this session.</p>;

  return (
    <section className="attendance-shell">
      <Link className="back-link" to="/attendance">
        ← Attendance
      </Link>
      <header className="page-heading">
        <div>
          <p className="eyebrow">{session.zoneName}</p>
          <h1>{session.name}</h1>
          <p className="muted">
            See who is here, sort out check-in problems, or account for everyone in an emergency.
          </p>
        </div>
        {session.canReadRoster ? (
          <label className="filter">
            <span>Show</span>
            <select value={filter} onChange={(event) => setFilter(parseFilter(event.target.value))}>
              <option value="all">Everyone</option>
              <option value="confirmation_due">Waiting</option>
              <option value="present">Present</option>
              <option value="temporarily_out">Temporarily out</option>
              <option value="complete">Complete</option>
              <option value="excused">Excused</option>
              <option value="needs_review">Needs review</option>
            </select>
          </label>
        ) : null}
      </header>

      {session.canReadRollCalls ? <AttendanceRollCall session={session} /> : null}

      {session.canExport ? (
        <Suspense fallback={<p className="muted">Loading export…</p>}>
          <AttendanceExport session={session} />
        </Suspense>
      ) : null}

      {session.canReadManualSheets ? (
        <Suspense fallback={<p className="muted">Loading paper backup…</p>}>
          <AttendanceManualRecovery session={session} serverNow={serverNow} />
        </Suspense>
      ) : null}

      {session.canReadRoster ? (
        <>
          <div className="roster-list">
            {roster.results.map((participant) => (
              <article className="roster-entry" key={participant.membershipId}>
                <div className="roster-row">
                  <div>
                    <strong>{participant.displayName}</strong>
                    <span>{participant.teamName ?? "No active team"}</span>
                  </div>
                  <div className="roster-state">
                    <strong>
                      {participant.result
                        ? resultName(participant.result)
                        : stateName(participant.state)}
                    </strong>
                    <span>
                      {participant.presentDurationMs !== undefined
                        ? durationName(participant.presentDurationMs)
                        : participant.late
                          ? "Late confirmation"
                          : expectationLabels[participant.expectation]}
                    </span>
                    {session.canReconcile ? (
                      <AttendanceReconciliation
                        session={session}
                        participant={participant}
                        serverNow={serverNow}
                      />
                    ) : null}
                    {session.canReadRemedies ? (
                      <AttendanceRemedy session={session} participant={participant} />
                    ) : null}
                  </div>
                </div>
              </article>
            ))}
            {roster.results.length === 0 ? (
              <p className="empty">No participants match this view.</p>
            ) : null}
          </div>
          {roster.status === "CanLoadMore" ? (
            <button className="secondary" type="button" onClick={() => roster.loadMore(50)}>
              Load more
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function parseFilter(value: string): PresenceFilter {
  if (
    value === "confirmation_due" ||
    value === "present" ||
    value === "temporarily_out" ||
    value === "complete" ||
    value === "excused" ||
    value === "needs_review"
  )
    return value;
  return "all";
}

function stateName(value: AttendanceRosterItem["state"]) {
  return presenceStateLabels[value];
}

function resultName(value: NonNullable<AttendanceRosterItem["result"]>) {
  return resultLabels[value];
}

function durationName(milliseconds: number) {
  const minutes = Math.floor(milliseconds / 60_000);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours > 0 ? `${hours}h ${remainder}m present` : `${minutes}m present`;
}
