import { LiveNumber } from "./LiveNumber";
import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useState, type SubmitEvent } from "react";

import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useMutationAttempt } from "../lib/operations";
import { reviewRubricPresets } from "../lib/reviewRubricPresets";

type Configuration = FunctionReturnType<
  typeof api.reviewAggregation.configuration
>;

export function ReviewAggregationConfiguration() {
  const configuration = useQuery(api.reviewAggregation.configuration, {
    eventSlug,
  });
  if (!configuration) return <p className="m-0 text-ink-2">Loading round weights…</p>;
  if (!configuration.rounds.length) return null;
  return (
    <AggregationEditor
      key={`${configuration.version}:${configuration.rounds.map((round) => round.id).join(",")}`}
      configuration={configuration}
    />
  );
}

function AggregationEditor({
  configuration,
}: {
  configuration: Configuration;
}) {
  const publish = useMutation(api.reviewAggregation.publish);
  const attempt =
    useMutationAttempt<
      FunctionReturnType<typeof api.reviewAggregation.publish>
    >();
  const [weights, setWeights] = useState(
    configuration.rounds.map((round) => ({
      roundId: round.id,
      weight: String(
        configuration.version
          ? round.weight
          : round.sequence === 1
            ? reviewRubricPresets.round1.overallWeight
            : round.sequence === 2
              ? reviewRubricPresets.round2.overallWeight
              : 0,
      ),
    })),
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = attempt.hasPending("round-weights");
  const total = weights.reduce((sum, entry) => sum + Number(entry.weight), 0);
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await attempt.run("round-weights", () => {
        const args = {
          eventSlug,
          expectedVersion: configuration.version,
          rounds: weights
            .map((entry) => ({
              roundId: entry.roundId,
              weight: Number(entry.weight),
            }))
            .filter((entry) => entry.weight > 0),
          reason,
          clientOperationId: crypto.randomUUID(),
        };
        return () => publish(args);
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
        <strong>Combined results · round weights</strong>
      </summary>
      <form className="grid gap-5 p-4 sm:p-5" onSubmit={submit}>
        <p className="m-0 text-ink-2">
          Set the contribution of each round to the final result. Use 0 to
          exclude a round. Weights must total 100%. Combined results use the
          approved outcomes after every contributing round closes.
        </p>
        {configuration.rounds.map((round, index) => (
          <label className="field" key={round.id}>
            {round.name} (%)
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              required
              disabled={!configuration.canPublish || busy || pending}
              value={weights[index]?.weight ?? "0"}
              onChange={(event) =>
                setWeights((current) =>
                  current.map((entry) =>
                    entry.roundId === round.id
                      ? { ...entry, weight: event.target.value }
                      : entry,
                  ),
                )
              }
            />
          </label>
        ))}
        <p className="m-0 text-ink-2">
          Total {total}% ·{" "}
          {configuration.version
            ? `Published version ${configuration.version}`
            : "Not published"}
        </p>
        {configuration.canPublish ? (
          <>
            <label className="field">
              Reason
              <input
                minLength={3}
                maxLength={300}
                required
                disabled={busy || pending}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            {error ? (
              <p className="notice error m-0" role="alert">
                {error}
              </p>
            ) : null}
            <button
              className="primary"
              type="submit"
              disabled={busy || (!pending && total !== 100)}
            >
              {busy
                ? "Saving…"
                : pending
                  ? "Retry publication"
                  : "Publish round weights"}
            </button>
          </>
        ) : null}
      </form>
    </details>
  );
}

export function CombinedReviewResults() {
  const data = useQuery(api.reviewAggregation.results, { eventSlug });
  if (!data || data.state === "hidden" || data.state === "unconfigured")
    return null;
  return (
    <section className="setup-section">
      <h2>Combined results</h2>
      <p className="m-0 text-ink-2">
        {data.rounds
          .map((round) => `${round.name} ${round.weight}%`)
          .join(" · ")}{" "}
        · Weight policy {data.policyVersion}
      </p>
      {data.state === "awaiting_rounds" ? (
        <p className="notice">
          Combined results will appear after all contributing rounds are closed.
        </p>
      ) : (
        <div className="my-4 min-w-0 overflow-x-auto">
          <table className="w-full border-collapse text-left text-[0.8125rem] [&_th]:px-4 [&_th]:py-3 [&_th]:font-medium [&_td]:px-4 [&_td]:py-3 [&_tr]:border-0 [&_tr]:border-b [&_tr]:border-solid [&_tr]:border-line">
            <thead>
              <tr>
                <th>Team</th>
                {data.rounds.map((round) => (
                  <th key={round.roundId}>{round.name} / 100</th>
                ))}
                <th>Combined / 100</th>
              </tr>
            </thead>
            <tbody>
              {data.teams.map((team) => (
                <tr key={team.teamId}>
                  <td>{team.name}</td>
                  {team.rounds.map((round) => (
                    <td key={round.roundId}>
                      {round.points === null
                        ? round.state
                        : <LiveNumber value={round.points} format={{ minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }} />}
                    </td>
                  ))}
                  <td>
                    {team.totalPoints === null
                      ? "Incomplete"
                      : <LiveNumber value={team.totalPoints} format={{ minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="m-0 text-ink-2">
        Missing, excluded, or withdrawn outcomes keep a team’s combined result
        incomplete. Equal totals remain tied.
      </p>
    </section>
  );
}
