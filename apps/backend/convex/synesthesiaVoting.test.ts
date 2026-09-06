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
  test("creates and edits voting windows without a vote quota", async () => {
    const backend = seededBackend();
    const fixture = await seedVotingFixture(backend);
    await backend.run(ctx => insertPermissionGrant(ctx, {
      eventId: fixture.eventId, personId: fixture.first.personId,
      eventAccessSubjectId: fixture.first.subjectId,
      permissionKey: "synesthesia.window.manage", scopeType: "event",
      sourceType: "manual", sourceId: "window-policy-test", reason: "Window policy test",
    }));
    const first = asAccount(backend, fixture.first);
    const fields = {
      eventSlug: fixture.eventSlug,
      name: "Evening session",
      kind: "working_session" as const,
      startsAt: fixture.now + 3_600_000,
      endsAt: fixture.now + 7_200_000,
      requestsOpen: true,
      votingOpen: true,
      catalogSourceLabel: "Fixture catalog",
      autoApproveRequests: false,
      maxRequestsPerParticipant: 3,
      maxRequestsTotal: 200,
      maxTrackDurationSeconds: 480,
      allowExplicit: false,
      allowedEnergyTags: ["focused"],
      reason: "Configure voting without a quota",
    };
    const created = await first.mutation(api.synesthesiaConfiguration.createWindow, {
      ...fields, clientOperationId: crypto.randomUUID(),
    });
    expect(created.version).toBe(1);
    const updated = await first.mutation(api.synesthesiaConfiguration.updateWindow, {
      ...fields, name: "Updated evening session", windowId: created.windowId,
      expectedVersion: created.version, clientOperationId: crypto.randomUUID(),
    });
    expect(updated.version).toBe(2);
    expect(await backend.run(ctx => ctx.db.get(created.windowId))).toMatchObject({
      name: "Updated evening session", votingOpen: true, maxRequestsPerParticipant: 3, maxRequestsTotal: 200,
    });
  });

  test("allows voting past the former cap and reads every vote without duplicates", async () => {
    const backend = seededBackend();
    const fixture = await seedVotingFixture(backend);
    const first = asAccount(backend, fixture.first);
    const requestIds = await backend.run(async (ctx) => {
      const ids = [fixture.requestId];
      for (let index = 1; index < 60; index += 1) {
        const track = {
          eventId: fixture.eventId,
          provider: "fixture",
          providerTrackId: `track-${index}`,
          title: `Fixture track ${index}`,
          artist: "Fixture artist",
          durationSeconds: 180,
          isExplicit: false,
          energyTag: "focused",
          version: 1,
          createdAt: fixture.now,
          updatedAt: fixture.now,
        };
        const catalogTrackId = await ctx.db.insert("synesthesiaCatalogTracks", {
          ...track,
          searchText: track.title.toLowerCase(),
          status: "active",
          createdByPersonId: fixture.first.personId,
          updatedByPersonId: fixture.first.personId,
        });
        ids.push(await ctx.db.insert("songRequests", {
          ...track,
          windowId: fixture.windowId,
          catalogTrackId,
          requestedByMembershipId: fixture.second.membershipId,
          requestedByPersonId: fixture.second.personId,
          state: "approved",
          openReportCount: 0,
          queueMode: "normal",
        }));
      }
      return ids;
    });
    for (const requestId of requestIds) {
      await first.mutation(api.synesthesiaParticipant.vote, {
        eventSlug: fixture.eventSlug, requestId, clientOperationId: crypto.randomUUID(),
      });
    }
    const state = await first.query(api.synesthesiaParticipant.state, { eventSlug: fixture.eventSlug });
    expect(state.usage.votes).toBe(60);
    expect(state.requests).toHaveLength(60);
    expect(state.requests.every(request => request.hasVoted && request.canVote)).toBe(true);

    // A new operation ID is still the same person's single vote on this song.
    await first.mutation(api.synesthesiaParticipant.vote, {
      eventSlug: fixture.eventSlug, requestId: fixture.requestId, clientOperationId: crypto.randomUUID(),
    });
    expect((await first.query(api.synesthesiaParticipant.state, { eventSlug: fixture.eventSlug })).usage.votes).toBe(60);
    const counts = await first.query(api.synesthesiaParticipant.voteCounts, { eventSlug: fixture.eventSlug });
    expect(counts?.counts).toHaveLength(60);
    expect(counts?.counts.every(request => request.voteCount === 1)).toBe(true);

    await first.mutation(api.synesthesiaParticipant.removeVote, {
      eventSlug: fixture.eventSlug, requestId: fixture.requestId, clientOperationId: crypto.randomUUID(),
    });
    const afterRemoval = await first.query(api.synesthesiaParticipant.state, { eventSlug: fixture.eventSlug });
    expect(afterRemoval.usage.votes).toBe(59);
    expect(afterRemoval.requests.find(request => request.id === fixture.requestId)?.hasVoted).toBe(false);
    await first.mutation(api.synesthesiaParticipant.vote, {
      eventSlug: fixture.eventSlug, requestId: fixture.requestId, clientOperationId: crypto.randomUUID(),
    });
    expect((await first.query(api.synesthesiaParticipant.state, { eventSlug: fixture.eventSlug })).usage.votes).toBe(60);
    const second = asAccount(backend, fixture.second);
    expect((await second.query(api.synesthesiaParticipant.state, { eventSlug: fixture.eventSlug })).usage.votes).toBe(0);
  });

  test("still rejects votes when voting is closed or the request is rejected", async () => {
    const backend = seededBackend();
    const fixture = await seedVotingFixture(backend);
    const first = asAccount(backend, fixture.first);
    await backend.run(ctx => ctx.db.patch(fixture.windowId, { votingOpen: false }));
    await expect(first.mutation(api.synesthesiaParticipant.vote, {
      eventSlug: fixture.eventSlug, requestId: fixture.requestId, clientOperationId: crypto.randomUUID(),
    })).rejects.toThrow("Voting is closed");
    await backend.run(async (ctx) => {
      await ctx.db.patch(fixture.windowId, { votingOpen: true });
      await ctx.db.patch(fixture.requestId, { state: "rejected" });
    });
    await expect(first.mutation(api.synesthesiaParticipant.vote, {
      eventSlug: fixture.eventSlug, requestId: fixture.requestId, clientOperationId: crypto.randomUUID(),
    })).rejects.toThrow("Voting is closed");
    expect((await first.query(api.synesthesiaParticipant.state, { eventSlug: fixture.eventSlug })).usage.votes).toBe(0);
  });

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

    expect(
      await first.query(api.synesthesiaParticipant.voteCounts, {
        eventSlug: fixture.eventSlug,
      }),
    ).toEqual({
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
    expect(
      await first.query(api.synesthesiaParticipant.voteCounts, {
        eventSlug: fixture.eventSlug,
      }),
    ).toEqual({
      windowId: fixture.windowId,
      counts: [{ requestId: fixture.requestId, voteCount: 1 }],
    });
  });

  test("pages every open report behind exact request access", async () => {
    const backend = seededBackend();
    const fixture = await seedVotingFixture(backend);
    await backend.run(async (ctx) => {
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.first.personId,
        eventAccessSubjectId: fixture.first.subjectId,
        permissionKey: "synesthesia.report.read",
        scopeType: "song_request",
        scopeId: fixture.requestId,
        sourceType: "manual",
        sourceId: `${fixture.requestId}:report-read`,
        grantedByPersonId: fixture.first.personId,
        reason: "Synesthesia report paging test",
      });
      const reports = [
        {
          reporterMembershipId: fixture.first.membershipId,
          reporterPersonId: fixture.first.personId,
          reason: "First report",
        },
        {
          reporterMembershipId: fixture.second.membershipId,
          reporterPersonId: fixture.second.personId,
          reason: "Second report",
        },
      ];
      for (const [index, report] of reports.entries()) {
        await ctx.db.insert("synesthesiaReports", {
          eventId: fixture.eventId,
          windowId: fixture.windowId,
          requestId: fixture.requestId,
          ...report,
          state: "open",
          version: 1,
          createdAt: fixture.now + index + 1,
          updatedAt: fixture.now + index + 1,
        });
      }
      const request = await ctx.db.get("songRequests", fixture.requestId);
      if (!request) throw new Error("The song request is missing.");
      await ctx.db.patch(request._id, { openReportCount: reports.length });
    });

    const operator = asAccount(backend, fixture.first);
    const firstPage = await operator.query(api.synesthesiaOperations.reports, {
      eventSlug: fixture.eventSlug,
      requestId: fixture.requestId,
      paginationOpts: { cursor: null, numItems: 1 },
    });
    expect(firstPage.page.map((report) => report.reason)).toEqual(["First report"]);
    expect(firstPage.isDone).toBe(false);

    const secondPage = await operator.query(api.synesthesiaOperations.reports, {
      eventSlug: fixture.eventSlug,
      requestId: fixture.requestId,
      paginationOpts: { cursor: firstPage.continueCursor, numItems: 1 },
    });
    expect(secondPage.page.map((report) => report.reason)).toEqual(["Second report"]);
    expect(secondPage.isDone).toBe(true);

    await expect(
      asAccount(backend, fixture.second).query(api.synesthesiaOperations.reports, {
        eventSlug: fixture.eventSlug,
        requestId: fixture.requestId,
        paginationOpts: { cursor: null, numItems: 1 },
      }),
    ).rejects.toThrow();
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

describe("Synesthesia quick Ops decisions", () => {
  for (const scopeType of ["event", "synesthesia_window"] as const) {
    for (const decision of ["approve", "reject"] as const) {
      test(`${scopeType} queue access permits ${decision} without hosting or typed reasons`, async () => {
        const backend = seededBackend();
        const fixture = await seedVotingFixture(backend);
        await grantQueueAccess(backend, fixture, scopeType);
        const operator = asAccount(backend, fixture.second);
        const before = await operator.query(api.synesthesiaOperations.queue, {
          eventSlug: fixture.eventSlug, windowId: fixture.windowId,
        });
        expect(before.requests[0]).toMatchObject({
          canDecide: true, canModerate: false, canSchedule: false,
          canAcknowledgePlayback: false, canReadReports: false,
          canSuspendRequester: false, canRestoreRequester: false,
        });
        const args = {
          eventSlug: fixture.eventSlug, requestId: fixture.requestId,
          decision, expectedVersion: 1, clientOperationId: crypto.randomUUID(),
        };
        expect(await operator.mutation(api.synesthesiaOperations.moderateRequest, args)).toEqual({ requestId: fixture.requestId, version: 2 });
        expect(await operator.mutation(api.synesthesiaOperations.moderateRequest, args)).toEqual({ requestId: fixture.requestId, version: 2 });
        await backend.run(async (ctx) => {
          const request = await ctx.db.get(fixture.requestId);
          expect(request).toMatchObject({ state: decision === "approve" ? "approved" : "rejected", version: 2, moderatedByPersonId: fixture.second.personId });
          expect(request?.publicReason).toBe(decision === "reject" ? "This request was declined by the music desk." : undefined);
          const audit = await ctx.db.query("auditEvents").withIndex("by_target_time", q => q.eq("targetType", "song_request").eq("targetId", fixture.requestId)).collect();
          expect(audit).toHaveLength(1);
          expect(audit[0]).toMatchObject({
            actorPersonId: fixture.second.personId,
            authorizingPermissionKey: "synesthesia.queue.read",
            resolvedScopeType: "synesthesia_window", resolvedScopeId: fixture.windowId,
            reason: decision === "approve" ? "Approved from the music desk." : "Rejected from the music desk.",
          });
        });
        if (decision === "reject") {
          const participantState = await asAccount(backend, fixture.first).query(
            api.synesthesiaParticipant.state,
            { eventSlug: fixture.eventSlug },
          );
          expect(participantState.requests[0]).toMatchObject({ state: "rejected", isMine: true });
          expect(participantState.requests[0]).not.toHaveProperty("publicReason");
        }
      });
    }
  }

  test("queue readers see requester names but not contact details or internal notes", async () => {
    const backend = seededBackend();
    const fixture = await seedVotingFixture(backend);
    await grantQueueAccess(backend, fixture);
    await backend.run(async ctx => {
      await ctx.db.patch(fixture.first.personId, { displayName: "Song Requester" });
      await ctx.db.patch(fixture.requestId, { internalNote: "Private moderation note" });
    });
    const operator = asAccount(backend, fixture.second);
    const queue = await operator.query(api.synesthesiaOperations.queue, { eventSlug: fixture.eventSlug, windowId: fixture.windowId });
    expect(queue.requests[0]?.requesterName).toBe("Song Requester");
    expect(queue.requests[0]).not.toHaveProperty("internalNote");
    expect(JSON.stringify(queue.requests)).not.toContain(fixture.first.email);
    await operator.mutation(api.synesthesiaOperations.moderateRequest, {
      eventSlug: fixture.eventSlug, requestId: fixture.requestId,
      decision: "approve", expectedVersion: 1, clientOperationId: crypto.randomUUID(),
    });
    expect(await backend.run(ctx => ctx.db.get(fixture.requestId))).toMatchObject({ internalNote: "Private moderation note" });
  });

  test("queue access does not permit hiding requests or changing internal notes", async () => {
    const backend = seededBackend();
    const fixture = await seedVotingFixture(backend);
    await grantQueueAccess(backend, fixture);
    const operator = asAccount(backend, fixture.second);
    const args = { eventSlug: fixture.eventSlug, requestId: fixture.requestId, expectedVersion: 1 };
    await expect(operator.mutation(api.synesthesiaOperations.moderateRequest, {
      ...args, decision: "hide", reason: "Hide for review", publicReason: "Not suitable for this session", clientOperationId: crypto.randomUUID(),
    })).rejects.toThrow();
    await expect(operator.mutation(api.synesthesiaOperations.moderateRequest, {
      ...args, decision: "approve", internalNote: "Overwrite a moderator note", clientOperationId: crypto.randomUUID(),
    })).rejects.toThrow("Internal notes require song-moderation permission");
    expect(await backend.run(ctx => ctx.db.get(fixture.requestId))).toMatchObject({ state: "pending", version: 1 });
  });

  test("ordinary participants and grants for another queue cannot make decisions", async () => {
    const backend = seededBackend();
    const fixture = await seedVotingFixture(backend);
    const operator = asAccount(backend, fixture.second);
    const args = { eventSlug: fixture.eventSlug, requestId: fixture.requestId, decision: "approve" as const, expectedVersion: 1, clientOperationId: crypto.randomUUID() };
    await expect(operator.mutation(api.synesthesiaOperations.moderateRequest, args)).rejects.toThrow();
    const otherWindowId = await backend.run(async ctx => {
      const source = await ctx.db.get(fixture.windowId);
      if (!source) throw new Error("Missing fixture window");
      const { _id, _creationTime, ...fields } = source;
      return ctx.db.insert("synesthesiaWindows", { ...fields, name: "Other queue" });
    });
    await grantQueueAccess(backend, fixture, "synesthesia_window", otherWindowId);
    await expect(operator.mutation(api.synesthesiaOperations.moderateRequest, args)).rejects.toThrow();
    await expect(operator.query(api.synesthesiaOperations.queue, { eventSlug: fixture.eventSlug, windowId: fixture.windowId })).rejects.toThrow();
  });

  test("stale competing decisions cannot overwrite a newer decision", async () => {
    const backend = seededBackend();
    const fixture = await seedVotingFixture(backend);
    await grantQueueAccess(backend, fixture);
    const operator = asAccount(backend, fixture.second);
    const args = { eventSlug: fixture.eventSlug, requestId: fixture.requestId, expectedVersion: 1 };
    await operator.mutation(api.synesthesiaOperations.moderateRequest, { ...args, decision: "approve", clientOperationId: crypto.randomUUID() });
    await expect(operator.mutation(api.synesthesiaOperations.moderateRequest, { ...args, decision: "reject", clientOperationId: crypto.randomUUID() })).rejects.toThrow("The song request changed");
    expect(await backend.run(ctx => ctx.db.get(fixture.requestId))).toMatchObject({ state: "approved", version: 2 });
  });

  test("an explicit moderator can still act without queue or playback grants", async () => {
    const backend = seededBackend();
    const fixture = await seedVotingFixture(backend);
    await backend.run(ctx => insertPermissionGrant(ctx, {
      eventId: fixture.eventId, personId: fixture.second.personId,
      eventAccessSubjectId: fixture.second.subjectId,
      permissionKey: "synesthesia.request.moderate", scopeType: "song_request", scopeId: fixture.requestId,
      sourceType: "manual", sourceId: "moderator-test", reason: "Moderator test",
    }));
    const operator = asAccount(backend, fixture.second);
    const args = { eventSlug: fixture.eventSlug, requestId: fixture.requestId, expectedVersion: 1, decision: "hide" as const, clientOperationId: crypto.randomUUID() };
    await expect(operator.mutation(api.synesthesiaOperations.moderateRequest, args)).rejects.toThrow();
    await expect(operator.mutation(api.synesthesiaOperations.moderateRequest, { ...args, reason: "Hide for review" })).rejects.toThrow("participant-facing reason");
    await operator.mutation(api.synesthesiaOperations.moderateRequest, { ...args, reason: "Hide for review", publicReason: "Not suitable for this session" });
    expect(await backend.run(ctx => ctx.db.get(fixture.requestId))).toMatchObject({ state: "hidden", version: 2 });
  });

  test("one-click moderator decisions preserve earlier internal notes", async () => {
    const backend = seededBackend();
    const fixture = await seedVotingFixture(backend);
    await backend.run(async ctx => {
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId, personId: fixture.second.personId,
        eventAccessSubjectId: fixture.second.subjectId,
        permissionKey: "synesthesia.request.moderate", scopeType: "song_request", scopeId: fixture.requestId,
        sourceType: "manual", sourceId: "moderator-test", reason: "Moderator test",
      });
      await ctx.db.patch(fixture.requestId, { internalNote: "Keep the original context" });
    });
    await asAccount(backend, fixture.second).mutation(api.synesthesiaOperations.moderateRequest, {
      eventSlug: fixture.eventSlug, requestId: fixture.requestId, expectedVersion: 1,
      decision: "reject", clientOperationId: crypto.randomUUID(),
    });
    expect(await backend.run(ctx => ctx.db.get(fixture.requestId))).toMatchObject({
      state: "rejected", version: 2, internalNote: "Keep the original context",
    });
  });
});

async function grantQueueAccess(
  backend: BackendTest,
  fixture: Awaited<ReturnType<typeof seedVotingFixture>>,
  scopeType: "event" | "synesthesia_window" = "synesthesia_window",
  windowId = fixture.windowId,
) {
  await backend.run(ctx => insertPermissionGrant(ctx, {
    eventId: fixture.eventId, personId: fixture.second.personId,
    eventAccessSubjectId: fixture.second.subjectId,
    permissionKey: "synesthesia.queue.read",
    ...(scopeType === "event" ? { scopeType } : { scopeType, scopeId: windowId }),
    sourceType: "manual", sourceId: "queue-decision-test", reason: "Queue decision test",
  }));
}

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
      applicationsCloseAt: Date.now() + 86_400_000,
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

async function insertParticipantAccount(backend: BackendTest, key: string, now: number) {
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
