import { ConvexError } from "convex/values";

import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { authComponent } from "../auth";
import {
  participantEligibilityLookupFromVerifiedIdentity,
  participantEligibilityLookupFromMembership,
  productionParticipantEligibilityAllowed,
} from "./participantEligibility";
import { normalizeEmail, normalizedText } from "./strings";

type ReadCtx = QueryCtx | MutationCtx;

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
        query.eq("eventId", eventId).eq("emailNormalized", emailNormalized).eq("status", "pending"),
      )
      .first(),
    ctx.db
      .query("rosterEntries")
      .withIndex("by_event_email_status", (query) =>
        query.eq("eventId", eventId).eq("emailNormalized", emailNormalized).eq("status", "claimed"),
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

export async function participantIdentityAccessAllowed(
  ctx: ReadCtx,
  event: Doc<"events">,
  identity: {
    verifiedEmail: string;
    hostedDomain?: string;
    displayName: string;
  },
) {
  const environment = process.env.C2C_DEPLOYMENT_ENVIRONMENT?.trim();
  if (environment === "staging") {
    return stagingParticipantAccessAllowed(ctx, event._id, identity.verifiedEmail);
  }
  if (environment !== "production") return true;
  return productionParticipantEligibilityAllowed(
    ctx,
    event,
    participantEligibilityLookupFromVerifiedIdentity(event, identity),
  );
}

export async function participantMembershipAccessAllowed(
  ctx: ReadCtx,
  event: Doc<"events">,
  person: Doc<"people">,
  membership: Doc<"eventMemberships">,
) {
  const environment = process.env.C2C_DEPLOYMENT_ENVIRONMENT?.trim();
  if (environment === "staging") {
    return stagingParticipantAccessAllowed(ctx, event._id, person.verifiedEmail);
  }
  if (environment !== "production") return true;
  let lookup = participantEligibilityLookupFromMembership(membership, person);
  if (!lookup && membership.participantClass === "vit_student") {
    const googleIdentity = await ctx.db
      .query("googleIdentityClaims")
      .withIndex("by_auth_user", (query) => query.eq("authUserId", person.authUserId))
      .unique();
    if (googleIdentity?.displayName) {
      lookup = participantEligibilityLookupFromVerifiedIdentity(event, {
        verifiedEmail: googleIdentity.verifiedEmail,
        ...(googleIdentity.hostedDomain !== undefined
          ? { hostedDomain: googleIdentity.hostedDomain }
          : {}),
        displayName: googleIdentity.displayName,
      });
    }
  }
  return productionParticipantEligibilityAllowed(ctx, event, lookup);
}

export async function requireParticipantIdentityAccess(
  ctx: ReadCtx,
  event: Doc<"events">,
  identity: {
    verifiedEmail: string;
    hostedDomain?: string;
    displayName: string;
  },
) {
  if (await participantIdentityAccessAllowed(ctx, event, identity)) return;
  const environment = process.env.C2C_DEPLOYMENT_ENVIRONMENT?.trim();
  throw new ConvexError(
    environment === "staging"
      ? {
          code: "STAGING_PARTICIPANT_NOT_INVITED",
          message: "This staging portal is available only to invited testers.",
        }
      : {
          code: "PARTICIPANT_NOT_REGISTERED",
          message: "This email address is not registered for Code2Create.",
        },
  );
}

export async function requireAuthUser(ctx: ReadCtx) {
  const user = await authComponent.getAuthUser(ctx);
  if (!user.emailVerified) {
    throw new ConvexError({
      code: "EMAIL_NOT_VERIFIED",
      message: "Verify the email address before it can be used.",
    });
  }
  return user;
}

export async function findCurrentPerson(ctx: ReadCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return ctx.db
    .query("people")
    .withIndex("by_auth_user", (query) => query.eq("authUserId", identity.subject))
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

export async function requireVerifiedIdentity(ctx: ReadCtx) {
  const user = await requireAuthUser(ctx);
  const googleIdentity = await ctx.db
    .query("googleIdentityClaims")
    .withIndex("by_auth_user", (query) => query.eq("authUserId", user._id))
    .unique();
  const verifiedEmail = normalizeEmail(user.email);
  if (googleIdentity && googleIdentity.verifiedEmail !== verifiedEmail) {
    throw new ConvexError({
      code: "IDENTITY_REFRESH_REQUIRED",
      message: "Sign out and verify this email address again before continuing.",
    });
  }
  if (googleIdentity && !googleIdentity.displayName) {
    throw new ConvexError({
      code: "GOOGLE_IDENTITY_REFRESH_REQUIRED",
      message: "Sign out and complete Google authentication again before continuing.",
    });
  }
  const displayName = normalizedText(
    googleIdentity?.displayName || user.name || verifiedEmail,
    "Account display name",
    1,
    100,
  );
  return {
    user,
    identity: {
      verifiedEmail,
      displayName,
      ...(googleIdentity
        ? {
            googleSubject: googleIdentity.googleSubject,
            ...(googleIdentity.hostedDomain !== undefined
              ? { hostedDomain: googleIdentity.hostedDomain }
              : {}),
          }
        : {}),
    },
  };
}

export async function requireVerifiedGoogleIdentity(ctx: ReadCtx) {
  const { user, identity } = await requireVerifiedIdentity(ctx);
  if (!identity.googleSubject) {
    throw new ConvexError({
      code: "GOOGLE_IDENTITY_REQUIRED",
      message: "Sign out and continue with Google before accessing operations.",
    });
  }
  return {
    user,
    googleIdentity: {
      ...identity,
      googleSubject: identity.googleSubject,
    },
  };
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
      .withIndex("by_verified_email", (query) => query.eq("verifiedEmail", args.verifiedEmail))
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

export async function ensurePerson(ctx: MutationCtx): Promise<{
  user: Awaited<ReturnType<typeof requireAuthUser>>;
  person: Doc<"people">;
  identity: Awaited<ReturnType<typeof requireVerifiedIdentity>>["identity"];
}> {
  const { user, identity } = await requireVerifiedIdentity(ctx);
  const existing = await ctx.db
    .query("people")
    .withIndex("by_auth_user", (query) => query.eq("authUserId", user._id))
    .unique();
  const now = Date.now();
  const verifiedEmail = identity.verifiedEmail;

  if (existing) {
    if (existing.status !== "active") {
      throw new ConvexError({
        code: "PERSON_NOT_ACTIVE",
        message: "This account is not active in Code2Create.",
      });
    }
    if (
      existing.googleSubject &&
      identity.googleSubject &&
      existing.googleSubject !== identity.googleSubject
    ) {
      throw new ConvexError({
        code: "GOOGLE_IDENTITY_CONFLICT",
        message: "This account is linked to another Google identity.",
      });
    }
    const person = await refreshExistingPersonIdentity(ctx, {
      person: existing,
      verifiedEmail,
      displayName: identity.displayName,
      now,
    });
    return { user, person, identity };
  }

  if (identity.googleSubject) {
    const subjectOwner = await ctx.db
      .query("people")
      .withIndex("by_google_subject", (query) => query.eq("googleSubject", identity.googleSubject))
      .unique();
    if (subjectOwner) {
      throw new ConvexError({
        code: "IDENTITY_LINK_REQUIRED",
        message: "This Google identity is already linked to another account.",
      });
    }
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
    ...(identity.googleSubject ? { googleSubject: identity.googleSubject } : {}),
    verifiedEmail,
    displayName: identity.displayName,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const person = await ctx.db.get(personId);
  if (!person) throw new Error("Person creation did not persist.");
  return { user, person, identity };
}

export async function ensureGooglePerson(ctx: MutationCtx) {
  const result = await ensurePerson(ctx);
  if (!result.identity.googleSubject) {
    throw new ConvexError({
      code: "GOOGLE_IDENTITY_REQUIRED",
      message: "Sign out and continue with Google before accessing operations.",
    });
  }
  return {
    user: result.user,
    person: result.person,
    googleIdentity: {
      ...result.identity,
      googleSubject: result.identity.googleSubject,
    },
  };
}

export async function requireEventSubject(
  ctx: ReadCtx,
  eventId: Doc<"events">["_id"],
  personId: Doc<"people">["_id"],
) {
  const subject = await ctx.db
    .query("eventAccessSubjects")
    .withIndex("by_event_person", (query) => query.eq("eventId", eventId).eq("personId", personId))
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
    .withIndex("by_event_person", (query) => query.eq("eventId", eventId).eq("personId", personId))
    .unique();
  if (!membership || membership.eligibilityStatus === "suspended") {
    throw new ConvexError({
      code: "PARTICIPANT_MEMBERSHIP_REQUIRED",
      message: "An active participant membership is required.",
    });
  }
  const [person, event] = await Promise.all([ctx.db.get(personId), ctx.db.get(eventId)]);
  if (!person || !event) {
    throw new Error("The participant membership references missing event data.");
  }
  if (!(await participantMembershipAccessAllowed(ctx, event, person, membership))) {
    const environment = process.env.C2C_DEPLOYMENT_ENVIRONMENT?.trim();
    throw new ConvexError(
      environment === "staging"
        ? {
            code: "STAGING_PARTICIPANT_NOT_INVITED",
            message: "This staging portal is available only to invited testers.",
          }
        : {
            code: "PARTICIPANT_NOT_REGISTERED",
            message: "This participant is not in the active Code2Create roster.",
          },
    );
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
