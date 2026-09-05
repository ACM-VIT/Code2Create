import { ConvexError, v } from "convex/values";
import {
  participantEmailTemplateKeys,
  type ParticipantEmailProvider,
  type ParticipantEmailTemplateKey,
} from "@code2create/domain";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { participantEmailProvider } from "../values";
import { fingerprintText, normalizedLongText, normalizedText } from "./strings";

type ReadCtx = QueryCtx | MutationCtx;

export const communicationsNextStepInput = v.object({
  stableKey: v.string(),
  title: v.string(),
  detail: v.string(),
  actionUrl: v.optional(v.string()),
  dueAt: v.optional(v.number()),
});

export const communicationsEmailTemplateInput = v.object({
  templateKey: v.union(
    v.literal("accept"),
    v.literal("waitlist"),
    v.literal("decline"),
    v.literal("offer"),
    v.literal("offer_confirmed"),
    v.literal("offer_declined"),
    v.literal("offer_expired"),
    v.literal("external_event_pass"),
  ),
  subject: v.string(),
  text: v.string(),
  html: v.string(),
  assetBundleId: v.optional(v.id("communicationsEmailAssetBundles")),
});

export const communicationsPolicyInput = v.object({
  venueName: v.string(),
  venueAddress: v.optional(v.string()),
  venueMapUrl: v.optional(v.string()),
  startsAt: v.number(),
  endsAt: v.number(),
  nextSteps: v.array(communicationsNextStepInput),
  discordUrl: v.string(),
  discordLabel: v.string(),
  notificationProvider: participantEmailProvider,
  emailTemplates: v.array(communicationsEmailTemplateInput),
});

export type CommunicationsNextStep = {
  stableKey: string;
  title: string;
  detail: string;
  actionUrl?: string;
  dueAt?: number;
};

export type CommunicationsPolicy = {
  venueName: string;
  venueAddress?: string;
  venueMapUrl?: string;
  startsAt: number;
  endsAt: number;
  nextSteps: CommunicationsNextStep[];
  discordUrl: string;
  discordLabel: string;
  notificationProvider: ParticipantEmailProvider;
  emailTemplates: Array<{
    templateKey: ParticipantEmailTemplateKey;
    subject: string;
    text: string;
    html: string;
    assetBundleId?: Id<"communicationsEmailAssetBundles">;
  }>;
};

const allowedPlaceholders = new Set([
  "participant_name",
  "team_name",
  "event_name",
  "portal_url",
  "event_start",
  "venue_name",
  "pass_reference",
  "google_wallet_url",
  "apple_wallet_url",
]);

function invalidPolicy(message: string): never {
  throw new ConvexError({ code: "INVALID_COMMUNICATIONS_POLICY", message });
}

function safeTimestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    invalidPolicy(`${label} must be a valid timestamp.`);
  }
  return value;
}

function optionalText(value: string | undefined, label: string, maximum: number) {
  const trimmed = value?.trim();
  return trimmed ? normalizedLongText(trimmed, label, 3, maximum) : undefined;
}

function normalizedExternalUrl(value: string, label: string) {
  const normalized = normalizedText(value, label, 8, 500);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    invalidPolicy(`${label} must be a complete HTTPS URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    invalidPolicy(`${label} must be a complete HTTPS URL without embedded credentials.`);
  }
  return url.toString();
}

function normalizedActionUrl(value: string | undefined, label: string) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  return normalizedExternalUrl(trimmed, label);
}

function normalizedDiscordUrl(value: string) {
  const normalized = normalizedExternalUrl(value, "Discord invite URL");
  const url = new URL(normalized);
  const host = url.hostname.toLocaleLowerCase("en");
  const validInvite =
    host === "discord.gg" ||
    ((host === "discord.com" || host === "www.discord.com") && url.pathname.startsWith("/invite/"));
  if (!validInvite) {
    invalidPolicy("Discord invite URL must use discord.gg or discord.com/invite.");
  }
  return normalized;
}

function validatePlaceholders(value: string, label: string) {
  for (const match of value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/gu)) {
    const placeholder = match[1];
    if (!placeholder || !allowedPlaceholders.has(placeholder)) {
      invalidPolicy(`${label} contains an unsupported placeholder: {{${placeholder ?? ""}}}.`);
    }
  }
}

function normalizedEmailHtml(value: string, label: string) {
  const normalized = normalizedLongText(value, label, 20, 250_000);
  if (
    /<(?:script|iframe|object|embed|form|input|svg|picture|source|video|audio|base)\b/iu.test(
      normalized,
    ) ||
    /\son[a-z]+\s*=/iu.test(normalized) ||
    /(?:href|src)\s*=\s*["']?\s*(?:javascript|data\s*:\s*text\/html)/iu.test(normalized)
  ) {
    invalidPolicy(`${label} contains executable or unsafe HTML.`);
  }
  validatePlaceholders(normalized, label);
  return normalized;
}

function normalizedEmailTemplates(input: CommunicationsPolicy["emailTemplates"]) {
  if (input.length !== participantEmailTemplateKeys.length) {
    invalidPolicy("Configure exactly one template for every participant email type.");
  }
  const seen = new Set<ParticipantEmailTemplateKey>();
  return input.map((template) => {
    if (seen.has(template.templateKey)) {
      invalidPolicy(`The ${template.templateKey} email template is duplicated.`);
    }
    seen.add(template.templateKey);
    const subject = normalizedLongText(
      template.subject,
      `${template.templateKey} email subject`,
      3,
      160,
    );
    if (/[\r\n]/u.test(subject)) {
      invalidPolicy(`${template.templateKey} email subject must stay on one line.`);
    }
    const text = normalizedLongText(
      template.text,
      `${template.templateKey} email text`,
      10,
      20_000,
    );
    validatePlaceholders(subject, `${template.templateKey} email subject`);
    validatePlaceholders(text, `${template.templateKey} email text`);
    return {
      templateKey: template.templateKey,
      subject,
      text,
      html: normalizedEmailHtml(template.html, `${template.templateKey} email HTML`),
      ...(template.assetBundleId !== undefined ? { assetBundleId: template.assetBundleId } : {}),
    };
  });
}

export function normalizeCommunicationsPolicy(input: CommunicationsPolicy): CommunicationsPolicy {
  const startsAt = safeTimestamp(input.startsAt, "Event start");
  const endsAt = safeTimestamp(input.endsAt, "Event end");
  if (endsAt <= startsAt || endsAt - startsAt > 14 * 24 * 60 * 60 * 1_000) {
    invalidPolicy("Event end must be after the start and no more than 14 days later.");
  }
  if (input.nextSteps.length < 1 || input.nextSteps.length > 8) {
    invalidPolicy("Accepted-team next steps must contain one through eight items.");
  }
  const nextSteps = input.nextSteps.map((step, index) => {
    const stableKey = step.stableKey.trim().toLocaleLowerCase("en");
    if (!/^[a-z][a-z0-9_]{0,39}$/u.test(stableKey)) {
      invalidPolicy(
        `Next step ${index + 1} needs a stable key using lowercase letters, numbers, or underscores.`,
      );
    }
    const dueAt =
      step.dueAt === undefined
        ? undefined
        : safeTimestamp(step.dueAt, `Next step ${index + 1} due time`);
    if (dueAt !== undefined && (dueAt < startsAt - 365 * 24 * 60 * 60 * 1_000 || dueAt > endsAt)) {
      invalidPolicy(`Next step ${index + 1} due time is outside the accepted event window.`);
    }
    const actionUrl = normalizedActionUrl(step.actionUrl, `Next step ${index + 1} action URL`);
    return {
      stableKey,
      title: normalizedText(step.title, `Next step ${index + 1} title`, 2, 80),
      detail: normalizedLongText(step.detail, `Next step ${index + 1} detail`, 5, 300),
      ...(actionUrl !== undefined ? { actionUrl } : {}),
      ...(dueAt !== undefined ? { dueAt } : {}),
    };
  });
  if (new Set(nextSteps.map((step) => step.stableKey)).size !== nextSteps.length) {
    invalidPolicy("Accepted-team next-step keys must be unique.");
  }
  const venueAddress = optionalText(input.venueAddress, "Venue address", 300);
  const venueMapUrl = input.venueMapUrl?.trim()
    ? normalizedExternalUrl(input.venueMapUrl, "Venue map URL")
    : undefined;
  return {
    venueName: normalizedText(input.venueName, "Venue name", 2, 120),
    ...(venueAddress !== undefined ? { venueAddress } : {}),
    ...(venueMapUrl !== undefined ? { venueMapUrl } : {}),
    startsAt,
    endsAt,
    nextSteps,
    discordUrl: normalizedDiscordUrl(input.discordUrl),
    discordLabel: normalizedText(input.discordLabel, "Discord label", 2, 60),
    notificationProvider: input.notificationProvider,
    emailTemplates: normalizedEmailTemplates(input.emailTemplates),
  };
}

export function communicationsPolicyChecksum(policy: CommunicationsPolicy) {
  return fingerprintText(JSON.stringify(normalizeCommunicationsPolicy(policy)));
}

export function communicationsPolicyFromDocument(
  policy: Doc<"communicationsPolicyVersions">,
): CommunicationsPolicy {
  return {
    venueName: policy.venueName,
    ...(policy.venueAddress !== undefined ? { venueAddress: policy.venueAddress } : {}),
    ...(policy.venueMapUrl !== undefined ? { venueMapUrl: policy.venueMapUrl } : {}),
    startsAt: policy.startsAt,
    endsAt: policy.endsAt,
    nextSteps: policy.nextSteps.map((step) => ({
      stableKey: step.stableKey,
      title: step.title,
      detail: step.detail,
      ...(step.actionUrl !== undefined ? { actionUrl: step.actionUrl } : {}),
      ...(step.dueAt !== undefined ? { dueAt: step.dueAt } : {}),
    })),
    discordUrl: policy.discordUrl,
    discordLabel: policy.discordLabel,
    notificationProvider: policy.notificationProvider,
    emailTemplates: policy.emailTemplates.map((template) => ({
      templateKey: template.templateKey,
      subject: template.subject,
      text: template.text,
      html: template.html,
      ...(template.assetBundleId !== undefined ? { assetBundleId: template.assetBundleId } : {}),
    })),
  };
}

async function assertEmailAssetBundles(
  ctx: ReadCtx,
  eventId: Id<"events">,
  policy: CommunicationsPolicy,
) {
  await Promise.all(
    policy.emailTemplates.map(async (template) => {
      if (template.assetBundleId === undefined) return;
      const bundle = await ctx.db.get(template.assetBundleId);
      if (!bundle || bundle.eventId !== eventId || bundle.templateKey !== template.templateKey) {
        invalidPolicy(
          `The ${template.templateKey} email asset bundle is not valid for this event.`,
        );
      }
    }),
  );
}

export async function loadPublishedCommunicationsPolicy(ctx: ReadCtx, event: Doc<"events">) {
  const policyId = event.publishedCommunicationsPolicyId;
  const policy = policyId ? await ctx.db.get(policyId) : null;
  if (!policy || policy.eventId !== event._id || policy.status !== "published") {
    throw new ConvexError({
      code: "COMMUNICATIONS_POLICY_UNAVAILABLE",
      message: "Accepted-team communications are not configured for this event.",
    });
  }
  const normalized = normalizeCommunicationsPolicy(communicationsPolicyFromDocument(policy));
  await assertEmailAssetBundles(ctx, event._id, normalized);
  if (communicationsPolicyChecksum(normalized) !== policy.checksum) {
    throw new Error("The published communications-policy checksum is invalid.");
  }
  return { policy, normalized };
}

function assertEventWindow(event: Doc<"events">, policy: CommunicationsPolicy) {
  if (
    event.startsAt === undefined ||
    event.endsAt === undefined ||
    event.startsAt !== policy.startsAt ||
    event.endsAt !== policy.endsAt
  ) {
    throw new ConvexError({
      code: "COMMUNICATIONS_EVENT_WINDOW_MISMATCH",
      message: "Accepted-team dates must match the event's operational start and end.",
    });
  }
}

export async function saveCommunicationsPolicyDraft(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    actorPersonId: Id<"people">;
    policy: CommunicationsPolicy;
    expectedDraftPolicyId?: Id<"communicationsPolicyVersions">;
    now: number;
  },
) {
  const normalized = normalizeCommunicationsPolicy(args.policy);
  assertEventWindow(args.event, normalized);
  await assertEmailAssetBundles(ctx, args.event._id, normalized);
  const checksum = communicationsPolicyChecksum(normalized);
  const currentDraft = await ctx.db
    .query("communicationsPolicyVersions")
    .withIndex("by_event_status", (index) =>
      index.eq("eventId", args.event._id).eq("status", "draft"),
    )
    .unique();
  if (currentDraft?._id !== args.expectedDraftPolicyId) {
    throw new ConvexError({
      code: "COMMUNICATIONS_POLICY_DRAFT_CHANGED",
      message: "The communications-policy draft changed in another session.",
    });
  }
  if (currentDraft?.checksum === checksum) {
    return {
      policyVersionId: currentDraft._id,
      policyVersion: currentDraft.version,
      checksum,
      changed: false,
    };
  }
  const latest = await ctx.db
    .query("communicationsPolicyVersions")
    .withIndex("by_event_version", (index) => index.eq("eventId", args.event._id))
    .order("desc")
    .first();
  if (currentDraft) await ctx.db.patch(currentDraft._id, { status: "retired" });
  const policyVersionId = await ctx.db.insert("communicationsPolicyVersions", {
    eventId: args.event._id,
    version: (latest?.version ?? 0) + 1,
    status: "draft",
    ...normalized,
    checksum,
    createdByPersonId: args.actorPersonId,
    createdAt: args.now,
  });
  return {
    policyVersionId,
    policyVersion: (latest?.version ?? 0) + 1,
    checksum,
    changed: true,
  };
}

export async function publishCommunicationsPolicy(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    draftPolicyId: Id<"communicationsPolicyVersions">;
    expectedDraftChecksum: string;
    now: number;
  },
) {
  const draft = await ctx.db.get(args.draftPolicyId);
  const currentDraft = await ctx.db
    .query("communicationsPolicyVersions")
    .withIndex("by_event_status", (index) =>
      index.eq("eventId", args.event._id).eq("status", "draft"),
    )
    .unique();
  if (
    !draft ||
    draft.eventId !== args.event._id ||
    currentDraft?._id !== draft._id ||
    draft.checksum !== args.expectedDraftChecksum
  ) {
    throw new ConvexError({
      code: "COMMUNICATIONS_POLICY_DRAFT_CHANGED",
      message: "The communications-policy draft changed in another session.",
    });
  }
  const normalized = normalizeCommunicationsPolicy(communicationsPolicyFromDocument(draft));
  assertEventWindow(args.event, normalized);
  await assertEmailAssetBundles(ctx, args.event._id, normalized);
  if (communicationsPolicyChecksum(normalized) !== draft.checksum) {
    throw new Error("The communications-policy draft checksum does not match its content.");
  }
  const previousId = args.event.publishedCommunicationsPolicyId;
  const previous = previousId ? await ctx.db.get(previousId) : null;
  if (!previous || previous.eventId !== args.event._id || previous.status !== "published") {
    throw new Error("The event's published communications policy is invalid.");
  }
  await ctx.db.patch(previous._id, { status: "superseded" });
  await ctx.db.patch(draft._id, { status: "published", publishedAt: args.now });
  await ctx.db.patch(args.event._id, {
    publishedCommunicationsPolicyId: draft._id,
    version: args.event.version + 1,
    updatedAt: args.now,
  });
  return { policyVersionId: draft._id, policyVersion: draft.version };
}
