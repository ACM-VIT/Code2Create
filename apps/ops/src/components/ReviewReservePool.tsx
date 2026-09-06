import { api } from "@code2create/backend/api";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useMutationAttempt } from "../lib/operations";

type RoundId = FunctionArgs<typeof api.reviewReservePool.candidates>["roundId"];
type Pool = NonNullable<
  FunctionReturnType<typeof api.reviewReservePool.candidates>
>;

export function ReviewReservePool({ roundId }: { roundId: RoundId }) {
  const data = useQuery(api.reviewReservePool.candidates, {
    eventSlug,
    roundId,
  });
  if (!data) return null;
  return (
    <details className="workspace-disclosure">
      <summary>
        <strong>Reviewer pool</strong>
        <span>
          {
            data.reviewers.filter(
              (r) => r.reserveStatus === "available" && !r.seated,
            ).length
          }{" "}
          reserves
        </span>
      </summary>
      <PoolEditor roundId={roundId} data={data} />
    </details>
  );
}

function PoolEditor({ roundId, data }: { roundId: RoundId; data: Pool }) {
  const save = useMutation(api.reviewReservePool.setMembership);
  const attempt = useMutationAttempt<{ version: number }>();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = attempt.hasPending("reserve-change");
  const selected = data.reviewers.find((r) => r.personId === selectedId);
  const adding = selected?.reserveStatus !== "available";
  async function submit() {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      await attempt.run("reserve-change", () => {
        const args = {
          eventSlug,
          roundId,
          personId: selected.personId,
          included: adding,
          expectedVersion: selected.reserveVersion,
          reason,
          clientOperationId: crypto.randomUUID(),
        };
        return () => save(args);
      });
      setSelectedId(null);
      setReason("");
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-4 p-4 sm:p-5">
      <p className="m-0 text-sm text-ink-2">
        Plan reviewers before training and availability confirmations. Both are
        required for live duty. Use <strong>Edit reviewers</strong> on a panel
        to move or swap people.
      </p>
      <Link className="text-button justify-self-start" to="/review-setup">
        Manage reviewer profiles and skills
      </Link>
      <label className="field">
        Find a reviewer
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Name"
        />
      </label>
      {selected ? (
        <div className="grid gap-3 rounded-xl border border-line p-4">
          <p className="m-0">
            <strong>{selected.name}</strong> ·{" "}
            {adding ? "Add to reserves" : "Remove from this round"}
          </p>
          <label className="field">
            Reason
            <input
              autoFocus
              value={reason}
              maxLength={500}
              disabled={busy || pending}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              className="primary"
              type="button"
              disabled={busy || (!pending && reason.trim().length < 5)}
              onClick={() => void submit()}
            >
              {busy
                ? "Saving…"
                : pending
                  ? "Retry change"
                  : adding
                    ? "Add to reserves"
                    : "Remove from round"}
            </button>
            <button
              className="secondary"
              type="button"
              disabled={busy || pending}
              onClick={() => {
                setSelectedId(null);
                setReason("");
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="notice error m-0" role="alert">
          {error}
        </p>
      ) : null}
      <div className="grid gap-2">
        {data.reviewers
          .filter((r) =>
            r.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
          )
          .map((r) => (
            <div
              key={r.personId}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-3"
            >
              <div className="min-w-0">
                <strong className="break-words">{r.name}</strong>
                <p className="m-0 text-sm text-ink-2">
                  {r.seniority.toUpperCase()} ·{" "}
                  {r.seated
                    ? "On a panel"
                    : r.reserveStatus === "paged"
                      ? "Responding to a page"
                      : r.reserveStatus === "available"
                        ? "Reserve"
                        : "Not in this round"}{" "}
                </p>
              </div>
              {data.canEdit &&
              !r.seated &&
              r.reserveStatus !== "paged" &&
              (r.canAdd || r.reserveStatus === "available") ? (
                <button
                  className="secondary"
                  type="button"
                  disabled={busy || pending || selectedId !== null}
                  onClick={() => {
                    setSelectedId(r.personId);
                    setError(null);
                  }}
                >
                  {r.reserveStatus === "available"
                    ? "Remove"
                    : "Add to reserves"}
                </button>
              ) : null}
            </div>
          ))}
      </div>
    </div>
  );
}
