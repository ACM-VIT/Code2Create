import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, components } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { insertPermissionGrant } from "./lib/permissions.ts";
import { permissionCatalog } from "./lib/permissionCatalog.ts";
import {
  normalizePhaseSchedule,
  publishPhaseSchedule,
  savePhaseScheduleDraft,
  type PhaseScheduleInput,
} from "./lib/phaseSchedule.ts";
import {
  normalizeProjectCheckpointPlan,
  publishProjectCheckpointPlan,
  saveProjectCheckpointPlanDraft,
  type ProjectCheckpointDefinitionInput,
} from "./lib/projectCheckpointPlan.ts";
import {
  projectCheckpointAvailabilityAt,
  projectCheckpointClosesAt,
  projectCheckpointSummaryCounts,
} from "./projectCheckpoints.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

describe("project checkpoint lifecycle", () => {
  test("keeps participant writes and operations reads independently scoped", () => {
    expect(permissionCatalog["team.project.write"]).toEqual({
      scopes: ["team"],
      eventWide: false,
    });
    expect(permissionCatalog["project.checkpoint.read"]).toEqual({
      scopes: ["team"],
      eventWide: true,
    });
    expect(permissionCatalog["configuration.checkpoint.publish"]).toEqual({
      scopes: [],
      eventWide: true,
    });
  });

  test("requires the complete three-checkpoint plan and its fixed phase semantics", () => {
    expect(() => normalizeProjectCheckpointPlan(definitions().slice(0, 2))).toThrow(
      "must define ideation, intermediate update, and final update",
    );
    const remapped = definitions();
    const intermediate = remapped[1];
    if (!intermediate) throw new Error("The fixture needs an intermediate checkpoint.");
    intermediate.phaseKey = "build";
    expect(() => normalizeProjectCheckpointPlan(remapped)).toThrow(
      "must use the intermediate update phase",
    );
    const excessiveGrace = definitions();
    const final = excessiveGrace[2];
    if (!final) throw new Error("The fixture needs a final checkpoint.");
    final.graceMinutes = 1_441;
    expect(() => normalizeProjectCheckpointPlan(excessiveGrace)).toThrow(
      "between zero and 1,440 minutes",
    );
  });

  test("treats a due time as open, the configured grace as late, and then closes", () => {
    const dueAt = Date.UTC(2027, 8, 10, 12);
    const closesAt = projectCheckpointClosesAt(dueAt, 30);
    expect(closesAt).toBe(dueAt + 30 * 60_000);
    expect(projectCheckpointAvailabilityAt({
      admitted: true,
      submitted: false,
      startsAt: dueAt - 60_000,
      dueAt,
      closesAt,
      now: dueAt,
    })).toBe("open");
    expect(projectCheckpointAvailabilityAt({
      admitted: true,
      submitted: false,
      startsAt: dueAt - 60_000,
      dueAt,
      closesAt,
      now: dueAt + 1,
    })).toBe("late");
    expect(projectCheckpointAvailabilityAt({
      admitted: true,
      submitted: false,
      startsAt: dueAt - 60_000,
      dueAt,
      closesAt,
      now: closesAt,
    })).toBe("closed");
    expect(projectCheckpointAvailabilityAt({
      admitted: false,
      submitted: false,
      startsAt: dueAt - 60_000,
      dueAt,
      closesAt,
      now: dueAt,
    })).toBe("awaiting_confirmation");
    expect(projectCheckpointAvailabilityAt({
      admitted: false,
      submitted: true,
      startsAt: dueAt - 60_000,
      dueAt,
      closesAt,
      now: closesAt + 1,
    })).toBe("submitted");
  });

  test("reports global checkpoint totals independently of a loaded page", () => {
    expect(
      projectCheckpointSummaryCounts(
        ["team-a", "team-b", "team-c", "team-d"],
        new Set(["team-b", "team-d", "unreadable-team"]),
      ),
    ).toEqual({
      totalTeamCount: 4,
      submittedCount: 2,
      outstandingCount: 2,
    });
  });

  test("counts only confirmed event teams in the operations summary", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const authUserId = await createAuthUser(backend);
    const authSessionId = await createAuthSession(backend, authUserId);
    const fixture = await seedFixture(backend, authUserId);
    await backend.run(async (ctx) => {
      await insertPermissionGrant(ctx, {
        eventId: fixture.event._id,
        personId: fixture.personId,
        eventAccessSubjectId: fixture.subjectId,
        permissionKey: "project.checkpoint.read",
        scopeType: "event",
        sourceType: "manual",
        sourceId: "checkpoint-summary-test",
        grantedByPersonId: fixture.personId,
        reason: "Checkpoint summary test",
        validFrom: Date.now() - 1,
      });
      for (const [index, status] of (
        ["forming", "submitted", "admitted", "withdrawn"] as const
      ).entries()) {
        await ctx.db.insert("teams", {
          eventId: fixture.event._id,
          name: `Excluded team ${index}`,
          publicCode: `EXCL${index}`,
          leadMembershipId: fixture.membershipId,
          status,
          activeMemberCount: 0,
          activeVitMemberCount: 0,
          activeExternalMemberCount: 0,
          membershipLocked: false,
          version: 1,
          createdAt: fixture.now,
          updatedAt: fixture.now,
        });
      }
      for (const [index, status] of (
        ["checked_in", "active", "completed"] as const
      ).entries()) {
        await ctx.db.insert("teams", {
          eventId: fixture.event._id,
          name: `Included team ${index}`,
          publicCode: `INCL${index}`,
          leadMembershipId: fixture.membershipId,
          status,
          activeMemberCount: 0,
          activeVitMemberCount: 0,
          activeExternalMemberCount: 0,
          membershipLocked: true,
          version: 1,
          createdAt: fixture.now,
          updatedAt: fixture.now,
        });
      }
    });

    const reader = backend.withIdentity({
      subject: authUserId,
      sessionId: authSessionId,
    });
    await expect(
      reader.query(api.projectCheckpoints.operationsCheckpointSummary, {
        eventSlug: fixture.event.slug,
        checkpointKey: "ideation",
      }),
    ).resolves.toEqual({
      totalTeamCount: 4,
      submittedCount: 0,
      outstandingCount: 4,
    });
  });

  test("keeps an open team checkpoint read-only without the exact write grant", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const authUserId = await createAuthUser(backend);
    const authSessionId = await createAuthSession(backend, authUserId);
    const fixture = await seedFixture(backend, authUserId);
    const phaseStart = Date.now() - 90 * 60_000;

    await backend.run(async (ctx) => {
      await ctx.db.patch(fixture.teamId, { activeMemberCount: 1 });
      await ctx.db.insert("teamMembers", {
        eventId: fixture.event._id,
        teamId: fixture.teamId,
        membershipId: fixture.membershipId,
        role: "lead",
        status: "active",
        joinedAt: fixture.now,
        source: "created",
      });
      await insertPermissionGrant(ctx, {
        eventId: fixture.event._id,
        personId: fixture.personId,
        eventAccessSubjectId: fixture.subjectId,
        permissionKey: "project.checkpoint.read",
        scopeType: "team",
        scopeId: fixture.teamId,
        sourceType: "manual",
        sourceId: "checkpoint-read-only-test",
        grantedByPersonId: fixture.personId,
        reason: "Checkpoint read-only test",
      });
    });
    const phaseDraft = await backend.run((ctx) =>
      savePhaseScheduleDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        phases: phases(phaseStart),
        now: fixture.now,
      }),
    );
    await backend.run((ctx) =>
      publishPhaseSchedule(ctx, {
        event: fixture.event,
        draftScheduleId: phaseDraft.scheduleVersionId,
        expectedDraftChecksum: phaseDraft.checksum,
        now: fixture.now + 1,
      }),
    );
    const eventWithPhases = await requireEvent(backend, fixture.event._id);
    const checkpointDraft = await backend.run((ctx) =>
      saveProjectCheckpointPlanDraft(ctx, {
        event: eventWithPhases,
        actorPersonId: fixture.personId,
        definitions: definitions(),
        now: fixture.now + 2,
      }),
    );
    await backend.run((ctx) =>
      publishProjectCheckpointPlan(ctx, {
        event: eventWithPhases,
        draftPlanId: checkpointDraft.planVersionId,
        expectedDraftChecksum: checkpointDraft.checksum,
        now: fixture.now + 3,
      }),
    );
    const participant = backend.withIdentity({
      subject: authUserId,
      sessionId: authSessionId,
    });

    const state = await participant.query(api.projectCheckpoints.mine, {
      eventSlug: fixture.event.slug,
    });
    expect(state.checkpoints.find((checkpoint) => checkpoint.checkpointKey === "ideation"))
      .toMatchObject({ availability: "open", canEdit: false });
    await expect(
      participant.mutation(api.projectCheckpoints.saveUpdate, {
        eventSlug: fixture.event.slug,
        checkpointKey: "ideation",
        updateText: "We narrowed the problem after talking to the people who face it.",
        expectedDraftVersion: 0,
        clientOperationId: "checkpoint-read-only-write-attempt",
      }),
    ).rejects.toThrow("does not have permission for that exact resource");
  });

  test("replays the exact checkpoint draft version after later team edits", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const authUserId = await createAuthUser(backend);
    const authSessionId = await createAuthSession(backend, authUserId);
    const fixture = await seedFixture(backend, authUserId);
    const phaseStart = Date.now() - 90 * 60_000;

    await backend.run(async (ctx) => {
      await ctx.db.patch(fixture.teamId, { activeMemberCount: 1 });
      await ctx.db.insert("teamMembers", {
        eventId: fixture.event._id,
        teamId: fixture.teamId,
        membershipId: fixture.membershipId,
        role: "lead",
        status: "active",
        joinedAt: fixture.now,
        source: "created",
      });
      await insertPermissionGrant(ctx, {
        eventId: fixture.event._id,
        personId: fixture.personId,
        eventAccessSubjectId: fixture.subjectId,
        permissionKey: "team.project.write",
        scopeType: "team",
        scopeId: fixture.teamId,
        sourceType: "manual",
        sourceId: "checkpoint-replay-test",
        grantedByPersonId: fixture.personId,
        reason: "Checkpoint replay test",
      });
    });
    const phaseDraft = await backend.run((ctx) =>
      savePhaseScheduleDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        phases: phases(phaseStart),
        now: fixture.now,
      }),
    );
    await backend.run((ctx) =>
      publishPhaseSchedule(ctx, {
        event: fixture.event,
        draftScheduleId: phaseDraft.scheduleVersionId,
        expectedDraftChecksum: phaseDraft.checksum,
        now: fixture.now + 1,
      }),
    );
    const eventWithPhases = await requireEvent(backend, fixture.event._id);
    const checkpointDraft = await backend.run((ctx) =>
      saveProjectCheckpointPlanDraft(ctx, {
        event: eventWithPhases,
        actorPersonId: fixture.personId,
        definitions: definitions(),
        now: fixture.now + 2,
      }),
    );
    await backend.run((ctx) =>
      publishProjectCheckpointPlan(ctx, {
        event: eventWithPhases,
        draftPlanId: checkpointDraft.planVersionId,
        expectedDraftChecksum: checkpointDraft.checksum,
        now: fixture.now + 3,
      }),
    );
    const participant = backend.withIdentity({
      subject: authUserId,
      sessionId: authSessionId,
    });
    const firstArgs = {
      eventSlug: fixture.event.slug,
      checkpointKey: "ideation" as const,
      updateText: "We narrowed the project to one complete participant journey.",
      expectedDraftVersion: 0,
      clientOperationId: "checkpoint-first-save",
    };

    const first = await participant.mutation(api.projectCheckpoints.saveUpdate, firstArgs);
    const second = await participant.mutation(api.projectCheckpoints.saveUpdate, {
      ...firstArgs,
      updateText: "We tested that journey and changed the first interaction.",
      expectedDraftVersion: first.draftVersion,
      clientOperationId: "checkpoint-second-save",
    });
    const replayedFirst = await participant.mutation(
      api.projectCheckpoints.saveUpdate,
      firstArgs,
    );
    const currentDraft = await backend.run((ctx) => ctx.db.get(first.draftId));

    expect(first.draftVersion).toBe(1);
    expect(second.draftVersion).toBe(2);
    expect(replayedFirst).toEqual(first);
    expect(currentDraft).toMatchObject({
      updateText: "We tested that journey and changed the first interaction.",
      version: 2,
    });
  });

  test("does not publish checkpoints before the event phases", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    const draft = await backend.run((ctx) =>
      saveProjectCheckpointPlanDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        definitions: definitions(),
        now: fixture.now,
      }),
    );
    await expect(
      backend.run((ctx) =>
        publishProjectCheckpointPlan(ctx, {
          event: fixture.event,
          draftPlanId: draft.planVersionId,
          expectedDraftChecksum: draft.checksum,
          now: fixture.now + 1,
        }),
      ),
    ).rejects.toThrow("Publish the event-phase schedule");
  });

  test("allows only one competing current draft", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    const create = (suffix: string) => backend.run((ctx) =>
      saveProjectCheckpointPlanDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        definitions: definitions(suffix),
        now: fixture.now,
      }),
    );
    const results = await Promise.allSettled([create("One"), create("Two")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const drafts = await backend.run((ctx) =>
      ctx.db
        .query("projectCheckpointPlanVersions")
        .withIndex("by_event_status", (index) =>
          index.eq("eventId", fixture.event._id).eq("status", "draft"),
        )
        .collect(),
    );
    expect(drafts).toHaveLength(1);
  });

  test("keeps an active team draft pinned when a new plan is published", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await publishedPhaseFixture(backend);
    const firstDraft = await backend.run((ctx) =>
      saveProjectCheckpointPlanDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        definitions: definitions("First"),
        now: fixture.now,
      }),
    );
    await backend.run((ctx) =>
      publishProjectCheckpointPlan(ctx, {
        event: fixture.event,
        draftPlanId: firstDraft.planVersionId,
        expectedDraftChecksum: firstDraft.checksum,
        now: fixture.now + 1,
      }),
    );
    const pinned = await backend.run(async (ctx) => {
      const definition = await ctx.db
        .query("projectCheckpointDefinitions")
        .withIndex("by_plan_key", (index) =>
          index.eq("planVersionId", firstDraft.planVersionId).eq("checkpointKey", "ideation"),
        )
        .unique();
      if (!definition) throw new Error("The first checkpoint definition is missing.");
      return ctx.db.insert("teamCheckpointDrafts", {
        eventId: fixture.event._id,
        teamId: fixture.teamId,
        planVersionId: firstDraft.planVersionId,
        definitionId: definition._id,
        checkpointKey: "ideation",
        stage: "follow_up",
        updateText: "We narrowed the first release to one clear user journey.",
        version: 1,
        lastEditedByMembershipId: fixture.membershipId,
        updatedAt: fixture.now + 2,
      });
    });
    const currentEvent = await requireEvent(backend, fixture.event._id);
    const secondDraft = await backend.run((ctx) =>
      saveProjectCheckpointPlanDraft(ctx, {
        event: currentEvent,
        actorPersonId: fixture.personId,
        definitions: definitions("Second"),
        now: fixture.now + 3,
      }),
    );
    await backend.run((ctx) =>
      publishProjectCheckpointPlan(ctx, {
        event: currentEvent,
        draftPlanId: secondDraft.planVersionId,
        expectedDraftChecksum: secondDraft.checksum,
        now: fixture.now + 4,
      }),
    );
    const state = await backend.run(async (ctx) => ({
      oldPlan: await ctx.db.get(firstDraft.planVersionId),
      newPlan: await ctx.db.get(secondDraft.planVersionId),
      pinnedDraft: await ctx.db.get(pinned),
    }));
    expect(state.oldPlan?.status).toBe("superseded");
    expect(state.newPlan?.status).toBe("published");
    expect(state.pinnedDraft).toMatchObject({
      planVersionId: firstDraft.planVersionId,
      checkpointKey: "ideation",
      version: 1,
    });
  });
});

function definitions(suffix = ""): ProjectCheckpointDefinitionInput[] {
  return [
    {
      checkpointKey: "ideation",
      phaseKey: "ideation",
      displayName: suffix ? `Ideation ${suffix}` : "Ideation update",
      prompt: "What changed about your idea after exploring it?",
      followUpQuestion: "What are you building first, and why?",
      graceMinutes: 240,
    },
    {
      checkpointKey: "intermediate_update",
      phaseKey: "intermediate_update",
      displayName: suffix ? `Intermediate ${suffix}` : "Intermediate update",
      prompt: "What has your team built or learned since the last update?",
      followUpQuestion: "What is the next concrete thing your team will finish?",
      graceMinutes: 120,
    },
    {
      checkpointKey: "final_update",
      phaseKey: "final_update",
      displayName: suffix ? `Final ${suffix}` : "Final update",
      prompt: "What did your team finish?",
      followUpQuestion: "What should someone try or look at first?",
      graceMinutes: 60,
    },
  ];
}

function phases(start: number): PhaseScheduleInput[] {
  const names = [
    ["introduction", "Introduction", "Welcome, orientation, and event setup."],
    ["ideation", "Ideation", "Teams refine the problem, users, and approach."],
    ["build", "Build", "The main hacking window."],
    ["intermediate_update", "Intermediate update", "Teams record a progress checkpoint."],
    ["final_update", "Final update", "Teams complete the final project checkpoint."],
  ] as const satisfies readonly (readonly [PhaseScheduleInput["phaseKey"], string, string])[];
  return normalizePhaseSchedule(names.map(([phaseKey, displayName, description], index) => ({
    phaseKey,
    displayName,
    description,
    startsAt: start + index * 60 * 60_000,
    endsAt: start + (index + 1) * 60 * 60_000,
  })));
}

async function publishedPhaseFixture(backend: BackendTest) {
  const fixture = await seedFixture(backend);
  const phaseDraft = await backend.run((ctx) =>
    savePhaseScheduleDraft(ctx, {
      event: fixture.event,
      actorPersonId: fixture.personId,
      phases: phases(fixture.phaseStart),
      now: fixture.now,
    }),
  );
  await backend.run((ctx) =>
    publishPhaseSchedule(ctx, {
      event: fixture.event,
      draftScheduleId: phaseDraft.scheduleVersionId,
      expectedDraftChecksum: phaseDraft.checksum,
      now: fixture.now + 1,
    }),
  );
  return { ...fixture, event: await requireEvent(backend, fixture.event._id) };
}

async function requireEvent(backend: BackendTest, eventId: Id<"events">) {
  const event = await backend.run((ctx) => ctx.db.get(eventId));
  if (!event) throw new Error("The event fixture is missing.");
  return event;
}

async function seedFixture(backend: BackendTest, authUserId?: string) {
  const now = Date.UTC(2027, 8, 10, 8);
  const phaseStart = now + 60 * 60_000;
  return backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId: authUserId ?? `checkpoint-user-${now}`,
      googleSubject: `checkpoint-subject-${now}`,
      verifiedEmail: `checkpoint-${now}@example.test`,
      displayName: "Mira Shah",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: `checkpoint-${now}`,
      name: "Code2Create checkpoint fixture",
      timezone: "Asia/Kolkata",
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: Date.now() + 86_400_000,
      createdByPersonId: personId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: `checkpoint-${now}@example.test`,
      displayName: "Mira Shah",
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
      participantClass: "external_participant",
      eligibilityStatus: "eligible",
      onboardingStatus: "accepted",
      acceptedParticipantPolicyVersionIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const teamId = await ctx.db.insert("teams", {
      eventId,
      name: "Checkpoint team",
      publicCode: "CHECK1",
      leadMembershipId: membershipId,
      status: "confirmed",
      activeMemberCount: 0,
      activeVitMemberCount: 0,
      activeExternalMemberCount: 0,
      membershipLocked: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const event = await ctx.db.get(eventId);
    if (!event) throw new Error("The event fixture did not persist.");
    return {
      event,
      personId,
      subjectId,
      membershipId,
      teamId,
      now,
      phaseStart,
    };
  });
}

async function createAuthUser(backend: BackendTest) {
  const now = Date.now();
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Checkpoint operator",
        email: `checkpoint-operator-${crypto.randomUUID()}@example.test`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  return documentId(result, "Better Auth user");
}

async function createAuthSession(backend: BackendTest, userId: string) {
  const now = Date.now();
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        expiresAt: now + 60 * 60_000,
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        userId,
      },
    },
  });
  return documentId(result, "Better Auth session");
}

function documentId(value: unknown, label: string) {
  if (typeof value !== "object" || value === null || !("_id" in value)) {
    throw new Error(`${label} did not return a document ID.`);
  }
  const id = value._id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${label} returned an invalid document ID.`);
  }
  return id;
}
