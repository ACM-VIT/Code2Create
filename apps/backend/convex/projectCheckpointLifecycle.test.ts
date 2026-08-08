import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "./_generated/dataModel.js";
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
} from "./projectCheckpoints.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
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

async function seedFixture(backend: BackendTest) {
  const now = Date.UTC(2027, 8, 10, 8);
  const phaseStart = now + 60 * 60_000;
  return backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId: `checkpoint-user-${now}`,
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
      membershipLocked: true,
      trackLocked: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const event = await ctx.db.get(eventId);
    if (!event) throw new Error("The event fixture did not persist.");
    return { event, personId, membershipId, teamId, now, phaseStart };
  });
}
