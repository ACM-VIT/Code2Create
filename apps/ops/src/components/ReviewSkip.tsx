import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useMutation } from "convex/react";
import { useState } from "react";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useMutationAttempt } from "../lib/operations";

type Team = FunctionReturnType<typeof api.reviewOperations.roundTeams>["page"][number];
type Round = FunctionReturnType<typeof api.reviewOperations.roundBoard>["round"];

export function ReviewSkip({ team, round }: { team: Team; round: Round }) {
  const save = useMutation(api.reviewParticipation.setSkipped);
  const attempt = useMutationAttempt<FunctionReturnType<typeof api.reviewParticipation.setSkipped>>();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = attempt.hasPending(team.teamId);
  if (!team.canSkip || !["published", "open"].includes(round.status) || ["in_review", "completed", "withdrawn"].includes(team.state)) return null;
  const skipped = team.state === "skipped";
  const submit = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await attempt.run(team.teamId, () => {
        const args = { eventSlug, roundId: round.id, teamId: team.teamId, skipped: !skipped, expectedVersion: team.version, reason, clientOperationId: crypto.randomUUID() };
        return () => save(args);
      });
      setReason("");
    } catch (caught) { setError(readableError(caught)); }
    finally { setBusy(false); }
  };
  return <details className="team-exceptions" key={team.state}>
    <summary>{skipped ? "Restore review" : "Skip this review"}</summary>
    <div className="space-y-3 rounded-lg border border-line p-4">
      <p className="m-0 text-sm text-ink-2">{skipped ? "Return this team to the review desk for a fresh panel assignment." : "Remove this team from this round and free its panel. Admission and other rounds stay unchanged. This round will have no score for the team."}</p>
      <label className="field"><span>Reason</span><input disabled={pending} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <button className="secondary" type="button" disabled={busy || reason.trim().length < 5} onClick={() => void submit()}>{busy ? "Saving…" : pending ? "Confirm earlier change" : skipped ? "Restore to desk" : "Skip review"}</button>
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </div>
  </details>;
}
