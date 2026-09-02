"use node";

import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { readBoundedJsonResponse } from "./lib/boundedHttpBody";
import { interpretCloudflareEmailSendResponse } from "./lib/cloudflareEmailSending";

const cloudflareApiBase = "https://api.cloudflare.com/client/v4/accounts";

type TemplateVariables = {
  participant_name: string;
  team_name: string;
  event_name: string;
  portal_url: string;
};

function renderTemplate(template: string, variables: TemplateVariables) {
  return template.replace(/\{\{\s*(participant_name|team_name|event_name|portal_url)\s*\}\}/gu, (
    _match,
    key: keyof TemplateVariables,
  ) => variables[key]);
}

function htmlEscaped(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function rewriteInlineAssetReferences(
  html: string,
  assets: Array<{ fileName: string; contentId: string; disposition: "inline" | "attachment" }>,
) {
  let rewritten = html;
  for (const asset of assets) {
    if (asset.disposition !== "inline") continue;
    const cid = `cid:${asset.contentId}`;
    rewritten = rewritten
      .replaceAll(`src="${asset.fileName}"`, `src="${cid}"`)
      .replaceAll(`src='${asset.fileName}'`, `src='${cid}'`)
      .replaceAll(`url("${asset.fileName}")`, `url("${cid}")`)
      .replaceAll(`url('${asset.fileName}')`, `url('${cid}')`)
      .replaceAll(`url(${asset.fileName})`, `url(${cid})`);
  }
  return rewritten;
}

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
    const variables: TemplateVariables = {
      participant_name: claim.participantName,
      team_name: claim.teamName,
      event_name: claim.eventName,
      portal_url: portalUrl,
    };
    const htmlVariables: TemplateVariables = {
      participant_name: htmlEscaped(claim.participantName),
      team_name: htmlEscaped(claim.teamName),
      event_name: htmlEscaped(claim.eventName),
      portal_url: htmlEscaped(portalUrl),
    };
    const subject = renderTemplate(claim.subjectTemplate, variables);
    const text = renderTemplate(claim.textTemplate, variables);
    const html = rewriteInlineAssetReferences(
      renderTemplate(claim.htmlTemplate, htmlVariables),
      claim.assets,
    );
    const attachments = [];
    for (const asset of claim.assets) {
      const blob = await ctx.storage.get(asset.storageId);
      if (!blob || blob.size !== asset.byteCount || blob.type !== asset.contentType) {
        await ctx.runMutation(internal.participantNotificationState.recordSendFailure, {
          deliveryId: claim.deliveryId,
          attemptId,
          errorCode: "email_asset_changed",
          retryable: false,
          ambiguous: false,
        });
        return null;
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytesToHex(sha256(bytes)) !== asset.sha256) {
        await ctx.runMutation(internal.participantNotificationState.recordSendFailure, {
          deliveryId: claim.deliveryId,
          attemptId,
          errorCode: "email_asset_changed",
          retryable: false,
          ambiguous: false,
        });
        return null;
      }
      attachments.push({
        filename: asset.fileName,
        type: asset.contentType,
        content: Buffer.from(bytes).toString("base64"),
        disposition: asset.disposition,
        ...(asset.disposition === "inline" ? { content_id: asset.contentId } : {}),
      });
    }
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
            subject,
            text,
            html,
            ...(attachments.length > 0 ? { attachments } : {}),
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
      decoded = await readBoundedJsonResponse(response, 64 * 1_024);
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
