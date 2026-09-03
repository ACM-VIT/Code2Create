import { api } from "@code2create/backend/api";
import { attendanceSessionResultLabels } from "@code2create/domain";
import type { FunctionReturnType } from "convex/server";
import { useMutation, usePaginatedQuery } from "convex/react";
import { useState, type SubmitEvent } from "react";

import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useMutationAttempt } from "../lib/operations";

type RemedySessions = FunctionReturnType<typeof api.attendanceRemedies.mine>;
type RemedySession = RemedySessions["page"][number];

export function AttendanceResultHistory() {
  const [historyOpen, setHistoryOpen] = useState(false);
  const {
    results: sessions,
    status,
    loadMore,
  } = usePaginatedQuery(api.attendanceRemedies.mine, historyOpen ? { eventSlug } : "skip", {
    initialNumItems: 5,
  });
  const openRemedy = useMutation(api.attendanceRemedies.openMine);
  const [selectedSessionId, setSelectedSessionId] = useState<RemedySession["sessionId"] | null>(
    null,
  );
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remedyAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.attendanceRemedies.openMine>>();
  const remedyPending = remedyAttempt.hasPending("attendance-remedy-open");
  const selectedSession = sessions?.find((session) => session.sessionId === selectedSessionId);

  const cancel = () => {
    setSelectedSessionId(null);
    setDescription("");
    setError(null);
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!remedyPending && !selectedSession) return;
    setBusy(true);
    setError(null);
    try {
      await remedyAttempt.run("attendance-remedy-open", () => {
        if (!selectedSession)
          throw new Error("The attendance session is no longer available for review.");
        const args = {
          eventSlug,
          sessionId: selectedSession.sessionId,
          expectedSessionVersion: selectedSession.sessionVersion,
          expectedParticipantVersion: selectedSession.participantVersion,
          description,
          clientOperationId: crypto.randomUUID(),
        };
        return () => openRemedy(args);
      });
      cancel();
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  if (!historyOpen) {
    return (
      <button className="text-button" type="button" onClick={() => setHistoryOpen(true)}>
        View past session results
      </button>
    );
  }

  return (
    <div className="attendance-results">
      <div className="attendance-result-summary">
        <div>
          <strong>Session results</strong>
          <p className="muted">Final results appear here after each hacking session closes.</p>
        </div>
        <button
          className="text-button"
          type="button"
          disabled={busy || remedyPending}
          onClick={() => setHistoryOpen(false)}
        >
          Hide results
        </button>
      </div>
      {status === "LoadingFirstPage" ? (
        <p className="muted">Loading final session results…</p>
      ) : sessions.length === 0 && status === "Exhausted" ? (
        <p className="muted">No finalized session results yet.</p>
      ) : (
        <ul className="attendance-result-list">
          {sessions.map((session) => (
            <li key={session.sessionId}>
              <div className="attendance-result-summary">
                <div>
                  <strong>{session.sessionName}</strong>
                  <span>{dateName(session.startsAt)}</span>
                </div>
                <div>
                  <strong>{resultName(session.result)}</strong>
                  <span>{durationName(session.presentDurationMs)}</span>
                </div>
              </div>
              {session.latestCase ? (
                <div className="attendance-result-case">
                  <span>{caseStateName(session.latestCase.state)}</span>
                  <p>{session.latestCase.description}</p>
                  {session.latestCase.participantResolutionNote ? (
                    <p>{session.latestCase.participantResolutionNote}</p>
                  ) : null}
                </div>
              ) : null}
              {session.canRequest && selectedSessionId !== session.sessionId ? (
                <button
                  className="text-button"
                  type="button"
                  disabled={busy || remedyPending}
                  onClick={() => {
                    setSelectedSessionId(session.sessionId);
                    setDescription("");
                    setError(null);
                  }}
                >
                  Report an issue
                </button>
              ) : null}
              {selectedSessionId === session.sessionId ? (
                <form className="attendance-result-form" onSubmit={submit}>
                  <label className="field">
                    <span className="field-label">What looks wrong?</span>
                    <textarea
                      autoFocus
                      required
                      minLength={10}
                      maxLength={1_000}
                      disabled={busy || remedyPending}
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      placeholder="For example: I checked in, but my final result says absent."
                    />
                  </label>
                  <p className="fine-print">
                    Staff will review the frozen result and scanner history. Sending a report does
                    not change the result by itself.
                  </p>
                  <div className="button-row">
                    <button
                      className="secondary"
                      type="submit"
                      disabled={busy || (!remedyPending && description.trim().length < 10)}
                    >
                      {busy ? "Sending…" : remedyPending ? "Confirm report" : "Send for review"}
                    </button>
                    <button
                      className="text-button"
                      type="button"
                      disabled={busy || remedyPending}
                      onClick={cancel}
                    >
                      Cancel
                    </button>
                  </div>
                  {error ? (
                    <p className="notice notice-error" role="alert">
                      {error}
                    </p>
                  ) : null}
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {status === "CanLoadMore" ? (
        <button className="text-button" type="button" onClick={() => loadMore(5)}>
          Load older results
        </button>
      ) : status === "LoadingMore" ? (
        <p className="muted">Loading older results…</p>
      ) : null}
    </div>
  );
}

function resultName(value: RemedySession["result"]) {
  return attendanceSessionResultLabels[value];
}

function caseStateName(value: NonNullable<RemedySession["latestCase"]>["state"]) {
  if (value === "open") return "Review in progress";
  return value === "approved" ? "Correction approved" : "Review declined";
}

function durationName(milliseconds: number) {
  const minutes = Math.floor(milliseconds / 60_000);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours > 0 ? `${hours}h ${remainder}m present` : `${minutes}m present`;
}

function dateName(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}
