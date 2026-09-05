"use node";

import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { rewriteParticipantEmailTemplateAssetReferences } from "@code2create/domain";
import type { ParticipantEmailAttachment } from "@code2create/domain";
import { v } from "convex/values";
import QRCode from "qrcode";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { sendEmailThroughService } from "./lib/emailServiceSending";
import {
  createAppleWalletDownloadToken,
  createGoogleWalletSaveUrl,
  EventPassWalletConfigurationError,
  externalEventPassReference,
  formattedEventStart,
  type ExternalEventPassDetails,
} from "./lib/externalEventPassWallet";

type TemplateVariables = {
  participant_name: string;
  team_name: string;
  event_name: string;
  portal_url: string;
  event_start: string;
  venue_name: string;
  pass_reference: string;
  google_wallet_url: string;
  apple_wallet_url: string;
};

function renderTemplate(template: string, variables: TemplateVariables) {
  return template.replace(
    /\{\{\s*(participant_name|team_name|event_name|portal_url|event_start|venue_name|pass_reference|google_wallet_url|apple_wallet_url)\s*\}\}/gu,
    (_match, key: keyof TemplateVariables) => variables[key],
  );
}

export function withoutUnavailableWalletActions(
  template: string,
  variables: Pick<TemplateVariables, "google_wallet_url" | "apple_wallet_url">,
) {
  let rendered = template;
  for (const key of ["google_wallet_url", "apple_wallet_url"] as const) {
    if (variables[key]) continue;
    const placeholder = String.raw`\{\{\s*${key}\s*\}\}`;
    rendered = rendered
      .replace(new RegExp(String.raw`<a\b[^>]*${placeholder}[^>]*>[\s\S]*?<\/a>`, "giu"), "")
      .split(/\r?\n/u)
      .filter((line) => !new RegExp(placeholder, "u").test(line))
      .join("\n");
  }
  return rendered;
}

export async function walletUrlOrEmpty(createUrl: () => Promise<string>) {
  try {
    return await createUrl();
  } catch {
    return "";
  }
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
  assets: Array<{ filename: string; contentId?: string; disposition: "inline" | "attachment" }>,
) {
  return rewriteParticipantEmailTemplateAssetReferences(
    html,
    assets
      .filter((asset) => asset.disposition === "inline" && asset.contentId !== undefined)
      .map((asset) => ({ fileName: asset.filename, replacement: `cid:${asset.contentId ?? ""}` })),
  );
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

function configuredConvexSiteUrl(path: string) {
  const configured = process.env.CONVEX_SITE_URL?.trim();
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
    const portalUrl = configuredPortalUrl(claim.portalPath);
    if (!portalUrl) {
      await ctx.runMutation(internal.participantNotificationState.recordSendFailure, {
        deliveryId: claim.deliveryId,
        attemptId,
        errorCode: "participant_portal_not_configured",
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
      event_start: "",
      venue_name: claim.venueName,
      pass_reference: "",
      google_wallet_url: "",
      apple_wallet_url: "",
    };
    const attachments: ParticipantEmailAttachment[] = [];
    if (claim.templateKey === "external_event_pass") {
      if (claim.participantClass !== "external_participant") {
        await ctx.runMutation(internal.participantNotificationState.recordSendFailure, {
          deliveryId: claim.deliveryId,
          attemptId,
          errorCode: "external_event_pass_recipient_invalid",
          retryable: false,
          ambiguous: false,
        });
        return null;
      }
      try {
        const pass = await ctx.runAction(internal.attendanceActions.externalPassForDelivery, {
          eventSlug: claim.eventSlug,
          eventId: claim.eventId,
          membershipId: claim.membershipId,
        });
        const details: ExternalEventPassDetails = {
          passId: pass.passId,
          payload: pass.payload,
          eventName: claim.eventName,
          eventStartsAt: claim.eventStartsAt,
          eventEndsAt: claim.eventEndsAt,
          eventTimezone: claim.eventTimezone,
          venueName: claim.venueName,
          participantName: claim.participantName,
          teamName: claim.teamName,
        };
        const qr = await QRCode.toBuffer(details.payload, {
          type: "png",
          width: 480,
          margin: 2,
          errorCorrectionLevel: "M",
          color: { dark: "#19070fff", light: "#ffffffff" },
        });
        const [googleWalletUrl, appleWalletUrl] = await Promise.all([
          walletUrlOrEmpty(() => optionalGoogleWalletUrl(details)),
          walletUrlOrEmpty(() => optionalAppleWalletUrl(details)),
        ]);
        variables.event_start = formattedEventStart(details);
        variables.pass_reference = externalEventPassReference(details.payload);
        variables.google_wallet_url = googleWalletUrl;
        variables.apple_wallet_url = appleWalletUrl;
        attachments.push({
          filename: "event-pass-qr.png",
          contentType: "image/png",
          contentBase64: qr.toString("base64"),
          disposition: "inline",
          contentId: "event-pass-qr.png",
        });
      } catch {
        await ctx.runMutation(internal.participantNotificationState.recordSendFailure, {
          deliveryId: claim.deliveryId,
          attemptId,
          errorCode: "event_pass_generation_failed",
          retryable: true,
          ambiguous: false,
        });
        return null;
      }
    }
    const htmlVariables: TemplateVariables = {
      participant_name: htmlEscaped(variables.participant_name),
      team_name: htmlEscaped(variables.team_name),
      event_name: htmlEscaped(variables.event_name),
      portal_url: htmlEscaped(variables.portal_url),
      event_start: htmlEscaped(variables.event_start),
      venue_name: htmlEscaped(variables.venue_name),
      pass_reference: htmlEscaped(variables.pass_reference),
      google_wallet_url: htmlEscaped(variables.google_wallet_url),
      apple_wallet_url: htmlEscaped(variables.apple_wallet_url),
    };
    const subject = renderTemplate(claim.subjectTemplate, variables);
    const text = renderTemplate(
      withoutUnavailableWalletActions(claim.textTemplate, variables),
      variables,
    );
    const html = rewriteInlineAssetReferences(
      renderTemplate(withoutUnavailableWalletActions(claim.htmlTemplate, variables), htmlVariables),
      [
        ...claim.assets.map((asset) => ({
          filename: asset.fileName,
          disposition: asset.disposition,
          ...(asset.contentId !== undefined ? { contentId: asset.contentId } : {}),
        })),
        ...attachments.map((attachment) => ({
          filename: attachment.filename,
          disposition: attachment.disposition,
          ...(attachment.contentId !== undefined
            ? { contentId: attachment.contentId }
            : {}),
        })),
      ],
    );
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
        contentType: asset.contentType,
        contentBase64: Buffer.from(bytes).toString("base64"),
        disposition: asset.disposition,
        ...(asset.disposition === "inline" ? { contentId: asset.contentId } : {}),
      });
    }
    const result = await sendEmailThroughService({
      provider: claim.notificationProvider,
      requestId: claim.deliveryId,
      to: claim.destinationEmail,
      subject,
      text,
      html,
      headers: [{ name: "X-Code2Create-Delivery-ID", value: claim.deliveryId }],
      attachments,
    });
    if (result.status === "rejected") {
      await ctx.runMutation(internal.participantNotificationState.recordSendFailure, {
        deliveryId: claim.deliveryId,
        attemptId,
        errorCode: result.errorCode,
        retryable: result.retryable,
        ambiguous: false,
      });
      return null;
    }
    if (result.status === "ambiguous") {
      await ctx.runMutation(internal.participantNotificationState.recordSendFailure, {
        deliveryId: claim.deliveryId,
        attemptId,
        errorCode: result.errorCode,
        retryable: false,
        ambiguous: true,
      });
      return null;
    }
    await ctx.runMutation(internal.participantNotificationState.recordSent, {
      deliveryId: claim.deliveryId,
      attemptId,
      provider: result.provider,
      providerMessageId: result.messageId,
      initialOutcome: result.initialOutcome,
    });
    return null;
  },
});

async function optionalGoogleWalletUrl(details: ExternalEventPassDetails) {
  if (
    !walletProviderConfigured([
      "GOOGLE_WALLET_ISSUER_ID",
      "GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL",
      "GOOGLE_WALLET_PRIVATE_KEY",
    ])
  ) {
    return "";
  }
  return createGoogleWalletSaveUrl(details);
}

async function optionalAppleWalletUrl(details: ExternalEventPassDetails) {
  if (
    !walletProviderConfigured([
      "APPLE_WALLET_PASS_TYPE_IDENTIFIER",
      "APPLE_WALLET_TEAM_IDENTIFIER",
      "APPLE_WALLET_WWDR_CERTIFICATE_BASE64",
      "APPLE_WALLET_SIGNER_CERTIFICATE_BASE64",
      "APPLE_WALLET_SIGNER_KEY_BASE64",
    ])
  ) {
    return "";
  }
  const token = await createAppleWalletDownloadToken(details);
  const baseUrl = configuredConvexSiteUrl("/attendance/external-pass/apple");
  if (!baseUrl) {
    throw new EventPassWalletConfigurationError(
      "CONVEX_SITE_URL is required when Apple Wallet is configured.",
    );
  }
  const url = new URL(baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

function walletProviderConfigured(names: readonly string[]) {
  const configured = names.filter((name) => Boolean(process.env[name]?.trim()));
  if (configured.length === 0) return false;
  if (configured.length !== names.length) {
    throw new EventPassWalletConfigurationError(
      `Wallet provider configuration is incomplete: ${names.join(", ")}.`,
    );
  }
  return true;
}
