import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "./_generated/dataModel.js";
import {
  recordStaffedVenueCheckIn,
  reverseStaffedVenueCheckIn,
} from "./lib/venueCheckInLifecycle.ts";
import {
  initializeAttendanceTeamAvailability,
  moveAttendanceTeamAvailability,
} from "./lib/attendanceTeamAvailability.ts";
import { permissionCatalog } from "./lib/permissionCatalog.ts";
import { readReviewParticipantAvailability } from "./lib/reviewParticipantAvailability.ts";
import {
  claimStaffedCredentialResolution,
  createStaffedParticipantResolution,
  requireAvailableStaffedCredentialResolution,
  requireAvailableStaffedVenueResolution,
  requireClaimedStaffedCredentialResolution,
  staffedParticipantResolutionLifetimeMs,
} from "./lib/staffedParticipantResolution.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

describe("staffed venue check-in lifecycle", () => {
  test("keeps each arrival authority exact-person scoped with an explicit event-wide option", () => {
    for (const permissionKey of [
      "attendance.venue_check_in.read",
      "attendance.venue_check_in.record",
      "attendance.venue_check_in.override_identity",
      "attendance.venue_check_in.reverse",
    ] as const) {
      expect(permissionCatalog[permissionKey]).toEqual({
        scopes: ["person"],
        eventWide: true,
      });
    }
  });

  test("keeps participant-availability exceptions exact and reads current team presence", async () => {
    expect(permissionCatalog["review.participant_availability.waive"]).toEqual({
      scopes: ["team", "review"],
      eventWide: true,
    });

    const now = Date.UTC(2027, 7, 8, 7, 30, 0);
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, now);
    const empty = await backend.run((ctx) =>
      readReviewParticipantAvailability(ctx, {
        eventId: fixture.eventId,
        teamId: fixture.teamId,
      }),
    );
    expect(empty).toEqual({ activeCount: 2, availableCount: 0 });

    await backend.run(async (ctx) => {
      await moveAttendanceTeamAvailability(ctx, {
        eventId: fixture.eventId,
        membershipId: fixture.leadMembershipId,
        previousState: "not_arrived",
        nextState: "inside",
        now: now + 1,
      });
      await moveAttendanceTeamAvailability(ctx, {
        eventId: fixture.eventId,
        membershipId: fixture.memberMembershipId,
        previousState: "not_arrived",
        nextState: "temporarily_out",
        now: now + 1,
      });
    });
    const current = await backend.run((ctx) =>
      readReviewParticipantAvailability(ctx, {
        eventId: fixture.eventId,
        teamId: fixture.teamId,
      }),
    );
    expect(current).toEqual({ activeCount: 2, availableCount: 1 });

    await backend.run(async (ctx) => {
      await moveAttendanceTeamAvailability(ctx, {
        eventId: fixture.eventId,
        membershipId: fixture.memberMembershipId,
        previousState: "temporarily_out",
        nextState: "inside",
        now: now + 2,
      });
      await moveAttendanceTeamAvailability(ctx, {
        eventId: fixture.eventId,
        membershipId: fixture.leadMembershipId,
        previousState: "inside",
        nextState: "temporarily_out",
        now: now + 3,
      });
    });
    const moved = await backend.run(async (ctx) => ({
      availability: await readReviewParticipantAvailability(ctx, {
        eventId: fixture.eventId,
        teamId: fixture.teamId,
      }),
      projection: await ctx.db
        .query("attendanceTeamAvailability")
        .withIndex("by_event_team", (index) =>
          index.eq("eventId", fixture.eventId).eq("teamId", fixture.teamId),
        )
        .unique(),
    }));
    expect(moved.availability).toEqual({ activeCount: 2, availableCount: 1 });
    expect(moved.projection?.version).toBe(4);
  });

  test("keeps arrival separate, advances the full-team milestone, and preserves reversal history", async () => {
    const now = Date.UTC(2027, 7, 8, 8, 0, 0);
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, now);

    const first = await backend.run((ctx) =>
      recordStaffedVenueCheckIn(ctx, {
        eventId: fixture.eventId,
        membershipId: fixture.leadMembershipId,
        stationId: fixture.stationId,
        identityCheckMethod: "vit_id",
        actorPersonId: fixture.operatorPersonId,
        now,
      }),
    );
    expect(first.teamStatusChanged).toBe(false);

    const second = await backend.run((ctx) =>
      recordStaffedVenueCheckIn(ctx, {
        eventId: fixture.eventId,
        membershipId: fixture.memberMembershipId,
        stationId: fixture.stationId,
        identityCheckMethod: "external_photo_id",
        actorPersonId: fixture.operatorPersonId,
        now: now + 1,
      }),
    );
    expect(second.teamStatusChanged).toBe(true);

    const checkedInState = await backend.run(async (ctx) => ({
      team: await ctx.db.get(fixture.teamId),
      first: await ctx.db.get(first.checkInId),
      second: await ctx.db.get(second.checkInId),
      counters: await ctx.db
        .query("venueCheckInCounterShards")
        .withIndex("by_event_shard", (index) => index.eq("eventId", fixture.eventId))
        .collect(),
      presenceEvents: await ctx.db.query("attendancePresenceEvents").collect(),
      venueStates: await ctx.db.query("attendanceVenueStates").collect(),
      sessionParticipants: await ctx.db.query("attendanceSessionParticipants").collect(),
    }));
    expect(checkedInState.team?.status).toBe("checked_in");
    expect(checkedInState.first).toMatchObject({
      status: "checked_in",
      identityCheckMethod: "vit_id",
      credentialId: fixture.vitCredentialId,
      credentialKind: "vit_id_barcode",
      credentialVersion: 3,
    });
    expect(checkedInState.second).toMatchObject({
      status: "checked_in",
      identityCheckMethod: "external_photo_id",
      credentialId: fixture.badgeCredentialId,
      credentialKind: "badge_qr",
      credentialVersion: 2,
      badgeReference: "EXT-7B2Q",
    });
    expect(checkedInState.counters.reduce((total, shard) => total + shard.checkedIn, 0)).toBe(2);
    expect(checkedInState.presenceEvents).toHaveLength(0);
    expect(checkedInState.venueStates).toHaveLength(0);
    expect(checkedInState.sessionParticipants).toHaveLength(0);

    await expect(
      backend.run((ctx) =>
        recordStaffedVenueCheckIn(ctx, {
          eventId: fixture.eventId,
          membershipId: fixture.leadMembershipId,
          stationId: fixture.stationId,
          identityCheckMethod: "vit_id",
          actorPersonId: fixture.operatorPersonId,
          now: now + 2,
        }),
      ),
    ).rejects.toThrow("already checked in");

    const reversed = await backend.run((ctx) =>
      reverseStaffedVenueCheckIn(ctx, {
        eventId: fixture.eventId,
        checkInId: first.checkInId,
        expectedVersion: first.version,
        actorPersonId: fixture.operatorPersonId,
        reason: "Wrong participant was selected at the desk",
        now: now + 3,
      }),
    );
    expect(reversed.teamStatusChanged).toBe(true);

    const replacement = await backend.run((ctx) =>
      recordStaffedVenueCheckIn(ctx, {
        eventId: fixture.eventId,
        membershipId: fixture.leadMembershipId,
        stationId: fixture.stationId,
        identityCheckMethod: "approved_exception",
        checkInReason: "Board approved identity recovery at the desk",
        actorPersonId: fixture.operatorPersonId,
        now: now + 4,
      }),
    );
    expect(replacement.teamStatusChanged).toBe(true);

    const finalState = await backend.run(async (ctx) => ({
      team: await ctx.db.get(fixture.teamId),
      history: await ctx.db
        .query("venueCheckIns")
        .withIndex("by_membership_time", (index) =>
          index.eq("membershipId", fixture.leadMembershipId),
        )
        .collect(),
      counters: await ctx.db
        .query("venueCheckInCounterShards")
        .withIndex("by_event_shard", (index) => index.eq("eventId", fixture.eventId))
        .collect(),
    }));
    expect(finalState.team?.status).toBe("checked_in");
    expect(finalState.history).toHaveLength(2);
    expect(finalState.history.map((checkIn) => checkIn.status).sort()).toEqual([
      "checked_in",
      "reversed",
    ]);
    expect(finalState.counters.reduce((total, shard) => total + shard.checkedIn, 0)).toBe(2);
  });

  test("rejects an identity method that does not match the participant class", async () => {
    const now = Date.UTC(2027, 7, 8, 9, 0, 0);
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, now);

    await expect(
      backend.run((ctx) =>
        recordStaffedVenueCheckIn(ctx, {
          eventId: fixture.eventId,
          membershipId: fixture.leadMembershipId,
          stationId: fixture.stationId,
          identityCheckMethod: "external_photo_id",
          actorPersonId: fixture.operatorPersonId,
          now,
        }),
      ),
    ).rejects.toThrow("does not match");
  });

  test("accepts only a fresh unused staffed-participant resolution", async () => {
    const now = Date.UTC(2027, 7, 8, 10, 0, 0);
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, now);

    const resolutionId = await backend.run((ctx) =>
      createStaffedParticipantResolution(ctx, {
        eventId: fixture.eventId,
        membershipId: fixture.leadMembershipId,
        portalQrTokenId: fixture.portalQrTokenId,
        stationId: fixture.stationId,
        deviceInstallationId: fixture.deviceInstallationId,
        resolvedByPersonId: fixture.operatorPersonId,
        now,
      }),
    );
    const resolution = await backend.run((ctx) =>
      requireAvailableStaffedVenueResolution(ctx, {
        resolutionId,
        eventId: fixture.eventId,
        stationId: fixture.stationId,
        deviceInstallationId: fixture.deviceInstallationId,
        actorPersonId: fixture.operatorPersonId,
        now: now + 1,
      }),
    );
    expect(resolution.portalQrTokenId).toBe(fixture.portalQrTokenId);

    await backend.run((ctx) =>
      ctx.db.patch(resolutionId, {
        venueAction: "record_check_in",
        venueActionAt: now + 2,
      }),
    );
    await expect(
      backend.run((ctx) =>
        requireAvailableStaffedVenueResolution(ctx, {
          resolutionId,
          eventId: fixture.eventId,
          stationId: fixture.stationId,
          deviceInstallationId: fixture.deviceInstallationId,
          actorPersonId: fixture.operatorPersonId,
          now: now + 3,
        }),
      ),
    ).rejects.toThrow("fresh portal QR");

    const expiredResolutionId = await backend.run(async (ctx) => {
      const portalQrTokenId = await ctx.db.insert("attendancePortalQrTokens", {
        eventId: fixture.eventId,
        membershipId: fixture.leadMembershipId,
        portalCredentialId: fixture.portalCredentialId,
        credentialVersion: 1,
        tokenHash: `arrival-expired-token-${now}`,
        state: "used",
        issuedAt: now - 1_000,
        expiresAt: now + 60_000,
        usedAt: now,
      });
      return createStaffedParticipantResolution(ctx, {
        eventId: fixture.eventId,
        membershipId: fixture.leadMembershipId,
        portalQrTokenId,
        stationId: fixture.stationId,
        deviceInstallationId: fixture.deviceInstallationId,
        resolvedByPersonId: fixture.operatorPersonId,
        now,
      });
    });
    await expect(
      backend.run((ctx) =>
        requireAvailableStaffedVenueResolution(ctx, {
          resolutionId: expiredResolutionId,
          eventId: fixture.eventId,
          stationId: fixture.stationId,
          deviceInstallationId: fixture.deviceInstallationId,
          actorPersonId: fixture.operatorPersonId,
          now: now + staffedParticipantResolutionLifetimeMs,
        }),
      ),
    ).rejects.toThrow("expired");
  });

  test("binds credential setup to one claimed resolution without consuming its venue slot", async () => {
    const now = Date.UTC(2027, 7, 8, 11, 0, 0);
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, now);
    const resolutionId = await backend.run(async (ctx) => {
      const portalQrTokenId = await ctx.db.insert("attendancePortalQrTokens", {
        eventId: fixture.eventId,
        membershipId: fixture.leadMembershipId,
        portalCredentialId: fixture.portalCredentialId,
        credentialVersion: 1,
        tokenHash: `credential-resolution-${now}`,
        state: "used",
        issuedAt: now - 1_000,
        expiresAt: now + 60_000,
        usedAt: now,
      });
      return createStaffedParticipantResolution(ctx, {
        eventId: fixture.eventId,
        membershipId: fixture.leadMembershipId,
        portalQrTokenId,
        stationId: fixture.stationId,
        deviceInstallationId: fixture.deviceInstallationId,
        resolvedByPersonId: fixture.operatorPersonId,
        now,
      });
    });

    await backend.run(async (ctx) => {
      const resolution = await requireAvailableStaffedCredentialResolution(ctx, {
        resolutionId,
        eventId: fixture.eventId,
        membershipId: fixture.leadMembershipId,
        stationId: fixture.stationId,
        deviceInstallationId: fixture.deviceInstallationId,
        actorPersonId: fixture.operatorPersonId,
        now: now + 1,
      });
      await claimStaffedCredentialResolution(ctx, {
        resolutionId: resolution._id,
        credentialAction: "begin_vit_rebind",
        attendanceCredentialId: fixture.vitCredentialId,
        now: now + 1,
      });
    });
    const claimed = await backend.run((ctx) =>
      requireClaimedStaffedCredentialResolution(ctx, {
        resolutionId,
        eventId: fixture.eventId,
        membershipId: fixture.leadMembershipId,
        stationId: fixture.stationId,
        deviceInstallationId: fixture.deviceInstallationId,
        actorPersonId: fixture.operatorPersonId,
        credentialAction: "begin_vit_rebind",
        attendanceCredentialId: fixture.vitCredentialId,
      }),
    );
    expect(claimed.venueAction).toBeUndefined();

    await expect(
      backend.run((ctx) =>
        requireAvailableStaffedCredentialResolution(ctx, {
          resolutionId,
          eventId: fixture.eventId,
          membershipId: fixture.leadMembershipId,
          stationId: fixture.stationId,
          deviceInstallationId: fixture.deviceInstallationId,
          actorPersonId: fixture.operatorPersonId,
          now: now + 2,
        }),
      ),
    ).rejects.toThrow("fresh portal QR");
    await expect(
      backend.run((ctx) =>
        requireClaimedStaffedCredentialResolution(ctx, {
          resolutionId,
          eventId: fixture.eventId,
          membershipId: fixture.leadMembershipId,
          stationId: fixture.stationId,
          deviceInstallationId: fixture.deviceInstallationId,
          actorPersonId: fixture.operatorPersonId,
          credentialAction: "begin_vit_rebind",
          attendanceCredentialId: fixture.badgeCredentialId,
        }),
      ),
    ).rejects.toThrow("Restart credential setup");
  });
});

async function seedFixture(backend: BackendTest, now: number) {
  return backend.run(async (ctx) => {
    const operatorPersonId = await insertPerson(ctx, now, "operator");
    const eventId = await ctx.db.insert("events", {
      slug: `venue-check-in-${now}`,
      name: "Venue check-in fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      startsAt: now - 60 * 60_000,
      endsAt: now + 60 * 60_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const planVersionId = await ctx.db.insert("attendancePlanVersions", {
      eventId,
      version: 1,
      name: "Live attendance",
      vitBarcodeSymbologies: ["code128"],
      vitBarcodeNormalizationVersion: "trim-v1",
      offlineQueueMaxScans: 8,
      offlineQueueMaxAgeSeconds: 180,
      status: "published",
      checksum: "venue-check-in-plan",
      createdByPersonId: operatorPersonId,
      createdAt: now - 10_000,
      publishedAt: now - 9_000,
    });
    await ctx.db.patch(eventId, { publishedAttendancePlanVersionId: planVersionId });
    const zoneId = await ctx.db.insert("attendanceZones", {
      eventId,
      planVersionId,
      stableKey: "arrival",
      name: "Arrival hall",
      createdAt: now - 8_000,
    });
    const deviceInstallationId = await ctx.db.insert("attendanceDeviceInstallations", {
      eventId,
      installationId: `arrival-phone-${now}`,
      secretHash: `arrival-secret-${now}`,
      name: "Arrival phone",
      platform: "android",
      status: "active",
      registeredByPersonId: operatorPersonId,
      registeredAt: now - 8_000,
      pendingReplayCount: 0,
    });
    const stationId = await ctx.db.insert("attendanceStations", {
      eventId,
      planVersionId,
      zoneId,
      stableKey: "arrival_desk_1",
      name: "Arrival desk 1",
      mode: "venue_entry",
      allowedCredentialKinds: ["vit_id_barcode", "badge_qr", "portal_qr"],
      status: "active",
      deviceInstallationId,
      configurationVersion: 1,
      createdAt: now - 7_000,
      updatedAt: now - 7_000,
    });
    const lead = await insertMembership(ctx, eventId, now, "lead", "vit_student");
    const member = await insertMembership(
      ctx,
      eventId,
      now,
      "member",
      "external_participant",
    );
    const teamId = await ctx.db.insert("teams", {
      eventId,
      name: "Arrival team",
      publicCode: `ARRIVAL-${now}`,
      leadMembershipId: lead.membershipId,
      status: "confirmed",
      activeMemberCount: 2,
      activeVitMemberCount: 1,
      activeExternalMemberCount: 1,
      membershipLocked: true,
      trackLocked: true,
      version: 4,
      createdAt: now - 20_000,
      updatedAt: now - 6_000,
    });
    await ctx.db.insert("teamMembers", {
      eventId,
      teamId,
      membershipId: lead.membershipId,
      role: "lead",
      status: "active",
      joinedAt: now - 19_000,
      source: "created",
    });
    await ctx.db.insert("teamMembers", {
      eventId,
      teamId,
      membershipId: member.membershipId,
      role: "member",
      status: "active",
      joinedAt: now - 18_000,
      source: "code",
    });
    await initializeAttendanceTeamAvailability(ctx, {
      eventId,
      teamId,
      activeMemberCount: 2,
      now: now - 17_000,
    });
    const vitCredentialId = await ctx.db.insert("attendanceCredentials", {
      eventId,
      membershipId: lead.membershipId,
      kind: "vit_id_barcode",
      lookupHash: `vit-${now}`,
      barcodeSymbology: "code128",
      normalizationVersion: "trim-v1",
      version: 3,
      state: "active",
      enrolledByPersonId: operatorPersonId,
      enrolledAt: now - 5_000,
      verifiedAt: now - 4_000,
    });
    const badgeCredentialId = await ctx.db.insert("attendanceCredentials", {
      eventId,
      membershipId: member.membershipId,
      kind: "badge_qr",
      lookupHash: `badge-${now}`,
      badgeReference: "EXT-7B2Q",
      version: 2,
      state: "active",
      enrolledByPersonId: operatorPersonId,
      enrolledAt: now - 3_000,
      verifiedAt: now - 2_000,
    });
    const portalCredentialId = await ctx.db.insert("attendancePortalCredentials", {
      eventId,
      membershipId: lead.membershipId,
      version: 1,
      state: "active",
      updatedAt: now - 1_500,
    });
    const portalQrTokenId = await ctx.db.insert("attendancePortalQrTokens", {
      eventId,
      membershipId: lead.membershipId,
      portalCredentialId,
      credentialVersion: 1,
      tokenHash: `arrival-token-${now}`,
      state: "used",
      issuedAt: now - 1_000,
      expiresAt: now + 60_000,
      usedAt: now,
    });
    return {
      eventId,
      stationId,
      deviceInstallationId,
      teamId,
      operatorPersonId,
      leadMembershipId: lead.membershipId,
      memberMembershipId: member.membershipId,
      vitCredentialId,
      badgeCredentialId,
      portalCredentialId,
      portalQrTokenId,
    } satisfies {
      eventId: Id<"events">;
      stationId: Id<"attendanceStations">;
      deviceInstallationId: Id<"attendanceDeviceInstallations">;
      teamId: Id<"teams">;
      operatorPersonId: Id<"people">;
      leadMembershipId: Id<"eventMemberships">;
      memberMembershipId: Id<"eventMemberships">;
      vitCredentialId: Id<"attendanceCredentials">;
      badgeCredentialId: Id<"attendanceCredentials">;
      portalCredentialId: Id<"attendancePortalCredentials">;
      portalQrTokenId: Id<"attendancePortalQrTokens">;
    };
  });
}

async function insertPerson(
  ctx: Parameters<Parameters<BackendTest["run"]>[0]>[0],
  now: number,
  suffix: string,
) {
  return ctx.db.insert("people", {
    authUserId: `venue-${suffix}-${now}`,
    googleSubject: `venue-${suffix}-subject-${now}`,
    verifiedEmail: `venue-${suffix}-${now}@example.test`,
    displayName: `Venue ${suffix}`,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
}

async function insertMembership(
  ctx: Parameters<Parameters<BackendTest["run"]>[0]>[0],
  eventId: Id<"events">,
  now: number,
  suffix: string,
  participantClass: "vit_student" | "external_participant",
) {
  const personId = await insertPerson(ctx, now, suffix);
  const subjectId = await ctx.db.insert("eventAccessSubjects", {
    eventId,
    personId,
    emailNormalized: `venue-${suffix}-${now}@example.test`,
    displayName: `Venue ${suffix}`,
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
    participantClass,
    eligibilityStatus: "eligible",
    onboardingStatus: "accepted",
    acceptedParticipantPolicyVersionIds: [],
    createdAt: now,
    updatedAt: now,
  });
  return { personId, membershipId };
}
