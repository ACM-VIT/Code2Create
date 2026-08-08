import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, type QueryCtx } from "./_generated/server";
import { isProfileCompleteForPolicy } from "./lib/participantPolicy";
import { matchingPermissionGrantIds } from "./lib/permissions";
import { normalizeEmail } from "./lib/strings";

type ReleaseAccount = {
  person: Doc<"people">;
  subject: Doc<"eventAccessSubjects">;
};

type ReleaseFixtureArgs = {
  eventSlug: string;
  operationsAccountEmail: string;
  participantAccountEmail: string;
};

const supportedIdentifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const supportedEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function releaseIdentifier(value: string, label: string) {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 80 ||
    !supportedIdentifier.test(normalized)
  ) {
    throw new ConvexError({
      code: "INVALID_RELEASE_FIXTURE_INPUT",
      message: `${label} is invalid.`,
    });
  }
  return normalized;
}

function releaseEmail(value: string, label: string) {
  const normalized = normalizeEmail(value);
  if (normalized.length > 320 || !supportedEmail.test(normalized)) {
    throw new ConvexError({
      code: "INVALID_RELEASE_FIXTURE_INPUT",
      message: `${label} is invalid.`,
    });
  }
  return normalized;
}

export function requireStagingReleaseDeployment(value: string | undefined) {
  if (value?.trim() !== "staging") {
    throw new ConvexError({
      code: "RELEASE_VERIFICATION_NOT_STAGING",
      message: "Release verification can run only on the staging Convex deployment.",
    });
  }
}

async function releaseAccount(
  ctx: QueryCtx,
  eventId: Id<"events">,
  email: string,
): Promise<ReleaseAccount | null> {
  const subject = await ctx.db
    .query("eventAccessSubjects")
    .withIndex("by_event_email", (index) =>
      index.eq("eventId", eventId).eq("emailNormalized", email),
    )
    .unique();
  if (!subject || subject.status !== "active") return null;
  const person = await ctx.db.get(subject.personId);
  if (
    !person ||
    person.status !== "active" ||
    normalizeEmail(person.verifiedEmail) !== email
  ) {
    return null;
  }
  return { person, subject };
}

function fixtureNotReady(missing: readonly string[]): never {
  throw new ConvexError({
    code: "RELEASE_FIXTURE_NOT_READY",
    message: `The staging release fixture is missing: ${missing.join(", ")}.`,
    missing: [...missing],
  });
}

export async function inspectReleaseFixture(
  ctx: QueryCtx,
  args: ReleaseFixtureArgs,
) {
  const eventSlug = releaseIdentifier(args.eventSlug, "Event slug");
  const participantAccountEmail = releaseEmail(
    args.participantAccountEmail,
    "Participant account email",
  );
  const operationsAccountEmail = releaseEmail(
    args.operationsAccountEmail,
    "Operations account email",
  );
  if (participantAccountEmail === operationsAccountEmail) {
    throw new ConvexError({
      code: "INVALID_RELEASE_FIXTURE_INPUT",
      message: "Participant and operations release accounts must be different.",
    });
  }

  const event = await ctx.db
    .query("events")
    .withIndex("by_slug", (index) => index.eq("slug", eventSlug))
    .unique();
  if (!event) fixtureNotReady(["event"]);

  const participantPolicy = event.publishedParticipantPolicyId
    ? await ctx.db.get(event.publishedParticipantPolicyId)
    : null;
  const participantPolicyReady = Boolean(
    participantPolicy &&
      participantPolicy.eventId === event._id &&
      participantPolicy.status === "published",
  );
  const [participantAccount, operationsAccount] = await Promise.all([
    releaseAccount(ctx, event._id, participantAccountEmail),
    releaseAccount(ctx, event._id, operationsAccountEmail),
  ]);
  const missing: string[] = [];

  if (!process.env.GOOGLE_CLIENT_ID?.trim() || !process.env.GOOGLE_CLIENT_SECRET?.trim()) {
    missing.push("google_auth");
  }
  if (!participantPolicyReady) missing.push("published_participant_policy");

  if (!participantAccount) {
    missing.push("participant_account");
  } else {
    const membership = await ctx.db
      .query("eventMemberships")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", participantAccount.person._id),
      )
      .unique();
    if (!membership || membership.eligibilityStatus !== "eligible") {
      missing.push("participant_membership");
    } else {
      const [profile, member, profileReadGrantIds] = await Promise.all([
        ctx.db
          .query("participantProfiles")
          .withIndex("by_membership", (index) =>
            index.eq("membershipId", membership._id),
          )
          .unique(),
        ctx.db
          .query("teamMembers")
          .withIndex("by_event_membership_status", (index) =>
            index
              .eq("eventId", event._id)
              .eq("membershipId", membership._id)
              .eq("status", "active"),
          )
          .unique(),
        matchingPermissionGrantIds(ctx, {
          eventId: event._id,
          eventAccessSubjectId: participantAccount.subject._id,
          permissionKey: "participant.profile.read",
          scopeType: "self",
          scopeId: membership._id,
        }),
      ]);
      if (
        !participantPolicy ||
        !participantPolicyReady ||
        !isProfileCompleteForPolicy(profile, membership, participantPolicy)
      ) {
        missing.push("participant_profile");
      }
      if (profileReadGrantIds.length === 0) {
        missing.push("participant_profile_read");
      }
      if (!member) {
        missing.push("participant_team_membership");
      } else {
        const team = await ctx.db.get(member.teamId);
        if (
          !team ||
          team.eventId !== event._id ||
          team.status === "withdrawn" ||
          team.status === "disqualified"
        ) {
          missing.push("participant_team");
        } else {
          const teamReadGrantIds = await matchingPermissionGrantIds(ctx, {
            eventId: event._id,
            eventAccessSubjectId: participantAccount.subject._id,
            permissionKey: "team.read",
            scopeType: "team",
            scopeId: team._id,
          });
          const teamReadGrants = await Promise.all(
            teamReadGrantIds.map((grantId) => ctx.db.get(grantId)),
          );
          if (
            !teamReadGrants.some(
              (grant) =>
                grant?.scopeType === "team" && grant.scopeId === team._id,
            )
          ) {
            missing.push("participant_team_read");
          }
        }
      }
    }
  }

  if (!operationsAccount) {
    missing.push("operations_account");
  } else {
    const [healthGrantIds, rehearsalGrantIds] = await Promise.all([
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: operationsAccount.subject._id,
        permissionKey: "operations.health.read",
        scopeType: "event",
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: operationsAccount.subject._id,
        permissionKey: "rehearsal.read",
        scopeType: "event",
      }),
    ]);
    if (healthGrantIds.length === 0) missing.push("operations_health_read");
    if (rehearsalGrantIds.length === 0) missing.push("operations_rehearsal_read");
  }

  return { missing };
}

export const assertReady = internalQuery({
  args: {
    eventSlug: v.string(),
    operationsAccountEmail: v.string(),
    participantAccountEmail: v.string(),
  },
  returns: v.object({ ready: v.literal(true) }),
  handler: async (ctx, args) => {
    requireStagingReleaseDeployment(process.env.C2C_DEPLOYMENT_ENVIRONMENT);
    const readiness = await inspectReleaseFixture(ctx, args);
    if (readiness.missing.length > 0) fixtureNotReady(readiness.missing);
    const ready: true = true;
    return { ready };
  },
});
