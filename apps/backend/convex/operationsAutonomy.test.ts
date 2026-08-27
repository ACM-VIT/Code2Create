import { operationFingerprint } from "./lib/operations.ts";
import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";

import {
  operationsAutonomyAdmissionSignatureMaximumAgeMs,
  operationsIntelligenceProtocolVersion,
  type OperationsAutonomyRecommendationCitation,
  type OperationsAutonomyRecommendationEvidenceSeal,
} from "@code2create/domain";

import { api, components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { insertPermissionGrant } from "./lib/permissions.ts";
import {
  appendEmergencyPackReadFactById,
  appendIncidentReadFactById,
} from "./lib/operationsAutonomyReadFacts/incidentReadiness.ts";
import { operationsAutonomyPolicyChecksum } from "./lib/operationsAutonomyPolicy.ts";
import { autonomyRecommendationCitationIdentity } from "./lib/operationsAutonomyRecommendationGrounding.ts";
import { operationsAutonomyReadPageMaximumBytes } from "./lib/operationsAutonomyReadLimits.ts";
import { revokeOperationsAutonomyPolicy } from "./lib/operationsAutonomyRevocation.ts";
import { operationsAutonomyOutboundAttemptLifetimeMs } from "./operationsAutonomyDispatch.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

const savedEnvironment = {
  AUTH_SITE_URL: process.env.AUTH_SITE_URL,
  PARTICIPANT_SITE_URL: process.env.PARTICIPANT_SITE_URL,
  OPERATIONS_SITE_URL: process.env.OPERATIONS_SITE_URL,
  INTELLIGENCE_INGRESS_SECRET: process.env.INTELLIGENCE_INGRESS_SECRET,
  INTELLIGENCE_WORKER_URL: process.env.INTELLIGENCE_WORKER_URL,
};

process.env.AUTH_SITE_URL = "http://localhost:3211";
process.env.PARTICIPANT_SITE_URL = "http://localhost:4173";
process.env.OPERATIONS_SITE_URL = "http://localhost:4174";
process.env.INTELLIGENCE_INGRESS_SECRET = "autonomy-ingress-test-secret".padEnd(48, "s");
process.env.INTELLIGENCE_WORKER_URL = "https://intelligence.example.test";

afterEach(() => vi.unstubAllGlobals());

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("operations autonomy durable boundaries", () => {
  test("a lost work response replays byte-for-byte after later work", async () => {
    const backend = seededBackend();
    const fixture = await seedRun(backend);
    const firstRequest = workRequest(fixture, "model-turn-0001", { kind: "model" as const });
    const first = await backend.mutation(internal.operationsAutonomyOperations.authorizeWork, {
      request: firstRequest,
      now: fixture.now,
    });
    const second = await backend.mutation(internal.operationsAutonomyOperations.authorizeWork, {
      request: workRequest(fixture, "delegation-0001", {
        kind: "delegation" as const,
        area: "reviews" as const,
      }),
      now: fixture.now + 1,
    });
    expect(second.state).toBe("accepted");
    const replay = await backend.mutation(internal.operationsAutonomyOperations.authorizeWork, {
      request: firstRequest,
      now: fixture.now + 2,
    });
    expect(replay).toEqual(first);
    await expect(
      backend.mutation(internal.operationsAutonomyOperations.authorizeWork, {
        request: { ...firstRequest, operation: { kind: "delegation", area: "reviews" } },
        now: fixture.now + 3,
      }),
    ).rejects.toThrow("already used");
    const checkpoint = await backend.run((ctx) =>
      ctx.db
        .query("operationsAutonomyRunCheckpoints")
        .withIndex("by_run", (index) => index.eq("runId", fixture.runId))
        .unique(),
    );
    expect(checkpoint).toMatchObject({ sequence: 2, delegationsUsed: 1 });
  });

  test("read retries resume one reservation and exact completion replays", async () => {
    const backend = seededBackend();
    const fixture = await seedRun(backend);
    const request = readRequest(fixture, "read-page-0001");
    const prepared = await backend.mutation(internal.operationsAutonomyReads.prepareRead, {
      request,
      now: fixture.now,
    });
    expect(prepared.state).toBe("execute");
    expect(
      await backend.mutation(internal.operationsAutonomyReads.prepareRead, {
        request,
        now: fixture.now + 1,
      }),
    ).toEqual(prepared);
    const dataJson = JSON.stringify({
      generatedAt: fixture.now,
      vacancies: [],
      teams: [],
      atLeast: false,
    });
    const responseJson = await backend.mutation(internal.operationsAutonomyReads.commitRead, {
      request,
      dataJson,
      dataBytes: new TextEncoder().encode(dataJson).byteLength,
      generatedAt: fixture.now,
      citationRows: [],
      isDone: true,
      now: fixture.now + 2,
    });
    expect(responseJson.state).toBe("committed");
    if (responseJson.state !== "committed") throw new Error("Read commit was rejected.");
    expect(JSON.parse(responseJson.responseJson)).toMatchObject({
      state: "accepted",
      sequence: 1,
      page: { isDone: true },
    });
    expect(
      await backend.mutation(internal.operationsAutonomyReads.prepareRead, {
        request,
        now: fixture.now + 3,
      }),
    ).toEqual({ state: "replay", responseJson: responseJson.responseJson });
  });

  test("a delayed read commit never rewinds the server operation sequence", async () => {
    const backend = seededBackend();
    const fixture = await seedRun(backend);
    const request = readRequest(fixture, "read-delayed-commit-0001");
    await backend.mutation(internal.operationsAutonomyReads.prepareRead, {
      request,
      now: fixture.now,
    });
    const workB = await backend.mutation(internal.operationsAutonomyOperations.authorizeWork, {
      request: workRequest(fixture, "model-during-read-0001", { kind: "model" }),
      now: fixture.now + 1,
    });
    expect(workB.state).toBe("accepted");
    const dataJson = JSON.stringify({
      generatedAt: fixture.now,
      vacancies: [],
      teams: [],
      atLeast: false,
    });
    const committed = await backend.mutation(internal.operationsAutonomyReads.commitRead, {
      request,
      dataJson,
      dataBytes: new TextEncoder().encode(dataJson).byteLength,
      generatedAt: fixture.now,
      citationRows: [],
      isDone: true,
      now: fixture.now + 2,
    });
    expect(committed.state).toBe("committed");
    const workC = await backend.mutation(internal.operationsAutonomyOperations.authorizeWork, {
      request: workRequest(fixture, "model-after-read-0001", { kind: "model" }),
      now: fixture.now + 3,
    });
    expect(workC.state).toBe("accepted");
    const replay = await backend.mutation(internal.operationsAutonomyReads.prepareRead, {
      request,
      now: fixture.now + 4,
    });
    if (committed.state !== "committed") throw new Error("Read commit was rejected.");
    expect(replay).toEqual({ state: "replay", responseJson: committed.responseJson });
    const checkpoint = await backend.run((ctx) =>
      ctx.db
        .query("operationsAutonomyRunCheckpoints")
        .withIndex("by_run", (index) => index.eq("runId", fixture.runId))
        .unique(),
    );
    expect(checkpoint).toMatchObject({
      sequence: 3,
      toolCallsUsed: 1,
      readBytesUsed: new TextEncoder().encode(dataJson).byteLength,
      activeRead: { kind: "none" },
    });
  });

  test("a deep read outside the frozen policy allowlist is rejected", async () => {
    const backend = seededBackend();
    const fixture = await seedRun(backend);
    await expect(
      backend.mutation(internal.operationsAutonomyReads.prepareRead, {
        request: {
          ...identity(fixture),
          operationId: "unauthorized-deep-read-0001",
          read: "attendance_operations",
        },
        now: fixture.now,
      }),
    ).rejects.toThrow("not authorized by the frozen autonomy policy");
  });

  test("a reserved read cannot resume or commit after owner revocation", async () => {
    const backend = seededBackend();
    const fixture = await seedRun(backend);
    const request = readRequest(fixture, "read-revoked-owner-0001");
    await backend.mutation(internal.operationsAutonomyReads.prepareRead, {
      request,
      now: fixture.now,
    });
    await backend.run((ctx) => ctx.db.patch(fixture.ownerSubjectId, { status: "suspended" }));
    expect(
      await backend.mutation(internal.operationsAutonomyReads.prepareRead, {
        request,
        now: fixture.now + 1,
      }),
    ).toEqual({ state: "rejected", code: "authority_revoked" });
    const dataJson = JSON.stringify({
      generatedAt: fixture.now,
      vacancies: [],
      teams: [],
      atLeast: false,
    });
    expect(
      await backend.mutation(internal.operationsAutonomyReads.commitRead, {
        request,
        dataJson,
        dataBytes: new TextEncoder().encode(dataJson).byteLength,
        generatedAt: fixture.now,
        citationRows: [],
        isDone: true,
        now: fixture.now + 2,
      }),
    ).toEqual({ state: "rejected", code: "authority_revoked" });
    const state = await backend.run(async (ctx) => ({
      checkpoint: await ctx.db
        .query("operationsAutonomyRunCheckpoints")
        .withIndex("by_run", (index) => index.eq("runId", fixture.runId))
        .unique(),
      receipt: await ctx.db
        .query("operationsAutonomyOperationReceipts")
        .withIndex("by_run_operation", (index) =>
          index.eq("runId", fixture.runId).eq("operationId", request.operationId),
        )
        .unique(),
    }));
    expect(state.checkpoint).toMatchObject({ readBytesUsed: 0 });
    expect(state.receipt).toMatchObject({ state: "reserved" });
  });

  test("recommendation evidence seals more than eight exact citations and remains fully reachable", async () => {
    const backend = seededBackend();
    const fixture = await seedRun(backend);
    const evidence = await seedRecommendationGroundingEvidence(backend, fixture);
    const targetId = String(evidence.teamRoundStateId);
    const targetVersion = String(evidence.expectedVersion);
    const proposalKey = "proposal-sealed-evidence-0001";
    const evidenceSetId = "evidence-sealed-set-0001";
    const citations = evidence.exactPages.map((page, index) => ({
      read: "review_exceptions" as const,
      generatedAt: evidence.generatedAt,
      keys: [targetId, targetVersion, `support-${String(index).padStart(2, "0")}`].sort(),
      operationId: page.operationId,
      snapshot: page.snapshot,
    })).sort((left, right) =>
      autonomyRecommendationCitationIdentity(left)
        .localeCompare(autonomyRecommendationCitationIdentity(right))
    );
    expect(citations).toHaveLength(12);
    const firstRequest = recommendationEvidenceRequest(fixture, {
      operationId: "evidence-page-0000",
      proposalKey,
      evidenceSetId,
      pageIndex: 0,
      citations: citations.slice(0, 4),
      isDone: false,
    });
    const first = await backend.mutation(
      internal.operationsAutonomyRecommendationEvidence.appendRecommendationEvidence,
      { request: firstRequest, now: fixture.now + 20 },
    );
    if (first.state !== "accepted") throw new Error("The first evidence page was rejected.");
    const firstReceipt = await storedRecommendationEvidenceReceipt(
      backend,
      fixture.runId,
      firstRequest.operationId,
    );
    const secondRequest = recommendationEvidenceRequest(fixture, {
      operationId: "evidence-page-0001",
      proposalKey,
      evidenceSetId,
      pageIndex: 1,
      previousPageHash: firstReceipt.pageHash,
      citations: citations.slice(4, 8),
      isDone: false,
    });
    const second = await backend.mutation(
      internal.operationsAutonomyRecommendationEvidence.appendRecommendationEvidence,
      { request: secondRequest, now: fixture.now + 21 },
    );
    if (second.state !== "accepted") throw new Error("The second evidence page was rejected.");
    const replayAfterB = await backend.mutation(
      internal.operationsAutonomyRecommendationEvidence.appendRecommendationEvidence,
      { request: firstRequest, now: fixture.now + 22 },
    );
    expect(replayAfterB).toEqual(first);
    await expect(
      backend.mutation(
        internal.operationsAutonomyRecommendationEvidence.appendRecommendationEvidence,
        {
          request: { ...firstRequest, isDone: true },
          now: fixture.now + 23,
        },
      ),
    ).rejects.toThrow("already used");
    const secondReceipt = await storedRecommendationEvidenceReceipt(
      backend,
      fixture.runId,
      secondRequest.operationId,
    );
    const terminal = await backend.mutation(
      internal.operationsAutonomyRecommendationEvidence.appendRecommendationEvidence,
      {
        request: recommendationEvidenceRequest(fixture, {
          operationId: "evidence-page-0002",
          proposalKey,
          evidenceSetId,
          pageIndex: 2,
          previousPageHash: secondReceipt.pageHash,
          citations: citations.slice(8, 12),
          isDone: true,
        }),
        now: fixture.now + 24,
      },
    );
    if (terminal.state !== "accepted") throw new Error("The evidence seal was rejected.");
    const terminalReceipt = await storedRecommendationEvidenceReceipt(
      backend,
      fixture.runId,
      "evidence-page-0002",
    );
    const terminalSeal = await storedRecommendationEvidenceSeal(
      backend,
      fixture.runId,
      evidenceSetId,
    );
    expect(terminalSeal).toMatchObject({
      evidenceSetId,
      rootHash: terminalReceipt.pageHash,
      leafCount: 12,
      chunkCount: 3,
    });
    const targetCitation = citations[0];
    if (targetCitation === undefined) throw new Error("The target citation is missing.");
    const accepted = await backend.mutation(
      internal.operationsAutonomyRecommendations.proposeRecommendation,
      {
        request: recommendationRequest(fixture, {
          operationId: "proposal-sealed-evidence-0001",
          proposalKey,
          teamRoundStateId: targetId,
          expectedVersion: evidence.expectedVersion,
          evidenceSet: terminalSeal,
          targetCitationIdentity: autonomyRecommendationCitationIdentity(targetCitation),
        }),
        now: fixture.now + 25,
      },
    );
    expect(accepted.state).toBe("accepted");
    const rows = await backend.run((ctx) => ctx.db.query("intelligenceRecommendations").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      arguments: {
        kind: "hold_review_team",
        teamRoundStateId: evidence.teamRoundStateId,
        expectedTeamRoundStateVersion: evidence.expectedVersion,
      },
      provenance: {
        kind: "autonomy",
        runId: fixture.runId,
        evidenceSet: terminalSeal,
      },
      status: "proposed",
    });
    const recommendationId = rows[0]?._id;
    if (recommendationId === undefined) throw new Error("The recommendation is missing.");
    const operator = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });
    const observations = await operator.query(
      api.operationsAutonomyRecommendationEvidence.observations,
      {
        eventSlug: fixture.slug,
        recommendationId,
        paginationOpts: { numItems: 5, cursor: null },
      },
    );
    expect(observations.page).toHaveLength(1);
    const observationId = observations.page[0]?.id;
    if (observationId === undefined) throw new Error("The autonomy observation is missing.");
    const leaves: string[] = [];
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const page: {
        page: Array<{ identity: string }>;
        isDone: boolean;
        continueCursor: string;
      } = await operator.query(api.operationsAutonomyRecommendationEvidence.page, {
        eventSlug: fixture.slug,
        recommendationId,
        observationId,
        paginationOpts: { numItems: 5, cursor },
      });
      leaves.push(...page.page.map((leaf) => leaf.identity));
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(leaves).toEqual(citations.map(autonomyRecommendationCitationIdentity));
  });

  test("evidence chain gaps, reordering, row splicing, and seal drift are rejected", async () => {
    const backend = seededBackend();
    const fixture = await seedRun(backend);
    const evidence = await seedRecommendationGroundingEvidence(backend, fixture);
    const targetId = String(evidence.teamRoundStateId);
    const targetVersion = String(evidence.expectedVersion);
    const exactCitation = {
      read: "review_exceptions" as const,
      generatedAt: evidence.generatedAt,
      keys: [targetId, targetVersion, "support-00"].sort(),
      operationId: evidence.exact.operationId,
      snapshot: evidence.exact.snapshot,
    };
    await expect(backend.mutation(
      internal.operationsAutonomyRecommendationEvidence.appendRecommendationEvidence,
      {
        request: recommendationEvidenceRequest(fixture, {
          operationId: "evidence-gap-page-0001",
          proposalKey: "proposal-evidence-gap-0001",
          evidenceSetId: "evidence-gap-set-0001",
          pageIndex: 1,
          previousPageHash: "a".repeat(64),
          citations: [exactCitation],
          isDone: true,
        }),
        now: fixture.now + 30,
      },
    )).rejects.toThrow("exact current chain");
    const secondCitation = {
      ...exactCitation,
      keys: [targetId, targetVersion, "support-01"].sort(),
      operationId: evidence.exactPages[1]?.operationId ?? "missing",
      snapshot: evidence.exactPages[1]?.snapshot ?? "missing",
    };
    const ordered = [exactCitation, secondCitation].sort((left, right) =>
      autonomyRecommendationCitationIdentity(left)
        .localeCompare(autonomyRecommendationCitationIdentity(right))
    );
    await expect(backend.mutation(
      internal.operationsAutonomyRecommendationEvidence.appendRecommendationEvidence,
      {
        request: recommendationEvidenceRequest(fixture, {
          operationId: "evidence-reordered-page-0001",
          proposalKey: "proposal-evidence-reorder-0001",
          evidenceSetId: "evidence-reorder-set-0001",
          pageIndex: 0,
          citations: [...ordered].reverse(),
          isDone: true,
        }),
        now: fixture.now + 31,
      },
    )).rejects.toThrow("canonically ordered");
    await expect(backend.mutation(
      internal.operationsAutonomyRecommendationEvidence.appendRecommendationEvidence,
      {
        request: recommendationEvidenceRequest(fixture, {
          operationId: "evidence-spliced-page-0001",
          proposalKey: "proposal-evidence-splice-0001",
          evidenceSetId: "evidence-splice-set-0001",
          pageIndex: 0,
          citations: [{
            ...exactCitation,
            operationId: evidence.crossRow.operationId,
            snapshot: evidence.crossRow.snapshot,
          }],
          isDone: true,
        }),
        now: fixture.now + 32,
      },
    )).rejects.toThrow("exact stored read page and row");
    const sealed = await backend.mutation(
      internal.operationsAutonomyRecommendationEvidence.appendRecommendationEvidence,
      {
        request: recommendationEvidenceRequest(fixture, {
          operationId: "evidence-drift-page-0001",
          proposalKey: "proposal-evidence-drift-0001",
          evidenceSetId: "evidence-drift-set-0001",
          pageIndex: 0,
          citations: [exactCitation],
          isDone: true,
        }),
        now: fixture.now + 33,
      },
    );
    if (sealed.state !== "accepted") throw new Error("The drift fixture was rejected.");
    const seal = await storedRecommendationEvidenceSeal(
      backend,
      fixture.runId,
      "evidence-drift-set-0001",
    );
    await expect(backend.mutation(
      internal.operationsAutonomyRecommendations.proposeRecommendation,
      {
        request: recommendationRequest(fixture, {
          operationId: "proposal-evidence-missing-target-0001",
          proposalKey: "proposal-evidence-drift-0001",
          teamRoundStateId: targetId,
          expectedVersion: evidence.expectedVersion,
          evidenceSet: seal,
          targetCitationIdentity: "e".repeat(64),
        }),
        now: fixture.now + 34,
      },
    )).rejects.toThrow("absent from the sealed set");
    await expect(backend.mutation(
      internal.operationsAutonomyRecommendations.proposeRecommendation,
      {
        request: recommendationRequest(fixture, {
          operationId: "proposal-evidence-drift-0001",
          proposalKey: "proposal-evidence-drift-0001",
          teamRoundStateId: targetId,
          expectedVersion: evidence.expectedVersion,
          evidenceSet: { ...seal, rootHash: "f".repeat(64) },
          targetCitationIdentity: autonomyRecommendationCitationIdentity(exactCitation),
        }),
        now: fixture.now + 35,
      },
    )).rejects.toThrow("exact current sealed evidence set");
  });

  test("fact traversal exhausts more than 101 rows and stays frozen through churn", async () => {
    const backend = seededBackend();
    const fixture = await seedRun(backend);
    const seeded = await backend.run(async (ctx) => {
      const itemIds: Array<Id<"operationsAttentionItems">> = [];
      const factIds: Array<Id<"operationsAutonomyReadFacts">> = [];
      for (let index = 0; index < 105; index += 1) {
        const sequence = index + 1;
        const itemId = await ctx.db.insert("operationsAttentionItems", {
          eventId: fixture.eventId,
          detectorKey: "panel_seat_empty",
          dedupeKey: `ledger-${index}`,
          subjectType: "panel",
          subjectId: `panel-${index}`,
          severity: "critical",
          statement: "Private detector detail",
          route: "/judging",
          actionLabel: "Review",
          visibility: {
            permissionKey: "operations.health.read",
            scopeType: "panel",
            scopeId: `panel-${index}`,
          },
          evidenceJson: "{}",
          state: "open",
          recurrenceCount: 1,
          firstObservedAt: fixture.now + sequence,
          lastObservedAt: fixture.now + sequence,
          version: 1,
        });
        itemIds.push(itemId);
        factIds.push(await ctx.db.insert("operationsAutonomyReadFacts", {
          eventId: fixture.eventId,
          source: "operations_attention",
          entityKey: `attention:${itemId}`,
          sequence,
          value: {
            itemId,
            detectorKey: "panel_seat_empty",
            subjectType: "panel",
            severity: "critical",
            state: "open",
            version: 1,
            recurrenceCount: 1,
            firstObservedAt: fixture.now + sequence,
            lastObservedAt: fixture.now + sequence,
          },
          createdAt: fixture.now + sequence,
        }));
      }
      await ctx.db.patch(factIds[0]!, { effectiveThroughSequence: 105 });
      const firstVersionTwo = await ctx.db.insert("operationsAutonomyReadFacts", {
        eventId: fixture.eventId,
        source: "operations_attention",
        entityKey: `attention:${itemIds[0]!}`,
        sequence: 106,
        value: {
          itemId: itemIds[0]!,
          detectorKey: "panel_seat_empty",
          subjectType: "panel",
          severity: "attention",
          state: "open",
          version: 2,
          recurrenceCount: 1,
          firstObservedAt: fixture.now + 1,
          lastObservedAt: fixture.now + 106,
        },
        createdAt: fixture.now + 106,
      });
      await ctx.db.patch(factIds[1]!, { effectiveThroughSequence: 106 });
      await ctx.db.insert("operationsAutonomyReadFacts", {
        eventId: fixture.eventId,
        source: "operations_attention",
        entityKey: `attention:${itemIds[1]!}`,
        sequence: 107,
        value: {
          itemId: itemIds[1]!,
          detectorKey: "panel_seat_empty",
          subjectType: "panel",
          severity: "critical",
          state: "dismissed",
          version: 2,
          recurrenceCount: 1,
          firstObservedAt: fixture.now + 2,
          lastObservedAt: fixture.now + 107,
        },
        createdAt: fixture.now + 107,
      });
      const snapshot = "snapshot:fact-churn-regression";
      await ctx.db.insert("operationsAutonomyReadTraversals", {
        eventId: fixture.eventId,
        runId: fixture.runId,
        snapshot,
        read: "operations_attention",
        generatedAt: fixture.now,
        kind: "facts",
        highWatermark: 107,
        summaryJson: "{}",
        createdAt: fixture.now,
      });
      await ctx.db.patch(firstVersionTwo, { effectiveThroughSequence: 107 });
      await ctx.db.insert("operationsAutonomyReadFacts", {
        eventId: fixture.eventId,
        source: "operations_attention",
        entityKey: `attention:${itemIds[0]!}`,
        sequence: 108,
        value: {
          itemId: itemIds[0]!,
          detectorKey: "panel_seat_empty",
          subjectType: "panel",
          severity: "attention",
          state: "resolved",
          version: 3,
          recurrenceCount: 1,
          firstObservedAt: fixture.now + 1,
          lastObservedAt: fixture.now + 108,
        },
        createdAt: fixture.now + 108,
      });
      const laterItemId = await ctx.db.insert("operationsAttentionItems", {
        eventId: fixture.eventId,
        detectorKey: "panel_seat_empty",
        dedupeKey: "ledger-later",
        subjectType: "panel",
        subjectId: "panel-later",
        severity: "critical",
        statement: "Private later detail",
        route: "/judging",
        actionLabel: "Review",
        visibility: {
          permissionKey: "operations.health.read",
          scopeType: "panel",
          scopeId: "panel-later",
        },
        evidenceJson: "{}",
        state: "open",
        recurrenceCount: 1,
        firstObservedAt: fixture.now + 109,
        lastObservedAt: fixture.now + 109,
        version: 1,
      });
      await ctx.db.insert("operationsAutonomyReadFacts", {
        eventId: fixture.eventId,
        source: "operations_attention",
        entityKey: `attention:${laterItemId}`,
        sequence: 109,
        value: {
          itemId: laterItemId,
          detectorKey: "panel_seat_empty",
          subjectType: "panel",
          severity: "critical",
          state: "open",
          version: 1,
          recurrenceCount: 1,
          firstObservedAt: fixture.now + 109,
          lastObservedAt: fixture.now + 109,
        },
        createdAt: fixture.now + 109,
      });
      return { itemIds, laterItemId, snapshot };
    });

    let cursorStateJson = JSON.stringify({
      kind: "facts",
      snapshot: seeded.snapshot,
      afterSequence: 0,
    });
    const rows: Array<{ itemId: string; version: number; severity: string }> = [];
    for (let pageNumber = 0; pageNumber < 40; pageNumber += 1) {
      const page = await backend.query(internal.operationsAutonomyReadPages.executePage, {
        runId: fixture.runId,
        read: "operations_attention",
        cursorStateJson,
      });
      const parsed: unknown = JSON.parse(page.dataJson);
      if (typeof parsed !== "object" || parsed === null || !("items" in parsed) || !Array.isArray(parsed.items)) {
        throw new Error("The attention fact page is invalid.");
      }
      for (const item of parsed.items) {
        if (
          typeof item !== "object" || item === null ||
          !("itemId" in item) || typeof item.itemId !== "string" ||
          !("version" in item) || typeof item.version !== "number" ||
          !("severity" in item) || typeof item.severity !== "string"
        ) throw new Error("An attention fact row is invalid.");
        rows.push({ itemId: item.itemId, version: item.version, severity: item.severity });
      }
      if (page.isDone) break;
      if (page.nextCursorStateJson === undefined) throw new Error("The fact page cursor is missing.");
      cursorStateJson = page.nextCursorStateJson;
    }
    expect(rows).toHaveLength(104);
    expect(new Set(rows.map((row) => row.itemId)).size).toBe(104);
    expect(rows).not.toContainEqual(expect.objectContaining({ itemId: seeded.itemIds[1] }));
    expect(rows).not.toContainEqual(expect.objectContaining({ itemId: seeded.laterItemId }));
    expect(rows.filter((row) => row.itemId === seeded.itemIds[0])).toEqual([
      { itemId: seeded.itemIds[0], version: 2, severity: "attention" },
    ]);
  });

  test("the 102nd deep-source episode is queued and each run reads its frozen high-watermark", async () => {
    const backend = seededBackend();
    const fixture = await seedRun(backend);
    const episodes = await backend.run(async (ctx) => {
      const health = await ctx.db
        .query("operationsHealthSnapshots")
        .withIndex("by_event", (index) => index.eq("eventId", fixture.eventId))
        .unique();
      if (!health) throw new Error("The autonomy health snapshot is missing.");
      const sourceSnapshot = {
        ...health.snapshot,
        summary: {
          status: "critical" as const,
          signalCount: 1,
          criticalSignalCount: 1,
          attentionSignalCount: 0,
          watchSignalCount: 0,
        },
        signals: [{
          key: "critical_incidents" as const,
          area: "system" as const,
          severity: "critical" as const,
          title: "Critical incidents need attention",
          detail: "One or more incidents require the operations owner.",
          owner: "Event operations",
          nextAction: "Inspect the redacted incident readiness ledger.",
          count: 1,
          atLeast: false,
          oldestAt: fixture.now,
        }],
      };
      await ctx.db.patch(health._id, { snapshot: sourceSnapshot });
      for (let index = 0; index < 102; index += 1) {
        const observedAt = fixture.now + index + 1;
        const incidentId = await ctx.db.insert("incidents", {
          eventId: fixture.eventId,
          title: `incident-secret-title-${index}`,
          summary: `private-summary-${index}`,
          severity: "critical",
          affectedService: index % 2 === 0 ? "attendance_backend" : "review_backend",
          state: "open",
          manualModeState: "not_requested",
          manualModeApprovalCount: 0,
          openedByPersonId: fixture.personId,
          openedAt: observedAt,
          version: 1,
          updatedAt: observedAt,
        });
        await appendIncidentReadFactById(ctx, incidentId, observedAt);
      }
      const queued = await ctx.db
        .query("operationsAutonomyInbox")
        .withIndex("by_event_policy_lifecycle", (index) =>
          index
            .eq("eventId", fixture.eventId)
            .eq("policyVersionId", fixture.policyId)
            .eq("lifecycle.kind", "pending"),
        )
        .collect();
      const episodes = queued
        .map((item) => ({
          inboxId: item._id,
          sequence: item.sourceFactHighWatermarks.find(
            (entry) => entry.read === "incident_readiness",
          )?.sequence,
        }))
        .filter((item): item is { inboxId: Id<"operationsAutonomyInbox">; sequence: number } =>
          item.sequence !== undefined,
        )
        .toSorted((left, right) => left.sequence - right.sequence);
      const firstIncident = await ctx.db
        .query("incidents")
        .withIndex("by_event_opened", (index) => index.eq("eventId", fixture.eventId))
        .order("asc")
        .first();
      if (!firstIncident) throw new Error("The first incident was not created.");
      return { episodes, firstIncidentId: firstIncident._id };
    });
    expect(episodes.episodes).toHaveLength(102);
    expect(episodes.episodes.map((episode) => episode.sequence)).toEqual(
      Array.from({ length: 102 }, (_value, index) => index + 1),
    );

    await backend.run(async (ctx) => {
      const first = await ctx.db.get(episodes.firstIncidentId);
      if (!first) throw new Error("The first incident disappeared before churn.");
      const now = fixture.now + 150;
      await ctx.db.patch(first._id, {
        state: "resolved",
        manualModeState: "closed",
        resolvedByPersonId: fixture.personId,
        resolutionReason: "private-resolution-detail",
        resolvedAt: now,
        version: 2,
        updatedAt: now,
      });
      await appendIncidentReadFactById(ctx, first._id, now);
    });

    await backend.run(async (ctx) => {
      const active = await ctx.db.get(fixture.runId);
      if (!active) throw new Error("The initial autonomy run is missing.");
      await ctx.db.patch(active._id, {
        lifecycle: { kind: "succeeded", completedAt: fixture.now + 200 },
      });
    });

    const firstEpisode = episodes.episodes[0];
    const lastEpisode = episodes.episodes.at(-1);
    if (!firstEpisode || !lastEpisode) throw new Error("The source episodes are missing.");
    const firstRunId = await backend.mutation(
      internal.operationsAutonomyScheduler.materializeInbox,
      { inboxId: firstEpisode.inboxId, now: fixture.now + 201 },
    );
    if (!firstRunId) throw new Error("The first source episode did not materialize.");
    const firstRun = await backend.run((ctx) => ctx.db.get(firstRunId));
    if (!firstRun || firstRun.lifecycle.kind !== "active") {
      throw new Error("The first source episode did not activate.");
    }
    const firstRequest = {
      protocolVersion: operationsIntelligenceProtocolVersion,
      runId: firstRun._id,
      policyVersionId: firstRun.policyVersionId,
      policyChecksum: firstRun.policyChecksum,
      sourceChecksum: firstRun.sourceChecksum,
      operationId: "incident-frozen-first-page",
      read: "incident_readiness" as const,
    };
    const firstPrepared = await backend.mutation(
      internal.operationsAutonomyReads.prepareRead,
      { request: firstRequest, now: fixture.now + 202 },
    );
    if (firstPrepared.state !== "execute") throw new Error("The first deep read was not prepared.");
    const firstPage = await backend.query(internal.operationsAutonomyReadPages.executePage, {
      runId: firstRun._id,
      read: "incident_readiness",
      cursorStateJson: firstPrepared.cursorStateJson,
    });
    const firstItems = pageRecords(firstPage.dataJson, "items");
    expect(firstItems).toHaveLength(1);
    expect(firstItems[0]).toMatchObject({ kind: "incident", state: "open", version: 1 });
    expect(firstPage.dataJson).not.toContain("incident-secret-title");
    expect(firstPage.dataJson).not.toContain("private-summary");
    expect(firstPage.dataJson).not.toContain("openedByPersonId");

    await backend.run(async (ctx) => {
      const run = await ctx.db.get(firstRun._id);
      const checkpoint = await ctx.db
        .query("operationsAutonomyRunCheckpoints")
        .withIndex("by_run", (index) => index.eq("runId", firstRun._id))
        .unique();
      if (!run || !checkpoint) throw new Error("The first episode owner is missing.");
      await ctx.db.patch(run._id, {
        lifecycle: { kind: "succeeded", completedAt: fixture.now + 203 },
      });
      await ctx.db.patch(checkpoint._id, {
        phase: "terminal",
        activeRead: { kind: "none" },
      });
    });

    const lastRunId = await backend.mutation(
      internal.operationsAutonomyScheduler.materializeInbox,
      { inboxId: lastEpisode.inboxId, now: fixture.now + 204 },
    );
    if (!lastRunId) throw new Error("The final source episode did not materialize.");
    const lastRun = await backend.run((ctx) => ctx.db.get(lastRunId));
    if (!lastRun || lastRun.lifecycle.kind !== "active") {
      throw new Error("The final source episode did not activate.");
    }
    expect(lastRun.sourceFactHighWatermarks).toContainEqual({
      read: "incident_readiness",
      sequence: 102,
    });
    const lastPrepared = await backend.mutation(
      internal.operationsAutonomyReads.prepareRead,
      {
        request: {
          protocolVersion: operationsIntelligenceProtocolVersion,
          runId: lastRun._id,
          policyVersionId: lastRun.policyVersionId,
          policyChecksum: lastRun.policyChecksum,
          sourceChecksum: lastRun.sourceChecksum,
          operationId: "incident-frozen-final-page",
          read: "incident_readiness",
        },
        now: fixture.now + 205,
      },
    );
    if (lastPrepared.state !== "execute") throw new Error("The final deep read was not prepared.");
    const observedRows = new Map<string, Record<string, unknown>>();
    let cursorStateJson = lastPrepared.cursorStateJson;
    for (let pageNumber = 0; pageNumber < 30; pageNumber += 1) {
      const page = await backend.query(internal.operationsAutonomyReadPages.executePage, {
        runId: lastRun._id,
        read: "incident_readiness",
        cursorStateJson,
      });
      for (const item of pageRecords(page.dataJson, "items")) {
        if (typeof item.incidentId !== "string") throw new Error("An incident fact ID is invalid.");
        observedRows.set(item.incidentId, item);
      }
      expect(new TextEncoder().encode(page.dataJson).byteLength)
        .toBeLessThanOrEqual(operationsAutonomyReadPageMaximumBytes);
      expect(page.dataJson).not.toContain("incident-secret-title");
      expect(page.dataJson).not.toContain("private-summary");
      if (page.isDone) break;
      if (!page.nextCursorStateJson) throw new Error("The incident page cursor is missing.");
      cursorStateJson = page.nextCursorStateJson;
    }
    expect(observedRows.size).toBe(102);
    expect(observedRows.get(episodes.firstIncidentId)).toMatchObject({
      state: "open",
      version: 1,
    });
  });

  test("a non-projected work ID does not advance the source HWM or enqueue duplicate evidence", async () => {
    const backend = seededBackend();
    const fixture = await seedRun(backend);
    const result = await backend.run(async (ctx) => {
      const health = await ctx.db
        .query("operationsHealthSnapshots")
        .withIndex("by_event", (index) => index.eq("eventId", fixture.eventId))
        .unique();
      if (!health) throw new Error("The autonomy health snapshot is missing.");
      await ctx.db.patch(health._id, {
        snapshot: {
          ...health.snapshot,
          summary: {
            status: "critical",
            signalCount: 1,
            criticalSignalCount: 1,
            attentionSignalCount: 0,
            watchSignalCount: 0,
          },
          signals: [{
            key: "emergency_pack_stalls",
            area: "system",
            severity: "critical",
            title: "Emergency pack generation is stalled",
            detail: "A redacted emergency pack operation requires inspection.",
            owner: "Event operations",
            nextAction: "Inspect incident readiness operations.",
            count: 1,
            atLeast: false,
          }],
        },
      });
      const packId = await ctx.db.insert("emergencyPacks", {
        eventId: fixture.eventId,
        requestedByPersonId: fixture.personId,
        purpose: "private-purpose-that-must-not-be-projected",
        serialPrefix: "PRIVATE-SERIAL",
        spareAttendanceSheetCount: 1,
        spareReviewSheetCount: 1,
        status: "pending",
        expiresAt: fixture.now + 3_600_000,
        requestedAt: fixture.now,
        version: 1,
      });
      await appendEmergencyPackReadFactById(ctx, packId, fixture.now);
      const firstState = await ctx.db
        .query("operationsAutonomyReadFactStates")
        .withIndex("by_event_source", (index) =>
          index.eq("eventId", fixture.eventId).eq("source", "incident_readiness"),
        )
        .unique();
      const firstInbox = await ctx.db
        .query("operationsAutonomyInbox")
        .withIndex("by_event_policy_lifecycle", (index) =>
          index
            .eq("eventId", fixture.eventId)
            .eq("policyVersionId", fixture.policyId)
            .eq("lifecycle.kind", "pending"),
        )
        .collect();
      await ctx.db.patch(packId, { workId: "non-projected-work-id" });
      await appendEmergencyPackReadFactById(ctx, packId, fixture.now + 1);
      const finalState = await ctx.db
        .query("operationsAutonomyReadFactStates")
        .withIndex("by_event_source", (index) =>
          index.eq("eventId", fixture.eventId).eq("source", "incident_readiness"),
        )
        .unique();
      const finalInbox = await ctx.db
        .query("operationsAutonomyInbox")
        .withIndex("by_event_policy_lifecycle", (index) =>
          index
            .eq("eventId", fixture.eventId)
            .eq("policyVersionId", fixture.policyId)
            .eq("lifecycle.kind", "pending"),
        )
        .collect();
      const facts = await ctx.db
        .query("operationsAutonomyReadFacts")
        .withIndex("by_event_source_entity_sequence", (index) =>
          index
            .eq("eventId", fixture.eventId)
            .eq("source", "incident_readiness")
            .eq("entityKey", `pack:${packId}`),
        )
        .collect();
      return {
        firstSequence: firstState?.sequence,
        finalSequence: finalState?.sequence,
        firstInboxCount: firstInbox.length,
        finalInboxCount: finalInbox.length,
        factCount: facts.length,
        factJson: JSON.stringify(facts),
      };
    });
    expect(result).toMatchObject({
      firstSequence: 1,
      finalSequence: 1,
      firstInboxCount: 1,
      finalInboxCount: 1,
      factCount: 1,
    });
    expect(result.factJson).not.toContain("private-purpose");
    expect(result.factJson).not.toContain("PRIVATE-SERIAL");
    expect(result.factJson).not.toContain("non-projected-work-id");
  });

  test("frozen review pages traverse max-sized panel rows below the byte ceiling", async () => {
    const backend = seededBackend();
    const fixture = await seedRun(backend);
    const snapshot = "snapshot:max-review-round-pages";
    const rounds = Array.from({ length: 8 }, (_, roundIndex) => ({
      roundId: `round-${String(roundIndex).padStart(2, "0")}`,
      name: `R${String(roundIndex).padStart(2, "0")}${"r".repeat(97)}`,
      status: "open",
      startsAt: fixture.now + roundIndex,
      endsAt: fixture.now + roundIndex + 1,
      isPaused: false,
      stateCounts: {
        unassigned: 0,
        queued: 0,
        called: 0,
        inReview: 0,
        completed: 0,
        held: 0,
        missed: 0,
        withdrawn: 0,
      },
      panels: Array.from({ length: 100 }, (_, panelIndex) => ({
        panelId: `panel-${String(roundIndex).padStart(2, "0")}-${String(panelIndex).padStart(3, "0")}`,
        name: `P${String(panelIndex).padStart(3, "0")}${"p".repeat(76)}`,
        status: "ready",
        queuedCount: 0,
        activeReviewCount: 0,
      })),
    }));
    await backend.run((ctx) =>
      ctx.db.insert("operationsAutonomyReadTraversals", {
        eventId: fixture.eventId,
        runId: fixture.runId,
        snapshot,
        read: "review_rounds",
        generatedAt: fixture.now,
        kind: "frozen",
        dataJson: JSON.stringify({ generatedAt: fixture.now, rounds }),
        createdAt: fixture.now,
      }),
    );

    let cursorStateJson = JSON.stringify({ kind: "frozen", snapshot, offset: 0 });
    const visited = new Map<string, Set<string>>();
    for (let pageNumber = 0; pageNumber < 8; pageNumber += 1) {
      const page = await backend.query(internal.operationsAutonomyReadPages.executePage, {
        runId: fixture.runId,
        read: "review_rounds",
        cursorStateJson,
      });
      expect(new TextEncoder().encode(page.dataJson).byteLength).toBeLessThanOrEqual(
        operationsAutonomyReadPageMaximumBytes,
      );
      const parsed: unknown = JSON.parse(page.dataJson);
      if (
        typeof parsed !== "object" || parsed === null ||
        !("rounds" in parsed) || !Array.isArray(parsed.rounds)
      ) throw new Error("The frozen review-round page is invalid.");
      for (const round of parsed.rounds) {
        if (
          typeof round !== "object" || round === null ||
          !("roundId" in round) || typeof round.roundId !== "string" ||
          !("panels" in round) || !Array.isArray(round.panels)
        ) throw new Error("A frozen review-round row is invalid.");
        const panelIds = new Set<string>();
        for (const panel of round.panels) {
          if (
            typeof panel !== "object" || panel === null ||
            !("panelId" in panel) || typeof panel.panelId !== "string"
          ) throw new Error("A frozen review-panel row is invalid.");
          panelIds.add(panel.panelId);
        }
        visited.set(round.roundId, panelIds);
      }
      if (page.isDone) break;
      if (page.nextCursorStateJson === undefined) {
        throw new Error("The frozen review-round continuation is missing.");
      }
      cursorStateJson = page.nextCursorStateJson;
    }
    expect([...visited.keys()]).toEqual(rounds.map((round) => round.roundId));
    expect([...visited.values()].every((panelIds) => panelIds.size === 100)).toBe(true);
  });

  test("a queued item is terminalized if its event leaves live before materialization", async () => {
    const backend = seededBackend();
    const fixture = await seedRun(backend);
    const operator = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });
    const inboxId = await backend.run(async (ctx) => {
      const existingRun = await ctx.db.get(fixture.runId);
      if (!existingRun) throw new Error("The autonomy fixture run is missing.");
      await ctx.db.patch(existingRun._id, {
        lifecycle: { kind: "succeeded", completedAt: fixture.now },
      });
      const state = await ctx.db
        .query("operationsAutonomyStates")
        .withIndex("by_policy", (index) => index.eq("policyVersionId", fixture.policyId))
        .unique();
      if (!state) throw new Error("The autonomy fixture state is missing.");
      await ctx.db.patch(state._id, { pendingWorkCount: 1 });
      const id = await ctx.db.insert("operationsAutonomyInbox", {
        eventId: fixture.eventId,
        policyVersionId: fixture.policyId,
        operationKey: "schedule:non-live-regression",
        trigger: { kind: "schedule", scheduledFor: fixture.now + 1 },
        sourceSnapshot: existingRun.sourceSnapshot,
        sourceFactHighWatermarks: existingRun.sourceFactHighWatermarks,
        sourceChecksum: existingRun.sourceChecksum,
        nextAttemptAt: fixture.now,
        lifecycle: { kind: "pending" },
        createdAt: fixture.now,
        updatedAt: fixture.now,
      });
      await ctx.db.patch(fixture.eventId, { status: "complete" });
      return id;
    });
    const runId = await backend.mutation(internal.operationsAutonomyScheduler.materializeInbox, {
      inboxId,
      now: fixture.now + 2,
    });
    expect(runId).not.toBeNull();
    const state = await backend.run(async (ctx) => ({
      inbox: await ctx.db.get(inboxId),
      run: runId ? await ctx.db.get(runId) : null,
      scheduler: await ctx.db
        .query("operationsAutonomyStates")
        .withIndex("by_policy", (index) => index.eq("policyVersionId", fixture.policyId))
        .unique(),
    }));
    expect(state.inbox?.lifecycle).toMatchObject({ kind: "canceled" });
    expect(state.run?.lifecycle).toMatchObject({ kind: "canceled", reason: "event_not_live" });
    expect(state.scheduler?.pendingWorkCount).toBe(0);
    const history = await operator.query(api.operationsAutonomy.history, {
      eventSlug: fixture.slug,
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(history.page.find((row) => row.runId === runId)).toMatchObject({
      state: "canceled",
      shutdownState: "not_required",
      hasStream: false,
    });
  });

  test("policy revocation exhaustively cancels a queue larger than one transaction page", async () => {
    const backend = seededBackend();
    const fixture = await seedRun(backend);
    await backend.run(async (ctx) => {
      const run = await ctx.db.get(fixture.runId);
      if (!run) throw new Error("The autonomy fixture run is missing.");
      for (let index = 0; index < 70; index += 1) {
        await ctx.db.insert("operationsAutonomyInbox", {
          eventId: fixture.eventId,
          policyVersionId: fixture.policyId,
          operationKey: `queued-revocation-${index}`,
          trigger: { kind: "schedule", scheduledFor: fixture.now + index },
          sourceSnapshot: run.sourceSnapshot,
          sourceFactHighWatermarks: run.sourceFactHighWatermarks,
          sourceChecksum: run.sourceChecksum,
          nextAttemptAt: fixture.now,
          lifecycle: { kind: "pending" },
          createdAt: fixture.now + index,
          updatedAt: fixture.now + index,
        });
      }
      const state = await ctx.db
        .query("operationsAutonomyStates")
        .withIndex("by_policy", (index) => index.eq("policyVersionId", fixture.policyId))
        .unique();
      if (!state) throw new Error("The autonomy fixture state is missing.");
      await ctx.db.patch(state._id, { pendingWorkCount: 70 });
      await revokeOperationsAutonomyPolicy(ctx, {
        eventId: fixture.eventId,
        policyVersionId: fixture.policyId,
        reason: "kill_switch",
        now: fixture.now + 100,
      });
    });
    let hasMore = true;
    for (let page = 0; page < 3 && hasMore; page += 1) {
      hasMore = await backend.mutation(
        internal.operationsAutonomyScheduler.cancelPendingInboxPage,
        { policyVersionId: fixture.policyId, now: fixture.now + 101 + page },
      );
    }
    expect(hasMore).toBe(false);
    const result = await backend.run(async (ctx) => ({
      pending: await ctx.db
        .query("operationsAutonomyInbox")
        .withIndex("by_policy_lifecycle", (index) =>
          index.eq("policyVersionId", fixture.policyId).eq("lifecycle.kind", "pending"),
        )
        .collect(),
      canceled: await ctx.db
        .query("operationsAutonomyInbox")
        .withIndex("by_policy_lifecycle", (index) =>
          index.eq("policyVersionId", fixture.policyId).eq("lifecycle.kind", "canceled"),
        )
        .collect(),
      state: await ctx.db
        .query("operationsAutonomyStates")
        .withIndex("by_policy", (index) => index.eq("policyVersionId", fixture.policyId))
        .unique(),
    }));
    expect(result.pending).toHaveLength(0);
    expect(result.canceled).toHaveLength(70);
    expect(result.state).toMatchObject({ pendingWorkCount: 0 });
    expect(result.state?.pendingCancellationAt).toBeUndefined();
  });

  test("continuing can re-enter reading and one prior submission owns one child", async () => {
    const backend = seededBackend();
    const fixture = await seedRun(backend);
    const continuing = callback(fixture, "callback-continuing-0001", "continuing");
    await backend.mutation(internal.operationsAutonomyCallbacks.applyCallback, {
      callback: continuing,
      now: fixture.now,
    });
    await backend.mutation(internal.operationsAutonomyCallbacks.applyCallback, {
      callback: callback(fixture, "callback-reading-0001", "reading"),
      now: fixture.now + 1,
    });
    await backend.mutation(internal.operationsAutonomyDispatch.recoverRun, {
      runId: fixture.runId,
      causedByOperationId: "lease-recovery-0001",
      priorSubmissionId: "submission-a",
    });
    const rows = await backend.run((ctx) =>
      ctx.db
        .query("operationsAutonomyContinuations")
        .withIndex("by_run_prior_submission", (index) =>
          index.eq("runId", fixture.runId).eq("priorSubmissionId", "submission-a"),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workItemId.length).toBeLessThanOrEqual(80);
  });

  test("a failed callback may terminalize from planning", async () => {
    const backend = seededBackend();
    const fixture = await seedRun(backend);
    const result = await backend.mutation(internal.operationsAutonomyCallbacks.applyCallback, {
      callback: {
        ...identity(fixture),
        operationId: "callback-policy-failure-0001",
        agentVersion: "operations-autopilot-test",
        model: "test/model",
        observedSignalKeys: [],
        status: "failed",
        phase: "terminal",
        failureCode: "policy_violation",
      },
      now: fixture.now + 1,
    });
    expect(result.state).toBe("accepted");
    const settled = await backend.run((ctx) => ctx.db.get(fixture.runId));
    expect(settled?.lifecycle).toEqual({
      kind: "failed",
      failureCode: "policy_violation",
      completedAt: fixture.now + 1,
    });
  });

  test("owner revocation persists cancellation and durable abort intent", async () => {
    const backend = seededBackend();
    const fixture = await seedRun(backend);
    await backend.run((ctx) => ctx.db.patch(fixture.ownerSubjectId, { status: "suspended" }));
    expect(
      await backend.mutation(internal.operationsAutonomyOperations.authorizeWork, {
        request: workRequest(fixture, "model-after-revoke", { kind: "model" }),
        now: fixture.now,
      }),
    ).toEqual({ state: "rejected", code: "authority_revoked" });
    const state = await backend.run(async (ctx) => ({
      run: await ctx.db.get(fixture.runId),
      supervision: await ctx.db
        .query("operationsAutonomyRunSupervision")
        .withIndex("by_run", (index) => index.eq("runId", fixture.runId))
        .unique(),
    }));
    expect(state.run?.lifecycle).toMatchObject({ kind: "canceled", reason: "owner_revoked" });
    expect(state.supervision?.lifecycle).toMatchObject({ kind: "abort_pending" });
  });

  test("manual start replays its original receipt after claim and cancellation", async () => {
    const backend = seededBackend();
    const fixture = await seedRun(backend);
    const operator = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });
    const request = {
      eventSlug: fixture.slug,
      clientOperationId: "manual-replay-after-claim",
    };
    const first = await operator.mutation(api.operationsAutonomy.startManual, request);
    expect(first.state).toBe("queued");
    await backend.run(async (ctx) => {
      await ctx.db.patch(fixture.runId, {
        lifecycle: { kind: "succeeded", completedAt: fixture.now + 1 },
      });
      const supervision = await ctx.db
        .query("operationsAutonomyRunSupervision")
        .withIndex("by_run", (index) => index.eq("runId", fixture.runId))
        .unique();
      if (!supervision) throw new Error("The autonomy fixture supervision is missing.");
      await ctx.db.patch(supervision._id, { lifecycle: { kind: "terminal" } });
    });
    const runId = await backend.mutation(internal.operationsAutonomyScheduler.materializeInbox, {
      inboxId: first.workItemId,
      now: fixture.now + 2,
    });
    expect(runId).not.toBeNull();
    expect(await operator.mutation(api.operationsAutonomy.startManual, request)).toEqual(first);
    await backend.run((ctx) =>
      revokeOperationsAutonomyPolicy(ctx, {
        eventId: fixture.eventId,
        policyVersionId: fixture.policyId,
        reason: "kill_switch",
        now: fixture.now + 3,
      }),
    );
    expect(await operator.mutation(api.operationsAutonomy.startManual, request)).toEqual(first);
  });

  test("event completion revokes autonomy and exposes truthful status", async () => {
    const backend = seededBackend();
    const fixture = await seedRun(backend);
    const operator = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });
    const queuedId = await backend.run(async (ctx) => {
      const run = await ctx.db.get(fixture.runId);
      if (!run) throw new Error("The autonomy fixture run is missing.");
      const state = await ctx.db
        .query("operationsAutonomyStates")
        .withIndex("by_policy", (index) => index.eq("policyVersionId", fixture.policyId))
        .unique();
      if (!state) throw new Error("The autonomy fixture state is missing.");
      await ctx.db.patch(state._id, { pendingWorkCount: 1 });
      return ctx.db.insert("operationsAutonomyInbox", {
        eventId: fixture.eventId,
        policyVersionId: fixture.policyId,
        operationKey: "schedule:event-completion-regression",
        trigger: { kind: "schedule", scheduledFor: fixture.now + 1 },
        sourceSnapshot: run.sourceSnapshot,
        sourceFactHighWatermarks: run.sourceFactHighWatermarks,
        sourceChecksum: run.sourceChecksum,
        nextAttemptAt: fixture.now,
        lifecycle: { kind: "pending" },
        createdAt: fixture.now,
        updatedAt: fixture.now,
      });
    });
    expect(await operator.mutation(api.eventLifecycle.transition, {
      eventSlug: fixture.slug,
      targetStatus: "complete",
      expectedEventVersion: 1,
      reason: "All event operations are complete.",
      clientOperationId: "complete-event-with-autonomy",
    })).toEqual({ status: "complete", eventVersion: 2 });
    const status = await operator.query(api.operationsAutonomy.status, {
      eventSlug: fixture.slug,
    });
    expect(status).toMatchObject({
      eventStatus: "complete",
      canStart: false,
      policy: { enabled: true },
      scheduler: { lifecycle: "disabled" },
      activeRun: null,
    });
    const state = await backend.run(async (ctx) => ({
      run: await ctx.db.get(fixture.runId),
      queued: await ctx.db.get(queuedId),
      scheduler: await ctx.db
        .query("operationsAutonomyStates")
        .withIndex("by_policy", (index) => index.eq("policyVersionId", fixture.policyId))
        .unique(),
      supervision: await ctx.db
        .query("operationsAutonomyRunSupervision")
        .withIndex("by_run", (index) => index.eq("runId", fixture.runId))
        .unique(),
    }));
    expect(state.run?.lifecycle).toMatchObject({ kind: "canceled", reason: "event_not_live" });
    expect(state.queued?.lifecycle).toMatchObject({ kind: "canceled" });
    expect(state.scheduler).toMatchObject({
      lifecycle: { kind: "disabled" },
      pendingWorkCount: 0,
    });
    expect(state.supervision?.lifecycle).toMatchObject({ kind: "abort_pending" });
  });

  test("eligible autonomy owners page beyond one hundred event accounts", async () => {
    const backend = seededBackend();
    const fixture = await seedRun(backend);
    const expectedIds = await backend.run(async (ctx) => {
      const ids: Array<Id<"eventAccessSubjects">> = [fixture.ownerSubjectId];
      for (let index = 0; index < 105; index += 1) {
        const email = `autonomy-owner-${String(index).padStart(3, "0")}@example.test`;
        const personId = await ctx.db.insert("people", {
          authUserId: `owner-auth-${index}`,
          googleSubject: `owner-google-${index}`,
          verifiedEmail: email,
          displayName: `Autonomy owner ${String(index).padStart(3, "0")}`,
          status: "active",
          createdAt: fixture.now,
          updatedAt: fixture.now,
        });
        const subjectId = await ctx.db.insert("eventAccessSubjects", {
          eventId: fixture.eventId,
          personId,
          emailNormalized: email,
          displayName: `Autonomy owner ${String(index).padStart(3, "0")}`,
          status: "active",
          linkedBy: "access_invitation",
          accessVersion: 1,
          createdAt: fixture.now,
          updatedAt: fixture.now,
        });
        ids.push(subjectId);
        await insertPermissionGrant(ctx, {
          eventId: fixture.eventId,
          personId,
          eventAccessSubjectId: subjectId,
          permissionKey: "operations.intelligence.read",
          scopeType: "event",
          sourceType: "manual",
          sourceId: `owner-option:${subjectId}`,
          grantedByPersonId: fixture.personId,
          reason: "Autonomy owner pagination test",
        });
      }
      return ids;
    });
    const operator = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });
    const actualIds: Array<Id<"eventAccessSubjects">> = [];
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page: {
        page: Array<{ eventAccessSubjectId: Id<"eventAccessSubjects"> }>;
        isDone: boolean;
        continueCursor: string;
      } = await operator.query(
        api.operationsAutonomyPolicyConfiguration.ownerOptionsPage,
        {
          eventSlug: fixture.slug,
          paginationOpts: { numItems: 20, cursor },
        },
      );
      actualIds.push(...page.page.map((owner) => owner.eventAccessSubjectId));
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(new Set(actualIds)).toEqual(new Set(expectedIds));
  });

  test("late initial admission after cancellation re-arms abort without reviving the run", async () => {
    const backend = seededBackend();
    const fixture = await seedRun(backend);
    await backend.run((ctx) =>
      ctx.db.patch(fixture.runId, { admission: { kind: "not_accepted" } }),
    );
    const response = deferredResponse();
    const requestStarted = deferredSignal();
    vi.stubGlobal("fetch", () => {
      requestStarted.resolve();
      return response.promise;
    });
    const dispatch = backend.action(internal.operationsAutonomyActions.dispatchRun, {
      runId: fixture.runId,
    });
    await requestStarted.promise;
    await backend.run((ctx) =>
      revokeOperationsAutonomyPolicy(ctx, {
        eventId: fixture.eventId,
        policyVersionId: fixture.policyId,
        reason: "kill_switch",
        now: fixture.now + 1,
      }),
    );
    response.resolve(acceptedWorkerResponse(fixture.runId, "late-submission-initial", fixture.now));
    await dispatch;
    const state = await backend.run(async (ctx) => ({
      run: await ctx.db.get(fixture.runId),
      supervision: await ctx.db
        .query("operationsAutonomyRunSupervision")
        .withIndex("by_run", (index) => index.eq("runId", fixture.runId))
        .unique(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.run).toMatchObject({
      admission: { kind: "not_accepted" },
      lifecycle: { kind: "canceled", reason: "kill_switch" },
    });
    expect(state.supervision).toMatchObject({
      outboundAttempt: { kind: "idle" },
      lifecycle: { kind: "abort_pending" },
    });
    expect(state.scheduled.some((job) => job.name.includes("operationsAutonomyActions:abortRun")))
      .toBe(true);
  });

  test("late continuation admission after cancellation cannot advance the submission head", async () => {
    const backend = seededBackend();
    const fixture = await seedRun(backend);
    const continuationId = await backend.run((ctx) =>
      ctx.db.insert("operationsAutonomyContinuations", {
        eventId: fixture.eventId,
        runId: fixture.runId,
        workItemId: "work-late-continuation",
        causedByOperationId: "callback-late-continuation",
        priorSubmissionId: "submission-a",
        lifecycle: { kind: "pending", nextAttemptAt: fixture.now },
        attemptCount: 0,
        createdAt: fixture.now,
        updatedAt: fixture.now,
      }),
    );
    const response = deferredResponse();
    const requestStarted = deferredSignal();
    vi.stubGlobal("fetch", () => {
      requestStarted.resolve();
      return response.promise;
    });
    const continuation = backend.action(internal.operationsAutonomyActions.continueRun, {
      continuationId,
    });
    await requestStarted.promise;
    await backend.run((ctx) =>
      revokeOperationsAutonomyPolicy(ctx, {
        eventId: fixture.eventId,
        policyVersionId: fixture.policyId,
        reason: "kill_switch",
        now: fixture.now + 1,
      }),
    );
    response.resolve(acceptedWorkerResponse(fixture.runId, "late-submission-child", fixture.now));
    await continuation;
    const state = await backend.run(async (ctx) => ({
      run: await ctx.db.get(fixture.runId),
      continuation: await ctx.db.get(continuationId),
      supervision: await ctx.db
        .query("operationsAutonomyRunSupervision")
        .withIndex("by_run", (index) => index.eq("runId", fixture.runId))
        .unique(),
    }));
    expect(state.run).toMatchObject({
      admission: { kind: "accepted", currentSubmissionId: "submission-a" },
      lifecycle: { kind: "canceled", reason: "kill_switch" },
    });
    expect(state.continuation?.lifecycle).toMatchObject({ kind: "canceled" });
    expect(state.supervision).toMatchObject({
      outboundAttempt: { kind: "idle" },
      lifecycle: { kind: "abort_pending" },
    });
  });

  test("ambiguous dispatch failure keeps shutdown pending through the uncertainty window", async () => {
    const backend = seededBackend();
    const fixture = await seedRun(backend);
    await backend.run((ctx) =>
      ctx.db.patch(fixture.runId, { admission: { kind: "not_accepted" } }),
    );
    const prepared = await backend.mutation(internal.operationsAutonomyDispatch.prepareDispatch, {
      runId: fixture.runId,
      now: fixture.now,
    });
    if (!prepared) throw new Error("The dispatch attempt was not prepared.");
    await backend.run((ctx) =>
      revokeOperationsAutonomyPolicy(ctx, {
        eventId: fixture.eventId,
        policyVersionId: fixture.policyId,
        reason: "kill_switch",
        now: fixture.now + 1,
      }),
    );
    await backend.mutation(internal.operationsAutonomyDispatch.recordDispatchFailure, {
      runId: fixture.runId,
      attemptId: prepared.attemptId,
      now: fixture.now + 20_000,
    });
    const beforeExpiry = await backend.run((ctx) =>
      ctx.db
        .query("operationsAutonomyRunSupervision")
        .withIndex("by_run", (index) => index.eq("runId", fixture.runId))
        .unique(),
    );
    expect(beforeExpiry).toMatchObject({
      outboundAttempt: { kind: "in_flight", attemptId: prepared.attemptId },
      lifecycle: { kind: "abort_pending" },
    });
    if (!beforeExpiry || beforeExpiry.lifecycle.kind !== "abort_pending") {
      throw new Error("The abort intent is missing.");
    }
    expect(await backend.mutation(internal.operationsAutonomyDispatch.acknowledgeAbort, {
      runId: fixture.runId,
      operationId: beforeExpiry.lifecycle.operationId,
      now: fixture.now + 20_001,
    })).toBe(false);
    expect(await backend.mutation(internal.operationsAutonomyScheduler.reconcileSupervision, {
      supervisionId: beforeExpiry._id,
      now: beforeExpiry.outboundAttempt.kind === "in_flight"
        ? beforeExpiry.outboundAttempt.expiresAt - 1
        : fixture.now,
    })).toBe("unchanged");
    const atExpiry = await backend.run((ctx) =>
      ctx.db
        .query("operationsAutonomyRunSupervision")
        .withIndex("by_run", (index) => index.eq("runId", fixture.runId))
        .unique(),
    );
    if (!atExpiry || atExpiry.outboundAttempt.kind !== "in_flight") {
      throw new Error("The outbound attempt expired unexpectedly.");
    }
    expect(await backend.mutation(internal.operationsAutonomyScheduler.reconcileSupervision, {
      supervisionId: atExpiry._id,
      now: atExpiry.outboundAttempt.expiresAt,
    })).toBe("abort");
  });

  test("a stalled initial dispatch cannot mint fresh authority after its attempt expires", async () => {
    const backend = seededBackend();
    const fixture = await seedRun(backend);
    await backend.run((ctx) =>
      ctx.db.patch(fixture.runId, { admission: { kind: "not_accepted" } }),
    );
    const resumedAt = fixture.now + operationsAutonomyOutboundAttemptLifetimeMs + 1;
    let nowCalls = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      nowCalls += 1;
      return nowCalls === 1 ? fixture.now : resumedAt;
    });
    let signedAt: number | null = null;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const timestamp = new Headers(init?.headers).get("x-c2c-timestamp");
      signedAt = timestamp === null ? null : Number(timestamp);
      await backend.run((ctx) =>
        revokeOperationsAutonomyPolicy(ctx, {
          eventId: fixture.eventId,
          policyVersionId: fixture.policyId,
          reason: "kill_switch",
          now: resumedAt,
        }),
      );
      const supervision = await backend.run((ctx) =>
        ctx.db
          .query("operationsAutonomyRunSupervision")
          .withIndex("by_run", (index) => index.eq("runId", fixture.runId))
          .unique(),
      );
      if (!supervision || supervision.lifecycle.kind !== "abort_pending") {
        throw new Error("The stalled dispatch abort intent is missing.");
      }
      await backend.mutation(internal.operationsAutonomyScheduler.reconcileSupervision, {
        supervisionId: supervision._id,
        now: resumedAt,
      });
      return Response.json({ error: "unauthorized" }, { status: 401 });
    });

    await backend.action(internal.operationsAutonomyActions.dispatchRun, {
      runId: fixture.runId,
    });

    expect(signedAt).toBe(fixture.now);
    expect(resumedAt - (signedAt ?? resumedAt)).toBeGreaterThan(
      operationsAutonomyAdmissionSignatureMaximumAgeMs,
    );
    const state = await backend.run(async (ctx) => ({
      run: await ctx.db.get(fixture.runId),
      supervision: await ctx.db
        .query("operationsAutonomyRunSupervision")
        .withIndex("by_run", (index) => index.eq("runId", fixture.runId))
        .unique(),
    }));
    expect(state.run).toMatchObject({
      admission: { kind: "not_accepted" },
      lifecycle: { kind: "canceled", reason: "kill_switch" },
    });
    expect(state.supervision).toMatchObject({
      outboundAttempt: { kind: "idle" },
      lifecycle: { kind: "abort_pending" },
    });
  });

  test("a stalled continuation cannot mint fresh authority after its attempt expires", async () => {
    const backend = seededBackend();
    const fixture = await seedRun(backend);
    const continuationId = await backend.run((ctx) =>
      ctx.db.insert("operationsAutonomyContinuations", {
        eventId: fixture.eventId,
        runId: fixture.runId,
        workItemId: "work-stalled-continuation",
        causedByOperationId: "callback-stalled-continuation",
        priorSubmissionId: "submission-a",
        lifecycle: { kind: "pending", nextAttemptAt: fixture.now },
        attemptCount: 0,
        createdAt: fixture.now,
        updatedAt: fixture.now,
      }),
    );
    const resumedAt = fixture.now + operationsAutonomyOutboundAttemptLifetimeMs + 1;
    let nowCalls = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      nowCalls += 1;
      return nowCalls === 1 ? fixture.now : resumedAt;
    });
    let signedAt: number | null = null;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const timestamp = new Headers(init?.headers).get("x-c2c-timestamp");
      signedAt = timestamp === null ? null : Number(timestamp);
      await backend.run((ctx) =>
        revokeOperationsAutonomyPolicy(ctx, {
          eventId: fixture.eventId,
          policyVersionId: fixture.policyId,
          reason: "kill_switch",
          now: resumedAt,
        }),
      );
      const supervision = await backend.run((ctx) =>
        ctx.db
          .query("operationsAutonomyRunSupervision")
          .withIndex("by_run", (index) => index.eq("runId", fixture.runId))
          .unique(),
      );
      if (!supervision || supervision.lifecycle.kind !== "abort_pending") {
        throw new Error("The stalled continuation abort intent is missing.");
      }
      await backend.mutation(internal.operationsAutonomyScheduler.reconcileSupervision, {
        supervisionId: supervision._id,
        now: resumedAt,
      });
      return Response.json({ error: "unauthorized" }, { status: 401 });
    });

    await backend.action(internal.operationsAutonomyActions.continueRun, { continuationId });

    expect(signedAt).toBe(fixture.now);
    expect(resumedAt - (signedAt ?? resumedAt)).toBeGreaterThan(
      operationsAutonomyAdmissionSignatureMaximumAgeMs,
    );
    const state = await backend.run(async (ctx) => ({
      run: await ctx.db.get(fixture.runId),
      continuation: await ctx.db.get(continuationId),
      supervision: await ctx.db
        .query("operationsAutonomyRunSupervision")
        .withIndex("by_run", (index) => index.eq("runId", fixture.runId))
        .unique(),
    }));
    expect(state.run).toMatchObject({
      admission: { kind: "accepted", currentSubmissionId: "submission-a" },
      lifecycle: { kind: "canceled", reason: "kill_switch" },
    });
    expect(state.continuation?.lifecycle).toMatchObject({ kind: "pending" });
    expect(state.supervision).toMatchObject({
      outboundAttempt: { kind: "idle" },
      lifecycle: { kind: "abort_pending" },
    });
  });
});

function seededBackend() {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return backend;
}

type Fixture = Awaited<ReturnType<typeof seedRun>>;

function identity(fixture: Fixture) {
  return {
    protocolVersion: operationsIntelligenceProtocolVersion,
    runId: fixture.runId,
    policyVersionId: fixture.policyId,
    policyChecksum: fixture.checksum,
    sourceChecksum: fixture.sourceChecksum,
  };
}

function workRequest(
  fixture: Fixture,
  operationId: string,
  operation: { kind: "model" } | { kind: "delegation"; area: "reviews" },
) {
  return { ...identity(fixture), operationId, operation };
}

function readRequest(fixture: Fixture, operationId: string) {
  return { ...identity(fixture), operationId, read: "review_exceptions" as const };
}

function callback(
  fixture: Fixture,
  operationId: string,
  phase: "continuing" | "reading",
) {
  return {
    ...identity(fixture),
    operationId,
    agentVersion: "operations-autopilot-test",
    model: "test/model",
    observedSignalKeys: [],
    status: "running" as const,
    phase,
  };
}

function recommendationRequest(
  fixture: Fixture,
  args: {
    operationId: string;
    proposalKey: string;
    teamRoundStateId: string;
    expectedVersion: number;
    evidenceSet: OperationsAutonomyRecommendationEvidenceSeal;
    targetCitationIdentity?: string;
  },
) {
  return {
    ...identity(fixture),
    operationId: args.operationId,
    proposalKey: args.proposalKey,
    eventSlug: fixture.slug,
    agentVersion: "operations-autopilot-test",
    model: "test/model",
    statement: "Hold the cited review team for operator review.",
    reasoning: "The exact cited team state and version require a human decision.",
    evidenceSet: args.evidenceSet,
    ...(args.targetCitationIdentity === undefined
      ? {}
      : { targetCitationIdentity: args.targetCitationIdentity }),
    arguments: {
      kind: "hold_review_team" as const,
      teamRoundStateId: args.teamRoundStateId,
      expectedTeamRoundStateVersion: args.expectedVersion,
      reason: "Exact cited review state requires operator confirmation.",
    },
  };
}

function recommendationEvidenceRequest(
  fixture: Fixture,
  args: {
    operationId: string;
    proposalKey: string;
    evidenceSetId: string;
    pageIndex: number;
    previousPageHash?: string;
    citations: OperationsAutonomyRecommendationCitation[];
    isDone: boolean;
  },
) {
  return {
    ...identity(fixture),
    operationId: args.operationId,
    proposalKey: args.proposalKey,
    evidenceSetId: args.evidenceSetId,
    pageIndex: args.pageIndex,
    ...(args.previousPageHash === undefined
      ? {}
      : { previousPageHash: args.previousPageHash }),
    citations: args.citations,
    isDone: args.isDone,
  };
}

async function storedRecommendationEvidenceReceipt(
  backend: BackendTest,
  runId: Id<"operationsAutonomyRuns">,
  operationId: string,
) {
  const receipt = await backend.run((ctx) =>
    ctx.db
      .query("operationsAutonomyOperationReceipts")
      .withIndex("by_run_operation", (index) =>
        index.eq("runId", runId).eq("operationId", operationId),
      )
      .unique(),
  );
  if (!receipt || receipt.kind !== "recommendation_support") {
    throw new Error("The recommendation evidence receipt is missing.");
  }
  return receipt;
}

async function storedRecommendationEvidenceSeal(
  backend: BackendTest,
  runId: Id<"operationsAutonomyRuns">,
  evidenceSetId: string,
) {
  const evidenceSet = await backend.run((ctx) =>
    ctx.db
      .query("operationsAutonomyRecommendationEvidenceSets")
      .withIndex("by_run_set", (index) =>
        index.eq("runId", runId).eq("evidenceSetId", evidenceSetId),
      )
      .unique(),
  );
  if (!evidenceSet || evidenceSet.lifecycle.kind !== "sealed") {
    throw new Error("The sealed recommendation evidence set is missing.");
  }
  return evidenceSet.lifecycle.seal;
}

async function seedRecommendationGroundingEvidence(
  backend: BackendTest,
  fixture: Fixture,
) {
  return backend.run(async (ctx) => {
    const rubricVersionId = await ctx.db.insert("reviewRubricVersions", {
      eventId: fixture.eventId,
      version: 1,
      name: "Autonomy grounding rubric",
      status: "published",
      scoreMinimum: 0,
      scoreMaximum: 4,
      aggregationFormula: "criterion_mean_weighted_v1",
      spreadThreshold: 2,
      checksum: "autonomy-grounding-rubric",
      createdByPersonId: fixture.personId,
      createdAt: fixture.now,
      publishedAt: fixture.now,
    });
    const roundId = await ctx.db.insert("reviewRounds", {
      eventId: fixture.eventId,
      rubricVersionId,
      stableKey: "autonomy-grounding-round",
      name: "Autonomy grounding round",
      sequence: 1,
      status: "open",
      reviewerReportAt: fixture.now - 30_000,
      clockInOpensAt: fixture.now - 60_000,
      noShowGraceSeconds: 30,
      startsAt: fixture.now - 10_000,
      endsAt: fixture.now + 60_000,
      correctionRequestsCloseAt: fixture.now + 60_000,
      reviewDurationSeconds: 600,
      ordinaryExtensionSeconds: 120,
      maximumOrdinaryExtensions: 1,
      missedCallGraceSeconds: 120,
      requiredCallAttempts: 2,
      substituteResponseSeconds: 60,
      missedReentryPolicy: "preserve_queue_time",
      requiredPanelSize: 3,
      minimumScorersPerCriterion: 1,
      minimumPresentParticipants: 1,
      requiresSharedCommitments: true,
      minimumReviewerBuild: 1,
      requiresCamera: false,
      requiresNotifications: false,
      version: 1,
      configurationChecksum: "autonomy-grounding-round",
      createdByPersonId: fixture.personId,
      createdAt: fixture.now,
      publishedAt: fixture.now,
      openedAt: fixture.now,
    });
    const membershipId = await ctx.db.insert("eventMemberships", {
      eventId: fixture.eventId,
      personId: fixture.personId,
      eventAccessSubjectId: fixture.ownerSubjectId,
      participantClass: "external_participant",
      eligibilityStatus: "eligible",
      onboardingStatus: "accepted",
      acceptedParticipantPolicyVersionIds: [],
      createdAt: fixture.now,
      updatedAt: fixture.now,
    });
    const teamId = await ctx.db.insert("teams", {
      eventId: fixture.eventId,
      name: "Grounded team",
      publicCode: "GROUND1",
      leadMembershipId: membershipId,
      status: "confirmed",
      activeMemberCount: 1,
      activeVitMemberCount: 0,
      activeExternalMemberCount: 1,
      membershipLocked: true,
      version: 1,
      createdAt: fixture.now,
      updatedAt: fixture.now,
    });
    const expectedVersion = 7;
    const teamRoundStateId = await ctx.db.insert("teamRoundStates", {
      eventId: fixture.eventId,
      roundId,
      teamId,
      state: "called",
      queuedAt: fixture.now - 20_000,
      calledAt: fixture.now - 5_000,
      callAttemptCount: 2,
      priority: 0,
      version: expectedVersion,
      updatedByPersonId: fixture.personId,
      updatedAt: fixture.now,
    });
    const generatedAt = fixture.now - 1_000;
    const targetId = String(teamRoundStateId);
    const version = String(expectedVersion);
    const pages = [
      {
        operationId: "read-exact-grounding-page-0001",
        snapshot: "snapshot:exact-grounding-page",
        citationRows: [[targetId, version, "support-00"], ["decoy-row"]],
      },
      {
        operationId: "read-cross-row-grounding-0001",
        snapshot: "snapshot:cross-row-grounding",
        citationRows: [[targetId, "id-row"], [version, "version-row"]],
      },
      {
        operationId: "read-cross-page-id-0001",
        snapshot: "snapshot:cross-page-id",
        citationRows: [[targetId, "id-page"]],
      },
      {
        operationId: "read-cross-page-version-0001",
        snapshot: "snapshot:cross-page-version",
        citationRows: [[version, "version-page"]],
      },
      ...Array.from({ length: 11 }, (_, index) => ({
        operationId: `read-exact-support-${String(index + 2).padStart(4, "0")}`,
        snapshot: `snapshot:exact-support-${String(index + 2).padStart(4, "0")}`,
        citationRows: [[targetId, version, `support-${String(index + 1).padStart(2, "0")}`]],
      })),
    ];
    for (const [pageIndex, page] of pages.entries()) {
      const sequence = pageIndex + 1;
      const responseJson = JSON.stringify({
        state: "accepted",
        sequence,
        read: "review_exceptions",
        data: { generatedAt, vacancies: [], teams: [] },
        page: { isDone: true, snapshot: page.snapshot },
      });
      await ctx.db.insert("operationsAutonomyOperationReceipts", {
        eventId: fixture.eventId,
        runId: fixture.runId,
        operationId: page.operationId,
        sequence,
        fingerprint: `grounding-page-${sequence}`,
        kind: "read",
        state: "completed",
        read: "review_exceptions",
        generatedAt,
        traversalSnapshot: page.snapshot,
        isDone: true,
        citationRows: page.citationRows,
        responseJson,
        responseBytes: new TextEncoder().encode(responseJson).byteLength,
        createdAt: fixture.now + sequence,
      });
    }
    const checkpoint = await ctx.db
      .query("operationsAutonomyRunCheckpoints")
      .withIndex("by_run", (index) => index.eq("runId", fixture.runId))
      .unique();
    if (!checkpoint) throw new Error("The autonomy grounding checkpoint is missing.");
    await ctx.db.patch(checkpoint._id, {
      sequence: pages.length,
      toolCallsUsed: pages.length,
      updatedAt: fixture.now + pages.length,
      version: checkpoint.version + 1,
    });
    return {
      teamRoundStateId,
      expectedVersion,
      generatedAt,
      exact: pages[0]!,
      exactPages: [pages[0]!, ...pages.slice(4)],
      crossRow: pages[1]!,
      idPage: pages[2]!,
      versionPage: pages[3]!,
    };
  });
}

function pageRecords(dataJson: string, key: string): Array<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(dataJson);
  if (typeof parsed !== "object" || parsed === null || !(key in parsed)) {
    throw new Error("The autonomy deep-read page is invalid.");
  }
  const rows = Object.entries(parsed).find(([name]) => name === key)?.[1];
  if (!Array.isArray(rows)) throw new Error("The autonomy deep-read rows are invalid.");
  return rows.map((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error("An autonomy deep-read row is invalid.");
    }
    return Object.fromEntries(Object.entries(row));
  });
}

async function seedRun(backend: BackendTest) {
  const now = Date.now();
  const authUserId = await createAuthUser(backend, now);
  const authSessionId = await createAuthSession(backend, authUserId, now);
  return backend.run(async (ctx) => {
    const slug = `autonomy-${crypto.randomUUID()}`;
    const eventId = await ctx.db.insert("events", {
      slug,
      name: "Autonomy fixture",
      timezone: "Asia/Dubai",
      status: "live",
      vitEmailDomains: ["example.test"],
        applicationsCloseAt: Date.now() + 86_400_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const email = `${crypto.randomUUID()}@example.test`;
    const personId = await ctx.db.insert("people", {
      authUserId,
      googleSubject: `google-${crypto.randomUUID()}`,
      verifiedEmail: email,
      displayName: "Autonomy owner",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const ownerSubjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: email,
      displayName: "Autonomy owner",
      status: "active",
      linkedBy: "access_invitation",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    for (const permissionKey of [
      "operations.intelligence.read",
      "operations.intelligence.generate",
      "configuration.intelligence.read",
      "event.lifecycle.read",
      "event.lifecycle.manage",
    ] as const) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId,
        eventAccessSubjectId: ownerSubjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "manual",
        sourceId: `${eventId}:${permissionKey}`,
        grantedByPersonId: personId,
        reason: "Autonomy boundary test",
      });
    }
    const policyInput = {
      enabled: true,
      mode: "recommend" as const,
      scheduleIntervalMinutes: 5,
      triggerSeverities: ["critical" as const],
      triggerAreas: ["reviews" as const, "system" as const],
      escalationSeverity: "critical" as const,
      allowedReadTools: [
        "operations_health" as const,
        "review_exceptions" as const,
        "incident_readiness" as const,
      ],
      allowedRecommendationKinds: ["hold_review_team" as const],
      accountableOwnerEventAccessSubjectId: ownerSubjectId,
      audience: "operations_dashboard" as const,
    };
    const checksum = operationsAutonomyPolicyChecksum(policyInput);
    const policyId = await ctx.db.insert("operationsAutonomyPolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...policyInput,
      checksum,
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    const sourceSnapshot = {
      generatedAt: now,
      event: { slug, name: "Autonomy fixture", timezone: "Asia/Dubai", status: "live" as const },
      summary: {
        status: "healthy" as const,
        signalCount: 0,
        criticalSignalCount: 0,
        attentionSignalCount: 0,
        watchSignalCount: 0,
      },
      signals: [],
    };
    const sourceChecksum = operationFingerprint([JSON.stringify(sourceSnapshot)]);
    await ctx.db.insert("operationsHealthSnapshots", {
      eventId,
      eventVersion: 1,
      state: "ready",
      staleAt: now + 90_000,
      snapshot: sourceSnapshot,
    });
    const runId = await ctx.db.insert("operationsAutonomyRuns", {
      eventId,
      policyVersionId: policyId,
      policyVersion: 1,
      policyChecksum: checksum,
      trigger: { kind: "schedule", scheduledFor: now },
      mode: "recommend",
      escalationSeverity: "critical",
      allowedReadTools: ["operations_health", "review_exceptions", "incident_readiness"],
      allowedRecommendationKinds: ["hold_review_team"],
      sourceSnapshot,
      sourceFactHighWatermarks: [],
      sourceChecksum,
      operationKey: `test:${crypto.randomUUID()}`,
      admission: {
        kind: "accepted",
        submissionId: "submission-a",
        currentSubmissionId: "submission-a",
        acceptedAt: now,
      },
      executor: { kind: "unknown" },
      lifecycle: { kind: "active", leaseId: "lease-a", leaseExpiresAt: now + 90_000 },
      attemptCount: 1,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("operationsAutonomyRunCheckpoints", {
      eventId,
      runId,
      sequence: 0,
      phase: "planning",
      toolCallsUsed: 0,
      delegationsUsed: 0,
      readBytesUsed: 0,
      recommendationsProposed: 0,
      observedSignalKeys: [],
      activeRead: { kind: "none" },
      updatedAt: now,
      version: 1,
    });
    await ctx.db.insert("operationsAutonomyStates", {
      eventId,
      policyVersionId: policyId,
      lifecycle: { kind: "active" },
      nextEvaluationAt: now,
      pendingWorkCount: 0,
      lastRunAt: now,
      cycle: 1,
      version: 1,
      updatedAt: now,
    });
    await ctx.db.insert("operationsAutonomyRunSupervision", {
      eventId,
      runId,
      outboundAttempt: { kind: "idle" },
      lifecycle: { kind: "active", nextActionAt: now + 90_000 },
      updatedAt: now,
    });
    return {
      now,
      slug,
      eventId,
      personId,
      ownerSubjectId,
      policyId,
      checksum,
      sourceChecksum,
      runId,
      authUserId,
      authSessionId,
    };
  });
}

async function createAuthUser(backend: BackendTest, now: number) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Autonomy owner",
        email: `autonomy-owner-${crypto.randomUUID()}@example.test`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  return documentId(result, "Better Auth user");
}

async function createAuthSession(backend: BackendTest, userId: string, now: number) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        expiresAt: now + 60 * 60 * 1_000,
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        userId,
      },
    },
  });
  return documentId(result, "Better Auth session");
}

function documentId(value: unknown, label: string): string {
  if (typeof value !== "object" || value === null || !("_id" in value)) {
    throw new Error(`${label} did not return a document ID.`);
  }
  const id = value._id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${label} returned an invalid document ID.`);
  }
  return id;
}

function deferredSignal() {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      if (!resolvePromise) throw new Error("The deferred signal is unavailable.");
      resolvePromise();
    },
  };
}

function deferredResponse() {
  let resolvePromise: ((response: Response) => void) | undefined;
  const promise = new Promise<Response>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(response: Response) {
      if (!resolvePromise) throw new Error("The deferred response is unavailable.");
      resolvePromise(response);
    },
  };
}

function acceptedWorkerResponse(runId: string, submissionId: string, acceptedAt: number) {
  return new Response(JSON.stringify({
    state: "accepted",
    runId,
    instanceId: runId,
    submissionId,
    acceptedAt: new Date(acceptedAt).toISOString(),
    uid: `uid:${submissionId}`,
  }), {
    status: 202,
    headers: { "content-type": "application/json" },
  });
}
