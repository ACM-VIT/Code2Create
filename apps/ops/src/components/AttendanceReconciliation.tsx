import { api } from "@code2create/backend/api";
import { attendanceHistoryEventLabel, sessionPresenceStateLabels } from "@code2create/domain";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useState, type FormEvent } from "react";

import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useMutationAttempt } from "../lib/operations";

type AttendanceOverview = FunctionReturnType<typeof api.attendanceOperations.overview>;
type AttendanceSession = AttendanceOverview["sessions"][number];
type AttendanceRoster = FunctionReturnType<typeof api.attendanceOperations.sessionRoster>;
type AttendanceParticipant = AttendanceRoster["page"][number];
type ActionKind =
  | "mark_present"
  | "mark_temporarily_out"
  | "mark_needs_review"
  | "void_last_transition";

export function AttendanceReconciliation({
  session,
  participant,
  serverNow,
}: {
  session: AttendanceSession;
  participant: AttendanceParticipant;
  serverNow: number;
}) {
  const reconcile = useMutation(api.attendanceReconciliation.reconcile);
  const options = actionOptions(participant);
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<ActionKind>(options[0]?.kind ?? "mark_needs_review");
  const [effectiveAt, setEffectiveAt] = useState(localDateTime(serverNow));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const correctionAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.attendanceReconciliation.reconcile>>();
  const correctionPending = correctionAttempt.hasPending("attendance-reconciliation");
  const preview = useQuery(
    api.attendanceOperations.reconciliationPreview,
    open
      ? {
          eventSlug,
          sessionId: session.id,
          membershipId: participant.membershipId,
        }
      : "skip",
  );

  if ((session.status !== "open" || options.length === 0) && !correctionPending) return null;
  const previewChanged =
    preview !== undefined && preview.participantVersion !== participant.version;

  const chooseAction = (value: string) => {
    const option = options.find((candidate) => candidate.kind === value);
    if (!option) return;
    setAction(option.kind);
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await correctionAttempt.run("attendance-reconciliation", () => {
        if (action === "void_last_transition") {
          const sourceEventId = participant.lastEventId;
          if (!sourceEventId)
            throw new Error("The latest scanner event changed. Refresh and try again.");
          const args = {
            eventSlug,
            sessionId: session.id,
            membershipId: participant.membershipId,
            expectedSessionVersion: session.version,
            expectedParticipantVersion: participant.version,
            reason,
            clientOperationId: crypto.randomUUID(),
            action: {
              kind: "void_last_transition" as const,
              sourceEventId,
            },
          };
          return () => reconcile(args);
        }
        const timestamp = Date.parse(effectiveAt);
        if (!Number.isSafeInteger(timestamp)) throw new Error("Choose a valid effective time.");
        if (action === "mark_present") {
          const args = {
            eventSlug,
            sessionId: session.id,
            membershipId: participant.membershipId,
            expectedSessionVersion: session.version,
            expectedParticipantVersion: participant.version,
            reason,
            clientOperationId: crypto.randomUUID(),
            action: { kind: "mark_present" as const, effectiveAt: timestamp },
          };
          return () => reconcile(args);
        }
        if (action === "mark_temporarily_out") {
          const args = {
            eventSlug,
            sessionId: session.id,
            membershipId: participant.membershipId,
            expectedSessionVersion: session.version,
            expectedParticipantVersion: participant.version,
            reason,
            clientOperationId: crypto.randomUUID(),
            action: { kind: "mark_temporarily_out" as const, effectiveAt: timestamp },
          };
          return () => reconcile(args);
        }
        const args = {
          eventSlug,
          sessionId: session.id,
          membershipId: participant.membershipId,
          expectedSessionVersion: session.version,
          expectedParticipantVersion: participant.version,
          reason,
          clientOperationId: crypto.randomUUID(),
          action: { kind: "mark_needs_review" as const, effectiveAt: timestamp },
        };
        return () => reconcile(args);
      });
      setReason("");
      setOpen(false);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        className="text-button"
        type="button"
        onClick={() => {
          setEffectiveAt(localDateTime(serverNow));
          setOpen(true);
        }}
      >
        Correct
      </button>
    );
  }

  return (
    <form className="attendance-correction" onSubmit={submit}>
      <div className="attendance-correction-fields">
        <label className="field">
          <span>Correction</span>
          <select
            disabled={busy || correctionPending}
            value={action}
            onChange={(event) => chooseAction(event.target.value)}
          >
            {options.map((option) => (
              <option key={option.kind} value={option.kind}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {action !== "void_last_transition" ? (
          <label className="field">
            <span>Effective time</span>
            <input
              type="datetime-local"
              step="60"
              disabled={busy || correctionPending}
              value={effectiveAt}
              onChange={(event) => setEffectiveAt(event.target.value)}
            />
          </label>
        ) : null}
        <label className="field attendance-correction-reason">
          <span>Reason</span>
          <textarea
            disabled={busy || correctionPending}
            required
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="What was missed or recorded incorrectly?"
          />
        </label>
      </div>
      <p className="muted">
        This adds a correction; the original scan stays in the history. Requires a Google sign-in
        from the last 15 minutes.
      </p>
      {preview === undefined ? (
        <p className="muted">Loading current history…</p>
      ) : (
        <div className="attendance-correction-preview">
          <p>
            <strong>Current state:</strong> {sessionPresenceStateLabels[preview.state]}
            {preview.currentInterval
              ? ` · present since ${timeName(preview.currentInterval.openedAt)}`
              : " · no open interval"}
          </p>
          <p>{consequenceText(action, preview.currentInterval !== null)}</p>
          {preview.recentEvents.length > 0 ? (
            <details>
              <summary>Recent presence history</summary>
              <ol>
                {preview.recentEvents.map((presenceEvent) => (
                  <li key={presenceEvent.id}>
                    <span>{attendanceHistoryEventLabel(presenceEvent)}</span>
                    <small>{timeName(presenceEvent.effectiveAt)}</small>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </div>
      )}
      {previewChanged ? (
        <p className="notice error" role="alert">
          {correctionPending
            ? "Attendance changed after the earlier correction was sent. Confirm that exact correction before continuing."
            : "Attendance changed while this form was open. Close it and review the new state."}
        </p>
      ) : null}
      <div className="button-row">
        <button
          className="primary"
          type="submit"
          disabled={
            busy ||
            (!correctionPending &&
              (preview === undefined || previewChanged || reason.trim().length < 5))
          }
        >
          {busy ? "Saving…" : correctionPending ? "Confirm correction" : "Save correction"}
        </button>
        <button
          className="secondary"
          type="button"
          disabled={busy || correctionPending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
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
  );
}

function actionOptions(participant: AttendanceParticipant) {
  const options: Array<{ kind: ActionKind; label: string }> = [];
  if (
    participant.state === "confirmation_due" ||
    participant.state === "temporarily_out" ||
    participant.state === "needs_review"
  ) {
    options.push({ kind: "mark_present", label: "Record presence" });
  }
  if (participant.state === "present") {
    options.push({ kind: "mark_temporarily_out", label: "Record temporary exit" });
  }
  if (
    participant.state !== "complete" &&
    participant.state !== "excused" &&
    participant.state !== "not_expected" &&
    participant.state !== "needs_review"
  ) {
    options.push({ kind: "mark_needs_review", label: "Mark for review" });
  }
  if (participant.canVoidLastTransition && participant.lastEventId) {
    options.push({ kind: "void_last_transition", label: "Cancel the latest scan" });
  }
  return options;
}

function localDateTime(timestamp: number) {
  const date = new Date(timestamp);
  const localTimestamp = timestamp - date.getTimezoneOffset() * 60_000;
  return new Date(localTimestamp).toISOString().slice(0, 16);
}

function timeName(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function consequenceText(action: ActionKind, hasOpenInterval: boolean) {
  if (action === "mark_present") {
    return hasOpenInterval
      ? "This keeps the verified open interval and restores the live state to present."
      : "This opens one presence interval at the effective time.";
  }
  if (action === "mark_temporarily_out") {
    return "This closes the current presence interval at the effective time.";
  }
  if (action === "void_last_transition") {
    return "This reverses only the latest accepted scan. The original scan remains in history.";
  }
  return hasOpenInterval
    ? "This closes the current interval and marks the participant for human review."
    : "This marks the participant for human review without inventing an interval.";
}
