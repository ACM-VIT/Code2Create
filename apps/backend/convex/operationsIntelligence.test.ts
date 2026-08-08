import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import {
  operationsIntelligenceProtocolVersion,
  type OperationsIntelligenceSuccess,
} from "@code2create/domain";

import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { permissionCatalog } from "./lib/permissionCatalog.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

describe("operations intelligence brief", () => {
  test("keeps read and generation behind separate event-scoped grants", () => {
    expect(permissionCatalog["configuration.intelligence.read"]).toEqual({
      scopes: [],
      eventWide: true,
    });
    expect(permissionCatalog["configuration.intelligence.draft.create"]).toEqual({
      scopes: [],
      eventWide: true,
    });
    expect(permissionCatalog["configuration.intelligence.validate"]).toEqual({
      scopes: [],
      eventWide: true,
    });
    expect(permissionCatalog["configuration.intelligence.publish"]).toEqual({
      scopes: [],
      eventWide: true,
    });
    expect(permissionCatalog["operations.intelligence.read"]).toEqual({
      scopes: [],
      eventWide: true,
    });
    expect(permissionCatalog["operations.intelligence.generate"]).toEqual({
      scopes: [],
      eventWide: true,
    });
  });

  test("accepts the first valid callback and ignores a later competing settlement", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedBrief(backend);
    const first = await backend.mutation(internal.operationsIntelligence.completeFromWorker, {
      callback: successCallback(fixture.briefId, fixture.sourceChecksum),
    });
    const second = await backend.mutation(internal.operationsIntelligence.completeFromWorker, {
      callback: {
        ...callbackBase(fixture.briefId, fixture.sourceChecksum),
        status: "failed",
        failureCode: "model_did_not_publish",
      },
    });
    const brief = await backend.run((ctx) => ctx.db.get(fixture.briefId));

    expect(first).toBe("accepted");
    expect(second).toBe("already_settled");
    expect(brief).toMatchObject({
      state: "succeeded",
      headline: "Review operations first",
      version: 2,
    });
  });

  test("rejects a priority that cites facts outside its frozen snapshot", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedBrief(backend);
    const callback = successCallback(fixture.briefId, fixture.sourceChecksum);
    const firstPriority = callback.priorities[0];
    if (!firstPriority) throw new Error("The fixture brief has no priority.");
    callback.priorities[0] = {
      ...firstPriority,
      signalKeys: ["stale_scanner_stations"],
    };

    await expect(
      backend.mutation(internal.operationsIntelligence.completeFromWorker, { callback }),
    ).rejects.toThrow("outside its frozen source snapshot");
    const brief = await backend.run((ctx) => ctx.db.get(fixture.briefId));
    expect(brief?.state).toBe("accepted");
  });

  test("does not apply a callback for another source checksum", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedBrief(backend);
    const result = await backend.mutation(internal.operationsIntelligence.completeFromWorker, {
      callback: successCallback(fixture.briefId, "b".repeat(64)),
    });
    const brief = await backend.run((ctx) => ctx.db.get(fixture.briefId));

    expect(result).toBe("stale");
    expect(brief?.state).toBe("accepted");
  });

  test("keeps a callback that settles before the dispatch receipt", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedBrief(backend, { state: "dispatching" });

    await backend.mutation(internal.operationsIntelligence.completeFromWorker, {
      callback: successCallback(fixture.briefId, fixture.sourceChecksum),
    });
    await backend.mutation(internal.operationsIntelligence.markAccepted, {
      briefId: fixture.briefId,
      workerSubmissionId: "late-receipt",
      workerAcceptedAt: Date.now(),
    });
    const brief = await backend.run((ctx) => ctx.db.get(fixture.briefId));

    expect(brief).toMatchObject({
      state: "succeeded",
      headline: "Review operations first",
      version: 2,
    });
    expect(brief?.workerSubmissionId).toBeUndefined();
  });

  test("does not let a callback reopen a timed-out brief", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedBrief(backend, {
      requestedAt: Date.now() - 10 * 60 * 1_000 - 1,
    });

    await backend.mutation(internal.operationsIntelligence.expire, {
      briefId: fixture.briefId,
    });
    const result = await backend.mutation(
      internal.operationsIntelligence.completeFromWorker,
      { callback: successCallback(fixture.briefId, fixture.sourceChecksum) },
    );
    const brief = await backend.run((ctx) => ctx.db.get(fixture.briefId));

    expect(result).toBe("already_settled");
    expect(brief).toMatchObject({
      state: "failed",
      failureCode: "agent_timed_out",
      version: 2,
    });
  });

  test("rejects model-authored severity, owner, and next-action changes", async () => {
    const changes: Array<{
      label: string;
      change: (priority: OperationsIntelligenceSuccess["priorities"][number]) => void;
      message: string;
    }> = [
      {
        label: "severity",
        change: (priority) => {
          priority.severity = "watch";
        },
        message: "cannot downgrade or inflate",
      },
      {
        label: "owner",
        change: (priority) => {
          priority.owner = "Invented owner";
        },
        message: "must come from one of its cited health signals",
      },
      {
        label: "next action",
        change: (priority) => {
          priority.nextAction = "Take an action that was not in the source.";
        },
        message: "must come from one of its cited health signals",
      },
    ];

    for (const change of changes) {
      const backend = convexTest(schema, modules);
      const fixture = await seedBrief(backend);
      const callback = successCallback(fixture.briefId, fixture.sourceChecksum);
      const priority = callback.priorities[0];
      if (!priority) throw new Error("The fixture brief has no priority.");
      change.change(priority);

      await expect(
        backend.mutation(internal.operationsIntelligence.completeFromWorker, { callback }),
        change.label,
      ).rejects.toThrow(change.message);
      const brief = await backend.run((ctx) => ctx.db.get(fixture.briefId));
      expect(brief?.state).toBe("accepted");
    }
  });
});

function callbackBase(briefId: Id<"operationsIntelligenceBriefs">, sourceChecksum: string) {
  return {
    protocolVersion: operationsIntelligenceProtocolVersion,
    briefId,
    sourceChecksum,
    agentVersion: "operations-brief-v1",
    model: "cloudflare/test-model",
    completedAt: Date.now(),
  };
}

function successCallback(
  briefId: Id<"operationsIntelligenceBriefs">,
  sourceChecksum: string,
): OperationsIntelligenceSuccess {
  return {
    ...callbackBase(briefId, sourceChecksum),
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

async function seedBrief(
  backend: BackendTest,
  options: {
    state?: "accepted" | "dispatching";
    requestedAt?: number;
  } = {},
) {
  const now = Date.now();
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: "intelligence-fixture",
      name: "Code2Create intelligence fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const personId = await ctx.db.insert("people", {
      authUserId: "intelligence-user",
      googleSubject: "intelligence-subject",
      verifiedEmail: "intelligence@example.test",
      displayName: "Operations lead",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const sourceChecksum = "a".repeat(64);
    const briefId = await ctx.db.insert("operationsIntelligenceBriefs", {
      eventId,
      requestedByPersonId: personId,
      origin: "manual",
      state: options.state ?? "accepted",
      sourceChecksum,
      sourceSnapshot: {
        generatedAt: now,
        event: {
          slug: "intelligence-fixture",
          name: "Code2Create intelligence fixture",
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
            oldestAt: now,
          },
        ],
      },
      requestedAt: options.requestedAt ?? now,
      updatedAt: now,
      workerAcceptedAt: now,
      version: 1,
    });
    return { briefId, sourceChecksum };
  });
}
