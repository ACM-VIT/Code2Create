import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import aggregateTest from "@convex-dev/aggregate/test";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { insertPermissionGrant } from "./lib/permissions.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;
type Identity = Awaited<ReturnType<typeof insertParticipantAccount>>;
type Account = Identity & {
  personId: Id<"people">;
  subjectId: Id<"eventAccessSubjects">;
  membershipId: Id<"eventMemberships">;
  teamId: Id<"teams">;
};

describe("Synesthesia vote ownership", () => {
  test("keeps vote-derived state out of the moderated request version", async () => {
    const backend = seededBackend();
    const fixture = await seedVotingFixture(backend);
    const first = asAccount(backend, fixture.first);
    const second = asAccount(backend, fixture.second);

    const firstOperationId = crypto.randomUUID();
    await Promise.all([
      first.mutation(api.synesthesiaParticipant.vote, {
        eventSlug: fixture.eventSlug,
        requestId: fixture.requestId,
        clientOperationId: firstOperationId,
      }),
      second.mutation(api.synesthesiaParticipant.vote, {
        eventSlug: fixture.eventSlug,
        requestId: fixture.requestId,
        clientOperationId: crypto.randomUUID(),
      }),
    ]);
    await first.mutation(api.synesthesiaParticipant.vote, {
      eventSlug: fixture.eventSlug,
      requestId: fixture.requestId,
      clientOperationId: firstOperationId,
    });

    expect(await first.query(api.synesthesiaParticipant.voteCounts, {
      eventSlug: fixture.eventSlug,
    })).toEqual({
      windowId: fixture.windowId,
      counts: [{ requestId: fixture.requestId, voteCount: 2 }],
    });
    await backend.run(async (ctx) => {
      const request = await ctx.db.get("songRequests", fixture.requestId);
      if (!request) throw new Error("The song request is missing.");
      expect(request.version).toBe(1);
      const firstVote = await ctx.db
        .query("songVotes")
        .withIndex("by_window_member_state", (index) =>
          index
            .eq("windowId", fixture.windowId)
            .eq("membershipId", fixture.first.membershipId)
            .eq("state", "active"),
        )
        .unique();
      const secondVote = await ctx.db
        .query("songVotes")
        .withIndex("by_window_member_state", (index) =>
          index
            .eq("windowId", fixture.windowId)
            .eq("membershipId", fixture.second.membershipId)
            .eq("state", "active"),
        )
        .unique();
      const votes = [firstVote, secondVote].filter((vote) => vote !== null);
      expect(votes).toHaveLength(2);
    });

    await first.mutation(api.synesthesiaParticipant.removeVote, {
      eventSlug: fixture.eventSlug,
      requestId: fixture.requestId,
      clientOperationId: crypto.randomUUID(),
    });
    expect(await first.query(api.synesthesiaParticipant.voteCounts, {
      eventSlug: fixture.eventSlug,
    })).toEqual({
      windowId: fixture.windowId,
      counts: [{ requestId: fixture.requestId, voteCount: 1 }],
    });
  });

  test("returns a compact count payload for a full configured window", async () => {
    const backend = seededBackend();
    const fixture = await seedVotingFixture(backend);
    await backend.run(async (ctx) => {
      for (let index = 1; index < 200; index += 1) {
        await ctx.db.insert("songRequests", {
          eventId: fixture.eventId,
          windowId: fixture.windowId,
          catalogTrackId: fixture.trackId,
          requestedByMembershipId: fixture.first.membershipId,
          requestedByPersonId: fixture.first.personId,
          provider: "fixture",
          providerTrackId: `track-${index}`,
          title: `Track ${index}`,
          artist: "Fixture artist",
          durationSeconds: 180,
          isExplicit: false,
          energyTag: "focused",
          state: "pending",
          openReportCount: 0,
          queueMode: "normal",
          version: 1,
          createdAt: fixture.now + index,
          updatedAt: fixture.now + index,
        });
      }
    });

    const result = await asAccount(backend, fixture.first).query(
      api.synesthesiaParticipant.voteCounts,
      { eventSlug: fixture.eventSlug },
    );
    expect(result?.counts).toHaveLength(200);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(18_000);
  });
});

function seededBackend() {
  const backend = convexTest({ schema, modules });
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  aggregateTest.register(backend, "reviewQueue");
  aggregateTest.register(backend, "synesthesiaVotes");
  return backend;
}

function asAccount(backend: BackendTest, account: Account) {
  return backend.withIdentity({
    subject: account.authUserId,
    sessionId: account.authSessionId,
  });
}

async function seedVotingFixture(backend: BackendTest) {
  const now = Date.now();
  const eventSlug = `synesthesia-voting-${crypto.randomUUID()}`;
  const first = await insertParticipantAccount(backend, "first", now);
  const second = await insertParticipantAccount(backend, "second", now);
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Synesthesia voting fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      startsAt: now - 60_000,
      endsAt: now + 3_600_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const linkedFirst = await linkParticipant(ctx, eventId, first, now);
    const linkedSecond = await linkParticipant(ctx, eventId, second, now);
    const windowId = await ctx.db.insert("synesthesiaWindows", {
      eventId,
      name: "Working session",
      kind: "working_session",
      startsAt: now - 60_000,
      endsAt: now + 3_600_000,
      status: "published",
      requestsOpen: true,
      votingOpen: true,
      playbackPaused: false,
      catalogSourceLabel: "Fixture catalog",
      autoApproveRequests: false,
      maxRequestsPerParticipant: 3,
      maxVotesPerParticipant: 8,
      maxRequestsTotal: 200,
      maxTrackDurationSeconds: 480,
      allowExplicit: false,
      allowedEnergyTags: ["focused"],
      version: 1,
      createdByPersonId: linkedFirst.personId,
      updatedByPersonId: linkedFirst.personId,
      createdAt: now,
      updatedAt: now,
      publishedByPersonId: linkedFirst.personId,
      publishedAt: now,
    });
    const trackId = await ctx.db.insert("synesthesiaCatalogTracks", {
      eventId,
      provider: "fixture",
      providerTrackId: "track-0",
      title: "Fixture track",
      artist: "Fixture artist",
      durationSeconds: 180,
      isExplicit: false,
      energyTag: "focused",
      searchText: "fixture track fixture artist",
      status: "active",
      version: 1,
      createdByPersonId: linkedFirst.personId,
      updatedByPersonId: linkedFirst.personId,
      createdAt: now,
      updatedAt: now,
    });
    const requestId = await ctx.db.insert("songRequests", {
      eventId,
      windowId,
      catalogTrackId: trackId,
      requestedByMembershipId: linkedFirst.membershipId,
      requestedByPersonId: linkedFirst.personId,
      provider: "fixture",
      providerTrackId: "track-0",
      title: "Fixture track",
      artist: "Fixture artist",
      durationSeconds: 180,
      isExplicit: false,
      energyTag: "focused",
      state: "pending",
      openReportCount: 0,
      queueMode: "normal",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    return {
      now,
      eventSlug,
      eventId,
      windowId,
      trackId,
      requestId,
      first: { ...first, ...linkedFirst },
      second: { ...second, ...linkedSecond },
    };
  });
}

async function insertParticipantAccount(
  backend: BackendTest,
  key: string,
  now: number,
) {
  const email = `${key}-${crypto.randomUUID()}@example.test`;
  const user: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: { name: key, email, emailVerified: true, createdAt: now, updatedAt: now },
    },
  });
  const authUserId = documentId(user, "Better Auth user");
  const session: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        expiresAt: now + 3_600_000,
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        userId: authUserId,
      },
    },
  });
  return { email, authUserId, authSessionId: documentId(session, "Better Auth session") };
}

async function linkParticipant(
  ctx: MutationCtx,
  eventId: Id<"events">,
  account: Identity,
  now: number,
) {
  const personId = await ctx.db.insert("people", {
    authUserId: account.authUserId,
    googleSubject: `google:${account.authUserId}`,
    verifiedEmail: account.email,
    displayName: account.email,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const subjectId = await ctx.db.insert("eventAccessSubjects", {
    eventId,
    personId,
    emailNormalized: account.email,
    displayName: account.email,
    status: "active",
    linkedBy: "participant_provisioning",
    accessVersion: 1,
    createdAt: now,
    updatedAt: now,
  });
  const membershipId = await ctx.db.insert("eventMemberships", {
    eventId,
    personId,
    eventAccessSubjectId: subjectId,
    participantClass: "vit_student",
    eligibilityStatus: "eligible",
    onboardingStatus: "accepted",
    acceptedParticipantPolicyVersionIds: [],
    createdAt: now,
    updatedAt: now,
  });
  const teamId = await ctx.db.insert("teams", {
    eventId,
    name: `${account.email} team`,
    publicCode: crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase(),
    leadMembershipId: membershipId,
    status: "confirmed",
    activeMemberCount: 1,
    activeVitMemberCount: 1,
    activeExternalMemberCount: 0,
    membershipLocked: true,
    trackLocked: true,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert("teamMembers", {
    eventId,
    teamId,
    membershipId,
    role: "lead",
    status: "active",
    joinedAt: now,
    source: "created",
  });
  await insertPermissionGrant(ctx, {
    eventId,
    personId,
    eventAccessSubjectId: subjectId,
    permissionKey: "synesthesia.window.read",
    scopeType: "event",
    sourceType: "manual",
    sourceId: `${membershipId}:synesthesia`,
    grantedByPersonId: personId,
    reason: "Synesthesia voting test",
  });
  return { personId, subjectId, membershipId, teamId };
}

function documentId(value: unknown, label: string) {
  if (typeof value !== "object" || value === null || !("_id" in value)) {
    throw new Error(`${label} did not return an ID.`);
  }
  const id = value._id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${label} returned an invalid ID.`);
  }
  return id;
}
