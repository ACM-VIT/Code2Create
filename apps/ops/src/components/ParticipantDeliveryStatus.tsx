import { api } from "@code2create/backend/api";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useMutation, usePaginatedQuery } from "convex/react";
import { useState, type SubmitEvent } from "react";

import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useMutationAttempt } from "../lib/operations";
import { LoadingLabel, SkeletonList } from "./Skeleton";

type DeliveryRecipients = FunctionReturnType<
  typeof api.participantNotifications.forApplication
>["page"];
type DeliveryRecipient = DeliveryRecipients[number];
type DeliveryState = NonNullable<DeliveryRecipient["delivery"]>["state"];
type ApplicationId = FunctionArgs<
  typeof api.participantNotifications.forApplication
>["applicationId"];
type Command = "retry" | "disable";

const deliveryStateLabel: Record<DeliveryState, string> = {
  pending: "Queued",
  sending: "Sending",
  retry_wait: "Waiting to retry",
  sent: "Sent",
  delivery_delayed: "Delayed",
  delivered: "Delivered to mail server",
  bounced: "Bounced",
  failed: "Failed",
  suppressed: "Suppressed",
  unknown: "Outcome unknown",
  superseded: "Replaced by a newer email",
};

export function ParticipantDeliveryStatus({
  applicationId,
  teamName,
}: {
  applicationId: ApplicationId;
  teamName: string;
}) {
  const recipientsPage = usePaginatedQuery(
    api.participantNotifications.forApplication,
    { eventSlug, applicationId },
    { initialNumItems: 25 },
  );
  const recipients = recipientsPage.results;

  if (recipientsPage.status === "LoadingFirstPage") {
    return (
      <section className="detail-section">
        <h2>Decision email</h2>
        <LoadingLabel>Loading email delivery</LoadingLabel>
        <SkeletonList rows={2} />
      </section>
    );
  }
  if (recipients.length === 0) return null;

  const stuck = recipients.filter(
    (recipient) => recipient.delivery && deliveryNeedsAttention(recipient.delivery.state),
  );
  const unreachable = recipients.filter((recipient) => recipient.destination === null);
  const deliveredCount = recipients.filter(
    (recipient) => recipient.delivery?.state === "delivered",
  ).length;
  const attention = [...new Set([...stuck, ...unreachable])];
  const ordered = [
    ...attention,
    ...recipients.filter((recipient) => !attention.includes(recipient)),
  ];

  return (
    <section className="detail-section">
      <h2>Decision email</h2>
      <p className="muted">
        {deliverySentence({ teamName, recipients, unreachable, stuck, deliveredCount })}
      </p>
      <div className="participant-delivery-list">
        {ordered.map((recipient) => (
          <DeliveryRow key={recipient.personId} recipient={recipient} />
        ))}
      </div>
      {recipientsPage.status === "CanLoadMore" || recipientsPage.status === "LoadingMore" ? (
        <button
          className="secondary"
          type="button"
          disabled={recipientsPage.status === "LoadingMore"}
          onClick={() => recipientsPage.loadMore(25)}
        >
          {recipientsPage.status === "LoadingMore" ? "Loading recipients…" : "Load more recipients"}
        </button>
      ) : null}
    </section>
  );
}

function deliverySentence({
  teamName,
  recipients,
  unreachable,
  stuck,
  deliveredCount,
}: {
  teamName: string;
  recipients: DeliveryRecipients;
  unreachable: DeliveryRecipients;
  stuck: DeliveryRecipients;
  deliveredCount: number;
}) {
  const missing = new Set([...unreachable, ...stuck]).size;
  if (missing === 0) {
    return deliveredCount === recipients.length
      ? `The decision email reached every ${teamName} member's mail server. This does not confirm that anyone read it.`
      : `${deliveredCount} of ${recipients.length} decision emails for ${teamName} reached a recipient mail server. The rest are still processing.`;
  }
  if (missing === recipients.length) {
    return `No decision email for ${teamName} has a confirmed mail-server delivery. Use another contact route.`;
  }
  return `${missing} of ${recipients.length} decision emails for ${teamName} need another contact route.`;
}

function deliveryNeedsAttention(state: DeliveryState) {
  return (
    state === "delivery_delayed" ||
    state === "bounced" ||
    state === "failed" ||
    state === "suppressed" ||
    state === "unknown"
  );
}

function DeliveryRow({ recipient }: { recipient: DeliveryRecipient }) {
  const retryDelivery = useMutation(api.participantNotifications.retry);
  const disableDestination = useMutation(api.participantNotifications.disableDestination);
  const [command, setCommand] = useState<Command | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commandAttempt = useMutationAttempt<void>();
  const commandPending = commandAttempt.hasPending("participant-delivery-command");
  const destination = recipient.destination;
  const delivery = recipient.delivery;
  const canRetry =
    recipient.canManage && destination?.status === "active" && delivery?.state === "failed";
  const canDisable = recipient.canManage && destination?.status === "active";

  const cancel = () => {
    setCommand(null);
    setReason("");
    setError(null);
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!commandPending && (!command || !reason.trim() || !destination)) return;
    setBusy(true);
    setError(null);
    try {
      await commandAttempt.run("participant-delivery-command", () => {
        if (!command || !destination) throw new Error("The email command is no longer available.");
        if (command === "retry") {
          if (!delivery || delivery.state !== "failed")
            throw new Error("The failed delivery is no longer available.");
          const args = {
            eventSlug,
            deliveryId: delivery.id,
            expectedDeliveryVersion: delivery.version,
            reason,
            clientOperationId: crypto.randomUUID(),
          };
          return async () => {
            await retryDelivery(args);
          };
        }
        const args = {
          eventSlug,
          destinationId: destination.id,
          expectedDestinationVersion: destination.version,
          reason,
          clientOperationId: crypto.randomUUID(),
        };
        return async () => {
          await disableDestination(args);
        };
      });
      cancel();
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="participant-delivery-row">
      <div className="participant-delivery-summary">
        <strong>{recipient.displayName}</strong>
        <span>{destination?.email ?? "No verified email address"}</span>
        <small>
          {delivery ? deliveryStateLabel[delivery.state] : "Not sent yet"}
          {destination
            ? ` · email ${destination.status === "active" ? "enabled" : "disabled"}`
            : ""}
          {delivery?.updatedAt ? ` · ${new Date(delivery.updatedAt).toLocaleString()}` : ""}
        </small>
        {delivery && deliveryNeedsAttention(delivery.state) ? (
          <small>{deliveryIssueMessage(delivery.state)}</small>
        ) : null}
      </div>
      {canRetry || canDisable ? (
        <div className="participant-delivery-actions">
          {canRetry ? (
            <button
              className="text-button"
              type="button"
              disabled={busy || commandPending}
              onClick={() => setCommand("retry")}
            >
              Retry
            </button>
          ) : null}
          {canDisable ? (
            <button
              className="text-button"
              type="button"
              disabled={busy || commandPending}
              onClick={() => setCommand("disable")}
            >
              Stop email
            </button>
          ) : null}
        </div>
      ) : null}
      {command ? (
        <form className="participant-delivery-command" onSubmit={submit}>
          <p>
            {command === "retry"
              ? "Try this failed email once more."
              : "Stop future email to this address."}
          </p>
          <label className="field">
            <span>Reason</span>
            <textarea
              disabled={busy || commandPending}
              value={reason}
              maxLength={300}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <small>Requires a Google sign-in from the last 15 minutes.</small>
          {error ? (
            <p className="notice error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="button-row">
            <button
              className="primary"
              type="submit"
              disabled={busy || (!commandPending && !reason.trim())}
            >
              {busy
                ? "Saving…"
                : commandPending
                  ? "Confirm earlier command"
                  : command === "retry"
                    ? "Retry email"
                    : "Stop email"}
            </button>
            <button
              className="secondary"
              type="button"
              disabled={busy || commandPending}
              onClick={cancel}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function deliveryIssueMessage(state: DeliveryState) {
  if (state === "bounced") return "The recipient's mail server rejected this email.";
  if (state === "suppressed") return "Email to this address has been stopped.";
  if (state === "delivery_delayed") return "Cloudflare has delayed this delivery.";
  if (state === "unknown") return "Check the Cloudflare Email logs before sending again.";
  return "Cloudflare could not send this email. Check the Email logs before retrying.";
}
