import { LiveNumber } from "./LiveNumber";
import { api } from "@code2create/backend/api";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useState, type SubmitEvent } from "react";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useMutationAttempt } from "../lib/operations";

type Settings = NonNullable<
  FunctionReturnType<typeof api.reviewQuestions.settings>
>;
type RoundId = FunctionArgs<typeof api.reviewQuestions.settings>["roundId"];
export function ReviewQuestionSettings({ roundId }: { roundId: RoundId }) {
  const settings = useQuery(api.reviewQuestions.settings, {
    eventSlug,
    roundId,
  });
  if (!settings) return null;
  const ready = settings.teams.filter((team) => team.state === "ready").length;
  return (
    <details className="workspace-disclosure">
      <summary>
        <strong>Suggested review questions</strong>
        <span className="text-right text-xs text-ink-2">
          {settings.policy.enabled ? (
            <>
              <LiveNumber value={ready} /> of{" "}
              <LiveNumber value={settings.teams.length} /> prepared
            </>
          ) : (
            "Off"
          )}
        </span>
      </summary>
      <QuestionForm
        key={settings.version}
        roundId={roundId}
        settings={settings}
      />
      {settings.policy.enabled ? (
        <div className="published-rounds">
          {settings.teams.map((team) => (
            <div className="published-round-row" key={team.teamId}>
              <strong>{team.name}</strong>
              <span>
                {team.state.replaceAll("_", " ")}
                {team.coverage
                  ? ` · ${team.coverage.analysedChunks}/${team.coverage.chunks} source sections inspected · ${team.coverage.captured} evidence items read · ${team.coverage.excluded} excluded · ${team.coverage.unavailable} unavailable · ${team.coverage.cachedBatches} reused analyses`
                  : ""}
                {team.failureCode
                  ? ` · ${team.failureCode.replaceAll("_", " ")}`
                  : ""}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </details>
  );
}
function QuestionForm({
  roundId,
  settings,
}: {
  roundId: RoundId;
  settings: Settings;
}) {
  const configure = useMutation(api.reviewQuestions.configure);
  const attempt =
    useMutationAttempt<
      FunctionReturnType<typeof api.reviewQuestions.configure>
    >();
  const [policy, setPolicy] = useState(settings.policy);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = attempt.hasPending("review-question-policy");
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await attempt.run("review-question-policy", () => {
        const args = {
          eventSlug,
          roundId,
          expectedVersion: settings.version,
          policy,
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
  const numericFields = [
    ["refreshSeconds", "Refresh interval, seconds", 30, 3600],
    ["maximumQuestions", "Questions per team", 1, 12],
    ["parallelAnalyses", "Concurrent analysis batches", 1, 8],
    [
      "batchCharacters",
      "Characters per batch (all batches are analysed)",
      64000,
      160000,
    ],
    ["maximumAttempts", "Preparation attempts per evidence version", 1, 10],
    [
      "preparationTimeoutSeconds",
      "Timeout per analysis step, seconds",
      60,
      600,
    ],
  ] as const;
  return (
    <form className="grid gap-5 p-4 sm:p-5" onSubmit={submit}>
      <p className="m-0 text-ink-2">
        Optional, ungraded follow-ups based on the team's idea, progress and repository evidence.
        The published rubric questions and 0–4 scoring anchors stay fixed. Figma links are for
        reviewers to open themselves. Preparation covers every readable repository file in batches.
      </p>
      <fieldset
        className="grid gap-4 md:grid-cols-2"
        disabled={!settings.canConfigure || busy || pending}
      >
        <label className="check-row md:col-span-2">
          <input
            type="checkbox"
            checked={policy.enabled}
            onChange={(e) =>
              setPolicy({ ...policy, enabled: e.target.checked })
            }
          />
          Continuously prepare suggested questions
        </label>
        <label className="field md:col-span-2">
          Model
          <input
            value={policy.model}
            onChange={(e) => setPolicy({ ...policy, model: e.target.value })}
          />
        </label>
        {numericFields.map(([key, label, min, max]) => (
          <label className="field" key={key}>
            {label}
            <input
              type="number"
              min={min}
              max={max}
              value={policy[key]}
              onChange={(e) =>
                setPolicy({ ...policy, [key]: Number(e.target.value) })
              }
            />
          </label>
        ))}
        <label className="field md:col-span-2">
          Additional review guidance
          <textarea
            className="min-h-28 resize-y"
            maxLength={2000}
            value={policy.instructions}
            onChange={(e) =>
              setPolicy({ ...policy, instructions: e.target.value })
            }
          />
        </label>
        <label className="field md:col-span-2">
          Reason
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      </fieldset>
      {settings.canConfigure ? (
        <button
          className="primary"
          type="submit"
          disabled={busy || (!pending && reason.trim().length < 3)}
        >
          {busy
            ? "Saving…"
            : pending
              ? "Confirm earlier update"
              : "Save question settings"}
        </button>
      ) : null}
      {error ? <p className="notice error m-0" role="alert">{error}</p> : null}
    </form>
  );
}
