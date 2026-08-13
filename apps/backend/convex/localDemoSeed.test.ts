import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import aggregateTest from "@convex-dev/aggregate/test";
import { convexTest } from "convex-test";
import { afterAll, beforeAll, expect, test } from "vitest";

import { api, components, internal } from "./_generated/api";
import { revokeSourceGrants } from "./lib/permissions.ts";
import { readReviewParticipantAvailability } from "./lib/reviewParticipantAvailability.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);

const originalEnvironment = {
  LOCAL_DEVELOPMENT_SEED_ENABLED: process.env.LOCAL_DEVELOPMENT_SEED_ENABLED,
  CONVEX_CLOUD_URL: process.env.CONVEX_CLOUD_URL,
  CONVEX_SITE_URL: process.env.CONVEX_SITE_URL,
  AUTH_SITE_URL: process.env.AUTH_SITE_URL,
  PARTICIPANT_SITE_URL: process.env.PARTICIPANT_SITE_URL,
  OPERATIONS_SITE_URL: process.env.OPERATIONS_SITE_URL,
  HANDBOOK_SITE_URL: process.env.HANDBOOK_SITE_URL,
};

beforeAll(() => {
  process.env.LOCAL_DEVELOPMENT_SEED_ENABLED = "true";
  process.env.CONVEX_CLOUD_URL = "http://127.0.0.1:3210";
  process.env.CONVEX_SITE_URL = "http://127.0.0.1:3211";
  process.env.AUTH_SITE_URL = "http://localhost:3211";
  process.env.PARTICIPANT_SITE_URL = "http://localhost:5173";
  process.env.OPERATIONS_SITE_URL = "http://localhost:5174";
  process.env.HANDBOOK_SITE_URL = "http://localhost:5175";
});

afterAll(() => {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

// The seed exceeds Vitest’s default five-second timeout.
const seedTestTimeoutMs = 120_000;

function seededBackend() {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  aggregateTest.register(backend, "reviewQueue");
  return backend;
}

async function seedBoth(backend: ReturnType<typeof seededBackend>) {
  await backend.mutation(api.localDevelopment.seedEvent, {
    confirmation: "seed-code2create-local",
  });
  return backend.action(api.localDemoSeed.seedDemoState, {
    confirmation: "seed-code2create-demo",
  });
}

test("the demo seed materialises a live event with teams across every queue state", async () => {
  const backend = seededBackend();
  const result = await seedBoth(backend);

  expect(result.teams).toBeGreaterThan(0);
  expect(result.reviewSessions).toBeGreaterThan(0);

  await backend.run(async (ctx) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (index) => index.eq("slug", "code2create-7"))
      .unique();
    if (!event) throw new Error("The seeded event is missing.");
    expect(event.status).toBe("live");
    expect(event.startsAt).toBeLessThan(Date.now());
    expect(event.endsAt).toBeGreaterThan(Date.now());

    const teams = await ctx.db
      .query("teams")
      .withIndex("by_event_status", (index) => index.eq("eventId", event._id))
      .collect();
    const confirmed = teams.filter((team) => team.status === "confirmed");
    expect(confirmed.length).toBe(result.teams);

    for (const team of confirmed) {
      const availability = await readReviewParticipantAvailability(ctx, {
        eventId: event._id,
        teamId: team._id,
      });
      expect(availability.activeCount).toBeGreaterThan(0);
    }

    const states = await ctx.db.query("teamRoundStates").collect();
    expect(new Set(states.map((state) => state.state))).toEqual(
      new Set(["queued", "called", "in_review", "completed", "held"]),
    );

    const stations = await ctx.db
      .query("attendanceStations")
      .withIndex("by_event_status", (index) => index.eq("eventId", event._id))
      .collect();
    const stationFactIds = (await ctx.db
      .query("operationsAutonomyReadFacts")
      .withIndex("by_event_source_sequence_entity", (index) =>
        index.eq("eventId", event._id).eq("source", "attendance_operations"),
      )
      .collect())
      .flatMap((fact) =>
        fact.source === "attendance_operations" && fact.value.kind === "station"
          ? [fact.value.stationId]
          : [],
      );
    expect(new Set(stationFactIds)).toEqual(
      new Set(stations.map((station) => station._id)),
    );
  });
}, seedTestTimeoutMs);

test("teams are in the hall, and exactly one is held below the round minimum", async () => {
  const backend = seededBackend();
  await seedBoth(backend);

  await backend.run(async (ctx) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (index) => index.eq("slug", "code2create-7"))
      .unique();
    if (!event) throw new Error("The seeded event is missing.");

    const availability = await ctx.db
      .query("attendanceTeamAvailability")
      .withIndex("by_event_team", (index) => index.eq("eventId", event._id))
      .collect();
    expect(availability.length).toBeGreaterThan(0);

    const arrived = availability.filter((row) => row.insideMemberCount > 0);
    const absent = availability.filter((row) => row.insideMemberCount === 0);
    expect(absent.length).toBeGreaterThan(0);

    const shortHanded = arrived.filter(
      (row) => row.insideMemberCount < row.activeMemberCount,
    );
    expect(shortHanded.length).toBe(1);
    expect(shortHanded[0]?.insideMemberCount).toBe(1);

    for (const row of arrived) {
      if (row === shortHanded[0]) continue;
      expect(row.insideMemberCount).toBe(row.activeMemberCount);
    }
  });
}, seedTestTimeoutMs);

test("running the demo seed twice changes nothing", async () => {
  const backend = seededBackend();
  await seedBoth(backend);

  const countRows = () =>
    backend.run(async (ctx) => ({
      people: (await ctx.db.query("people").collect()).length,
      teams: (await ctx.db.query("teams").collect()).length,
      roundStates: (await ctx.db.query("teamRoundStates").collect()).length,
      sessions: (await ctx.db.query("reviewSessions").collect()).length,
      scorecards: (await ctx.db.query("scorecards").collect()).length,
      grants: (await ctx.db.query("permissionGrants").collect()).length,
    }));

  const before = await countRows();
  await backend.action(api.localDemoSeed.seedDemoState, {
    confirmation: "seed-code2create-demo",
  });

  expect(await countRows()).toEqual(before);
}, seedTestTimeoutMs);

test("applications sit across the stages the admissions workspace groups by", async () => {
  const backend = seededBackend();
  await seedBoth(backend);

  await backend.run(async (ctx) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (index) => index.eq("slug", "code2create-7"))
      .unique();
    if (!event) throw new Error("The seeded event is missing.");

    const applications = await ctx.db
      .query("applications")
      .withIndex("by_event_state_submitted", (index) => index.eq("eventId", event._id))
      .collect();
    const states = new Set(applications.map((application) => application.state));

    for (const state of ["submitted", "under_review", "accepted", "declined", "confirmed"]) {
      expect(states).toContain(state);
    }

    const undecided = applications.filter(
      (application) => application.state === "submitted" || application.state === "under_review",
    );
    expect(undecided.length).toBeGreaterThan(0);
    for (const application of undecided) {
      expect(application.humanDecision).toBeUndefined();
      expect(application.decidedAt).toBeUndefined();
    }
  });
}, seedTestTimeoutMs);

test("demo maintenance helpers mutate only the seed-owned round and published plan", async () => {
  const backend = seededBackend();
  await seedBoth(backend);
  const fixture = await backend.run(async (ctx) => {
    const demoEvent = await ctx.db
      .query("events")
      .withIndex("by_slug", (index) => index.eq("slug", "code2create-7"))
      .unique();
    if (!demoEvent) throw new Error("The seeded event is missing.");
    const demoRound = await ctx.db
      .query("reviewRounds")
      .withIndex("by_event_key", (index) =>
        index.eq("eventId", demoEvent._id).eq("stableKey", "demo_final"),
      )
      .unique();
    const demoPlan = demoEvent.publishedAttendancePlanVersionId
      ? await ctx.db.get(demoEvent.publishedAttendancePlanVersionId)
      : null;
    if (!demoRound || !demoPlan) throw new Error("The demo fixtures are incomplete.");
    const demoPanel = await ctx.db
      .query("reviewPanels")
      .withIndex("by_round_status", (index) => index.eq("roundId", demoRound._id))
      .first();
    if (!demoPanel) throw new Error("The demo round has no panel.");
    const demoPanelMember = await ctx.db
      .query("reviewPanelMembers")
      .withIndex("by_panel_status", (index) =>
        index.eq("panelId", demoPanel._id).eq("status", "active"),
      )
      .first();
    if (!demoPanelMember) throw new Error("The demo panel has no active member.");
    const localOperator = await ctx.db
      .query("people")
      .withIndex("by_verified_email", (index) =>
        index.eq("verifiedEmail", "supreme@example.test"),
      )
      .unique();
    if (!localOperator) {
      await ctx.db.insert("people", {
        authUserId: `local-operator-${crypto.randomUUID()}`,
        googleSubject: `local-operator-${crypto.randomUUID()}`,
        verifiedEmail: "supreme@example.test",
        displayName: "Local Supreme",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    const decoyRoundEndsAt = demoRound.endsAt + 10_000_000;
    const decoyRoundId = await ctx.db.insert("reviewRounds", {
      eventId: demoEvent._id,
      rubricVersionId: demoRound.rubricVersionId,
      stableKey: "same_event_decoy",
      name: "Same-event decoy round",
      sequence: 99,
      status: demoRound.status,
      startsAt: demoRound.startsAt + 10_000_000,
      endsAt: decoyRoundEndsAt,
      clockInOpensAt: demoRound.clockInOpensAt + 10_000_000,
      reviewerReportAt: demoRound.reviewerReportAt + 10_000_000,
      noShowGraceSeconds: demoRound.noShowGraceSeconds,
      correctionRequestsCloseAt: demoRound.correctionRequestsCloseAt + 10_000_000,
      reviewDurationSeconds: demoRound.reviewDurationSeconds,
      ordinaryExtensionSeconds: demoRound.ordinaryExtensionSeconds,
      maximumOrdinaryExtensions: demoRound.maximumOrdinaryExtensions,
      missedCallGraceSeconds: demoRound.missedCallGraceSeconds,
      requiredCallAttempts: demoRound.requiredCallAttempts,
      substituteResponseSeconds: demoRound.substituteResponseSeconds,
      missedReentryPolicy: demoRound.missedReentryPolicy,
      requiredPanelSize: demoRound.requiredPanelSize,
      minimumScorersPerCriterion: demoRound.minimumScorersPerCriterion,
      minimumPresentParticipants: demoRound.minimumPresentParticipants,
      requiresSharedCommitments: demoRound.requiresSharedCommitments,
      minimumReviewerBuild: demoRound.minimumReviewerBuild,
      requiresCamera: demoRound.requiresCamera,
      requiresNotifications: demoRound.requiresNotifications,
      version: 7,
      configurationChecksum: "same-event-decoy-round",
      createdByPersonId: demoRound.createdByPersonId,
      createdAt: demoRound.createdAt + 10_000_000,
    });
    const decoyPanelId = await ctx.db.insert("reviewPanels", {
      eventId: demoEvent._id,
      roundId: decoyRoundId,
      stableKey: "same_event_decoy_panel",
      name: "Same-event decoy panel",
      coordinatorPersonId: demoPanel.coordinatorPersonId,
      status: "ready",
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const decoyPanelMemberId = await ctx.db.insert("reviewPanelMembers", {
      eventId: demoEvent._id,
      roundId: decoyRoundId,
      panelId: decoyPanelId,
      personId: demoPanelMember.personId,
      eventAccessSubjectId: demoPanelMember.eventAccessSubjectId,
      assignedCriterionIds: demoPanelMember.assignedCriterionIds,
      isCoordinator: true,
      status: "active",
      assignedAt: Date.now(),
    });

    await ctx.db.patch(demoPlan._id, {
      vitBarcodeSymbologies: ["qr"],
      checksum: "published-plan-before-reset",
    });
    const draftPlanId = await ctx.db.insert("attendancePlanVersions", {
      eventId: demoEvent._id,
      version: demoPlan.version + 1,
      name: "Newer draft plan",
      vitBarcodeSymbologies: ["qr"],
      vitBarcodeNormalizationVersion: "trim-v1",
      offlineQueueMaxScans: 1,
      offlineQueueMaxAgeSeconds: 30,
      status: "draft",
      checksum: "newer-draft-plan",
      createdByPersonId: demoPlan.createdByPersonId,
      createdAt: demoPlan.createdAt + 10_000_000,
    });
    const supersededPlanId = await ctx.db.insert("attendancePlanVersions", {
      eventId: demoEvent._id,
      version: demoPlan.version + 2,
      name: "Newest superseded plan",
      vitBarcodeSymbologies: ["qr"],
      vitBarcodeNormalizationVersion: "trim-v1",
      offlineQueueMaxScans: 2,
      offlineQueueMaxAgeSeconds: 60,
      status: "superseded",
      checksum: "newest-superseded-plan",
      createdByPersonId: demoPlan.createdByPersonId,
      createdAt: demoPlan.createdAt + 20_000_000,
      publishedAt: demoPlan.createdAt + 20_000_000,
    });
    return {
      demoRoundId: demoRound._id,
      demoPlanId: demoPlan._id,
      decoyRoundId,
      decoyRoundEndsAt,
      decoyPanelId,
      decoyPanelMemberId,
      draftPlanId,
      supersededPlanId,
    };
  });

  const seated = await backend.mutation(api.localDemoSeed.seatLocalOperatorOnPanel, {
    confirmation: "seat-code2create-local-operator",
  });
  expect(seated.panelName).not.toBe("Same-event decoy panel");
  const seatedRoundIds = await backend.run(async (ctx) => {
    const operator = await ctx.db
      .query("people")
      .withIndex("by_verified_email", (index) =>
        index.eq("verifiedEmail", "supreme@example.test"),
      )
      .unique();
    if (!operator) throw new Error("The local operator is missing.");
    const memberships = await ctx.db
      .query("reviewPanelMembers")
      .withIndex("by_person_status", (index) =>
        index.eq("personId", operator._id).eq("status", "active"),
      )
      .collect();
    return memberships.map((membership) => membership.roundId);
  });
  expect(seatedRoundIds).toContain(fixture.demoRoundId);
  expect(seatedRoundIds).not.toContain(fixture.decoyRoundId);

  const paged = await backend.mutation(api.localDemoSeed.pageLocalOperator, {
    confirmation: "page-code2create-local-operator",
  });
  expect(paged.panelName).not.toBe("Same-event decoy panel");
  await backend.mutation(api.localDemoSeed.reopenDemoRound, {
    confirmation: "reopen-code2create-demo-round",
    hours: 5,
  });
  await backend.mutation(api.localDemoSeed.resetDemoBarcodeSymbologies, {
    confirmation: "reset-code2create-demo-symbologies",
  });

  const state = await backend.run(async (ctx) => ({
    demoRound: await ctx.db.get(fixture.demoRoundId),
    demoPlan: await ctx.db.get(fixture.demoPlanId),
    decoyRound: await ctx.db.get(fixture.decoyRoundId),
    decoyPanelMember: await ctx.db.get(fixture.decoyPanelMemberId),
    decoyPageChains: await ctx.db
      .query("reviewerPageChains")
      .withIndex("by_panel_state", (index) => index.eq("panelId", fixture.decoyPanelId))
      .collect(),
    draftPlan: await ctx.db.get(fixture.draftPlanId),
    supersededPlan: await ctx.db.get(fixture.supersededPlanId),
  }));
  expect(state.demoRound?.endsAt).toBeGreaterThan(Date.now() + 4 * 60 * 60 * 1_000);
  expect(state.demoPlan?.vitBarcodeSymbologies).toEqual(["code128"]);
  expect(state.decoyRound).toMatchObject({
    name: "Same-event decoy round",
    endsAt: fixture.decoyRoundEndsAt,
    sequence: 99,
    version: 7,
  });
  expect(state.decoyPanelMember?.status).toBe("active");
  expect(state.decoyPageChains).toEqual([]);
  expect(state.draftPlan).toMatchObject({
    name: "Newer draft plan",
    status: "draft",
    vitBarcodeSymbologies: ["qr"],
    checksum: "newer-draft-plan",
  });
  expect(state.supersededPlan).toMatchObject({
    name: "Newest superseded plan",
    status: "superseded",
    vitBarcodeSymbologies: ["qr"],
    checksum: "newest-superseded-plan",
  });
}, seedTestTimeoutMs);

test("live-review setup is deterministic, complete, idempotent, and ignores same-event decoys", async () => {
  const backend = seededBackend();
  await seedBoth(backend);
  await backend.mutation(internal.localDevelopment.ensureSupremeAccess, {
    authUserId: "local-live-review-auth-user",
    googleSubject: "local-live-review-google-subject",
    verifiedEmail: "supreme@example.test",
    displayName: "Local Supreme",
  });
  const fixture = await backend.run(async (ctx) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (index) => index.eq("slug", "code2create-7"))
      .unique();
    if (!event) throw new Error("The seeded event is missing.");
    const localOperator = await ctx.db
      .query("people")
      .withIndex("by_verified_email", (index) =>
        index.eq("verifiedEmail", "supreme@example.test"),
      )
      .unique();
    const localOperatorId = localOperator?._id ?? await ctx.db.insert("people", {
        authUserId: `local-live-operator-${crypto.randomUUID()}`,
        googleSubject: `local-live-operator-${crypto.randomUUID()}`,
        verifiedEmail: "supreme@example.test",
        displayName: "Local Supreme",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    const localOperatorSubject = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", localOperatorId),
      )
      .unique();
    if (!localOperatorSubject) throw new Error("The local operator event account is missing.");
    const reviewerDeviceGrant = await ctx.db
      .query("permissionGrants")
      .withIndex("by_subject_permission_status_scope", (index) =>
        index
          .eq("eventAccessSubjectId", localOperatorSubject._id)
          .eq("permissionKey", "reviewer.device.register")
          .eq("status", "active")
          .eq("scopeType", "self")
          .eq("scopeId", localOperatorSubject._id),
      )
      .unique();
    if (!reviewerDeviceGrant) {
      throw new Error("The local operator cannot register a reviewer phone.");
    }
    const device = await ctx.db
      .query("reviewerDevices")
      .withIndex("by_event_person_status", (index) =>
        index
          .eq("eventId", event._id)
          .eq("personId", localOperatorId)
          .eq("status", "active"),
      )
      .unique();
    if (!device) {
      await ctx.db.insert("reviewerDevices", {
        eventId: event._id,
        personId: localOperatorId,
        installationId: "local-live-review-test-phone",
        name: "Local live-review test phone",
        platform: "android",
        appBuild: 40,
        cameraReady: true,
        encryptedDraftReady: true,
        pushTokenStatus: "not_registered",
        pushTokenUpdatedAt: Date.now(),
        status: "active",
        version: 1,
        registeredAt: Date.now(),
        lastSeenAt: Date.now(),
      });
    }
    const round = await ctx.db
      .query("reviewRounds")
      .withIndex("by_event_key", (index) =>
        index.eq("eventId", event._id).eq("stableKey", "demo_final"),
      )
      .unique();
    if (!round) throw new Error("The demo round is missing.");
    const targetPanel = await ctx.db
      .query("reviewPanels")
      .withIndex("by_round_key", (index) =>
        index.eq("roundId", round._id).eq("stableKey", "panel_d"),
      )
      .unique();
    if (!targetPanel) throw new Error("The live-review fixture panel is missing.");
    const targetMembers = await ctx.db
      .query("reviewPanelMembers")
      .withIndex("by_panel_status", (index) =>
        index.eq("panelId", targetPanel._id).eq("status", "active"),
      )
      .take(round.requiredPanelSize + 1);
    const removedTargetMember = targetMembers.find((member) => !member.isCoordinator);
    if (!removedTargetMember) {
      throw new Error("The live-review fixture panel has no removable seed member.");
    }
    await ctx.db.patch(removedTargetMember._id, {
      status: "removed",
      endedAt: Date.now(),
    });
    await revokeSourceGrants(ctx, {
      eventId: event._id,
      sourceType: "panel_assignment",
      sourceId: removedTargetMember._id,
      revokedByPersonId: targetPanel.coordinatorPersonId,
      reason: "Simulate a prior local fixture removing the seed panel member",
    });
    await ctx.db.patch(targetPanel._id, {
      status: "needs_reviewer",
      version: targetPanel.version + 1,
      updatedAt: Date.now(),
    });
    const decoyRoundId = await ctx.db.insert("reviewRounds", {
      eventId: event._id,
      rubricVersionId: round.rubricVersionId,
      stableKey: "same_event_live_decoy",
      name: "Same-event live decoy",
      sequence: 0,
      status: "open",
      startsAt: round.startsAt,
      endsAt: round.endsAt,
      clockInOpensAt: round.clockInOpensAt,
      reviewerReportAt: round.reviewerReportAt,
      noShowGraceSeconds: round.noShowGraceSeconds,
      correctionRequestsCloseAt: round.correctionRequestsCloseAt,
      reviewDurationSeconds: round.reviewDurationSeconds,
      ordinaryExtensionSeconds: round.ordinaryExtensionSeconds,
      maximumOrdinaryExtensions: round.maximumOrdinaryExtensions,
      missedCallGraceSeconds: round.missedCallGraceSeconds,
      requiredCallAttempts: round.requiredCallAttempts,
      substituteResponseSeconds: round.substituteResponseSeconds,
      missedReentryPolicy: round.missedReentryPolicy,
      requiredPanelSize: round.requiredPanelSize,
      minimumScorersPerCriterion: round.minimumScorersPerCriterion,
      minimumPresentParticipants: round.minimumPresentParticipants,
      requiresSharedCommitments: round.requiresSharedCommitments,
      minimumReviewerBuild: round.minimumReviewerBuild,
      requiresCamera: round.requiresCamera,
      requiresNotifications: round.requiresNotifications,
      version: 13,
      configurationChecksum: "same-event-live-decoy",
      createdByPersonId: round.createdByPersonId,
      createdAt: round.createdAt,
      ...(round.publishedAt !== undefined ? { publishedAt: round.publishedAt } : {}),
      ...(round.openedAt !== undefined ? { openedAt: round.openedAt } : {}),
    });
    const decoyPanelId = await ctx.db.insert("reviewPanels", {
      eventId: event._id,
      roundId: decoyRoundId,
      stableKey: "panel_d",
      name: "Decoy Panel D",
      coordinatorPersonId: targetPanel.coordinatorPersonId,
      status: "needs_reviewer",
      version: 9,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return {
      eventId: event._id,
      roundId: round._id,
      targetPanelId: targetPanel._id,
      removedTargetMemberId: removedTargetMember._id,
      decoyRoundId,
      decoyPanelId,
    };
  });

  const first = await backend.mutation(api.localDemoSeed.startLiveReviewForLocalOperator, {
    confirmation: "start-code2create-live-review",
  });
  const second = await backend.mutation(api.localDemoSeed.startLiveReviewForLocalOperator, {
    confirmation: "start-code2create-live-review",
  });
  expect(first).toMatchObject({ panelName: "Panel D", alreadyLive: false });
  expect(second).toEqual({ ...first, alreadyLive: true });

  await backend.run(async (ctx) => {
    const operator = await ctx.db
      .query("people")
      .withIndex("by_verified_email", (index) =>
        index.eq("verifiedEmail", "supreme@example.test"),
      )
      .unique();
    if (!operator) throw new Error("The local operator is missing.");
    const operatorAssignments = await ctx.db
      .query("reviewAssignments")
      .withIndex("by_person_status", (index) =>
        index.eq("reviewerPersonId", operator._id).eq("status", "assigned"),
      )
      .collect();
    const matchingAssignments = operatorAssignments.filter(
      (assignment) => assignment.roundId === fixture.roundId,
    );
    expect(matchingAssignments).toHaveLength(1);
    const operatorAssignment = matchingAssignments[0];
    if (!operatorAssignment) throw new Error("The local operator assignment is missing.");
    expect(operatorAssignment.panelId).toBe(fixture.targetPanelId);
    expect(operatorAssignment.isCoordinator).toBe(false);
    const restoredTargetMember = await ctx.db.get(fixture.removedTargetMemberId);
    expect(restoredTargetMember?.status).toBe("active");
    expect(restoredTargetMember?.endedAt).toBeUndefined();

    const session = await ctx.db.get(operatorAssignment.reviewSessionId);
    if (!session) throw new Error("The live review session is missing.");
    expect(session).toMatchObject({
      eventId: fixture.eventId,
      roundId: fixture.roundId,
      panelId: fixture.targetPanelId,
      status: "active",
      extensionCount: 0,
      extensionSeconds: 0,
      sharedNotesVersion: 0,
      version: 2,
    });
    expect(session.startedAt).toBeGreaterThan(Date.now() - 5 * 60 * 1_000);
    expect(session.startedAt).toBeLessThan(Date.now() - 3 * 60 * 1_000);
    expect(session.plannedEndAt).toBeGreaterThan(Date.now());

    const round = await ctx.db.get(fixture.roundId);
    if (!round) throw new Error("The demo round is missing.");
    const assignments = await ctx.db
      .query("reviewAssignments")
      .withIndex("by_session_person", (index) =>
        index.eq("reviewSessionId", session._id),
      )
      .collect();
    const scorecards = await ctx.db
      .query("scorecards")
      .withIndex("by_session_status", (index) =>
        index.eq("reviewSessionId", session._id).eq("status", "draft"),
      )
      .collect();
    const presences = await ctx.db
      .query("reviewPresence")
      .withIndex("by_session_reviewer", (index) =>
        index.eq("reviewSessionId", session._id),
      )
      .collect();
    const clockIns = await Promise.all(
      assignments.map((assignment) =>
        ctx.db
          .query("reviewerClockIns")
          .withIndex("by_round_person", (index) =>
            index
              .eq("roundId", fixture.roundId)
              .eq("reviewerPersonId", assignment.reviewerPersonId),
          )
          .unique(),
      ),
    );
    expect(assignments).toHaveLength(round.requiredPanelSize);
    expect(scorecards).toHaveLength(round.requiredPanelSize);
    expect(presences).toHaveLength(round.requiredPanelSize);
    expect(new Set(assignments.map((assignment) => assignment.reviewerPersonId)).size)
      .toBe(round.requiredPanelSize);
    expect(clockIns.every((clockIn) => clockIn?.status === "present")).toBe(true);

    const teamState = await ctx.db
      .query("teamRoundStates")
      .withIndex("by_round_team", (index) =>
        index.eq("roundId", fixture.roundId).eq("teamId", session.teamId),
      )
      .unique();
    expect(teamState).toMatchObject({
      panelId: fixture.targetPanelId,
      state: "in_review",
      callAttemptCount: 1,
    });

    const assignmentGrants = await ctx.db
      .query("permissionGrants")
      .withIndex("by_source", (index) =>
        index
          .eq("eventId", fixture.eventId)
          .eq("sourceType", "panel_assignment")
          .eq("sourceId", operatorAssignment._id)
          .eq("status", "active"),
      )
      .collect();
    expect(assignmentGrants.map((grant) => grant.permissionKey).sort()).toEqual([
      "review.conflict.report",
      "review.evidence.read",
      "review.presence.confirm",
      "review.read",
      "scorecard.correction.request",
      "scorecard.draft.write",
      "scorecard.submit",
    ]);

    expect(await ctx.db.get(fixture.decoyRoundId)).toMatchObject({
      name: "Same-event live decoy",
      status: "open",
      version: 13,
    });
    expect(await ctx.db.get(fixture.decoyPanelId)).toMatchObject({
      name: "Decoy Panel D",
      status: "needs_reviewer",
      version: 9,
    });
    expect(
      await ctx.db
        .query("reviewSessions")
        .withIndex("by_panel_status", (index) =>
          index.eq("panelId", fixture.decoyPanelId),
        )
        .collect(),
    ).toEqual([]);
  });
}, seedTestTimeoutMs);

test("live-review setup is rejected outside a local deployment", async () => {
  const backend = seededBackend();
  process.env.LOCAL_DEVELOPMENT_SEED_ENABLED = "false";
  try {
    await expect(
      backend.mutation(api.localDemoSeed.startLiveReviewForLocalOperator, {
        confirmation: "start-code2create-live-review",
      }),
    ).rejects.toThrow("Local development fixtures require the full localhost-only stack.");
  } finally {
    process.env.LOCAL_DEVELOPMENT_SEED_ENABLED = "true";
  }
});
