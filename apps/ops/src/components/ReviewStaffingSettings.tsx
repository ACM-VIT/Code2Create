import { LiveNumber } from "./LiveNumber";
import { api } from "@code2create/backend/api";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useState, type SubmitEvent } from "react";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useMutationAttempt } from "../lib/operations";

type Settings = FunctionReturnType<typeof api.reviewStaffing.settings>;
type RoundId = FunctionArgs<typeof api.reviewStaffing.settings>["roundId"];
export function ReviewStaffingSettings({ roundId }: { roundId: RoundId }) {
  const settings = useQuery(api.reviewStaffing.settings, {
    eventSlug,
    roundId,
  });
  if (!settings) return null;
  return (
    <>
      {settings.staffing.automaticReplacement &&
      settings.automationBlockedPanels > 0 ? (
        <p role="alert">
          Automatic staffing is blocked for {settings.automationBlockedPanels}{" "}
          panels. The operator who published this round needs permission to page
          and assign substitutes for these panels.
        </p>
      ) : null}
      <StaffingForm
        key={settings.version}
        roundId={roundId}
        settings={settings}
      />
      <JuniorParticipation roundId={roundId} />
    </>
  );
}

function JuniorParticipation({ roundId }: { roundId: RoundId }) {
  const people = useQuery(api.reviewStaffing.juniorParticipation, {
    eventSlug,
    roundId,
  });
  if (!people?.length) return null;
  const reviewed = people.filter(
    (person) => person.completedReviews > 0,
  ).length;
  const waitingForFirst = people.filter(
    (person) => person.completedReviews === 0 && person.status === "waiting",
  ).length;
  const labels = {
    on_panel: "On a panel",
    paged: "Paged; awaiting response",
    waiting: "On duty; waiting",
    off_duty: "Off duty",
    outside_window: "Outside confirmed hours",
    unconfirmed: "Availability not confirmed",
    training_needed: "Training or profile needed",
  };
  return (
    <details className="workspace-disclosure">
      <summary>
        <strong>
          JC participation · <LiveNumber value={reviewed} /> of <LiveNumber value={people.length} /> have reviewed
        </strong>
      </summary>
      <p className="muted">
        {waitingForFirst} on-duty JCs are waiting for their first review.
        Allocation checks availability and qualifications, then prefers the
        fewest completed reviews across this event and the longest wait since
        the last review. Pages and declines do not count as completed reviews.
      </p>
      <div className="published-rounds">
        {people.map((person) => (
          <div className="published-round-row" key={person.personId}>
            <strong>{person.displayName}</strong>
            <span>
              <LiveNumber value={person.completedReviews} /> completed · {labels[person.status]}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}
function StaffingForm({
  roundId,
  settings,
}: {
  roundId: RoundId;
  settings: Settings;
}) {
  const configure = useMutation(api.reviewStaffing.configure);
  const attempt =
    useMutationAttempt<
      FunctionReturnType<typeof api.reviewStaffing.configure>
    >();
  const [policy, setPolicy] = useState(settings.staffing);
  const [response, setResponse] = useState(
    String(settings.substituteResponseSeconds),
  );
  const [grace, setGrace] = useState(String(settings.noShowGraceSeconds));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = attempt.hasPending("staffing");
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await attempt.run("staffing", () => {
        const args = {
          eventSlug,
          roundId,
          expectedVersion: settings.version,
          staffing: policy,
          substituteResponseSeconds: Number(response),
          noShowGraceSeconds: Number(grace),
          reason,
          clientOperationId: crypto.randomUUID(),
        };
        return () => configure(args);
      });
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="workspace-disclosure">
      <summary>
        <strong>Staffing controls</strong>
      </summary>
      <p className="muted">
        One lead · {policy.seniorSeats} SC · {policy.juniorSeats} JC. Changes
        apply to new pages and subsequent staffing checks. An active page keeps
        its response deadline.
      </p>
      <form className="stack" onSubmit={submit}>
        <fieldset disabled={!settings.canConfigure || busy || pending}>
          <label>
            <input
              type="checkbox"
              checked={policy.allowSeniorLeadFallback}
              onChange={(event) =>
                setPolicy((current) => ({
                  ...current,
                  allowSeniorLeadFallback: event.target.checked,
                }))
              }
            />
            Allow an SC lead if Board is unavailable
          </label>
          <label>
            <input
              type="checkbox"
              checked={policy.automaticReplacement}
              onChange={(event) =>
                setPolicy((current) => ({
                  ...current,
                  automaticReplacement: event.target.checked,
                }))
              }
            />
            Automatic replacement
          </label>
          <label>
            Rotate JC after this many reviews (0 disables)
            <input
              type="number"
              min={0}
              max={100}
              required
              value={policy.juniorRotationReviews}
              onChange={(event) =>
                setPolicy((current) => ({
                  ...current,
                  juniorRotationReviews: Number(event.target.value),
                }))
              }
            />
          </label>
          <label>
            Page response window (seconds)
            <input
              type="number"
              min={15}
              max={1800}
              required
              value={response}
              onChange={(event) => setResponse(event.target.value)}
            />
          </label>
          <label>
            Arrival after page acceptance (seconds)
            <input
              type="number"
              min={15}
              max={1800}
              required
              value={policy.reviewerArrivalSeconds}
              onChange={(event) =>
                setPolicy((current) => ({
                  ...current,
                  reviewerArrivalSeconds: Number(event.target.value),
                }))
              }
            />
          </label>
          <label>
            No-show grace (seconds)
            <input
              type="number"
              min={15}
              max={1800}
              required
              value={grace}
              onChange={(event) => setGrace(event.target.value)}
            />
          </label>
          <label>
            Assignment reminder before a shift (seconds, 0 disables)
            <input
              type="number"
              min={0}
              max={3600}
              required
              value={policy.assignmentReminderSeconds}
              onChange={(event) =>
                setPolicy((current) => ({
                  ...current,
                  assignmentReminderSeconds: Number(event.target.value),
                }))
              }
            />
          </label>
          {settings.canConfigure ? (
            <label>
              Reason
              <input
                required
                minLength={3}
                maxLength={300}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
          ) : null}
        </fieldset>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        {settings.canConfigure ? (
          <button type="submit" disabled={busy}>
            {busy
              ? "Saving…"
              : pending
                ? "Retry settings change"
                : "Save staffing settings"}
          </button>
        ) : null}
      </form>
    </details>
  );
}
