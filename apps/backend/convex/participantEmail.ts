"use node";

import { randomUUID } from "node:crypto";

import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { interpretCloudflareEmailSendResponse } from "./lib/cloudflareEmailSending";
import { localProviderFixturesEnabled } from "./lib/localBrowserFixtures";

const cloudflareApiBase = "https://api.cloudflare.com/client/v4/accounts";

function configuredPortalUrl(path: string) {
  const configured = process.env.PARTICIPANT_SITE_URL?.trim();
  if (!configured || !path.startsWith("/") || path.startsWith("//")) return null;
  let base: URL;
  try {
    base = new URL(configured);
  } catch {
    return null;
  }
  const localDevelopment = base.hostname === "localhost" || base.hostname === "127.0.0.1";
  if (base.protocol !== "https:" && !(localDevelopment && base.protocol === "http:")) return null;
  return new URL(path, base).toString();
}

export const deliver = internalAction({
  args: { deliveryId: v.id("participantNotificationDeliveries") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const attemptId = randomUUID();
    const claim = await ctx.runMutation(internal.participantNotificationState.claimDelivery, {
      deliveryId: args.deliveryId,
      attemptId,
    });
    if (!claim) return null;
    if (localProviderFixturesEnabled()) {
      const providerMessageId = `local-${randomUUID()}`;
      const providerAt = Date.now();
      await ctx.runMutation(internal.participantNotificationState.recordSent, {
        deliveryId: claim.deliveryId,
        attemptId,
        providerMessageId,
        initialOutcome: "queued",
      });
      await ctx.runMutation(internal.participantNotificationState.recordProviderEvent, {
        eventId: `local-${randomUUID()}`,
        providerMessageId,
        recipientEmailNormalized: claim.destinationEmail,
        eventType: "email.delivered",
        providerAt,
        disableDestination: false,
        payloadHash: `local-${claim.deliveryId}-${providerAt}`,
      });
      return null;
    }
    const accountId = process.env.CLOUDFLARE_EMAIL_ACCOUNT_ID?.trim();
    const apiToken = process.env.CLOUDFLARE_EMAIL_API_TOKEN?.trim();
    const from = process.env.CLOUDFLARE_EMAIL_FROM?.trim();
    const replyTo = process.env.CLOUDFLARE_EMAIL_REPLY_TO?.trim();
    const portalUrl = configuredPortalUrl(claim.portalPath);
    if (!accountId || !apiToken || !from || !portalUrl) {
      await ctx.runMutation(internal.participantNotificationState.recordSendFailure, {
        deliveryId: claim.deliveryId,
        attemptId,
        errorCode: "cloudflare_email_not_configured",
        retryable: false,
        ambiguous: false,
      });
      return null;
    }
    const text = [
      "Hello,",
      "",
      claim.notificationIntro,
      "Sign in to view the authoritative status and next steps:",
      portalUrl,
      "",
      "Email delivery does not confirm that you have read or accepted the update.",
    ].join("\n");
    let response: Response;
    try {
      response = await fetch(
        `${cloudflareApiBase}/${encodeURIComponent(accountId)}/email/sending/send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from,
            to: claim.destinationEmail,
            subject: claim.notificationSubject,
            text,
            headers: { "X-Code2Create-Delivery-ID": claim.deliveryId },
            ...(replyTo ? { reply_to: replyTo } : {}),
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      await ctx.runMutation(internal.participantNotificationState.recordSendFailure, {
        deliveryId: claim.deliveryId,
        attemptId,
        errorCode: "cloudflare_email_request_ambiguous",
        retryable: false,
        ambiguous: true,
      });
      return null;
    }
    let decoded: unknown;
    try {
      decoded = await response.json();
    } catch {
      await ctx.runMutation(internal.participantNotificationState.recordSendFailure, {
        deliveryId: claim.deliveryId,
        attemptId,
        errorCode: "cloudflare_email_response_ambiguous",
        retryable: false,
        ambiguous: true,
      });
      return null;
    }
    const interpretation = interpretCloudflareEmailSendResponse({
      status: response.status,
      ok: response.ok,
      body: decoded,
      destinationEmail: claim.destinationEmail,
    });
    if (interpretation.kind === "rejected") {
      await ctx.runMutation(internal.participantNotificationState.recordSendFailure, {
        deliveryId: claim.deliveryId,
        attemptId,
        errorCode: interpretation.errorCode,
        retryable: interpretation.retryable,
        ambiguous: false,
      });
      return null;
    }
    if (interpretation.kind === "ambiguous") {
      await ctx.runMutation(internal.participantNotificationState.recordSendFailure, {
        deliveryId: claim.deliveryId,
        attemptId,
        errorCode: interpretation.errorCode,
        retryable: false,
        ambiguous: true,
      });
      return null;
    }
    await ctx.runMutation(internal.participantNotificationState.recordSent, {
      deliveryId: claim.deliveryId,
      attemptId,
      providerMessageId: interpretation.providerMessageId,
      initialOutcome: interpretation.initialOutcome,
    });
    return null;
  },
});
