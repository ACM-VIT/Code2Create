import { api } from "@code2create/backend/api";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useState, type SubmitEvent } from "react";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useMutationAttempt } from "../lib/operations";

type Settings = FunctionReturnType<typeof api.reviewQueueAutomation.settings>;
type RoundId = FunctionArgs<
  typeof api.reviewQueueAutomation.settings
>["roundId"];
export function ReviewQueueSettings({ roundId }: { roundId: RoundId }) {
  const settings = useQuery(api.reviewQueueAutomation.settings, {
    eventSlug,
    roundId,
  });
  if (!settings) return null;
  return (
    <details className="workspace-disclosure">
      <summary>
        <strong>Queue call-up</strong>
        <span>{settings.automaticCallUp ? "Automatic" : "Manual"}</span>
      </summary>
      <QueueForm key={settings.version} settings={settings} roundId={roundId} />
      {settings.automaticCallUp ? (
        <div className="published-rounds">
          {settings.panels.map((panel) => (
            <div className="published-round-row" key={panel.name}>
              <strong>{panel.name}</strong>
              <span>{panel.status}</span>
            </div>
          ))}
        </div>
      ) : null}
    </details>
  );
}
function QueueForm({
  settings,
  roundId,
}: {
  settings: Settings;
  roundId: RoundId;
}) {
  const configure = useMutation(api.reviewQueueAutomation.configure);
  const attempt =
    useMutationAttempt<
      FunctionReturnType<typeof api.reviewQueueAutomation.configure>
    >();
  const [routingPreference, setRoutingPreference] = useState(
    settings.routingPreference,
  );
  const [automatic, setAutomatic] = useState(settings.automaticCallUp);
  const [voice, setVoice] = useState(settings.voiceCalls);
  const [headsUp, setHeadsUp] = useState(String(settings.teamHeadsUpSeconds));
  const [buffer, setBuffer] = useState(String(settings.scoringBufferSeconds));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = attempt.hasPending("queue-settings");
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await attempt.run("queue-settings", () => {
        const args = {
          eventSlug,
          roundId,
          expectedVersion: settings.version,
          routingPreference,
          automaticCallUp: automatic,
          voiceCalls: voice,
          teamHeadsUpSeconds: Number(headsUp),
          scoringBufferSeconds: Number(buffer),
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
  return (
    <form onSubmit={submit}>
      <p className="muted">
        Call the next queued team after all scorecards are finished and staffing
        is ready. Team order follows priority, then time queued. The dashboard
        shows the next-team notice; calls go only to team leads who opted in.
      </p>
      <fieldset disabled={!settings.canConfigure || busy || pending}>
        <label>
          Automatic panel selection
          <select
            value={routingPreference}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "skills_then_wait" || value === "shortest_wait")
                setRoutingPreference(value);
            }}
          >
            <option value="skills_then_wait">Skills, then shortest wait</option>
            <option value="shortest_wait">Shortest wait</option>
          </select>
        </label>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={automatic}
            onChange={(e) => setAutomatic(e.target.checked)}
          />
          Automatic next-team call-up
        </label>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={voice}
            onChange={(e) => setVoice(e.target.checked)}
          />
          Voice calls to consenting team leads
        </label>
        <label>
          Next-team heads-up, seconds before discussion ends (0 disables)
          <input
            type="number"
            min="0"
            max="1800"
            value={headsUp}
            onChange={(e) => setHeadsUp(e.target.value)}
          />
        </label>
        <label>
          Score-entry allowance for ETA, seconds
          <input
            type="number"
            min="0"
            max="1800"
            value={buffer}
            onChange={(e) => setBuffer(e.target.value)}
          />
        </label>
        <label>
          Reason
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      </fieldset>
      {settings.canConfigure ? (
        <button
          type="submit"
          disabled={busy || (!pending && reason.trim().length < 3)}
        >
          {busy
            ? "Saving…"
            : pending
              ? "Confirm earlier update"
              : "Save queue settings"}
        </button>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}
