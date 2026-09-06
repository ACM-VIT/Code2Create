import { LiveNumber } from "./LiveNumber";
import { api } from "@code2create/backend/api";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useState, type SubmitEvent } from "react";

import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import {
  rescheduleReviewConfirmationWindow,
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
    return (
      <p className="m-0 text-ink-2">Loading availability confirmations…</p>
    );
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
            <LiveNumber value={confirmed} /> confirmed ·{" "}
            <LiveNumber value={pending} /> awaiting response ·{" "}
            <LiveNumber value={data.people.length - confirmed - pending} />{" "}
            unavailable
          </small>
        </span>
      </summary>
      <p className="m-0 px-4 py-5 text-ink-2 sm:px-5">
        App confirmation: {dateTime.format(data.opensAt)} to{" "}
        {dateTime.format(data.closesAt)} IST. These responses determine
        availability for this round.
      </p>
      {data.canConfigure ? (
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
  const [closing, setClosing] = useState(
    timestampToIndiaDateTime(current.closesAt),
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
        const { opensAt, closesAt } = rescheduleReviewConfirmationWindow(
          current,
          opening,
          closing,
        );
        if (opensAt === null || closesAt === null)
          throw new Error("Choose a valid confirmation time in IST.");
        const args = {
          eventSlug,
          roundId,
          opensAt,
          closesAt,
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
    <details className="mx-4 mb-5 rounded-md border border-solid border-line sm:mx-5">
      <summary className="cursor-pointer px-4 py-3 text-sm">
        Change confirmation time
      </summary>
      <form className="grid gap-5 p-4 sm:p-5" onSubmit={submit}>
        <label className="field">
          Opening time (IST)
          <input
            type="datetime-local"
            required
            disabled={busy || pending}
            readOnly={current.state !== "scheduled"}
            value={opening}
            onChange={(event) => setOpening(event.target.value)}
          />
        </label>
        <label className="field">
          Closing time (IST)
          <input
            type="datetime-local"
            required
            disabled={busy || pending}
            value={closing}
            onChange={(event) => setClosing(event.target.value)}
          />
        </label>
        <label className="field">
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
        <p className="m-0 text-ink-2">
          Extend or reopen confirmations by moving the closing time. Existing
          responses are preserved.
        </p>
        {error ? (
          <p role="alert" className="notice error m-0">
            {error}
          </p>
        ) : null}
        <button className="primary" type="submit" disabled={busy}>
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
