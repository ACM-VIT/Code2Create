import { api } from "@code2create/backend/api";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import {
  indiaDateTimeToTimestamp,
  timestampToIndiaDateTime,
} from "../lib/indiaDateTime";
import { useMutationAttempt } from "../lib/operations";

type Settings = FunctionReturnType<typeof api.reviewTiming.settings>;
type RoundId = FunctionArgs<typeof api.reviewTiming.extend>["roundId"];
const time = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "numeric",
  minute: "2-digit",
});
export function ReviewTiming({ roundId }: { roundId: RoundId }) {
  const data = useQuery(api.reviewTiming.settings, { eventSlug, roundId });
  if (!data) return null;
  return (
    <details className="workspace-disclosure">
      <summary>
        <strong>Round timing</strong>
        <span>
          {time.format(data.startsAt)}–{time.format(data.endsAt)} IST
        </span>
      </summary>
      <TimingEditor key={data.version} data={data} roundId={roundId} />
    </details>
  );
}
function TimingEditor({ data, roundId }: { data: Settings; roundId: RoundId }) {
  const extend = useMutation(api.reviewTiming.extend);
  const attempt = useMutationAttempt<{ version: number }>();
  const [ending, setEnding] = useState(
    timestampToIndiaDateTime(data.endsAt + 15 * 60_000),
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = attempt.hasPending("extend-round");
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await attempt.run("extend-round", () => {
        const endsAt = indiaDateTimeToTimestamp(ending);
        if (endsAt === null) throw new Error("Choose a valid finish time.");
        const args = {
          eventSlug,
          roundId,
          endsAt,
          expectedVersion: data.version,
          reason,
          clientOperationId: crypto.randomUUID(),
        };
        return () => extend(args);
      });
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-4 p-4 sm:p-5">
      <p className="m-0 text-ink-2">
        {data.confirmedThroughEnd} of {data.confirmedReviewers} confirmed
        reviewers have hours through the current finish. Reviewers must confirm
        any extra time. Active reviews and unfinished scores remain open.
      </p>
      {data.canExtend ? (
        <>
          <div className="flex flex-wrap gap-2">
            {[15, 30, 60].map((minutes) => (
              <button
                type="button"
                className="secondary"
                disabled={busy || pending}
                key={minutes}
                onClick={() =>
                  setEnding(
                    timestampToIndiaDateTime(data.endsAt + minutes * 60_000),
                  )
                }
              >
                +{minutes} min
              </button>
            ))}
          </div>
          <label className="field">
            New finish (IST)
            <input
              type="datetime-local"
              value={ending}
              disabled={busy || pending}
              onChange={(e) => setEnding(e.target.value)}
            />
          </label>
          <label className="field">
            Reason
            <input
              value={reason}
              maxLength={500}
              disabled={busy || pending}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="primary justify-self-start"
            disabled={busy || (!pending && reason.trim().length < 5)}
            onClick={() => void save()}
          >
            {busy ? "Extending…" : pending ? "Retry extension" : "Extend round"}
          </button>
        </>
      ) : null}
      {error ? (
        <p className="notice error m-0" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
