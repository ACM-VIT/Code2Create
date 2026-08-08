import workpoolTest from "@convex-dev/workpool/test";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import {
  operationsIntelligenceProtocolVersion,
  type OperationsHealthSnapshot,
  type OperationsIntelligenceSuccess,
} from "@code2create/domain";

import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import {
  defaultOperationsIntelligencePolicy,
  normalizeOperationsIntelligencePolicy,
  operationsIntelligencePolicyChecksum,
  publishOperationsIntelligencePolicy,
  saveOperationsIntelligencePolicyDraft,
  type OperationsIntelligencePolicy,
} from "./lib/operationsIntelligencePolicy.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

function createBackend() {
  const backend = convexTest(schema, modules);
  workpoolTest.register(backend, "intelligenceWorkpool");
  return backend;
}

describe("proactive operations intelligence", () => {
  test("rejects empty triggers, duplicates, and unsafe budgets", () => {
    expect(() => normalizeOperationsIntelligencePolicy({
      ...defaultOperationsIntelligencePolicy,
      triggerSeverities: [],
    })).toThrow("must contain at least one value");
    expect(() => normalizeOperationsIntelligencePolicy({
      ...defaultOperationsIntelligencePolicy,
      triggerAreas: ["reviews", "reviews"],
    })).toThrow("must not contain duplicates");
    expect(() => normalizeOperationsIntelligencePolicy({
      ...defaultOperationsIntelligencePolicy,
      maximumBriefsPerLocalDay: 25,
    })).toThrow("whole number from 1 through 24");
  });

  test("publishes one replacement policy and supersedes the prior automation state", async () => {
    const backend = createBackend();
    const fixture = await seedAutomation(backend, { enabled: false });
    const draft = await backend.run((ctx) => saveOperationsIntelligencePolicyDraft(ctx, {
      event: fixture.event,
      actorPersonId: fixture.personId,
      policy: enabledPolicy(),
      now: fixture.now + 1,
    }));
    await backend.run((ctx) => publishOperationsIntelligencePolicy(ctx, {
      event: fixture.event,
      draftPolicyId: draft.policyVersionId,
      expectedDraftChecksum: draft.checksum,
      now: fixture.now + 2,
    }));

    const result = await backend.run(async (ctx) => ({
      event: await ctx.db.get(fixture.event._id),
      policies: await ctx.db
        .query("operationsIntelligencePolicyVersions")
        .withIndex("by_event_version", (index) => index.eq("eventId", fixture.event._id))
        .collect(),
      states: await ctx.db
        .query("operationsIntelligenceAutomationStates")
        .withIndex("by_event", (index) => index.eq("eventId", fixture.event._id))
        .collect(),
    }));
    expect(result.event?.publishedOperationsIntelligencePolicyId).toBe(draft.policyVersionId);
    expect(result.policies.map((policy) => policy.status)).toEqual(["superseded", "published"]);
    expect(result.states.map((state) => state.state)).toEqual(["superseded", "active"]);
  });

  test("allows one concurrent draft from the same observed policy state", async () => {
    const backend = createBackend();
    const fixture = await seedAutomation(backend, { enabled: false });
    const attempts = await Promise.allSettled([
      backend.run((ctx) => saveOperationsIntelligencePolicyDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        policy: enabledPolicy({ accountableOwner: "Review operations" }),
        now: fixture.now + 1,
      })),
      backend.run((ctx) => saveOperationsIntelligencePolicyDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        policy: enabledPolicy({ accountableOwner: "Attendance operations" }),
        now: fixture.now + 1,
      })),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const drafts = await backend.run((ctx) => ctx.db
      .query("operationsIntelligencePolicyVersions")
      .withIndex("by_event_status", (index) =>
        index.eq("eventId", fixture.event._id).eq("status", "draft"),
      )
      .collect());
    expect(drafts).toHaveLength(1);
  });

  test("two due evaluations create one signal and one proactive brief", async () => {
    const backend = createBackend();
    const fixture = await seedAutomation(backend, { enabled: true });
    const args = {
      stateId: fixture.stateId,
      expectedVersion: 1,
      snapshot: criticalSnapshot(fixture.now),
      now: fixture.now,
    };
    const results = await Promise.all([
      backend.mutation(internal.operationsIntelligenceAutomation.evaluateSnapshot, args),
      backend.mutation(internal.operationsIntelligenceAutomation.evaluateSnapshot, args),
    ]);
    const records = await automationRecords(backend, fixture.event._id);

    expect(results.toSorted()).toEqual(["stale", "triggered"]);
    expect(records.signals).toHaveLength(1);
    expect(records.briefs).toHaveLength(1);
    expect(records.briefs[0]).toMatchObject({
      origin: "automation",
      state: "pending",
      automationSignalId: records.signals[0]?._id,
    });
    expect(records.state).toMatchObject({
      briefsStartedToday: 1,
      version: 2,
    });
  });

  test("does not repeat an unchanged signal and re-arms only after recovery", async () => {
    const backend = createBackend();
    const fixture = await seedAutomation(backend, { enabled: true });
    await evaluate(backend, fixture, 1, criticalSnapshot(fixture.now), fixture.now);
    await settleLatestBrief(backend, fixture.event._id);

    expect(
      await evaluate(
        backend,
        fixture,
        2,
        criticalSnapshot(fixture.now + 60_000, fixture.now),
        fixture.now + 60_000,
      ),
    ).toBe("unchanged");
    expect(
      await evaluate(
        backend,
        fixture,
        3,
        healthySnapshot(fixture.now + 120_000),
        fixture.now + 120_000,
      ),
    ).toBe("quiet");
    expect(
      await evaluate(
        backend,
        fixture,
        4,
        criticalSnapshot(fixture.now + 31 * 60_000),
        fixture.now + 31 * 60_000,
      ),
    ).toBe("triggered");

    const records = await automationRecords(backend, fixture.event._id);
    expect(records.signals).toHaveLength(2);
    expect(records.briefs).toHaveLength(2);
    expect(records.state?.cycle).toBe(2);
  });

  test("holds a changed signal until cooldown ends", async () => {
    const backend = createBackend();
    const fixture = await seedAutomation(backend, { enabled: true });
    await evaluate(backend, fixture, 1, criticalSnapshot(fixture.now), fixture.now);
    await settleLatestBrief(backend, fixture.event._id);
    const changed = criticalSnapshot(fixture.now + 60_000, fixture.now);
    const firstSignal = changed.signals[0];
    if (!firstSignal) throw new Error("The changed snapshot has no signal.");
    firstSignal.count = 2;

    expect(
      await evaluate(backend, fixture, 2, changed, fixture.now + 60_000),
    ).toBe("cooldown");
    expect(
      await evaluate(
        backend,
        fixture,
        3,
        { ...changed, generatedAt: fixture.now + 31 * 60_000 },
        fixture.now + 31 * 60_000,
      ),
    ).toBe("triggered");
    const records = await automationRecords(backend, fixture.event._id);
    expect(records.briefs).toHaveLength(2);
  });

  test("settles the committed automation signal with its brief callback", async () => {
    const backend = createBackend();
    const fixture = await seedAutomation(backend, { enabled: true });
    await evaluate(backend, fixture, 1, criticalSnapshot(fixture.now), fixture.now);
    const records = await automationRecords(backend, fixture.event._id);
    const brief = records.briefs[0];
    const sourceSignal = records.signals[0];
    if (!brief?.sourceChecksum || !brief.sourceSnapshot || !sourceSignal) {
      throw new Error("The proactive brief source is missing.");
    }
    await backend.mutation(internal.operationsIntelligence.beginDispatch, {
      briefId: brief._id,
      snapshot: brief.sourceSnapshot,
      sourceChecksum: brief.sourceChecksum,
    });
    const dispatching = await backend.run((ctx) => ctx.db.get(brief._id));
    expect(dispatching).toMatchObject({ state: "dispatching", version: 2 });
    await backend.mutation(internal.operationsIntelligence.markAccepted, {
      briefId: brief._id,
      workerSubmissionId: "proactive-submission",
      workerAcceptedAt: fixture.now + 1,
    });
    await backend.mutation(internal.operationsIntelligence.completeFromWorker, {
      callback: successCallback(brief._id, brief.sourceChecksum, fixture.now + 2),
    });
    const signal = await backend.run((ctx) => ctx.db.get(sourceSignal._id));

    expect(signal).toMatchObject({
      state: "succeeded",
      settledAt: expect.any(Number),
    });
  });

  test("enforces the event-local daily budget after a recovered signal", async () => {
    const backend = createBackend();
    const fixture = await seedAutomation(backend, {
      enabled: true,
      maximumBriefsPerLocalDay: 1,
    });
    await evaluate(backend, fixture, 1, criticalSnapshot(fixture.now), fixture.now);
    await settleLatestBrief(backend, fixture.event._id);
    await evaluate(
      backend,
      fixture,
      2,
      healthySnapshot(fixture.now + 60_000),
      fixture.now + 60_000,
    );
    const result = await evaluate(
      backend,
      fixture,
      3,
      criticalSnapshot(fixture.now + 31 * 60_000),
      fixture.now + 31 * 60_000,
    );

    expect(result).toBe("budget_exhausted");
    const records = await automationRecords(backend, fixture.event._id);
    expect(records.briefs).toHaveLength(1);
    expect(records.signals).toHaveLength(1);
  });
});

function enabledPolicy(
  overrides: Partial<OperationsIntelligencePolicy> = {},
): OperationsIntelligencePolicy {
  return {
    ...defaultOperationsIntelligencePolicy,
    enabled: true,
    ...overrides,
  };
}

function criticalSnapshot(now: number, oldestAt = now): OperationsHealthSnapshot {
  return {
    generatedAt: now,
    event: {
      slug: "intelligence-automation",
      name: "Code2Create intelligence automation",
      timezone: "Asia/Kolkata",
      status: "live",
    },
    summary: {
      status: "critical",
      signalCount: 1,
      criticalSignalCount: 1,
      attentionSignalCount: 0,
      watchSignalCount: 0,
    },
    signals: [
      {
        key: "active_round_pauses",
        area: "reviews",
        severity: "critical",
        title: "Paused review round",
        detail: "Review work is paused by an active incident.",
        owner: "Review lead",
        nextAction: "Resolve the linked incident before resuming the round.",
        count: 1,
        atLeast: false,
        oldestAt,
      },
    ],
  };
}

function healthySnapshot(now: number): OperationsHealthSnapshot {
  return {
    generatedAt: now,
    event: {
      slug: "intelligence-automation",
      name: "Code2Create intelligence automation",
      timezone: "Asia/Kolkata",
      status: "live",
    },
    summary: {
      status: "healthy",
      signalCount: 0,
      criticalSignalCount: 0,
      attentionSignalCount: 0,
      watchSignalCount: 0,
    },
    signals: [],
  };
}

function successCallback(
  briefId: Id<"operationsIntelligenceBriefs">,
  sourceChecksum: string,
  completedAt: number,
): OperationsIntelligenceSuccess {
  return {
    protocolVersion: operationsIntelligenceProtocolVersion,
    briefId,
    sourceChecksum,
    agentVersion: "operations-brief-v1",
    model: "cloudflare/test-model",
    completedAt,
    status: "succeeded",
    headline: "Review operations first",
    summary: "The paused review round is the highest current operational priority.",
    priorities: [
      {
        severity: "critical",
        title: "Resume the paused round safely",
        why: "Review work cannot continue while its linked incident remains unresolved.",
        owner: "Review lead",
        nextAction: "Resolve the linked incident before resuming the round.",
        signalKeys: ["active_round_pauses"],
      },
    ],
  };
}

async function evaluate(
  backend: BackendTest,
  fixture: Awaited<ReturnType<typeof seedAutomation>>,
  expectedVersion: number,
  snapshot: OperationsHealthSnapshot,
  now: number,
) {
  return backend.mutation(internal.operationsIntelligenceAutomation.evaluateSnapshot, {
    stateId: fixture.stateId,
    expectedVersion,
    snapshot,
    now,
  });
}

async function settleLatestBrief(
  backend: BackendTest,
  eventId: Id<"events">,
) {
  await backend.run(async (ctx) => {
    const brief = await ctx.db
      .query("operationsIntelligenceBriefs")
      .withIndex("by_event_requested", (index) => index.eq("eventId", eventId))
      .order("desc")
      .first();
    if (!brief) throw new Error("The proactive brief is missing.");
    await ctx.db.patch(brief._id, {
      state: "succeeded",
      headline: "Current operations brief",
      summary: "The current critical signal has an accountable owner and next action.",
      priorities: [],
      completedAt: brief.requestedAt + 1,
      updatedAt: brief.requestedAt + 1,
      version: brief.version + 1,
    });
    if (brief.automationSignalId) {
      await ctx.db.patch(brief.automationSignalId, {
        state: "succeeded",
        settledAt: brief.requestedAt + 1,
      });
    }
  });
}

async function automationRecords(backend: BackendTest, eventId: Id<"events">) {
  return backend.run(async (ctx) => ({
    state: await ctx.db
      .query("operationsIntelligenceAutomationStates")
      .withIndex("by_event", (index) => index.eq("eventId", eventId))
      .filter((filter) => filter.neq(filter.field("state"), "superseded"))
      .unique(),
    signals: await ctx.db
      .query("operationsIntelligenceSignals")
      .withIndex("by_event_observed", (index) => index.eq("eventId", eventId))
      .collect(),
    briefs: await ctx.db
      .query("operationsIntelligenceBriefs")
      .withIndex("by_event_requested", (index) => index.eq("eventId", eventId))
      .collect(),
  }));
}

async function seedAutomation(
  backend: BackendTest,
  overrides: Partial<OperationsIntelligencePolicy>,
) {
  const now = Date.UTC(2026, 7, 8, 5, 0, 0);
  return backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId: `automation-${now}`,
      googleSubject: `automation-subject-${now}`,
      verifiedEmail: `automation-${now}@example.test`,
      displayName: "Technical operations",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: "intelligence-automation",
      name: "Code2Create intelligence automation",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      createdByPersonId: personId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const policy = normalizeOperationsIntelligencePolicy(
      enabledPolicy(overrides),
    );
    const policyVersionId = await ctx.db.insert("operationsIntelligencePolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...policy,
      checksum: operationsIntelligencePolicyChecksum(policy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    const stateId = await ctx.db.insert("operationsIntelligenceAutomationStates", {
      eventId,
      policyVersionId,
      state: policy.enabled ? "active" : "disabled",
      nextEvaluationAt: now,
      cycle: 1,
      localBudgetDate: "2026-08-08",
      briefsStartedToday: 0,
      version: 1,
      updatedAt: now,
    });
    await ctx.db.patch(eventId, {
      publishedOperationsIntelligencePolicyId: policyVersionId,
    });
    const event = await ctx.db.get(eventId);
    if (!event) throw new Error("The automation fixture event is missing.");
    return { now, personId, event, policyVersionId, stateId };
  });
}
