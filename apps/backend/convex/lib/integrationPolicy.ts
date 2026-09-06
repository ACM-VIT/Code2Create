import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { fingerprintText, normalizedText } from "./strings";
import { maximumReviewTeamsPerEvent } from "./reviewLimits";

type ReadCtx = QueryCtx | MutationCtx;

export const integrationPolicyInput = v.object({
  policyVersion: v.string(),
  requiredGitHubTopic: v.string(),
  maxActiveGitHubRepositoriesPerTeam: v.number(),
  githubFreezeAt: v.optional(v.number()),
});

export type IntegrationPolicy = {
  policyVersion: string;
  requiredGitHubTopic: string;
  maxActiveGitHubRepositoriesPerTeam: number;
  githubFreezeAt?: number;
};


const maximumGitHubRepositoriesPerTeam = 20;

function invalidPolicy(message: string): never {
  throw new ConvexError({ code: "INVALID_INTEGRATION_POLICY", message });
}

function boundedInteger(value: number, label: string, maximum: number) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    invalidPolicy(`${label} must be a whole number from 1 through ${maximum}.`);
  }
  return value;
}

function optionalTimestamp(value: number | undefined, label: string) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    invalidPolicy(`${label} must be a valid timestamp.`);
  }
  return value;
}

export function normalizeIntegrationPolicy(input: IntegrationPolicy): IntegrationPolicy {
  const requiredGitHubTopic = input.requiredGitHubTopic.trim().toLocaleLowerCase("en");
  if (requiredGitHubTopic.length > 50 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(requiredGitHubTopic)) {
    invalidPolicy("Required GitHub topic must use lowercase letters, numbers, and single hyphens.");
  }
  const githubFreezeAt = optionalTimestamp(input.githubFreezeAt, "GitHub freeze time");
  return {
    policyVersion: normalizedText(input.policyVersion, "Integration policy version", 1, 80),
    requiredGitHubTopic,
    maxActiveGitHubRepositoriesPerTeam: boundedInteger(
      input.maxActiveGitHubRepositoriesPerTeam,
      "GitHub repository limit",
      maximumGitHubRepositoriesPerTeam,
    ),
    ...(githubFreezeAt !== undefined ? { githubFreezeAt } : {}),
  };
}

export function integrationPolicyChecksum(policy: IntegrationPolicy) {
  return fingerprintText(JSON.stringify(normalizeIntegrationPolicy(policy)));
}

export function integrationPolicyFromDocument(
  policy: Doc<"integrationPolicyVersions">,
): IntegrationPolicy {
  return {
    policyVersion: policy.policyVersion,
    requiredGitHubTopic: policy.requiredGitHubTopic,
    maxActiveGitHubRepositoriesPerTeam: policy.maxActiveGitHubRepositoriesPerTeam,
    ...(policy.githubFreezeAt !== undefined ? { githubFreezeAt: policy.githubFreezeAt } : {}),
  };
}

export function githubIntegrationFrozenAt(
  policy: Pick<IntegrationPolicy, "githubFreezeAt">,
  serverNow: number,
) {
  const freezeAt = policy.githubFreezeAt;
  return freezeAt !== undefined && serverNow >= freezeAt;
}

export function githubTopicVerificationIsCurrent(
  binding: {
    requiredTopic: string;
    topicState: "present" | "missing" | "unknown";
  },
  requiredGitHubTopic: string,
) {
  return binding.requiredTopic === requiredGitHubTopic && binding.topicState !== "unknown";
}

export async function loadPublishedIntegrationPolicy(ctx: ReadCtx, event: Doc<"events">) {
  const policyId = event.publishedIntegrationPolicyId;
  const policy = policyId ? await ctx.db.get(policyId) : null;
  if (!policy || policy.eventId !== event._id || policy.status !== "published") {
    throw new ConvexError({
      code: "INTEGRATIONS_NOT_CONFIGURED",
      message: "The published integration policy is unavailable.",
    });
  }
  const normalized = normalizeIntegrationPolicy(integrationPolicyFromDocument(policy));
  if (integrationPolicyChecksum(normalized) !== policy.checksum) {
    throw new Error("The published integration-policy checksum is invalid.");
  }
  return { policy, normalized };
}

export async function integrationPolicyPublicationIssues(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    policy: IntegrationPolicy;
  },
) {
  const normalized = normalizeIntegrationPolicy(args.policy);
  const githubMetrics = await ctx.db.query("githubTeamMetrics")
    .withIndex("by_event_updated", index => index.eq("eventId", args.eventId))
    .take(maximumReviewTeamsPerEvent + 1);
  if (githubMetrics.length > maximumReviewTeamsPerEvent) throw new Error(`Integration policy validation supports at most ${maximumReviewTeamsPerEvent} event teams.`);
  const largestRepositorySet = githubMetrics.reduce(
    (largest, metric) => Math.max(largest, metric.repositoryCount),
    0,
  );
  const issues: string[] = [];
  if (largestRepositorySet > normalized.maxActiveGitHubRepositoriesPerTeam) {
    issues.push(
      `At least one team already has ${largestRepositorySet} active GitHub repositories. Archive repositories before lowering the limit.`,
    );
  }
  return issues;
}

export async function saveIntegrationPolicyDraft(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    actorPersonId: Id<"people">;
    policy: IntegrationPolicy;
    expectedDraftPolicyId?: Id<"integrationPolicyVersions">;
    now: number;
  },
) {
  const normalized = normalizeIntegrationPolicy(args.policy);
  const checksum = integrationPolicyChecksum(normalized);
  const currentDraft = await ctx.db
    .query("integrationPolicyVersions")
    .withIndex("by_event_status", (index) =>
      index.eq("eventId", args.event._id).eq("status", "draft"),
    )
    .unique();
  if (currentDraft?._id !== args.expectedDraftPolicyId) {
    throw new ConvexError({
      code: "INTEGRATION_POLICY_DRAFT_CHANGED",
      message: "The integration-policy draft changed in another session.",
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
    .query("integrationPolicyVersions")
    .withIndex("by_event_version", (index) => index.eq("eventId", args.event._id))
    .order("desc")
    .first();
  if (currentDraft) await ctx.db.patch(currentDraft._id, { status: "retired" });
  const policyVersion = (latest?.version ?? 0) + 1;
  const policyVersionId = await ctx.db.insert("integrationPolicyVersions", {
    eventId: args.event._id,
    version: policyVersion,
    status: "draft",
    ...normalized,
    checksum,
    createdByPersonId: args.actorPersonId,
    createdAt: args.now,
  });
  return { policyVersionId, policyVersion, checksum, changed: true };
}

export async function publishIntegrationPolicy(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    draftPolicyId: Id<"integrationPolicyVersions">;
    expectedDraftChecksum: string;
    now: number;
  },
) {
  const [draft, currentDraft] = await Promise.all([
    ctx.db.get(args.draftPolicyId),
    ctx.db
      .query("integrationPolicyVersions")
      .withIndex("by_event_status", (index) =>
        index.eq("eventId", args.event._id).eq("status", "draft"),
      )
      .unique(),
  ]);
  if (
    !draft ||
    draft.eventId !== args.event._id ||
    currentDraft?._id !== draft._id ||
    draft.checksum !== args.expectedDraftChecksum
  ) {
    throw new ConvexError({
      code: "INTEGRATION_POLICY_DRAFT_CHANGED",
      message: "The integration-policy draft changed in another session.",
    });
  }
  const normalized = normalizeIntegrationPolicy(integrationPolicyFromDocument(draft));
  if (integrationPolicyChecksum(normalized) !== draft.checksum) {
    throw new Error("The integration-policy draft checksum does not match its content.");
  }
  const issues = await integrationPolicyPublicationIssues(ctx, {
    eventId: args.event._id,
    policy: normalized,
  });
  if (issues.length > 0) {
    throw new ConvexError({
      code: "INTEGRATION_POLICY_BLOCKED",
      message: issues.join(" "),
    });
  }
  const previousId = args.event.publishedIntegrationPolicyId;
  const previous = previousId ? await ctx.db.get(previousId) : null;
  if (!previous || previous.eventId !== args.event._id || previous.status !== "published") {
    throw new Error("The event's published integration policy is invalid.");
  }
  await ctx.db.patch(previous._id, { status: "superseded" });
  await ctx.db.patch(draft._id, { status: "published", publishedAt: args.now });
  await ctx.db.patch(args.event._id, {
    publishedIntegrationPolicyId: draft._id,
    version: args.event.version + 1,
    updatedAt: args.now,
  });
  return {
    policyVersionId: draft._id,
    policyVersion: draft.version,
    requiredGitHubTopicChanged: previous.requiredGitHubTopic !== normalized.requiredGitHubTopic,
  };
}
