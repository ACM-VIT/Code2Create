import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { autonomyOperationId } from "../lib/autonomyOperationId.ts";
import { AutonomyProductionRuntimeEvaluation } from "./autonomy-runtime-harness.ts";

let activeEvaluation: AutonomyProductionRuntimeEvaluation | undefined;

describe("operations autonomy production-runtime evaluation", () => {
  afterEach(async () => {
    await activeEvaluation?.stop();
    activeEvaluation = undefined;
    vi.unstubAllGlobals();
  });

  test("recovers durably while exhaustive observe mode reaches no domain effect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "c2c-autonomy-eval-"));
    const evaluation = new AutonomyProductionRuntimeEvaluation(directory);
    activeEvaluation = evaluation;
    vi.stubGlobal("fetch", evaluation.backend.request);

    await evaluation.start();
    await evaluation.dispatchInitial();
    expect(evaluation.observation().plannerPrompts).toBe(1);

    // Stop the real Node Flue runtime and reopen the same SQLite persistence.
    // The next work item must resume its stored reading progress, not replan.
    await evaluation.coldRestart();

    evaluation.queueOuterFailure("omit_tool");
    expect(await evaluation.dispatchContinuation()).toBe("failed");
    evaluation.queueOuterFailure("provider_error");
    expect(await evaluation.dispatchContinuation()).toBe("failed");

    // A test runaway detector, not a production work-item or reasoning quota.
    for (let workItem = 0; workItem < 24; workItem += 1) {
      if (evaluation.backend.terminalStates().length > 0) break;
      await evaluation.dispatchContinuation();
    }

    expect(evaluation.backend.terminalStates()).toEqual(["escalated"]);
    expect(evaluation.terminalEffects()).toEqual([
      `purge:${evaluation.input.runId}`,
      `settle:${evaluation.input.runId}`,
      `callback:${evaluation.input.runId}`,
    ]);
    const observation = evaluation.observation();
    expect(observation).toMatchObject({
      plannerPrompts: 1,
      investigatorPrompts: 4,
      synthesisPrompts: 2,
      invalidObserveCandidateAttempts: 1,
      hostilePromptSeen: true,
    });

    const laterPageOperationId = await autonomyOperationId("read", [
      evaluation.input.runId,
      "operations_attention",
      "1",
    ]);
    expect(evaluation.backend.effectCount("read", laterPageOperationId)).toBe(1);
    expect(
      evaluation.backend.trace.filter((entry) => entry.boundary === "recommendation_support"),
    ).toEqual([]);
    expect(evaluation.backend.trace.filter((entry) => entry.boundary === "recommendation")).toEqual(
      [],
    );
    expect(
      evaluation.backend.trace.filter((entry) => entry.boundary === "work" && !entry.replayed)
        .length,
    ).toBeGreaterThan(observation.investigatorPrompts + observation.synthesisPrompts);
  });

  test("seals multi-page evidence and publishes one exact recommendation under replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "c2c-autonomy-recommend-eval-"));
    const evaluation = new AutonomyProductionRuntimeEvaluation(directory, "recommend");
    activeEvaluation = evaluation;
    evaluation.backend.loseNextRecommendationEvidenceResponse();
    evaluation.backend.loseNextRecommendationResponse();
    vi.stubGlobal("fetch", evaluation.backend.request);

    await evaluation.start();
    await evaluation.dispatchInitial();
    for (let workItem = 0; workItem < 48; workItem += 1) {
      if (evaluation.backend.terminalStates().length > 0) break;
      await evaluation.dispatchContinuation();
    }

    const boundaryCounts: Record<string, number> = {};
    for (const entry of evaluation.backend.trace) {
      const key = `${entry.boundary}:${entry.replayed}`;
      boundaryCounts[key] = (boundaryCounts[key] ?? 0) + 1;
    }

    expect(
      evaluation.backend.terminalStates(),
      JSON.stringify({
        observation: evaluation.observation(),
        recommendations: evaluation.backend.recommendations().length,
        boundaries: boundaryCounts,
      }),
    ).toEqual(["succeeded"]);
    expect(evaluation.terminalEffects()).toEqual([
      `purge:${evaluation.input.runId}`,
      `settle:${evaluation.input.runId}`,
      `callback:${evaluation.input.runId}`,
    ]);
    const recommendations = evaluation.backend.recommendations();
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]).toMatchObject({
      targetCitationIdentity: expect.stringMatching(/^[a-f0-9]{64}$/u),
      arguments: {
        kind: "dismiss_attention_item",
        itemId: "attention-final",
        expectedItemVersion: 7,
      },
      evidenceSet: {
        leafCount: 5,
        chunkCount: 2,
      },
    });
    const evidenceEffects = evaluation.backend.trace.filter(
      (entry) => entry.boundary === "recommendation_support" && !entry.replayed,
    );
    expect(evidenceEffects).toHaveLength(2);
    expect(new Set(evidenceEffects.map((entry) => entry.operationId)).size).toBe(2);
    expect(
      evaluation.backend.trace.some(
        (entry) => entry.boundary === "recommendation_support" && entry.replayed,
      ),
    ).toBe(true);
    const recommendationEffects = evaluation.backend.trace.filter(
      (entry) => entry.boundary === "recommendation",
    );
    expect(recommendationEffects.filter((entry) => !entry.replayed)).toHaveLength(1);
    expect(recommendationEffects.some((entry) => entry.replayed)).toBe(true);
    const traceLengthBeforeReplay = evaluation.backend.trace.length;
    expect(await evaluation.replayCurrentContinuation()).toBe("completed");
    expect(evaluation.backend.trace).toHaveLength(traceLengthBeforeReplay);
    expect(evaluation.backend.recommendations()).toHaveLength(1);
    expect(evaluation.observation()).toMatchObject({
      invalidObserveCandidateAttempts: 0,
      adjudicationPrompts: 1,
      hostilePromptSeen: true,
    });
  });
});
