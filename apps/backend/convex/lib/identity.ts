import { ConvexError } from "convex/values";

import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { authComponent, createAuth } from "../auth";
import { normalizeEmail } from "./strings";

type ReadCtx = QueryCtx | MutationCtx;

export const sensitiveCommandSessionMaxAgeMs = 15 * 60 * 1_000;

export async function stagingParticipantAccessAllowed(
  ctx: ReadCtx,
  eventId: Doc<"events">["_id"],
  email: string,
) {
  if (process.env.C2C_DEPLOYMENT_ENVIRONMENT?.trim() !== "staging") return true;
  const emailNormalized = normalizeEmail(email);
  const [pending, claimed] = await Promise.all([
    ctx.db
      .query("rosterEntries")
      .withIndex("by_event_email_status", (query) =>
        query
          .eq("eventId", eventId)
          .eq("emailNormalized", emailNormalized)
          .eq("status", "pending"),
      )
      .first(),
    ctx.db
      .query("rosterEntries")
      .withIndex("by_event_email_status", (query) =>
        query
          .eq("eventId", eventId)
          .eq("emailNormalized", emailNormalized)
          .eq("status", "claimed"),
      )
      .first(),
  ]);
  const now = Date.now();
  return [pending, claimed].some(
    (entry) => entry !== null && entry.validFrom <= now && now < entry.validUntil,
  );
}

export async function requireStagingParticipantAccess(
  ctx: ReadCtx,
  eventId: Doc<"events">["_id"],
  email: string,
) {
  if (await stagingParticipantAccessAllowed(ctx, eventId, email)) return;
  throw new ConvexError({
    code: "STAGING_PARTICIPANT_NOT_INVITED",
    message: "This staging portal is available only to invited testers.",
  });
}

export function authSessionCreatedAtMs(value: unknown) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  throw new Error("Better Auth returned an invalid session creation time.");
}

export async function requireAuthUser(ctx: ReadCtx) {
  const user = await authComponent.getAuthUser(ctx);
  if (!user.emailVerified) {
    throw new ConvexError({
      code: "EMAIL_NOT_VERIFIED",
      message: "Google must verify the email address before it can be used.",
    });
  }
  return user;
}

export async function findCurrentPerson(ctx: ReadCtx) {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) return null;
  return ctx.db
    .query("people")
    .withIndex("by_auth_user", (query) => query.eq("authUserId", user._id))
    .unique();
}

export async function requireCurrentPerson(ctx: ReadCtx) {
  const user = await requireAuthUser(ctx);
  const person = await ctx.db
    .query("people")
    .withIndex("by_auth_user", (query) => query.eq("authUserId", user._id))
    .unique();
  if (!person || person.status !== "active") {
    throw new ConvexError({
      code: "PERSON_NOT_ACTIVE",
      message: "This account is not active in Code2Create.",
    });
  }
  return { user, person };
}

export async function requireVerifiedGoogleIdentity(ctx: ReadCtx) {
  const user = await requireAuthUser(ctx);
  const googleIdentity = await ctx.db
    .query("googleIdentityClaims")
    .withIndex("by_auth_user", (query) => query.eq("authUserId", user._id))
    .unique();
  if (!googleIdentity || googleIdentity.verifiedEmail !== normalizeEmail(user.email)) {
    throw new ConvexError({
      code: "GOOGLE_IDENTITY_REQUIRED",
      message: "Sign out and complete Google authentication again before continuing.",
    });
  }
  return { user, googleIdentity };
}

export async function requireFreshAuthSession(
  ctx: ReadCtx,
  maximumAgeMs: number,
) {
  const current = await currentAuthSessionFreshness(ctx, maximumAgeMs);
  if (!current.fresh) {
    throw new ConvexError({
      code: "FRESH_AUTH_REQUIRED",
      message: "Verify with Google again before performing this sensitive action.",
    });
  }
  return { sessionId: current.sessionId, createdAt: current.createdAt };
}

type AuthSessionFreshness =
  | { fresh: false }
  | { fresh: true; sessionId: string; createdAt: number };

export async function currentAuthSessionFreshness(
  ctx: ReadCtx,
  maximumAgeMs: number,
): Promise<AuthSessionFreshness> {
  const { auth, headers } = await authComponent.getAuth(createAuth, ctx);
  const current = await auth.api.getSession({ headers });
  if (!current) return { fresh: false };
  const createdAt = authSessionCreatedAtMs(current.session.createdAt);
  if (Date.now() - createdAt >= maximumAgeMs) return { fresh: false };
  return { fresh: true, sessionId: current.session.id, createdAt };
}

export async function refreshExistingPersonIdentity(
  ctx: MutationCtx,
  args: {
    person: Doc<"people">;
    verifiedEmail: string;
    displayName: string;
    now: number;
  },
) {
  const emailChanged = args.person.verifiedEmail !== args.verifiedEmail;
  const displayNameChanged = args.person.displayName !== args.displayName;
  if (!emailChanged && !displayNameChanged) return args.person;
  if (emailChanged) {
    const emailOwner = await ctx.db
      .query("people")
      .withIndex("by_verified_email", (query) =>
        query.eq("verifiedEmail", args.verifiedEmail),
      )
      .unique();
    if (emailOwner && emailOwner._id !== args.person._id) {
      throw new ConvexError({
        code: "IDENTITY_LINK_REQUIRED",
        message: "This verified email is already linked to another account.",
      });
    }
  }
  const eventSubjects = await ctx.db
    .query("eventAccessSubjects")
    .withIndex("by_person", (query) => query.eq("personId", args.person._id))
    .collect();
  if (emailChanged) {
    for (const subject of eventSubjects) {
      const eventEmailOwner = await ctx.db
        .query("eventAccessSubjects")
        .withIndex("by_event_email", (query) =>
          query.eq("eventId", subject.eventId).eq("emailNormalized", args.verifiedEmail),
        )
        .unique();
      if (eventEmailOwner && eventEmailOwner._id !== subject._id) {
        throw new ConvexError({
          code: "EVENT_EMAIL_CONFLICT",
          message: "This verified email belongs to another account in an event.",
        });
      }
    }
  }
  await ctx.db.patch(args.person._id, {
    verifiedEmail: args.verifiedEmail,
    displayName: args.displayName,
    updatedAt: args.now,
  });
  for (const subject of eventSubjects) {
    await ctx.db.patch(subject._id, {
      emailNormalized: args.verifiedEmail,
      displayName: args.displayName,
      accessVersion: emailChanged ? subject.accessVersion + 1 : subject.accessVersion,
      updatedAt: args.now,
    });
  }
  return {
    ...args.person,
    verifiedEmail: args.verifiedEmail,
    displayName: args.displayName,
    updatedAt: args.now,
  };
}

export async function ensurePerson(
  ctx: MutationCtx,
): Promise<{
  user: Awaited<ReturnType<typeof requireAuthUser>>;
  person: Doc<"people">;
  googleIdentity: Doc<"googleIdentityClaims">;
}> {
  const { user, googleIdentity } = await requireVerifiedGoogleIdentity(ctx);
  const existing = await ctx.db
    .query("people")
    .withIndex("by_auth_user", (query) => query.eq("authUserId", user._id))
    .unique();
  const now = Date.now();
  const verifiedEmail = normalizeEmail(user.email);

  if (existing) {
    if (existing.status !== "active") {
      throw new ConvexError({
        code: "PERSON_NOT_ACTIVE",
        message: "This account is not active in Code2Create.",
      });
    }
    if (existing.googleSubject !== googleIdentity.googleSubject) {
      throw new ConvexError({
        code: "GOOGLE_IDENTITY_CONFLICT",
        message: "This account is linked to another Google identity.",
      });
    }
    const person = await refreshExistingPersonIdentity(ctx, {
      person: existing,
      verifiedEmail,
      displayName: googleIdentity.displayName,
      now,
    });
    return { user, person, googleIdentity };
  }

  const subjectOwner = await ctx.db
    .query("people")
    .withIndex("by_google_subject", (query) =>
      query.eq("googleSubject", googleIdentity.googleSubject),
    )
    .unique();
  if (subjectOwner) {
    throw new ConvexError({
      code: "IDENTITY_LINK_REQUIRED",
      message: "This Google identity is already linked to another account.",
    });
  }

  const emailOwner = await ctx.db
    .query("people")
    .withIndex("by_verified_email", (query) => query.eq("verifiedEmail", verifiedEmail))
    .unique();
  if (emailOwner) {
    throw new ConvexError({
      code: "IDENTITY_LINK_REQUIRED",
      message: "This verified email is already linked to another account.",
    });
  }

  const personId = await ctx.db.insert("people", {
    authUserId: user._id,
    googleSubject: googleIdentity.googleSubject,
    verifiedEmail,
    displayName: googleIdentity.displayName,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const person = await ctx.db.get(personId);
  if (!person) throw new Error("Person creation did not persist.");
  return { user, person, googleIdentity };
}

export async function requireEventSubject(
  ctx: ReadCtx,
  eventId: Doc<"events">["_id"],
  personId: Doc<"people">["_id"],
) {
  const subject = await ctx.db
    .query("eventAccessSubjects")
    .withIndex("by_event_person", (query) =>
      query.eq("eventId", eventId).eq("personId", personId),
    )
    .unique();
  if (!subject || subject.status !== "active") {
    throw new ConvexError({
      code: "EVENT_ACCESS_REQUIRED",
      message: "This account does not have active access to the event.",
    });
  }
  return subject;
}

export async function requireMembership(
  ctx: ReadCtx,
  eventId: Doc<"events">["_id"],
  personId: Doc<"people">["_id"],
) {
  const membership = await ctx.db
    .query("eventMemberships")
    .withIndex("by_event_person", (query) =>
      query.eq("eventId", eventId).eq("personId", personId),
    )
    .unique();
  if (!membership || membership.eligibilityStatus === "suspended") {
    throw new ConvexError({
      code: "PARTICIPANT_MEMBERSHIP_REQUIRED",
      message: "An active participant membership is required.",
    });
  }
  if (process.env.C2C_DEPLOYMENT_ENVIRONMENT?.trim() === "staging") {
    const person = await ctx.db.get(personId);
    if (!person) throw new Error("The participant person does not exist.");
    await requireStagingParticipantAccess(ctx, eventId, person.verifiedEmail);
  }
  return membership;
}

export function requireEligibleMembership(membership: Doc<"eventMemberships">) {
  if (membership.eligibilityStatus !== "eligible") {
    throw new ConvexError({
      code: "PARTICIPANT_NOT_ELIGIBLE",
      message: "An eligible participant membership is required.",
    });
  }
  return membership;
}
