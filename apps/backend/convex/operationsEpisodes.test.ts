/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

function snapshot(slug: string, generatedAt: number, active: boolean) {
  const signals = active
    ? [
        {
          key: "intake_interpretation_stalls" as const,
          area: "intake" as const,
          severity: "attention" as const,
          title: "Stalled intake interpretations",
          detail: "Interpretations exceeded their worker window.",
          owner: "Intake operations",
          nextAction: "Inspect the current interpretation jobs.",
          count: 2,
          atLeast: false,
          oldestAt: generatedAt - 120_000,
        },
        {
          key: "participant_delivery_stalls" as const,
          area: "communications" as const,
          severity: "attention" as const,
          title: "Stalled participant messages",
          detail: "Participant messages exceeded their delivery window.",
          owner: "Admissions communications",
          nextAction: "Inspect the current delivery attempts.",
          count: 3,
          atLeast: false,
          oldestAt: generatedAt - 180_000,
        },
      ]
    : [];
  return {
    generatedAt,
    event: {
      slug,
      name: "Episode fixture",
      timezone: "Asia/Kolkata",
      status: "live" as const,
    },
    summary: {
      status: active ? "attention" as const : "healthy" as const,
      signalCount: signals.length,
      criticalSignalCount: 0,
      attentionSignalCount: signals.length,
      watchSignalCount: 0,
    },
    signals,
  };
}

async function insertEvent(backend: BackendTest, slug: string) {
  return backend.run((ctx) => {
    const now = Date.now();
    return ctx.db.insert("events", {
      slug,
      name: "Episode fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      applicationsCloseAt: now + 86_400_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe("operations intelligence episodes", () => {
  test("correlates related facts into one durable episode and resolves after three clear passes", async () => {
    const backend = convexTest(schema, modules);
    const slug = `episode-${crypto.randomUUID()}`;
    const eventId = await insertEvent(backend, slug);

    await backend.mutation(internal.operationsHealth.upsertSnapshot, {
      eventId,
      eventVersion: 1,
      snapshot: snapshot(slug, 1_000_000, true),
    });
    let episodes = await backend.run((ctx) => ctx.db
      .query("operationsIntelligenceEpisodes")
      .withIndex("by_event_correlation_lifecycle", (index) =>
        index.eq("eventId", eventId).eq("correlationKey", "participant_pipeline").eq("lifecycle", "active"),
      )
      .collect());
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      state: "active",
      signalCount: 2,
      factCount: 2,
      revision: 1,
      analysisState: { kind: "pending" },
    });

    const episode = episodes[0];
    if (!episode) throw new Error("The episode was not created.");
    const projectionJson = await backend.query(internal.operationsEpisodes.serviceProjection, {
      episodeId: episode._id,
      operationId: "test-projection-read",
    });
    expect(projectionJson).not.toBeNull();
    expect(JSON.parse(projectionJson ?? "{}")).toMatchObject({
      episodeId: episode._id,
      revision: 1,
      correlationKey: "participant_pipeline",
      facts: expect.arrayContaining([
        expect.objectContaining({ signalKey: "intake_interpretation_stalls" }),
        expect.objectContaining({ signalKey: "participant_delivery_stalls" }),
      ]),
    });

    await backend.mutation(internal.operationsHealth.upsertSnapshot, {
      eventId,
      eventVersion: 1,
      snapshot: snapshot(slug, 1_000_030, true),
    });
    episodes = await backend.run((ctx) => ctx.db
      .query("operationsIntelligenceEpisodes")
      .withIndex("by_event_correlation_lifecycle", (index) =>
        index.eq("eventId", eventId).eq("correlationKey", "participant_pipeline").eq("lifecycle", "active"),
      )
      .collect());
    expect(episodes[0]).toMatchObject({ revision: 1, factCount: 4 });

    for (const generatedAt of [1_000_060, 1_000_090, 1_000_120]) {
      await backend.mutation(internal.operationsHealth.upsertSnapshot, {
        eventId,
        eventVersion: 1,
        snapshot: snapshot(slug, generatedAt, false),
      });
    }
    const resolved = await backend.run((ctx) => ctx.db.get(episode._id));
    expect(resolved).toMatchObject({
      lifecycle: "terminal",
      state: "resolved",
      clearPassCount: 3,
    });
    const outcomes = await backend.run((ctx) => ctx.db
      .query("operationsIntelligenceOutcomes")
      .withIndex("by_episode_observed_at", (index) => index.eq("episodeId", episode._id))
      .collect());
    expect(outcomes).toEqual([
      expect.objectContaining({ kind: "episode_resolved" }),
    ]);
  });
});
