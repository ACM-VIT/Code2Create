import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { venuePresenceLabel } from "../lib/venue-presence";

type Policy = NonNullable<
  FunctionReturnType<typeof api.reviewerVenueOperations.configuration>
>;

export function ReviewerVenuePanel({
  canReadConfiguration,
  canPublish,
  canReadProfiles,
}: {
  canReadConfiguration: boolean;
  canPublish: boolean;
  canReadProfiles: boolean;
}) {
  const policy = useQuery(
    api.reviewerVenueOperations.configuration,
    canReadConfiguration ? { eventSlug } : "skip",
  );
  return (
    <section className="setup-section venue-operations">
      <h2>Reviewer venue presence</h2>
      <p className="muted">
        Track physical presence separately from panel clock-in. Unavailable
        location is not a confirmed departure.
      </p>
      {canReadConfiguration && policy !== undefined ? (
        <VenueConfiguration
          key={policy?.version ?? 0}
          policy={policy}
          canPublish={canPublish}
        />
      ) : null}
      {canReadProfiles ? <VenueRoster /> : null}
    </section>
  );
}

function VenueConfiguration({
  policy,
  canPublish,
}: {
  policy: Policy | null;
  canPublish: boolean;
}) {
  const save = useMutation(api.reviewerVenueOperations.configure);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ fingerprint: string; id: string } | null>(null);
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const text = (key: string) => {
      const value = form.get(key);
      if (typeof value !== "string") throw new Error(`Enter ${key}.`);
      return value;
    };
    const number = (key: string) => Number(text(key));
    const draft = {
      ...(form.get("confirmationCalls") === "on"
        ? {
            confirmationAgent: {
              appId: text("appId").trim(),
              appVersion: number("appVersion"),
              responseWindowMinutes: number("responseWindowMinutes"),
            },
          }
        : {}),
      enabled: form.get("enabled") === "on",
      name: text("name"),
      latitude: number("latitude"),
      longitude: number("longitude"),
      radiusMeters: number("radiusMeters"),
      startsAt: new Date(text("startsAt")).getTime(),
      endsAt: new Date(text("endsAt")).getTime(),
      absenceGraceMinutes: number("absenceGraceMinutes"),
      callDelayMinutes: number("callDelayMinutes"),
    };
    setBusy(true);
    setError(null);
    try {
      const fingerprint = JSON.stringify(draft);
      if (pending.current?.fingerprint !== fingerprint)
        pending.current = { fingerprint, id: crypto.randomUUID() };
      await save({
        eventSlug,
        policy: draft,
        expectedVersion: policy?.version ?? 0,
        clientOperationId: pending.current.id,
      });
      pending.current = null;
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="workspace-disclosure" open={!policy}>
      <summary>
        <strong>
          {policy
            ? `${policy.name} · ${policy.enabled ? "Enabled" : "Disabled"}`
            : "Configure the venue boundary"}
        </strong>
      </summary>
      <form
        className="workspace-disclosure-body venue-configuration"
        onSubmit={submit}
      >
        <p className="muted">
          Use the venue centre and a radius that covers the building. Changing
          settings stops checks using the old boundary; reviewers reconnect from
          the app. All times below use this browser's timezone.
        </p>
        <fieldset disabled={!canPublish || busy}>
          <label>
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={policy?.enabled ?? false}
            />{" "}
            Enable during the live event
          </label>
          <div className="venue-fields">
            <label>
              Venue name
              <input
                name="name"
                required
                maxLength={100}
                defaultValue={policy?.name ?? ""}
              />
            </label>
            <label>
              Latitude
              <input
                name="latitude"
                type="number"
                step="any"
                min={-90}
                max={90}
                required
                defaultValue={policy?.latitude}
              />
            </label>
            <label>
              Longitude
              <input
                name="longitude"
                type="number"
                step="any"
                min={-180}
                max={180}
                required
                defaultValue={policy?.longitude}
              />
            </label>
            <label>
              Radius in metres
              <input
                name="radiusMeters"
                type="number"
                min={100}
                max={5000}
                required
                defaultValue={policy?.radiusMeters ?? 200}
              />
            </label>
            <label>
              Checks start
              <input
                name="startsAt"
                type="datetime-local"
                required
                defaultValue={policy ? localTime(policy.startsAt) : ""}
              />
            </label>
            <label>
              Checks end
              <input
                name="endsAt"
                type="datetime-local"
                required
                defaultValue={policy ? localTime(policy.endsAt) : ""}
              />
            </label>
            <label>
              Check after minutes outside
              <input
                name="absenceGraceMinutes"
                type="number"
                min={2}
                max={60}
                required
                defaultValue={policy?.absenceGraceMinutes ?? 2}
              />
            </label>
            <label>
              Call minutes after reminder
              <input
                name="callDelayMinutes"
                type="number"
                min={0}
                max={120}
                required
                defaultValue={policy?.callDelayMinutes ?? 1}
              />
            </label>
          </div>
          <details className="workspace-disclosure">
            <summary>Confirmation calls</summary>
            <p className="muted">
              GPS triggers a conversation. A confirmed absence clocks the
              reviewer out between reviews. No answer or an active review needs
              ops follow-up. Configure and test the published Sarvam agent
              before enabling calls.
            </p>
            <label>
              <input
                type="checkbox"
                name="confirmationCalls"
                defaultChecked={Boolean(policy?.confirmationAgent)}
              />{" "}
              Enable conversational confirmation calls
            </label>
            <div className="venue-fields">
              <label>
                Published Sarvam agent ID
                <input
                  name="appId"
                  maxLength={128}
                  defaultValue={policy?.confirmationAgent?.appId ?? ""}
                />
              </label>
              <label>
                Agent version
                <input
                  name="appVersion"
                  type="number"
                  min={1}
                  defaultValue={policy?.confirmationAgent?.appVersion ?? 1}
                />
              </label>
              <label>
                Accept response within minutes
                <input
                  name="responseWindowMinutes"
                  type="number"
                  min={2}
                  max={30}
                  defaultValue={
                    policy?.confirmationAgent?.responseWindowMinutes ?? 10
                  }
                />
              </label>
            </div>
          </details>
          {canPublish ? (
            <button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save venue settings"}
            </button>
          ) : null}
        </fieldset>
        {error ? (
          <p role="alert" className="error-note">
            {error}
          </p>
        ) : null}
      </form>
    </details>
  );
}

function VenueRoster() {
  const { results, status, loadMore } = usePaginatedQuery(
    api.reviewerVenueOperations.roster,
    { eventSlug },
    { initialNumItems: 40 },
  );
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="venue-roster">
      <div className="venue-table-scroll">
        <table>
          <caption>Reviewer locations and departure follow-up</caption>
          <thead>
            <tr>
              <th scope="col">Reviewer</th>
              <th scope="col">Venue status</th>
              <th scope="col">Last location check</th>
              <th scope="col">Departure / follow-up</th>
            </tr>
          </thead>
          <tbody>
            {results.map((row) => (
              <tr key={row.personId}>
                <th scope="row">
                  {row.name}
                  {row.profileStatus === "inactive" ? " (inactive)" : ""}
                </th>
                <td>
                  {venuePresenceLabel(row.status, row.lastCheckedAt, now)}
                  {!row.monitoringEnabled ? (
                    <small>Location checks off</small>
                  ) : null}
                </td>
                <td>
                  {row.lastCheckedAt === undefined
                    ? "No location received"
                    : new Date(row.lastCheckedAt).toLocaleString()}
                </td>
                <td>
                  {row.reason ??
                    (row.leftAt
                      ? `Detected ${new Date(row.leftAt).toLocaleTimeString()}`
                      : "—")}
                  {row.notificationState ? (
                    <small>
                      Push: {row.notificationState.replaceAll("_", " ")}
                    </small>
                  ) : null}
                  {row.callState ? (
                    <small>
                      Call: {row.callState.replaceAll("_", " ")}
                      {row.callError === "call_consent_not_granted"
                        ? " (not enabled by reviewer)"
                        : ""}
                    </small>
                  ) : null}
                  {row.response && row.callId ? (
                    <div>
                      <strong>
                        {row.responseEffect === "stale"
                          ? "Response no longer current"
                          : row.responseEffect === "clocked_out"
                            ? "Confirmed away · replacement requested"
                            : row.responseEffect === "confirmed"
                              ? "Confirmed available by phone"
                              : "Ops follow-up needed"}
                      </strong>
                      <p>{row.response.summary}</p>
                      {row.responseRecordedAt ? (
                        <small>
                          Recorded{" "}
                          {new Date(
                            row.responseRecordedAt,
                          ).toLocaleTimeString()}
                          {row.response.returnInMinutes !== null
                            ? ` · expected back in ${row.response.returnInMinutes} minutes from this call`
                            : ""}
                        </small>
                      ) : null}
                      <CallTranscript deliveryId={row.callId} />
                    </div>
                  ) : row.callState === "completed" ? (
                    <small>Answered; availability was not confirmed.</small>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {status === "LoadingFirstPage" ? (
        <p className="muted">Loading reviewer presence…</p>
      ) : null}
      {status !== "LoadingFirstPage" && results.length === 0 ? (
        <p className="muted">
          Reviewer profiles will appear here even before location checks are
          enabled.
        </p>
      ) : null}
      {status === "CanLoadMore" || status === "LoadingMore" ? (
        <button
          type="button"
          disabled={status === "LoadingMore"}
          onClick={() => loadMore(40)}
        >
          Load more reviewers
        </button>
      ) : null}
    </div>
  );
}

function localTime(timestamp: number) {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function CallTranscript({
  deliveryId,
}: {
  deliveryId: NonNullable<
    FunctionReturnType<
      typeof api.reviewerVenueOperations.roster
    >["page"][number]["callId"]
  >;
}) {
  const [open, setOpen] = useState(false);
  const response = useQuery(
    api.reviewerVenueOperations.callResponse,
    open ? { eventSlug, deliveryId } : "skip",
  );
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Conversation</summary>
      {open && response === undefined ? <p>Loading…</p> : null}
      {response?.transcript.map((turn, index) => (
        <p key={index}>
          <strong>{turn.role === "user" ? "Reviewer" : "Agent"}:</strong>{" "}
          {turn.text}
        </p>
      ))}
    </details>
  );
}
