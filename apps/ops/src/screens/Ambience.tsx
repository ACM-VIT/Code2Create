import { api } from "@code2create/backend/api";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { LoadingLabel } from "../components/Skeleton";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";

function timeLabel(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Chill mode: one switch that lowers the disco ball over every participant's portal. */
export function Ambience() {
  const state = useQuery(api.ambience.current, { eventSlug });
  const set = useMutation(api.ambience.set);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state === undefined) {
    return (
      <section className="benefits-shell">
        <LoadingLabel>Loading ambience</LoadingLabel>
      </section>
    );
  }
  const on = state.mode === "chill";

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await set({
        eventSlug,
        mode: on ? "off" : "chill",
        reason: note.trim() || (on ? "Chill mode off" : "Chill mode on"),
      });
      setNote("");
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="benefits-shell">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Room ambience</p>
          <h1>Chill mode</h1>
          <p className="muted">
            While it is on, a disco ball lowers over every participant’s portal and turns there.
            Turn it on for a break; turn it off to bring the room back.
          </p>
        </div>
      </div>

      <section className="synesthesia-section" aria-labelledby="ambience-title">
        <h2 id="ambience-title">
          Chill mode is <strong>{on ? "on" : "off"}</strong>
          {state.changedAt ? <span className="muted"> · since {timeLabel(state.changedAt)}</span> : null}
        </h2>
        {state.canManage ? (
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void toggle();
            }}
          >
            <label className="field">
              <span className="field-label">Note for the log</span>
              <input
                value={note}
                maxLength={200}
                disabled={busy}
                placeholder={on ? "Back to building" : "Midnight break"}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
            <div className="form-actions">
              <button type="submit" className="primary" disabled={busy}>
                {busy ? "Saving…" : on ? "Turn chill mode off" : "Turn chill mode on"}
              </button>
            </div>
          </form>
        ) : (
          <p className="muted">Only event managers can change this.</p>
        )}
        {error ? (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </section>
  );
}
