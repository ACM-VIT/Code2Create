import { api } from "@code2create/backend/api";
import { useVersionedState } from "@code2create/web-forms";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useState, type SubmitEvent } from "react";

import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useMutationAttempt } from "../lib/operations";

const rosterStatuses = ["waiting", "permitted", "out", "overdue"] as const;
type RosterStatus = (typeof rosterStatuses)[number];
const labels: Record<RosterStatus, string> = { waiting: "Waiting", permitted: "Can go", out: "Out now", overdue: "Overdue" };
type CallState = NonNullable<FunctionReturnType<typeof api.serviceQueues.roster>["page"][number]["callState"]>;
const callLabels: Record<CallState, string> = {
  pending: "Call queued", retry_wait: "Call queued", sending: "Starting call",
  provider_accepted: "Call accepted", queued: "Call queued", initiated: "Calling",
  ringing: "Ringing", answered: "Connected", completed: "Call ended; return scan still required",
  busy: "Phone busy; staff follow-up needed", no_answer: "No answer; staff follow-up needed",
  unavailable: "No usable phone number; staff follow-up needed",
  failed: "Call failed; staff follow-up needed", ambiguous: "Call outcome unknown; staff follow-up needed",
  cancelled: "Call cancelled; staff follow-up needed",
};

export function OutingCapacity() {
  const configuration = useQuery(api.serviceQueues.configuration, { eventSlug });
  const configure = useMutation(api.serviceQueues.configure);
  const [status, setStatus] = useState<RosterStatus>("overdue");
  const roster = usePaginatedQuery(api.serviceQueues.roster, { eventSlug, status }, { initialNumItems: 25 });
  if (!configuration) return <p className="muted">Loading outing capacity…</p>;
  return <OutingCapacityContent configuration={configuration} configure={configure} status={status} setStatus={setStatus} roster={roster} />;
}

type CapacityProps = {
  configuration: FunctionReturnType<typeof api.serviceQueues.configuration>;
  configure: (args: FunctionArgs<typeof api.serviceQueues.configure>) => Promise<null>;
  status: RosterStatus;
  setStatus: (status: RosterStatus) => void;
  roster: {
    results: FunctionReturnType<typeof api.serviceQueues.roster>["page"];
    status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
    loadMore: (count: number) => void;
  };
};

export function OutingCapacityContent({ configuration, configure, status, setStatus, roster }: CapacityProps) {
  const capacity = useVersionedState(`${configuration.version}`, `${configuration.capacity ?? 15}`);
  const attempt = useMutationAttempt<null>();
  const pending = attempt.hasPending("outing-capacity");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await attempt.run("outing-capacity", () => {
        const value = Number(capacity.value);
        if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw new Error("Enter a whole number from 1 to 1,000.");
        const args = { eventSlug, capacity: value, expectedVersion: configuration.version, clientOperationId: crypto.randomUUID() };
        return () => configure(args);
      });
    } catch (caught) { setError(readableError(caught)); }
    finally { setBusy(false); }
  };

  return <section className="configuration-card" aria-label="Washroom outings">
    <h2>Washroom outings</h2>
    <p className="muted">After 15 minutes outside, Sarvam calls the participant’s registered number once to ask them to return. A phone call does not record a return or release capacity.</p>
    <p className="muted">Each outing lasts 15 minutes from the exit scan. Permission reserves a slot immediately and expires if unused for 15 minutes. Scan the same ID on return to release the slot.</p>
    <p role="status">
      {configuration.capacity === null ? "Capacity has not been set. Outing permission cannot be granted yet." : `${configuration.occupiedCount} of ${configuration.capacity} slots occupied · ${configuration.waitingCount} waiting`}
    </p>
    {configuration.capacity !== null && configuration.occupiedCount > configuration.capacity ? <p className="notice">Existing permissions remain valid. New permissions will wait until occupancy falls below the new limit.</p> : null}
    <form onSubmit={(event) => void save(event)} className="form-grid">
      <label className="field">
        <span>Maximum simultaneous outings</span>
        <input type="number" min="1" max="1000" step="1" required value={capacity.value}
          disabled={busy || pending} onChange={(event) => capacity.update(() => event.target.value)} />
      </label>
      <div className="button-row"><button className="primary" type="submit" disabled={busy}>
        {busy ? "Saving…" : pending ? "Retry capacity change" : "Save outing capacity"}
      </button></div>
    </form>
    {error ? <p role="alert" className="notice">{error}</p> : null}
    <div className="button-row" aria-label="Outing status">
      {rosterStatuses.map((value) => <button key={value} className={status === value ? "primary" : "secondary"} type="button" aria-pressed={status === value} onClick={() => setStatus(value)}>{labels[value]}</button>)}
    </div>
    {roster.status === "LoadingFirstPage" ? <p className="muted">Loading participants…</p>
      : roster.results.length === 0 ? <p className="muted">No participants {labels[status].toLowerCase()}.</p>
      : <ul>{roster.results.map((entry) => <li key={entry.id}>
        <strong>{entry.name}</strong>{" "}
        {entry.phase.status === "permitted" ? `— leave before ${clock(entry.phase.expiresAt)}`
          : entry.phase.status === "out" || entry.phase.status === "overdue" ? `— return by ${clock(entry.phase.returnBy)}`
          : `— requested at ${clock(entry.joinedAt)}`}
        {entry.phase.status === "overdue" ? <p className="muted">{entry.callState ? callLabels[entry.callState] : "Waiting for the automatic reminder"}</p> : null}
      </li>)}</ul>}
    {roster.status === "CanLoadMore" ? <button type="button" className="secondary" onClick={() => roster.loadMore(25)}>Load more participants</button> : null}
  </section>;
}

function clock(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
}
