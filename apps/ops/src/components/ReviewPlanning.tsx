import { ReviewSkip } from "./ReviewSkip";
import { api } from "@code2create/backend/api";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useMutationAttempt } from "../lib/operations";

type Workspace = FunctionReturnType<typeof api.reviewPlanning.workspace>;
type Team = Workspace["teams"][number];
type RoundId = FunctionArgs<typeof api.reviewPlanning.workspace>["roundId"];
const clock = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "numeric",
  minute: "2-digit",
});

export function ReviewPlanning({ roundId }: { roundId: RoundId }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="workspace-disclosure"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        <strong>Project & panel planning</strong>
      </summary>
      {open ? <PlanningWorkspace roundId={roundId} /> : null}
    </details>
  );
}
function PlanningWorkspace({ roundId }: { roundId: RoundId }) {
  const data = useQuery(api.reviewPlanning.workspace, { eventSlug, roundId });
  const [search, setSearch] = useState("");
  const [onlyUnassigned, setOnlyUnassigned] = useState(false);
  if (!data)
    return <p className="p-5 text-ink-2">Loading project preparation…</p>;
  const active = data.teams.filter((t) => !t.blocker);
  const prepared = active.filter((t) => t.briefCurrent).length;
  return (
    <div className="grid gap-5 p-4 sm:p-5">
      <p className="m-0 text-ink-2">
        {prepared}/{active.length} current intake briefs ·{" "}
        {active.filter((t) => t.plan).length} assigned ·{" "}
        {data.teams.filter((t) => t.blocker).length} held out. Planning includes
        accepted teams awaiting RSVP. Staff place teams in the live queue when
        they are ready.
      </p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {data.panels.map((panel) => {
          const count = active.filter(
            (t) => t.plan?.panelId === panel.id,
          ).length;
          const finish =
            data.startsAt +
            count * (data.durationSeconds + data.scoringBufferSeconds) * 1000;
          return (
            <div
              key={panel.id}
              className="rounded-xl border border-solid border-line p-3"
            >
              <strong>{panel.name}</strong>
              <p className="m-0 mt-1 text-sm text-ink-2">
                {panel.memberCount}/{data.requiredPanelSize} seats · {count}{" "}
                projects · nominal finish {clock.format(finish)}
                {finish > data.endsAt ? " · extension needed" : ""}
              </p>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <label className="field grow">
          Find a project
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={onlyUnassigned}
            onChange={(e) => setOnlyUnassigned(e.target.checked)}
          />
          Unassigned only
        </label>
      </div>
      <div className="grid gap-2">
        {data.teams
          .filter(
            (t) =>
              (!onlyUnassigned || !t.plan) &&
              `${t.name} ${t.brief?.title ?? ""} ${t.brief?.primaryPool ?? ""}`
                .toLowerCase()
                .includes(search.toLowerCase()),
          )
          .map((team) => (
            <TeamPlan
              key={`${team.teamId}:${team.plan?.version ?? 0}:${data.roundVersion}`}
              team={team}
              data={data}
              roundId={roundId}
            />
          ))}
      </div>
    </div>
  );
}
function TeamPlan({
  team,
  data,
  roundId,
}: {
  team: Team;
  data: Workspace;
  roundId: RoundId;
}) {
  const assign = useMutation(api.reviewPlanning.assign);
  const attempt = useMutationAttempt<{ version: number }>();
  const [panelId, setPanelId] = useState<string>(team.plan?.panelId ?? "");
  const [backupId, setBackupId] = useState<string>(
    team.plan?.backupPanelId ?? "",
  );
  const [rationale, setRationale] = useState(
    team.plan?.rationale ?? team.brief?.panelFitReason ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = attempt.hasPending("team-plan");
  const disabled =
    !data.canEdit || team.inQueue || !!team.blocker || busy || pending;
  const brief = team.brief;
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await attempt.run("team-plan", () => {
        const panel = data.panels.find((p) => p.id === panelId);
        const backup = data.panels.find((p) => p.id === backupId);
        if (!panel) throw new Error("Choose a panel.");
        const args = {
          eventSlug,
          roundId,
          teamId: team.teamId,
          panelId: panel.id,
          ...(backup ? { backupPanelId: backup.id } : {}),
          rationale,
          expectedVersion: team.plan?.version ?? 0,
          expectedRoundVersion: data.roundVersion,
          clientOperationId: crypto.randomUUID(),
        };
        return () => assign(args);
      });
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="rounded-xl border border-solid border-line">
      <summary className="cursor-pointer px-4 py-3">
        <strong>{team.name}</strong>
        <span className="ml-3 text-sm text-ink-2">
          {data.panels.find((p) => p.id === team.plan?.panelId)?.name ??
            "Unassigned"}{" "}
          · {team.blocker ?? team.status}
        </span>
      </summary>
      <div className="grid gap-4 border-0 border-t border-solid border-line p-4">
        {brief ? (
          <>
            <div>
              <h3 className="m-0">{brief.title}</h3>
              <p className="mb-0 text-ink-2">{brief.summary.text}</p>
            </div>
            {!team.briefCurrent ? (
              <p className="notice m-0">
                The submission changed. Refresh this assessment before relying
                on it.
              </p>
            ) : null}
            <dl className="m-0 grid gap-4 sm:grid-cols-2">
              {[
                { label: "Users & problem", value: brief.users.text },
                {
                  label: "Proposed architecture",
                  value: brief.architecture.text,
                },
                {
                  label: "Suggested scope",
                  value: brief.minimumDeliverable.text,
                },
                {
                  label: "Implementation evidence",
                  value: brief.implementationEvidence.text,
                },
              ].map((item) => (
                <div key={item.label}>
                  <dt className="font-medium">{item.label}</dt>
                  <dd className="m-0 mt-1 text-sm text-ink-2">{item.value}</dd>
                </div>
              ))}
            </dl>
            <p className="m-0 text-sm text-ink-2">
              Expertise:{" "}
              {[brief.primaryPool, ...brief.secondaryPools].join(" · ")}
              <br />
              {brief.specialistSkills.join(" · ")}
            </p>
            <details>
              <summary className="cursor-pointer">
                Review prompts & evidence gaps
              </summary>
              <div className="mt-3 grid gap-3">
                <ol className="m-0 space-y-3 pl-5">
                  {brief.suggestedQuestions.map((q) => (
                    <li key={q.question}>
                      {q.question}
                      <span className="mt-1 block text-sm text-ink-2">
                        Ungraded prompt · {q.criterionKey.replaceAll("_", " ")}{" "}
                        · {q.sourceIds.join(", ")}
                      </span>
                    </li>
                  ))}
                </ol>
                <ul className="m-0 space-y-2 pl-5 text-sm text-ink-2">
                  {brief.risksToProbe.map((r) => (
                    <li key={r.text}>{r.text}</li>
                  ))}
                  {brief.limitations.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </div>
            </details>
          </>
        ) : (
          <p className="notice m-0">
            This project still needs an intake assessment.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="field">
            Planned panel
            <select
              disabled={disabled}
              value={panelId}
              onChange={(e) => setPanelId(e.target.value)}
            >
              <option value="">Choose panel</option>
              {data.panels.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Backup panel
            <select
              disabled={disabled}
              value={backupId}
              onChange={(e) => setBackupId(e.target.value)}
            >
              <option value="">No backup selected</option>
              {data.panels
                .filter((p) => p.id !== panelId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <label className="field">
          Why this panel fits
          <textarea
            rows={3}
            value={rationale}
            maxLength={2000}
            disabled={disabled}
            onChange={(e) => setRationale(e.target.value)}
          />
        </label>
        {team.inQueue ? (
          <p className="m-0 text-sm text-ink-2">
            This team is already in the review flow. Use its queue controls to
            move or restore it.
          </p>
        ) : (
          <button
            type="button"
            className="primary justify-self-start"
            disabled={
              busy ||
              (!pending &&
                (disabled || !panelId || rationale.trim().length < 10))
            }
            onClick={() => void save()}
          >
            {busy
              ? "Saving…"
              : pending
                ? "Retry assignment"
                : "Save planned assignment"}
          </button>
        )}
        {error ? (
          <p className="notice error m-0" role="alert">
            {error}
          </p>
        ) : null}
        <ReviewSkip
          team={{
            teamId: team.teamId,
            state: team.state,
            version: team.stateVersion,
            canSkip: data.canEdit,
          }}
          round={{ id: roundId, status: data.roundStatus }}
        />
      </div>
    </details>
  );
}
