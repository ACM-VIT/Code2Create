import {
  supportCaseCategoryLabels,
  supportCaseStateLabels,
} from "@code2create/domain";
import { createHash } from "node:crypto";

import type { DiscordSupportDelivery } from "./contracts.ts";

const discordMessageLimit = 2_000;
const preferredChunkLimit = 1_900;

function safeInline(value: string) {
  return value.replaceAll("`", "ˋ").replaceAll("\n", " ").trim();
}

export function splitDiscordMessage(value: string, limit = preferredChunkLimit) {
  if (!Number.isSafeInteger(limit) || limit < 100 || limit > discordMessageLimit) {
    throw new RangeError("Discord message chunk limits must be between 100 and 2000.");
  }
  const remaining = value.trim();
  if (remaining.length === 0) return [];
  const chunks: string[] = [];
  let cursor = remaining;
  while (cursor.length > limit) {
    const window = cursor.slice(0, limit + 1);
    const paragraph = window.lastIndexOf("\n\n");
    const line = window.lastIndexOf("\n");
    const space = window.lastIndexOf(" ");
    const splitAt = Math.max(
      paragraph >= Math.floor(limit * 0.6) ? paragraph : -1,
      line >= Math.floor(limit * 0.7) ? line : -1,
      space >= Math.floor(limit * 0.8) ? space : -1,
      limit,
    );
    chunks.push(cursor.slice(0, splitAt).trim());
    cursor = cursor.slice(splitAt).trim();
  }
  if (cursor.length > 0) chunks.push(cursor);
  return chunks;
}

export function deliveryNonce(deliveryId: string, chunkIndex: number) {
  const digest = createHash("sha256").update(`${deliveryId}:${chunkIndex}`).digest("hex");
  return BigInt(`0x${digest.slice(0, 16)}`).toString(10);
}

function openedMessage(delivery: DiscordSupportDelivery, operationsSiteUrl: string) {
  const supportCase = delivery.supportCase;
  const context = [
    supportCase.teamName ? `**Team:** ${safeInline(supportCase.teamName)}` : null,
    supportCase.roundName ? `**Round:** ${safeInline(supportCase.roundName)}` : null,
  ].filter((value): value is string => value !== null);
  return [
    `## ${safeInline(supportCase.publicCode)} · ${supportCaseCategoryLabels[supportCase.category]}`,
    `**Reporter:** ${safeInline(supportCase.reporterName)} · ${safeInline(supportCase.contactEmail)}`,
    `**Origin:** ${supportCase.origin}`,
    ...context,
    `**Opened:** <t:${Math.floor(supportCase.createdAt / 1_000)}:f>`,
    `**Ops:** ${new URL(`/support/${supportCase.id}`, operationsSiteUrl).toString()}`,
    "",
    delivery.action.body ?? "No description was supplied.",
  ].join("\n");
}

export function renderDelivery(
  delivery: DiscordSupportDelivery,
  operationsSiteUrl: string,
) {
  const action = delivery.action;
  if (action.kind === "opened") return openedMessage(delivery, operationsSiteUrl);
  if (action.kind === "reporter_reply") {
    return `**Reporter · ${safeInline(action.actorName)}**\n${action.body ?? ""}`;
  }
  if (action.kind === "public_note") {
    return `**Ops reply · ${safeInline(action.actorName)}**\n${action.body ?? ""}`;
  }
  if (action.kind === "internal_note") {
    return `**Internal note · ${safeInline(action.actorName)}**\n${action.body ?? ""}`;
  }
  if (action.kind === "state_changed") {
    const previous = action.previousState
      ? supportCaseStateLabels[action.previousState]
      : "Previous state";
    const next = action.nextState ? supportCaseStateLabels[action.nextState] : "Updated";
    return `**Status changed · ${safeInline(action.actorName)}**\n${previous} → ${next}`;
  }
  const previous = action.previousOwnerName ?? "Unassigned";
  const next = action.nextOwnerName ?? "Unassigned";
  return `**Owner changed · ${safeInline(action.actorName)}**\n${safeInline(previous)} → ${safeInline(next)}`;
}

type SupportChannelNamingDelivery = {
  supportCase: Pick<DiscordSupportDelivery["supportCase"], "publicCode" | "teamName" | "reporterName">;
};

export function supportChannelName(delivery: SupportChannelNamingDelivery) {
  const subject = delivery.supportCase.teamName ?? delivery.supportCase.reporterName;
  const name = `${delivery.supportCase.publicCode} · ${subject}`
    .replaceAll(/[\r\n\t]+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/gu, "-")
    .replaceAll(/-{2,}/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 100);
}

export function inboundMessageText(content: string, attachmentUrls: readonly string[]) {
  const attachments = attachmentUrls.map((url) => `Attachment: ${url}`);
  const combined = [content.trim(), ...attachments].filter((part) => part.length > 0).join("\n\n");
  if (combined.length <= discordMessageLimit) return combined;
  const suffix = "\n\n[Reply shortened to fit the support portal.]";
  return `${combined.slice(0, discordMessageLimit - suffix.length).trimEnd()}${suffix}`;
}
