import { api } from "@code2create/backend/api";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useState, type SubmitEvent } from "react";

import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import {
  indiaDateTimeToTimestamp,
  timestampToIndiaDateTime,
} from "../lib/indiaDateTime";
import { useMutationAttempt } from "../lib/operations";

const time = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "numeric",
  minute: "2-digit",
});
const dateTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});
type ConfirmationOverview = FunctionReturnType<
  typeof api.reviewConfirmations.overview
>;

export function ReviewConfirmations({
  roundId,
}: {
  roundId: FunctionArgs<typeof api.reviewConfirmations.overview>["roundId"];
}) {
  const data = useQuery(api.reviewConfirmations.overview, {
    eventSlug,
    roundId,
  });
  if (!data)
    return <p className="muted">Loading availability confirmations…</p>;
  const confirmed = data.people.filter(
    (person) => person.response.status === "confirmed",
  ).length;
  const pending = data.people.filter(
    (person) => person.response.status === "pending",
  ).length;
  return (
    <details className="workspace-disclosure">
      <summary>
        <span>
          <strong>Round availability</strong>
          <small>
            {confirmed} confirmed · {pending} awaiting response ·{" "}
            {data.people.length - confirmed - pending} unavailable
          </small>
        </span>
      </summary>
      <p className="muted">
        App confirmation opens at {dateTime.format(data.opensAt)} IST. These
        responses determine availability for this round.
      </p>
      {data.canConfigure && data.state === "scheduled" ? (
        <ConfirmationSchedule
          key={data.version}
          roundId={roundId}
          current={data}
        />
      ) : null}
      <div className="published-rounds">
        {data.people.map((person) => (
          <div key={person.personId} className="published-round-row">
            <strong>{person.displayName}</strong>
            <span>
              {person.response.status === "pending"
                ? "Awaiting confirmation"
                : person.response.status === "unavailable"
                  ? "Unavailable"
                  : person.response.windows
                      .map(
                        (window) =>
                          `${time.format(window.startsAt)}–${time.format(window.endsAt)}`,
                      )
                      .join(", ")}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}

function ConfirmationSchedule({
  roundId,
  current,
}: {
  roundId: FunctionArgs<typeof api.reviewConfirmations.reschedule>["roundId"];
  current: ConfirmationOverview;
}) {
  const reschedule = useMutation(api.reviewConfirmations.reschedule);
  const attempt =
    useMutationAttempt<
      FunctionReturnType<typeof api.reviewConfirmations.reschedule>
    >();
  const [opening, setOpening] = useState(
    timestampToIndiaDateTime(current.opensAt),
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = attempt.hasPending("confirmation-schedule");

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await attempt.run("confirmation-schedule", () => {
        const opensAt = indiaDateTimeToTimestamp(opening);
        if (opensAt === null)
          throw new Error("Choose a valid confirmation time in IST.");
        const args = {
          eventSlug,
          roundId,
          opensAt,
          reason,
          expectedVersion: current.version,
          clientOperationId: crypto.randomUUID(),
        };
        return () => reschedule(args);
      });
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="workspace-disclosure">
      <summary>Change confirmation time</summary>
      <form className="stack" onSubmit={submit}>
        <label>
          Opening time (IST)
          <input
            type="datetime-local"
            required
            disabled={busy || pending}
            value={opening}
            onChange={(event) => setOpening(event.target.value)}
          />
        </label>
        <label>
          Reason for the change
          <input
            required
            minLength={3}
            maxLength={300}
            disabled={busy || pending}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <p className="muted">
          You can change this until confirmation opens. Existing reviewer
          responses are preserved.
        </p>
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={busy}>
          {busy
            ? "Saving…"
            : pending
              ? "Retry schedule change"
              : "Save confirmation time"}
        </button>
      </form>
    </details>
  );
}
