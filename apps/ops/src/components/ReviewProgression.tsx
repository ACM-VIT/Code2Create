import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useMutationAttempt } from "../lib/operations";

type Workspace = FunctionReturnType<typeof api.reviewProgression.workspace>;
type Combined = FunctionReturnType<typeof api.reviewAggregation.results>;
type Choice = { outcome: "advance" | "eliminate" | null; reason: string };

export function ReviewProgression({
  roundId,
}: {
  roundId: Workspace["roundId"];
}) {
  const data = useQuery(api.reviewProgression.workspace, {
    eventSlug,
    roundId,
  });
  const [open, setOpen] = useState(false);
  const combined = useQuery(
    api.reviewAggregation.results,
    open && data?.roundStatus === "closed" ? { eventSlug } : "skip",
  );
  if (!data) return <p className="muted">Loading round progression…</p>;
  return (
    <details
      className="workspace-disclosure"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <strong>Who advances</strong>
        <span>
          {data.mode === "all_advance"
            ? "Non-eliminatory"
            : data.published
              ? "Decisions applied"
              : "Eliminatory"}
        </span>
      </summary>
      {open ? (
        <ProgressionEditor
          key={`${roundId}:${data.version}:${data.roundVersion}:${combined?.policyVersion ?? 0}:${combined?.rounds.map((r) => r.closeSnapshotId).join(":") ?? ""}`}
          data={data}
          combined={combined}
        />
      ) : null}
    </details>
  );
}

function ProgressionEditor({
  data,
  combined,
}: {
  data: Workspace;
  combined: Combined | undefined;
}) {
  const configure = useMutation(api.reviewProgression.configure);
  const publish = useMutation(api.reviewProgression.publish);
  const attempt = useMutationAttempt<{ version: number }>();
  const [step, setStep] = useState(data.mode === "elimination" ? 2 : 1);
  const [mode, setMode] = useState(data.mode);
  const [choices, setChoices] = useState<Record<string, Choice>>(() =>
    Object.fromEntries(
      data.teams.map((team) => [
        team.teamId,
        { outcome: team.outcome, reason: team.reason },
      ]),
    ),
  );
  const [reason, setReason] = useState("");
  const [search, setSearch] = useState("");
  const [cutoff, setCutoff] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = attempt.hasPending("progression");
  const advancing = data.teams.filter(
    (team) => choices[team.teamId]?.outcome === "advance",
  );
  const eliminated = data.teams.filter(
    (team) => choices[team.teamId]?.outcome === "eliminate",
  );
  const undecided = data.teams.length - advancing.length - eliminated.length;
  const missingReasons = data.teams.filter(
    (team) =>
      choices[team.teamId]?.outcome &&
      (choices[team.teamId]?.reason.trim().length ?? 0) < 5,
  ).length;
  const canDecide =
    data.canManage && data.canReadScores && data.roundStatus === "closed";
  const locked = busy || pending || !canDecide;
  const weighted =
    combined?.state === "ready" &&
    combined.rounds.at(-1)?.roundId === data.roundId;
  const scoreLabel = weighted
    ? combined.rounds.map((r) => `${r.name} ${r.weight}%`).join(" + ")
    : data.roundName;
  const scoreFor = (team: Workspace["teams"][number]) =>
    weighted
      ? (combined.teams.find((t) => t.teamId === team.teamId)?.weightedPoints ??
        null)
      : team.points;

  async function save(action: "configure" | "publish") {
    setBusy(true);
    setError(null);
    try {
      await attempt.run("progression", () => {
        const common = {
          eventSlug,
          roundId: data.roundId,
          expectedVersion: data.version,
          expectedRoundVersion: data.roundVersion,
          reason,
          clientOperationId: crypto.randomUUID(),
        };
        if (action === "configure") return () => configure({ ...common, mode });
        const closeSnapshotId = data.closeSnapshotId;
        if (!closeSnapshotId)
          throw new Error("Close and verify the round first.");
        const decisions = data.teams.map((team) => {
          const choice = choices[team.teamId];
          if (!choice?.outcome)
            throw new Error("Choose an outcome for every team.");
          return {
            teamId: team.teamId,
            outcome: choice.outcome,
            reason: choice.reason,
          };
        });
        const reference = weighted
          ? {
              policyVersion: combined.policyVersion,
              rounds: combined.rounds.flatMap((r) =>
                r.closeSnapshotId
                  ? [{ roundId: r.roundId, closeSnapshotId: r.closeSnapshotId }]
                  : [],
              ),
            }
          : undefined;
        return () =>
          publish({
            ...common,
            closeSnapshotId,
            decisions,
            ...(reference ? { scoreReference: reference } : {}),
          });
      });
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  }

  function suggestCutoff() {
    setError(null);
    const count = Number(cutoff);
    const scored = data.teams
      .map((team) => ({ ...team, points: scoreFor(team) }))
      .filter(
        (team): team is typeof team & { points: number } =>
          team.points !== null,
      )
      .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
    if (!Number.isInteger(count) || count < 1 || count > scored.length) {
      setError(`Choose between 1 and ${scored.length} scored teams.`);
      return;
    }
    if (scored[count] && scored[count]?.points === scored[count - 1]?.points) {
      setError(
        "There is a tie at this cutoff. Choose the tied teams individually, or include the whole tied group.",
      );
      return;
    }
    setChoices((current) => ({
      ...current,
      ...Object.fromEntries(
        scored.map((team, index) => [
          team.teamId,
          {
            outcome:
              index < count ? ("advance" as const) : ("eliminate" as const),
            reason: `${index < count ? "Within" : "Below"} the proposed top ${count}. ${scoreLabel}: ${team.points.toFixed(2)}/100.`,
          },
        ]),
      ),
    }));
  }

  return (
    <div className="grid gap-5 p-4 sm:p-5">
      <ol
        aria-label="Progression steps"
        className="m-0 grid list-none grid-cols-3 gap-2 p-0"
      >
        {["Round type", "Choose teams", "Review & apply"].map(
          (label, index) => (
            <li key={label}>
              <button
                type="button"
                aria-current={step === index + 1 ? "step" : undefined}
                className={`${step === index + 1 ? "primary" : "secondary"} w-full text-sm`}
                disabled={
                  busy ||
                  pending ||
                  (index > 0 && data.mode !== "elimination") ||
                  (index === 2 &&
                    (undecided > 0 || missingReasons > 0 || !data.teams.length))
                }
                onClick={() => setStep(index + 1)}
              >
                {index + 1}. {label}
              </button>
            </li>
          ),
        )}
      </ol>
      {data.published ? (
        <p className="notice m-0">
          Decisions are applied to later reviews. Participant messages are not
          sent by this action.
        </p>
      ) : null}
      {step === 1 ? (
        <>
          <fieldset
            className="m-0 grid gap-3 border-0 p-0"
            disabled={!data.canManage || busy || pending}
          >
            <legend className="mb-3 font-medium">
              Does {data.roundName} eliminate teams?
            </legend>
            <label className="flex items-start gap-3">
              <input
                type="radio"
                name="progression-mode"
                checked={mode === "all_advance"}
                onChange={() => setMode("all_advance")}
              />
              <span>
                Everyone continues
                <span className="mt-1 block text-sm text-ink-2">
                  This round provides scores and feedback without eliminating
                  teams.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3">
              <input
                type="radio"
                name="progression-mode"
                checked={mode === "elimination"}
                onChange={() => setMode("elimination")}
              />
              <span>
                Choose who advances
                <span className="mt-1 block text-sm text-ink-2">
                  After results are finalized, ops reviews and applies each
                  team's outcome.
                </span>
              </span>
            </label>
          </fieldset>
          {data.canManage ? (
            <>
              <label className="field">
                Reason
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={500}
                  disabled={busy || pending}
                />
              </label>
              <button
                type="button"
                className="primary justify-self-start"
                disabled={
                  busy ||
                  (!pending &&
                    (reason.trim().length < 5 ||
                      (data.version > 0 && mode === data.mode)))
                }
                onClick={() => void save("configure")}
              >
                {busy ? "Saving…" : pending ? "Retry save" : "Save round type"}
              </button>
            </>
          ) : null}
        </>
      ) : null}
      {step === 2 ? (
        <>
          {data.roundStatus !== "closed" ? (
            <p className="notice m-0">
              Finish reviews and{" "}
              <Link to={`/scores/${data.roundId}`}>
                close and verify the round
              </Link>{" "}
              before selecting teams.
            </p>
          ) : !data.canReadScores ? (
            <p className="notice m-0">
              You need access to this round's scores to review progression
              decisions.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <label className="field grow">
                  Find a team
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <label className="field">
                  Propose top
                  <input
                    className="max-w-28"
                    type="number"
                    min={1}
                    max={data.teams.length}
                    value={cutoff}
                    disabled={locked}
                    onChange={(e) => setCutoff(e.target.value)}
                  />
                </label>
                <button
                  className="secondary"
                  type="button"
                  disabled={locked}
                  onClick={suggestCutoff}
                >
                  Fill proposal
                </button>
              </div>
              <p className="m-0 text-sm text-ink-2">
                Score reference: {scoreLabel}. {advancing.length} advance ·{" "}
                {eliminated.length} eliminated · {undecided} undecided. Ties and
                teams without scores require an individual choice.
              </p>
              <div className="max-h-[32rem] overflow-y-auto rounded-xl border border-solid border-line">
                {data.teams
                  .filter((team) =>
                    team.name.toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((team) => (
                    <div
                      key={team.teamId}
                      className="grid gap-3 border-0 border-b border-solid border-line p-4 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto]"
                    >
                      <div>
                        <strong>{team.name}</strong>
                        <p className="m-0 mt-1 text-sm text-ink-2">
                          {scoreFor(team) === null
                            ? `No complete score · ${team.kind}`
                            : `${scoreFor(team)?.toFixed(2)} / 100`}
                        </p>
                      </div>
                      <div className="flex items-start gap-2">
                        {(["advance", "eliminate"] as const).map((value) => (
                          <button
                            key={value}
                            className={
                              choices[team.teamId]?.outcome === value
                                ? "primary"
                                : "secondary"
                            }
                            type="button"
                            aria-pressed={
                              choices[team.teamId]?.outcome === value
                            }
                            disabled={locked}
                            onClick={() =>
                              setChoices((current) => ({
                                ...current,
                                [team.teamId]: {
                                  outcome: value,
                                  reason: current[team.teamId]?.reason ?? "",
                                },
                              }))
                            }
                          >
                            {value === "advance" ? "Advance" : "Eliminate"}
                          </button>
                        ))}
                      </div>
                      {choices[team.teamId]?.outcome ? (
                        <label className="field sm:col-span-2">
                          Decision reason
                          <input
                            aria-label={`Decision reason for ${team.name}`}
                            maxLength={500}
                            value={choices[team.teamId]?.reason ?? ""}
                            disabled={locked}
                            onChange={(e) =>
                              setChoices((current) => ({
                                ...current,
                                [team.teamId]: {
                                  outcome:
                                    current[team.teamId]?.outcome ?? null,
                                  reason: e.target.value,
                                },
                              }))
                            }
                          />
                        </label>
                      ) : null}
                    </div>
                  ))}
              </div>
              <button
                type="button"
                className="primary justify-self-start"
                disabled={
                  undecided > 0 ||
                  missingReasons > 0 ||
                  !data.teams.length ||
                  locked
                }
                onClick={() => setStep(3)}
              >
                Review {data.teams.length} decisions
              </button>
            </>
          )}
        </>
      ) : null}
      {step === 3 ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              { title: "Advance", teams: advancing },
              { title: "Eliminate", teams: eliminated },
            ].map((group) => (
              <section
                key={group.title}
                className="rounded-xl border border-solid border-line p-4"
              >
                <h3 className="m-0">
                  {group.title} · {group.teams.length}
                </h3>
                <ul className="max-h-72 space-y-2 overflow-y-auto pl-5">
                  {group.teams.map((team) => (
                    <li key={team.teamId}>
                      {team.name}
                      <span className="block text-sm text-ink-2">
                        {choices[team.teamId]?.reason}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <p className="m-0 text-sm text-ink-2">
            Only advancing teams can enter later reviews. Admission, RSVP, and
            event access stay separate.
          </p>
          <label className="field">
            Reason for applying these decisions
            <input
              maxLength={500}
              value={reason}
              disabled={locked}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-3">
            <button
              className="secondary"
              type="button"
              disabled={busy || pending}
              onClick={() => setStep(2)}
            >
              Back to teams
            </button>
            <button
              type="button"
              className="primary"
              disabled={
                busy ||
                (!pending &&
                  (!canDecide ||
                    reason.trim().length < 5 ||
                    undecided > 0 ||
                    missingReasons > 0))
              }
              onClick={() => void save("publish")}
            >
              {busy
                ? "Applying…"
                : pending
                  ? "Retry applying decisions"
                  : `Apply ${data.teams.length} decisions`}
            </button>
          </div>
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
