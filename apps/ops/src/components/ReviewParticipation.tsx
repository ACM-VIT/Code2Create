import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useMutationAttempt } from "../lib/operations";

type Team = FunctionReturnType<typeof api.reviewParticipation.teams>[number];

export function ReviewParticipation() {
  const teams = useQuery(api.reviewParticipation.teams, { eventSlug });
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<"all" | "competitor" | "oc">("oc");
  const [limit, setLimit] = useState(30);
  if (!teams) return <p className="muted">Loading competition eligibility…</p>;
  const ocTeams = teams.filter(team => team.category === "oc");
  const visible = teams.filter(team =>
    (category === "all" || team.category === category) && team.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <details className="overflow-hidden rounded-xl bg-surface">
      <summary className="cursor-pointer px-5 py-4 font-medium">Competition eligibility · {ocTeams.length} OC teams</summary>
      <div className="space-y-4 border-t border-line p-5">
        <p className="m-0 text-sm text-ink-2">OC teams keep their admission and event access. They are excluded from competitive review queues and rankings. Members can still serve as reviewers.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="field"><span>Find a team</span><input type="search" value={search} onChange={event => { setSearch(event.target.value); setLimit(30); }} placeholder="Team name" /></label>
          <label className="field"><span>Show</span><select value={category} onChange={event => { const value = event.target.value; if (value === "all" || value === "oc" || value === "competitor") setCategory(value); setLimit(30); }}><option value="oc">OC</option><option value="competitor">Competitors</option><option value="all">All teams</option></select></label>
        </div>
        <p className="m-0 text-sm text-ink-2">{visible.length} teams · {visible.reduce((sum, team) => sum + team.memberCount, 0)} members</p>
        <div className="divide-y divide-line">{visible.slice(0, limit).map(team => <TeamEligibility key={team.id} team={team} />)}</div>
        {visible.length === 0 ? <p className="muted">No matching teams.</p> : null}
        {visible.length > limit ? <button className="secondary" type="button" onClick={() => setLimit(value => value + 30)}>Show more teams</button> : null}
      </div>
    </details>
  );
}

function TeamEligibility({ team }: { team: Team }) {
  const save = useMutation(api.reviewParticipation.setCategory);
  const attempt = useMutationAttempt<FunctionReturnType<typeof api.reviewParticipation.setCategory>>();
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = attempt.hasPending(team.id);
  const change = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await attempt.run(team.id, () => {
        const args = { eventSlug, teamId: team.id, category: team.category === "oc" ? "competitor" as const : "oc" as const, expectedVersion: team.version, reason, clientOperationId: crypto.randomUUID() };
        return () => save(args);
      });
      setEditing(false); setReason("");
    } catch (caught) { setError(readableError(caught)); }
    finally { setBusy(false); }
  };
  return <div className="space-y-3 py-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><strong>{team.name}</strong><p className="m-0 text-sm text-ink-2">{team.memberCount} members · {team.status}</p></div>
      <div className="flex items-center gap-3"><span className="state-label">{team.category === "oc" ? "OC" : "Competitor"}</span>{team.canManage ? <button className="secondary compact-link" type="button" onClick={() => setEditing(true)}>Change</button> : null}</div>
    </div>
    {editing ? <div className="space-y-3 rounded-lg border border-line p-4">
      <p className="m-0 text-sm">{team.category === "oc" ? "Make this team a competitor. Any previously skipped reviews stay skipped until restored on the round board." : "Mark this team OC and remove its pending competitive reviews. Teams whose reviews have already started cannot be reclassified here."}</p>
      <label className="field"><span>Reason</span><input disabled={pending} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <div className="button-row"><button className="primary" type="button" disabled={busy || reason.trim().length < 5} onClick={() => void change()}>{busy ? "Saving…" : pending ? "Confirm earlier change" : team.category === "oc" ? "Make competitor" : "Mark OC"}</button><button className="secondary" type="button" disabled={busy || pending} onClick={() => setEditing(false)}>Cancel</button></div>
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </div> : null}
  </div>;
}
