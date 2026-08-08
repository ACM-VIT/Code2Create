import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { fingerprintText, normalizedLongText, normalizedText } from "./strings";

type ReadCtx = QueryCtx | MutationCtx;

export const communicationsNextStepInput = v.object({
  stableKey: v.string(),
  title: v.string(),
  detail: v.string(),
  actionUrl: v.optional(v.string()),
  dueAt: v.optional(v.number()),
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
  notificationProvider: v.literal("cloudflare_email"),
  notificationSubject: v.string(),
  notificationIntro: v.string(),
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
  notificationProvider: "cloudflare_email";
  notificationSubject: string;
  notificationIntro: string;
};

const outcomeTerms = [
  "accepted",
  "declined",
  "offer",
  "selected",
  "waitlist",
] as const;

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
    ((host === "discord.com" || host === "www.discord.com") &&
      url.pathname.startsWith("/invite/"));
  if (!validInvite) {
    invalidPolicy("Discord invite URL must use discord.gg or discord.com/invite.");
  }
  return normalized;
}

function genericNotificationText(value: string, label: string, minimum: number, maximum: number) {
  const normalized = normalizedLongText(value, label, minimum, maximum);
  const lower = normalized.toLocaleLowerCase("en");
  if (outcomeTerms.some((term) => lower.includes(term))) {
    invalidPolicy(`${label} must remain generic and must not disclose an application outcome.`);
  }
  return normalized;
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
      step.dueAt === undefined ? undefined : safeTimestamp(step.dueAt, `Next step ${index + 1} due time`);
    if (
      dueAt !== undefined &&
      (dueAt < startsAt - 365 * 24 * 60 * 60 * 1_000 || dueAt > endsAt)
    ) {
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
    notificationProvider: "cloudflare_email",
    notificationSubject: genericNotificationText(
      input.notificationSubject,
      "Notification subject",
      5,
      120,
    ),
    notificationIntro: genericNotificationText(
      input.notificationIntro,
      "Notification introduction",
      10,
      300,
    ),
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
    notificationSubject: policy.notificationSubject,
    notificationIntro: policy.notificationIntro,
  };
}

export async function loadPublishedCommunicationsPolicy(
  ctx: ReadCtx,
  event: Doc<"events">,
) {
  const policyId = event.publishedCommunicationsPolicyId;
  const policy = policyId ? await ctx.db.get(policyId) : null;
  if (!policy || policy.eventId !== event._id || policy.status !== "published") {
    throw new ConvexError({
      code: "COMMUNICATIONS_POLICY_UNAVAILABLE",
      message: "Accepted-team communications are not configured for this event.",
    });
  }
  const normalized = normalizeCommunicationsPolicy(communicationsPolicyFromDocument(policy));
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
