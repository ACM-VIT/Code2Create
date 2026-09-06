import { useState } from "react";

import { readableError } from "../../lib/errors";
import type { MusicRequestView } from "../dashboard/MusicTile";

/** The same report action is available for the playing track and queue rows. */
export function MusicReport({
  request,
  report,
}: {
  request: MusicRequestView;
  report: (request: MusicRequestView, reason: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = async () => {
    const trimmed = reason.trim();
    if (busy || !trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await report(request, trimmed);
      setSent(true);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  if (request.hasReported || sent) {
    return <span role="status" className="shrink-0 text-[11px] text-fg/35">flagged</span>;
  }
  if (!request.canReport) return null;

  return <>
    <button
      type="button"
      disabled={busy}
      onClick={() => setExpanded((current) => !current)}
      aria-expanded={expanded}
      aria-label={`Flag ${request.title} for the desk`}
      className={`shrink-0 text-[11px] transition-colors hover:text-rose-light disabled:opacity-45 ${
        expanded ? "text-rose-light" : "text-fg/35"
      }`}
    >
      flag
    </button>
    {expanded ? (
      <form
        className="col-span-full mt-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={180}
          autoFocus
          placeholder="Why should the desk look at this?"
          aria-label="Reason"
          className="min-w-0 rounded-petal-xs border border-petal-edge-soft bg-wash/45 px-3 py-1.5 text-[12.5px] text-fg placeholder:text-fg/45 focus:border-rose-light focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || !reason.trim()}
          className="shrink-0 text-[12px] text-rose-light underline-offset-4 hover:underline disabled:opacity-45"
        >
          {busy ? "Sending…" : "Send"}
        </button>
        {error ? <p role="alert" className="col-span-full m-0 text-[12px] text-rose-light">{error}</p> : null}
      </form>
    ) : null}
  </>;
}
