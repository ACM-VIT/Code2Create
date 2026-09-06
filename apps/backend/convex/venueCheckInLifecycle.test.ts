import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "./_generated/dataModel.js";
import {
  recordStaffedVenueCheckIn,
  reverseStaffedVenueCheckIn,
} from "./lib/venueCheckInLifecycle.ts";
import { requireStaffedVenueIdentityEvidence } from "./attendanceVenueCheckIns.ts";
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

  test.each(["submitted", "selected", "offer_pending"] as const)(
    "rejects staffed check-in for %s participants even with an identity exception",
    async (onboardingStatus) => {
      const now = Date.UTC(2027, 7, 8, 9, 0, 0);
      const backend = convexTest(schema, modules);
      const fixture = await seedFixture(backend, now);

      for (const { membershipId, identityCheckMethod } of [
        { membershipId: fixture.leadMembershipId, identityCheckMethod: "vit_id" },
        { membershipId: fixture.memberMembershipId, identityCheckMethod: "external_photo_id" },
      ] as const) {
        await backend.run((ctx) => ctx.db.patch(membershipId, { onboardingStatus }));
        for (const method of [identityCheckMethod, "approved_exception"] as const) {
          await expect(
            backend.run((ctx) =>
              recordStaffedVenueCheckIn(ctx, {
                eventId: fixture.eventId,
                membershipId,
                stationId: fixture.stationId,
                identityCheckMethod: method,
                ...(method === "approved_exception"
                  ? { checkInReason: "Staff verified identity using the approved fallback." }
                  : {}),
                actorPersonId: fixture.operatorPersonId,
                now,
              }),
            ),
          ).rejects.toThrow("Only a participant on a confirmed team can check in");
        }
      }

      const arrival = await backend.run(async (ctx) => ({
        checkIn: await ctx.db.query("venueCheckIns").first(),
        counter: await ctx.db.query("venueCheckInCounterShards").first(),
        team: await ctx.db.get(fixture.teamId),
      }));
      expect(arrival.checkIn).toBeNull();
      expect(arrival.counter).toBeNull();
      expect(arrival.team?.status).toBe("confirmed");
    },
  );

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
        resolutionMethod: "vit_id_barcode",
        barcodeLookupHash: `resolved-vit-${now}`,
        barcodeSymbology: "code128",
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
    expect(resolution.resolutionMethod).toBe("vit_id_barcode");

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
    ).rejects.toThrow("Resolve the participant again");

    const expiredResolutionId = await backend.run((ctx) =>
      createStaffedParticipantResolution(ctx, {
        eventId: fixture.eventId,
        membershipId: fixture.leadMembershipId,
        resolutionMethod: "manual_lookup",
        stationId: fixture.stationId,
        deviceInstallationId: fixture.deviceInstallationId,
        resolvedByPersonId: fixture.operatorPersonId,
        now,
      }),
    );
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
    const resolutionId = await backend.run((ctx) =>
      createStaffedParticipantResolution(ctx, {
        eventId: fixture.eventId,
        membershipId: fixture.leadMembershipId,
        resolutionMethod: "manual_lookup",
        stationId: fixture.stationId,
        deviceInstallationId: fixture.deviceInstallationId,
        resolvedByPersonId: fixture.operatorPersonId,
        now,
      }),
    );

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
    ).rejects.toThrow("Resolve the participant again");
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
    ).rejects.toThrow("restarting credential setup");
  });

  test("requires completed class-ID evidence before first check-in", async () => {
    const now = Date.UTC(2027, 7, 8, 12, 0, 0);
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, now);
    const vitResolutionId = await backend.run((ctx) =>
      createStaffedParticipantResolution(ctx, {
        eventId: fixture.eventId,
        membershipId: fixture.leadMembershipId,
        resolutionMethod: "vit_id_barcode",
        barcodeLookupHash: `different-vit-${now}`,
        barcodeSymbology: "code128",
        stationId: fixture.stationId,
        deviceInstallationId: fixture.deviceInstallationId,
        resolvedByPersonId: fixture.operatorPersonId,
        now,
      }),
    );

    await expect(
      backend.run(async (ctx) => {
        const membership = await ctx.db.get(fixture.leadMembershipId);
        const resolution = await ctx.db.get(vitResolutionId);
        if (!membership || !resolution) throw new Error("VIT evidence fixture is incomplete.");
        await requireStaffedVenueIdentityEvidence(ctx, {
          eventId: fixture.eventId,
          membership,
          resolution,
          identityCheckKind: "class_id",
        });
      }),
    ).rejects.toThrow("Link or replace this VIT ID");

    await backend.run(async (ctx) => {
      await ctx.db.patch(vitResolutionId, { barcodeLookupHash: `vit-${now}` });
      const membership = await ctx.db.get(fixture.leadMembershipId);
      const resolution = await ctx.db.get(vitResolutionId);
      if (!membership || !resolution) throw new Error("VIT evidence fixture is incomplete.");
      await requireStaffedVenueIdentityEvidence(ctx, {
        eventId: fixture.eventId,
        membership,
        resolution,
        identityCheckKind: "class_id",
      });
    });

    const externalResolutionId = await backend.run((ctx) =>
      createStaffedParticipantResolution(ctx, {
        eventId: fixture.eventId,
        membershipId: fixture.memberMembershipId,
        resolutionMethod: "external_pass",
        stationId: fixture.stationId,
        deviceInstallationId: fixture.deviceInstallationId,
        resolvedByPersonId: fixture.operatorPersonId,
        now,
      }),
    );

    await expect(
      backend.run(async (ctx) => {
        const membership = await ctx.db.get(fixture.memberMembershipId);
        const resolution = await ctx.db.get(externalResolutionId);
        if (!membership || !resolution) throw new Error("External evidence fixture is incomplete.");
        await requireStaffedVenueIdentityEvidence(ctx, {
          eventId: fixture.eventId,
          membership,
          resolution,
          identityCheckKind: "class_id",
        });
      }),
    ).rejects.toThrow("link its barcode first");

    await backend.run(async (ctx) => {
      await ctx.db.insert("attendanceExternalIdentityBindings", {
        eventId: fixture.eventId,
        membershipId: fixture.memberMembershipId,
        lookupHash: `external-id-${now}`,
        barcodeSymbology: "code128",
        version: 1,
        state: "active",
        linkedByPersonId: fixture.operatorPersonId,
        linkedAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(externalResolutionId, {
        credentialAction: "link_external_id",
        credentialActionAt: now,
      });
      const membership = await ctx.db.get(fixture.memberMembershipId);
      const resolution = await ctx.db.get(externalResolutionId);
      if (!membership || !resolution) throw new Error("External evidence fixture is incomplete.");
      await requireStaffedVenueIdentityEvidence(ctx, {
        eventId: fixture.eventId,
        membership,
        resolution,
        identityCheckKind: "class_id",
      });
    });
  });
  test("a linked external card can prove identity again without repeating enrollment", async () => {
    const now = Date.now();
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, now);
    await backend.run(async (ctx) => {
      const resolutionId = await createStaffedParticipantResolution(ctx, {
        eventId: fixture.eventId,
        membershipId: fixture.memberMembershipId,
        resolutionMethod: "external_id_barcode",
        stationId: fixture.stationId,
        deviceInstallationId: fixture.deviceInstallationId,
        resolvedByPersonId: fixture.operatorPersonId,
        now,
      });
      const bindingId = await ctx.db.insert(
        "attendanceExternalIdentityBindings",
        {
          eventId: fixture.eventId,
          membershipId: fixture.memberMembershipId,
          lookupHash: "external-card-hmac",
          barcodeSymbology: "code128",
          version: 1,
          state: "active",
          linkedByPersonId: fixture.operatorPersonId,
          linkedAt: now,
          updatedAt: now,
        },
      );
      const resolution = await ctx.db.get(resolutionId);
      const membership = await ctx.db.get(fixture.memberMembershipId);
      if (!resolution || !membership)
        throw new Error("Missing fixture identity");
      await requireStaffedVenueIdentityEvidence(ctx, {
        eventId: fixture.eventId,
        membership,
        resolution,
        identityCheckKind: "class_id",
      });
      await ctx.db.patch(bindingId, { state: "suspended" });
      await expect(
        requireStaffedVenueIdentityEvidence(ctx, {
          eventId: fixture.eventId,
          membership,
          resolution,
          identityCheckKind: "class_id",
        }),
      ).rejects.toThrow("not actively linked");
    });
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
      applicationsCloseAt: Date.now() + 86_400_000,
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
      allowedCredentialKinds: ["vit_id_barcode", "badge_qr", "external_pass"],
      status: "active",
      deviceInstallationId,
      configurationVersion: 1,
      createdAt: now - 7_000,
      updatedAt: now - 7_000,
    });
    const lead = await insertMembership(ctx, eventId, now, "lead", "vit_student");
    const member = await insertMembership(ctx, eventId, now, "member", "external_participant");
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
