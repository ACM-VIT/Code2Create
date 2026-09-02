import { type Infer, ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, query } from "./_generated/server";
import { requireEventBySlug, requireRegistrationOpen } from "./lib/events";
import {
  findCurrentPerson,
  requireCurrentPerson,
  requireEligibleMembership,
  requireMembership,
} from "./lib/identity";
import {
  isProfileCompleteForPolicy,
  loadPublishedParticipantPolicy,
} from "./lib/participantPolicy";

const setupLifetimeMs = 10 * 60 * 1_000;
const providerClaimLifetimeMs = 60 * 1_000;

async function onboardingContext(ctx: MutationCtx, eventSlug: string) {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const membership = requireEligibleMembership(
    await requireMembership(ctx, event._id, person._id),
  );
  requireRegistrationOpen(event, membership.participantClass);
  const profile = await ctx.db
    .query("participantProfiles")
    .withIndex("by_membership", (index) => index.eq("membershipId", membership._id))
    .unique();
  const participantPolicy = await loadPublishedParticipantPolicy(ctx, event);
  if (!isProfileCompleteForPolicy(profile, membership, participantPolicy.policy)) {
    throw new ConvexError({
      code: "PROFILE_REQUIRED",
      message: "Complete your participant details before connecting GitHub.",
    });
  }
  return { event, person, membership };
}

export async function requireGitHubStarCompletion(
  ctx: MutationCtx,
  event: Doc<"events">,
  membership: Doc<"eventMemberships">,
) {
  const profile = await ctx.db
    .query("participantProfiles")
    .withIndex("by_membership", (index) => index.eq("membershipId", membership._id))
    .unique();
  const participantPolicy = await loadPublishedParticipantPolicy(ctx, event);
  if (!isProfileCompleteForPolicy(profile, membership, participantPolicy.policy)) {
    throw new ConvexError({
      code: "PROFILE_REQUIRED",
      message: "Complete your participant details before connecting GitHub.",
    });
  }
  const completion = await ctx.db
    .query("githubStarCompletions")
    .withIndex("by_event_membership", (index) =>
      index.eq("eventId", event._id).eq("membershipId", membership._id),
    )
    .unique();
  if (!completion) {
    throw new ConvexError({
      code: "GITHUB_STAR_REQUIRED",
      message: "Connect GitHub and star sgl-project/sglang before setting up a team.",
    });
  }
  return completion;
}

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      connected: v.boolean(),
      githubLogin: v.optional(v.string()),
      completed: v.boolean(),
      completedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const person = await findCurrentPerson(ctx);
    if (!person) return null;
    const membership = await ctx.db
      .query("eventMemberships")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", person._id),
      )
      .unique();
    if (!membership) return null;
    const completion = await ctx.db
      .query("githubStarCompletions")
      .withIndex("by_event_membership", (index) =>
        index.eq("eventId", event._id).eq("membershipId", membership._id),
      )
      .unique();
    if (completion) {
      return {
        connected: true,
        githubLogin: completion.githubLogin,
        completed: true,
        completedAt: completion.completedAt,
      };
    }
    const authorization = await ctx.db
      .query("githubStarAuthorizations")
      .withIndex("by_event_membership", (index) =>
        index.eq("eventId", event._id).eq("membershipId", membership._id),
      )
      .unique();
    return authorization
      ? { connected: true, githubLogin: authorization.githubLogin, completed: false }
      : { connected: false, completed: false };
  },
});

const disconnectClaim = v.union(
  v.object({ kind: v.literal("clear") }),
  v.object({
    kind: v.literal("revoke"),
    authorizationId: v.id("githubStarAuthorizations"),
    accessTokenCiphertext: v.string(),
  }),
);

export const prepareDisconnect = internalMutation({
  args: { eventSlug: v.string() },
  returns: disconnectClaim,
  handler: async (ctx, args) => {
    const { event, membership } = await onboardingContext(ctx, args.eventSlug);
    const completion = await ctx.db
      .query("githubStarCompletions")
      .withIndex("by_event_membership", (index) =>
        index.eq("eventId", event._id).eq("membershipId", membership._id),
      )
      .unique();
    if (completion) {
      throw new ConvexError({
        code: "GITHUB_STAR_COMPLETE",
        message: "This GitHub step is already complete.",
      });
    }
    const authorization = await ctx.db
      .query("githubStarAuthorizations")
      .withIndex("by_event_membership", (index) =>
        index.eq("eventId", event._id).eq("membershipId", membership._id),
      )
      .unique();
    return authorization
      ? {
          kind: "revoke" as const,
          authorizationId: authorization._id,
          accessTokenCiphertext: authorization.accessTokenCiphertext,
        }
      : { kind: "clear" as const };
  },
});

export const finishDisconnect = internalMutation({
  args: {
    eventSlug: v.string(),
    authorizationId: v.optional(v.id("githubStarAuthorizations")),
  },
  returns: v.object({ disconnected: v.boolean() }),
  handler: async (ctx, args) => {
    const { event, membership } = await onboardingContext(ctx, args.eventSlug);
    const completion = await ctx.db
      .query("githubStarCompletions")
      .withIndex("by_event_membership", (index) =>
        index.eq("eventId", event._id).eq("membershipId", membership._id),
      )
      .unique();
    if (completion) {
      throw new ConvexError({
        code: "GITHUB_STAR_COMPLETE",
        message: "This GitHub step is already complete.",
      });
    }

    let disconnected = false;
    if (args.authorizationId) {
      const authorization = await ctx.db.get(args.authorizationId);
      if (
        authorization &&
        authorization.eventId === event._id &&
        authorization.membershipId === membership._id
      ) {
        await ctx.db.delete(authorization._id);
        disconnected = true;
      }
    }

    for (const status of ["pending", "verifying", "failed"] as const) {
      const intents = await ctx.db
        .query("githubStarSetupIntents")
        .withIndex("by_membership_status", (index) =>
          index.eq("membershipId", membership._id).eq("status", status),
        )
        .collect();
      for (const intent of intents) {
        await ctx.db.patch(intent._id, {
          status: "expired",
          pkceVerifierCiphertext: undefined,
          attemptId: undefined,
          claimExpiresAt: undefined,
          completedAt: Date.now(),
        });
        disconnected = true;
      }
    }
    return { disconnected };
  },
});

export const createSetupIntent = internalMutation({
  args: {
    eventSlug: v.string(),
    stateDigest: v.string(),
    pkceVerifierCiphertext: v.string(),
    redirectUri: v.string(),
  },
  returns: v.object({ intentId: v.id("githubStarSetupIntents") }),
  handler: async (ctx, args) => {
    const { event, person, membership } = await onboardingContext(ctx, args.eventSlug);
    const completed = await ctx.db
      .query("githubStarCompletions")
      .withIndex("by_event_membership", (index) =>
        index.eq("eventId", event._id).eq("membershipId", membership._id),
      )
      .unique();
    if (completed) {
      throw new ConvexError({
        code: "GITHUB_STAR_COMPLETE",
        message: "This GitHub step is already complete.",
      });
    }
    const collision = await ctx.db
      .query("githubStarSetupIntents")
      .withIndex("by_state_digest", (index) => index.eq("stateDigest", args.stateDigest))
      .unique();
    if (collision) throw new Error("GitHub onboarding state collision.");
    const now = Date.now();
    const expiresAt = now + setupLifetimeMs;
    const intentId = await ctx.db.insert("githubStarSetupIntents", {
      eventId: event._id,
      membershipId: membership._id,
      personId: person._id,
      stateDigest: args.stateDigest,
      pkceVerifierCiphertext: args.pkceVerifierCiphertext,
      redirectUri: args.redirectUri,
      status: "pending",
      expiresAt,
      createdAt: now,
    });
    await ctx.scheduler.runAt(expiresAt, internal.githubStarGate.expireSetupIntent, {
      intentId,
    });
    return { intentId };
  },
});

const setupClaim = v.union(
  v.object({
    kind: v.literal("verify"),
    intentId: v.id("githubStarSetupIntents"),
    pkceVerifierCiphertext: v.string(),
    redirectUri: v.string(),
  }),
  v.object({ kind: v.literal("completed") }),
);
type SetupClaim = Infer<typeof setupClaim>;

export const claimSetupIntent = internalMutation({
  args: { eventSlug: v.string(), stateDigest: v.string(), attemptId: v.string() },
  returns: setupClaim,
  handler: async (ctx, args): Promise<SetupClaim> => {
    const { event, person, membership } = await onboardingContext(ctx, args.eventSlug);
    const intent = await ctx.db
      .query("githubStarSetupIntents")
      .withIndex("by_state_digest", (index) => index.eq("stateDigest", args.stateDigest))
      .unique();
    if (
      !intent ||
      intent.eventId !== event._id ||
      intent.membershipId !== membership._id ||
      intent.personId !== person._id
    ) {
      throw new ConvexError({
        code: "GITHUB_SETUP_INVALID",
        message: "This GitHub connection is invalid. Start again.",
      });
    }
    if (intent.status === "completed") return { kind: "completed" };
    const now = Date.now();
    if (intent.expiresAt <= now || intent.status === "expired") {
      await ctx.db.patch(intent._id, {
        status: "expired",
        pkceVerifierCiphertext: undefined,
        claimExpiresAt: undefined,
      });
      throw new ConvexError({
        code: "GITHUB_SETUP_EXPIRED",
        message: "The GitHub connection expired. Start again.",
      });
    }
    if (intent.status === "failed") {
      throw new ConvexError({
        code: "GITHUB_SETUP_FAILED",
        message: "The GitHub connection failed. Start again.",
      });
    }
    if (intent.status === "verifying" && (intent.claimExpiresAt ?? 0) > now) {
      throw new ConvexError({
        code: "GITHUB_SETUP_IN_PROGRESS",
        message: "This GitHub connection is already being verified.",
      });
    }
    if (!intent.pkceVerifierCiphertext) {
      throw new ConvexError({
        code: "GITHUB_SETUP_INVALID",
        message: "This GitHub connection is invalid. Start again.",
      });
    }
    await ctx.db.patch(intent._id, {
      status: "verifying",
      attemptId: args.attemptId,
      claimExpiresAt: now + providerClaimLifetimeMs,
    });
    return {
      kind: "verify",
      intentId: intent._id,
      pkceVerifierCiphertext: intent.pkceVerifierCiphertext,
      redirectUri: intent.redirectUri,
    };
  },
});

const setupAuthorization = v.union(
  v.object({ kind: v.literal("already_starred") }),
  v.object({
    kind: v.literal("connected"),
    accessTokenCiphertext: v.string(),
    authorizationExpiresAt: v.number(),
  }),
);

const setupSettlement = v.union(
  v.object({ kind: v.literal("connected"), githubLogin: v.string() }),
  v.object({
    kind: v.literal("completed"),
    githubLogin: v.string(),
    completedAt: v.number(),
  }),
);
type SetupSettlement = Infer<typeof setupSettlement>;

async function completeGitHubStar(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    person: Doc<"people">;
    membership: Doc<"eventMemberships">;
    githubUserId: string;
    githubLogin: string;
  },
) {
  const existing = await ctx.db
    .query("githubStarCompletions")
    .withIndex("by_event_membership", (index) =>
      index.eq("eventId", args.event._id).eq("membershipId", args.membership._id),
    )
    .unique();
  if (existing) {
    return { githubLogin: existing.githubLogin, completedAt: existing.completedAt };
  }
  const githubCompletion = await ctx.db
    .query("githubStarCompletions")
    .withIndex("by_event_github_user", (index) =>
      index.eq("eventId", args.event._id).eq("githubUserId", args.githubUserId),
    )
    .unique();
  if (githubCompletion) {
    throw new ConvexError({
      code: "GITHUB_ACCOUNT_IN_USE",
      message: "That GitHub account was already used by another participant. Disconnect it, then connect a different GitHub account.",
    });
  }
  const completedAt = Date.now();
  await ctx.db.insert("githubStarCompletions", {
    eventId: args.event._id,
    membershipId: args.membership._id,
    personId: args.person._id,
    githubUserId: args.githubUserId,
    githubLogin: args.githubLogin,
    repositoryOwner: "sgl-project",
    repositoryName: "sglang",
    completedAt,
  });
  await ctx.db.patch(args.membership._id, {
    onboardingStatus: "team_required",
    updatedAt: completedAt,
  });
  return { githubLogin: args.githubLogin, completedAt };
}

export const finishSetupIntent = internalMutation({
  args: {
    eventSlug: v.string(),
    intentId: v.id("githubStarSetupIntents"),
    attemptId: v.string(),
    githubUserId: v.string(),
    githubLogin: v.string(),
    authorization: setupAuthorization,
  },
  returns: setupSettlement,
  handler: async (ctx, args): Promise<SetupSettlement> => {
    const { event, person, membership } = await onboardingContext(ctx, args.eventSlug);
    const intent = await ctx.db.get(args.intentId);
    const now = Date.now();
    if (
      !intent ||
      intent.eventId !== event._id ||
      intent.membershipId !== membership._id ||
      intent.personId !== person._id ||
      intent.status !== "verifying" ||
      intent.attemptId !== args.attemptId ||
      intent.expiresAt <= now
    ) {
      throw new ConvexError({
        code: "GITHUB_SETUP_STALE",
        message: "The GitHub connection changed. Start again.",
      });
    }
    if (
      args.authorization.kind === "connected" &&
      args.authorization.authorizationExpiresAt <= now
    ) {
      throw new ConvexError({
        code: "GITHUB_TOKEN_EXPIRED",
        message: "GitHub returned an expired authorization. Start again.",
      });
    }
    const membershipCompletion = await ctx.db
      .query("githubStarCompletions")
      .withIndex("by_event_membership", (index) =>
        index.eq("eventId", event._id).eq("membershipId", membership._id),
      )
      .unique();
    if (membershipCompletion) {
      await ctx.db.patch(intent._id, {
        status: "completed",
        pkceVerifierCiphertext: undefined,
        completedAt: now,
        claimExpiresAt: undefined,
      });
      return {
        kind: "completed",
        githubLogin: membershipCompletion.githubLogin,
        completedAt: membershipCompletion.completedAt,
      };
    }
    const githubCompletion = await ctx.db
      .query("githubStarCompletions")
      .withIndex("by_event_github_user", (index) =>
        index.eq("eventId", event._id).eq("githubUserId", args.githubUserId),
      )
      .unique();
    if (githubCompletion && githubCompletion.membershipId !== membership._id) {
      throw new ConvexError({
        code: "GITHUB_ACCOUNT_IN_USE",
        message: "That GitHub account was already used by another participant. Disconnect it, then connect a different GitHub account.",
      });
    }
    const githubAuthorization = await ctx.db
      .query("githubStarAuthorizations")
      .withIndex("by_event_github_user", (index) =>
        index.eq("eventId", event._id).eq("githubUserId", args.githubUserId),
      )
      .unique();
    if (githubAuthorization && githubAuthorization.membershipId !== membership._id) {
      throw new ConvexError({
        code: "GITHUB_ACCOUNT_IN_USE",
        message: "That GitHub account is connected to another participant.",
      });
    }
    const currentAuthorization = await ctx.db
      .query("githubStarAuthorizations")
      .withIndex("by_event_membership", (index) =>
        index.eq("eventId", event._id).eq("membershipId", membership._id),
      )
      .unique();
    if (currentAuthorization) await ctx.db.delete(currentAuthorization._id);

    if (args.authorization.kind === "already_starred") {
      const completion = await completeGitHubStar(ctx, {
        event,
        person,
        membership,
        githubUserId: args.githubUserId,
        githubLogin: args.githubLogin,
      });
      await ctx.db.patch(intent._id, {
        status: "completed",
        pkceVerifierCiphertext: undefined,
        authorizationId: undefined,
        completedAt: completion.completedAt,
        claimExpiresAt: undefined,
      });
      return { kind: "completed", ...completion };
    }

    const authorizationId = await ctx.db.insert("githubStarAuthorizations", {
      eventId: event._id,
      membershipId: membership._id,
      personId: person._id,
      githubUserId: args.githubUserId,
      githubLogin: args.githubLogin,
      accessTokenCiphertext: args.authorization.accessTokenCiphertext,
      expiresAt: args.authorization.authorizationExpiresAt,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(intent._id, {
      status: "completed",
      pkceVerifierCiphertext: undefined,
      authorizationId,
      completedAt: now,
      claimExpiresAt: undefined,
    });
    await ctx.scheduler.runAt(
      args.authorization.authorizationExpiresAt,
      internal.githubStarGate.expireAuthorization,
      { authorizationId },
    );
    return { kind: "connected", githubLogin: args.githubLogin };
  },
});

export const failSetupIntent = internalMutation({
  args: {
    intentId: v.id("githubStarSetupIntents"),
    attemptId: v.string(),
    failureCode: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const intent = await ctx.db.get(args.intentId);
    if (intent?.status === "verifying" && intent.attemptId === args.attemptId) {
      await ctx.db.patch(intent._id, {
        status: "failed",
        pkceVerifierCiphertext: undefined,
        failureCode: args.failureCode,
        completedAt: Date.now(),
        claimExpiresAt: undefined,
      });
    }
    return null;
  },
});

export const expireSetupIntent = internalMutation({
  args: { intentId: v.id("githubStarSetupIntents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const intent = await ctx.db.get(args.intentId);
    if (intent && (intent.status === "pending" || intent.status === "verifying")) {
      await ctx.db.patch(intent._id, {
        status: "expired",
        pkceVerifierCiphertext: undefined,
        claimExpiresAt: undefined,
      });
    }
    return null;
  },
});

const starClaim = v.union(
  v.object({
    kind: v.literal("completed"),
    githubLogin: v.string(),
    completedAt: v.number(),
  }),
  v.object({
    kind: v.union(v.literal("star"), v.literal("revoke")),
    authorizationId: v.id("githubStarAuthorizations"),
    accessTokenCiphertext: v.string(),
  }),
  v.object({
    kind: v.literal("finish"),
    authorizationId: v.id("githubStarAuthorizations"),
  }),
);
type StarClaim = Infer<typeof starClaim>;

export const claimStar = internalMutation({
  args: { eventSlug: v.string(), attemptId: v.string() },
  returns: starClaim,
  handler: async (ctx, args): Promise<StarClaim> => {
    const { event, membership } = await onboardingContext(ctx, args.eventSlug);
    const completion = await ctx.db
      .query("githubStarCompletions")
      .withIndex("by_event_membership", (index) =>
        index.eq("eventId", event._id).eq("membershipId", membership._id),
      )
      .unique();
    if (completion) {
      return {
        kind: "completed",
        githubLogin: completion.githubLogin,
        completedAt: completion.completedAt,
      };
    }
    const authorization = await ctx.db
      .query("githubStarAuthorizations")
      .withIndex("by_event_membership", (index) =>
        index.eq("eventId", event._id).eq("membershipId", membership._id),
      )
      .unique();
    const now = Date.now();
    if (
      !authorization ||
      (authorization.expiresAt <= now &&
        authorization.status !== "revoking" &&
        authorization.status !== "revoked")
    ) {
      if (authorization) await ctx.db.delete(authorization._id);
      throw new ConvexError({
        code: "GITHUB_CONNECTION_REQUIRED",
        message: "Your GitHub connection expired. Connect GitHub again.",
      });
    }
    if (authorization.status !== "active" && (authorization.claimExpiresAt ?? 0) > now) {
      throw new ConvexError({
        code: "GITHUB_STAR_IN_PROGRESS",
        message: "The repository star is already being confirmed.",
      });
    }
    const kind = authorization.status === "revoking"
      ? "revoke" as const
      : authorization.status === "revoked"
        ? "finish" as const
        : "star" as const;
    await ctx.db.patch(authorization._id, {
      status: kind === "star" ? "starring" : authorization.status,
      attemptId: args.attemptId,
      claimExpiresAt: now + providerClaimLifetimeMs,
      updatedAt: now,
    });
    if (kind === "finish") {
      return { kind, authorizationId: authorization._id };
    }
    return {
      kind,
      authorizationId: authorization._id,
      accessTokenCiphertext: authorization.accessTokenCiphertext,
    };
  },
});

export const markStarSucceeded = internalMutation({
  args: {
    authorizationId: v.id("githubStarAuthorizations"),
    attemptId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const authorization = await ctx.db.get(args.authorizationId);
    if (
      !authorization ||
      authorization.status !== "starring" ||
      authorization.attemptId !== args.attemptId
    ) {
      throw new ConvexError({
        code: "GITHUB_STAR_STALE",
        message: "The GitHub connection changed. Connect again.",
      });
    }
    await ctx.db.patch(authorization._id, {
      status: "revoking",
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const markGrantRevoked = internalMutation({
  args: {
    authorizationId: v.id("githubStarAuthorizations"),
    attemptId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const authorization = await ctx.db.get(args.authorizationId);
    if (
      !authorization ||
      authorization.status !== "revoking" ||
      authorization.attemptId !== args.attemptId
    ) {
      throw new ConvexError({
        code: "GITHUB_STAR_STALE",
        message: "The GitHub connection changed. Connect again.",
      });
    }
    await ctx.db.patch(authorization._id, {
      status: "revoked",
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const finishStar = internalMutation({
  args: {
    eventSlug: v.string(),
    authorizationId: v.id("githubStarAuthorizations"),
    attemptId: v.string(),
  },
  returns: v.object({ githubLogin: v.string(), completedAt: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, membership } = await onboardingContext(ctx, args.eventSlug);
    const existing = await ctx.db
      .query("githubStarCompletions")
      .withIndex("by_event_membership", (index) =>
        index.eq("eventId", event._id).eq("membershipId", membership._id),
      )
      .unique();
    if (existing) return { githubLogin: existing.githubLogin, completedAt: existing.completedAt };
    const authorization = await ctx.db.get(args.authorizationId);
    if (
      !authorization ||
      authorization.eventId !== event._id ||
      authorization.membershipId !== membership._id ||
      authorization.personId !== person._id ||
      authorization.status !== "revoked" ||
      authorization.attemptId !== args.attemptId
    ) {
      throw new ConvexError({
        code: "GITHUB_STAR_STALE",
        message: "The GitHub connection changed. Connect again.",
      });
    }
    const completion = await completeGitHubStar(ctx, {
      event,
      person,
      membership,
      githubUserId: authorization.githubUserId,
      githubLogin: authorization.githubLogin,
    });
    await ctx.db.delete(authorization._id);
    return completion;
  },
});

export const failStar = internalMutation({
  args: {
    authorizationId: v.id("githubStarAuthorizations"),
    attemptId: v.string(),
    invalidateAuthorization: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const authorization = await ctx.db.get(args.authorizationId);
    if (
      authorization &&
      authorization.status !== "active" &&
      authorization.attemptId === args.attemptId
    ) {
      if (args.invalidateAuthorization && authorization.status === "starring") {
        await ctx.db.delete(authorization._id);
      } else {
        await ctx.db.patch(authorization._id, {
          status: authorization.status === "starring" ? "active" : authorization.status,
          attemptId: undefined,
          claimExpiresAt: undefined,
          updatedAt: Date.now(),
        });
      }
    }
    return null;
  },
});

export const expireAuthorization = internalMutation({
  args: { authorizationId: v.id("githubStarAuthorizations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const authorization = await ctx.db.get(args.authorizationId);
    if (
      authorization &&
      authorization.expiresAt <= Date.now() &&
      authorization.status !== "revoking" &&
      authorization.status !== "revoked"
    ) {
      await ctx.db.delete(authorization._id);
    }
    return null;
  },
});
