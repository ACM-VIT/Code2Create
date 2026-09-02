/// <reference types="vite/client" />

import workpoolTest from "@convex-dev/workpool/test";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

function episodeBackend() {
  const backend = convexTest(schema, modules);
  workpoolTest.register(backend, "intelligenceWorkpool");
  return backend;
}

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
          oldestAt: 880_000,
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
          oldestAt: 820_000,
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
    const backend = episodeBackend();
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

  test("recovers only the exact accepted episode submission without overlapping dispatches", async () => {
    const backend = episodeBackend();
    const slug = `episode-recovery-${crypto.randomUUID()}`;
    const eventId = await insertEvent(backend, slug);
    await backend.mutation(internal.operationsHealth.upsertSnapshot, {
      eventId,
      eventVersion: 1,
      snapshot: snapshot(slug, 2_000_000, true),
    });
    const episode = await backend.run((ctx) => ctx.db
      .query("operationsIntelligenceEpisodes")
      .withIndex("by_event_lifecycle_relevance", (index) =>
        index.eq("eventId", eventId).eq("lifecycle", "active"),
      )
      .first());
    if (!episode) throw new Error("The recovery fixture did not create an episode.");

    const prepared = await backend.mutation(internal.operationsEpisodes.prepareDispatch, {
      episodeId: episode._id,
      now: 2_000_001,
    });
    if (!prepared) throw new Error("The episode dispatch was not prepared.");
    expect(await backend.mutation(internal.operationsEpisodes.prepareDispatch, {
      episodeId: episode._id,
      now: 2_000_002,
    })).toBeNull();
    expect(await backend.mutation(internal.operationsEpisodes.recordDispatchReceipt, {
      episodeId: episode._id,
      revision: prepared.revision,
      attemptId: prepared.attemptId,
      submissionId: "episode-submission-1",
      acceptedAt: 2_000_003,
    })).toBe(true);
    expect(await backend.mutation(internal.operationsEpisodes.recoverAcceptedDispatch, {
      episodeId: episode._id,
      revision: prepared.revision,
      submissionId: "another-submission",
    })).toBe(false);
    expect(await backend.mutation(internal.operationsEpisodes.recoverAcceptedDispatch, {
      episodeId: episode._id,
      revision: prepared.revision,
      submissionId: "episode-submission-1",
    })).toBe(true);
    expect(await backend.run((ctx) => ctx.db.get(episode._id))).toMatchObject({
      analysisState: { kind: "failed", revision: prepared.revision },
    });

    const recovered = await backend.mutation(internal.operationsEpisodes.prepareDispatch, {
      episodeId: episode._id,
      now: 2_000_004,
    });
    expect(recovered?.attemptId).not.toBe(prepared.attemptId);
    expect(await backend.mutation(internal.operationsEpisodes.recordDispatchReceipt, {
      episodeId: episode._id,
      revision: prepared.revision,
      attemptId: prepared.attemptId,
      submissionId: "stale-submission",
      acceptedAt: 2_000_005,
    })).toBe(false);
  });

  test("enforces episode evidence, causal stance, language, and forecast horizons on callback", async () => {
    const backend = episodeBackend();
    const slug = `episode-policy-${crypto.randomUUID()}`;
    const eventId = await insertEvent(backend, slug);
    await backend.mutation(internal.operationsHealth.upsertSnapshot, {
      eventId,
      eventVersion: 1,
      snapshot: snapshot(slug, 3_000_000, true),
    });
    const episode = await backend.run((ctx) => ctx.db
      .query("operationsIntelligenceEpisodes")
      .withIndex("by_event_lifecycle_relevance", (index) =>
        index.eq("eventId", eventId).eq("lifecycle", "active"),
      )
      .first());
    if (!episode) throw new Error("The callback-policy fixture did not create an episode.");
    const projectionJson = await backend.query(internal.operationsEpisodes.serviceProjection, {
      episodeId: episode._id,
      operationId: "callback-policy-projection",
    });
    const projection = JSON.parse(projectionJson ?? "{}") as {
      facts?: Array<{ factKey: string }>;
    };
    const factKey = projection.facts?.[0]?.factKey;
    if (!factKey) throw new Error("The callback-policy projection has no authorized fact.");
    const completedAt = 3_000_100;
    const leadingHypothesis = {
      stance: "leading" as const,
      statement: "A shared handoff is delaying both operational pipelines.",
      confidence: 0.6,
      evidenceFactKeys: [factKey],
    };
    const base = {
      episodeId: episode._id,
      revision: episode.revision,
      summary: "Two operational queues show a shared delivery bottleneck.",
      confidence: 0.65,
      suggestedAction: "Ask an operator to inspect the two affected pipelines.",
      hypotheses: [leadingHypothesis],
      predictions: [],
      counterfactuals: [],
      agentVersion: "operations-episode-v1",
      model: "openai/gpt-5-mini",
      completedAt,
    };

    await expect(backend.mutation(internal.operationsEpisodes.recordAnalysis, {
      ...base,
      operationId: "episode-analysis:two-leading",
      hypotheses: [leadingHypothesis, {
        ...leadingHypothesis,
        statement: "A second leading cause cannot be equally authoritative.",
      }],
    })).rejects.toThrow("exactly one leading hypothesis");
    await expect(backend.mutation(internal.operationsEpisodes.recordAnalysis, {
      ...base,
      operationId: "episode-analysis:scoring-language",
      summary: "The stalled pipeline has a poor operational score.",
    })).rejects.toThrow("cannot contain scoring");
    await expect(backend.mutation(internal.operationsEpisodes.recordAnalysis, {
      ...base,
      operationId: "episode-analysis:short-horizon",
      predictions: [{
        statement: "The episode will remain active at the stated horizon.",
        expectedState: "active" as const,
        probability: 0.6,
        horizonAt: completedAt + 60_000,
        evidenceFactKeys: [factKey],
      }],
    })).rejects.toThrow("between five minutes and seven days");
    await expect(backend.mutation(internal.operationsEpisodes.recordAnalysis, {
      ...base,
      operationId: "episode-analysis:fabricated-fact",
      hypotheses: [{ ...leadingHypothesis, evidenceFactKeys: ["fabricated-fact"] }],
    })).rejects.toThrow("facts from this episode");

    expect(await backend.mutation(internal.operationsEpisodes.recordAnalysis, {
      ...base,
      operationId: "episode-analysis:accepted",
      predictions: [{
        statement: "The episode will remain active until the handoff is inspected.",
        expectedState: "active",
        probability: 0.6,
        horizonAt: completedAt + 5 * 60_000,
        evidenceFactKeys: [factKey],
      }],
    })).toBe("accepted");
    expect(await backend.run((ctx) => ctx.db.get(episode._id))).toMatchObject({
      analysisState: { kind: "ready", revision: episode.revision },
      analysisAgentVersion: "operations-episode-v1",
    });
  });
});
