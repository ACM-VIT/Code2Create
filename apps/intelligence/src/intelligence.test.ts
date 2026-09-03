import {
  operationsCopilotRecommendationSignatureContext,
  operationsIntelligenceCallbackSignatureContext,
  operationsIntelligenceIngressSignatureContext,
  operationsIntelligenceProtocolVersion,
  operationsIntelligenceReadSignatureContext,
  signServiceBody,
  verifyServiceBody,
  type OperationsIntelligenceCallback,
} from "@code2create/domain";
import { describe, expect, test } from "vitest";
import * as v from "valibot";

import { deliverCallback } from "./lib/callback.ts";
import { performAdmissionRead } from "./lib/admissionReads.ts";
import { deliverProposal, performPlatformRead } from "./lib/reads.ts";
import {
  operationsCopilotRequestSchema,
  operationsIntelligenceRequestSchema,
  type CopilotProposal,
} from "./protocol.ts";

const secret = "f".repeat(64);
const conversationId = `cv_${"a".repeat(64)}`;

describe("operations intelligence transport", () => {
  test("accepts only a current signature over the exact body and context", async () => {
    const body = JSON.stringify({ briefId: "brief-1" });
    const timestamp = Date.now().toString();
    const signature = await signServiceBody({
      context: operationsIntelligenceIngressSignatureContext,
      secret,
      timestamp,
      body,
    });

    expect(
      await verifyServiceBody({
        context: operationsIntelligenceIngressSignatureContext,
        secret,
        timestamp,
        signature,
        body,
        now: Number(timestamp),
        maximumAgeMs: 60_000,
      }),
    ).toBe(true);
    expect(
      await verifyServiceBody({
        context: operationsIntelligenceCallbackSignatureContext,
        secret,
        timestamp,
        signature,
        body,
        now: Number(timestamp),
        maximumAgeMs: 60_000,
      }),
    ).toBe(false);
    expect(
      await verifyServiceBody({
        context: operationsIntelligenceIngressSignatureContext,
        secret,
        timestamp,
        signature,
        body: `${body} `,
        now: Number(timestamp),
        maximumAgeMs: 60_000,
      }),
    ).toBe(false);
  });

  test("rejects unknown fields at the signed request boundary", () => {
    const parsed = v.safeParse(operationsIntelligenceRequestSchema, {
      protocolVersion: operationsIntelligenceProtocolVersion,
      briefId: "brief-1",
      sourceChecksum: "a".repeat(64),
      snapshot: {
        generatedAt: 1,
        event: {
          slug: "code2create-7",
          name: "Code2Create 7.0",
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
      },
      unexpected: true,
    });
    expect(parsed.success).toBe(false);
  });

  test("signs the exact callback body sent to Convex", async () => {
    const payload: OperationsIntelligenceCallback = {
      protocolVersion: operationsIntelligenceProtocolVersion,
      briefId: "brief-1",
      sourceChecksum: "a".repeat(64),
      agentVersion: "operations-brief-v1",
      model: "openai/test-model",
      completedAt: Date.now(),
      status: "succeeded",
      headline: "No current signal",
      summary: "The bounded source snapshot contains no current operations signal.",
      priorities: [],
    };
    let received = false;
    const request: typeof fetch = async (input, init) => {
      const outbound = new Request(input, init);
      const body = await outbound.text();
      const timestamp = outbound.headers.get("x-c2c-timestamp") ?? "";
      const signature = outbound.headers.get("x-c2c-signature") ?? "";
      received = await verifyServiceBody({
        context: operationsIntelligenceCallbackSignatureContext,
        secret,
        timestamp,
        signature,
        body,
        now: Number(timestamp),
        maximumAgeMs: 60_000,
      });
      return Response.json({ state: "accepted" }, { status: 202 });
    };

    await deliverCallback(
      payload,
      {
        CONVEX_INTELLIGENCE_CALLBACK_URL: "https://example.test/callback",
        INTELLIGENCE_CALLBACK_SECRET: secret,
      },
      request,
    );
    expect(received).toBe(true);
  });

  test("signs platform reads with the read context and re-validates the response shape", async () => {
    let received = false;
    const request: typeof fetch = async (input, init) => {
      const outbound = new Request(input, init);
      const body = await outbound.text();
      received = await verifyServiceBody({
        context: operationsIntelligenceReadSignatureContext,
        secret,
        timestamp: outbound.headers.get("x-c2c-timestamp") ?? "",
        signature: outbound.headers.get("x-c2c-signature") ?? "",
        body,
        now: Date.now(),
        maximumAgeMs: 60_000,
      });
      expect(JSON.parse(body)).toEqual({
        protocolVersion: operationsIntelligenceProtocolVersion,
        read: "support_load",
        eventSlug: "code2create-7",
      });
      return Response.json({
        read: "support_load",
        data: {
          generatedAt: 1,
          byState: { open: 2, investigating: 1, waiting: 0, resolved: 5, closed: 3 },
          openByCategory: [{ category: "queue", count: 2 }],
          unassignedActiveCount: 1,
          atLeast: false,
          cases: [
            {
              caseId: "support-case-1",
              category: "queue",
              state: "open",
              createdAt: 1,
            },
          ],
        },
      });
    };

    const result = await performPlatformRead(
      "support_load",
      { eventSlug: "code2create-7", conversationId },
      {
        CONVEX_INTELLIGENCE_READ_URL: "https://example.test/reads",
        INTELLIGENCE_READ_SECRET: secret,
      },
      request,
    );
    expect(received).toBe(true);
    expect(result).toMatchObject({ unassignedActiveCount: 1 });

    const wrongShape: typeof fetch = async () =>
      Response.json({ read: "support_load", data: { generatedAt: 1, leaked: "value" } });
    await expect(
      performPlatformRead(
        "support_load",
        { eventSlug: "code2create-7", conversationId },
        {
          CONVEX_INTELLIGENCE_READ_URL: "https://example.test/reads",
          INTELLIGENCE_READ_SECRET: secret,
        },
        wrongShape,
      ),
    ).rejects.toThrow();
  });

  test("accepts explicit absent novelty in admission cohorts and rejects an omitted field", async () => {
    const candidate = {
      applicationId: "application-1",
      teamId: "team-1",
      teamName: "Boundary Team",
      state: "under_review",
      submittedAt: 1,
      experienceBand: "early_year",
      teamSize: 3,
      reviewCoverage: { assigned: 2, completed: 2, required: 2, decidable: true, shortfall: 0 },
      reviewSignal: { accept: 2, waitlist: 0, decline: 0 },
      novelty: null,
      rank: 1,
      cumulativePeople: 3,
      entryCapacityPeople: 3,
      suggestedIn: true,
    };
    const data = {
      generatedAt: 1,
      capacityPeople: 750,
      policy: {
        version: "admissions-v1",
        minimumHumanReviews: 2,
        overallParticipantCapacity: 750,
        criteria: [{ criterionKey: "problem", label: "Problem clarity" }],
      },
      summary: {
        capacityPeople: 750,
        committedPeople: 0,
        suggestedPeople: 3,
        remainingPeople: 747,
        suggestedInTeamCount: 1,
        suggestedInNotYetDecidableCount: 0,
        bandMix: [
          { band: "first_year", teamsIn: 0, peopleIn: 0, teamsOut: 0, peopleOut: 0 },
          { band: "early_year", teamsIn: 1, peopleIn: 3, teamsOut: 0, peopleOut: 0 },
          { band: "later_year", teamsIn: 0, peopleIn: 0, teamsOut: 0, peopleOut: 0 },
          {
            band: "postgraduate_or_professional",
            teamsIn: 0,
            peopleIn: 0,
            teamsOut: 0,
            peopleOut: 0,
          },
          { band: "mixed_or_external", teamsIn: 0, peopleIn: 0, teamsOut: 0, peopleOut: 0 },
        ],
      },
      counts: { committedTeams: 0, decidedOutTeams: 0, candidateTeams: 1 },
      window: { startRank: 1, endRank: 1, hasEarlier: false, hasLater: false },
      candidates: [candidate],
    };
    const bindings = {
      CONVEX_INTELLIGENCE_READ_URL: "https://example.test/intelligence/reads",
      INTELLIGENCE_READ_SECRET: secret,
    };
    const validRequest: typeof fetch = async () =>
      Response.json({ read: "admission_cohort", data });
    await expect(
      performAdmissionRead(
        "admission_cohort",
        "code2create-7",
        { capacityPeople: 750 },
        bindings,
        validRequest,
      ),
    ).resolves.toMatchObject({ capacityPeople: 750, candidates: [{ novelty: null }] });

    const { novelty: _novelty, ...withoutNovelty } = candidate;
    const invalidRequest: typeof fetch = async () =>
      Response.json({
        read: "admission_cohort",
        data: { ...data, candidates: [withoutNovelty] },
      });
    await expect(
      performAdmissionRead(
        "admission_cohort",
        "code2create-7",
        { capacityPeople: 750 },
        bindings,
        invalidRequest,
      ),
    ).rejects.toThrow("read data is invalid");
  });

  test("signs recommendation proposals with their own context", async () => {
    const proposal: CopilotProposal = {
      protocolVersion: operationsIntelligenceProtocolVersion,
      proposalKey: `${conversationId}:hold-team`,
      conversationId,
      eventSlug: "code2create-7",
      agentVersion: "operations-copilot-v1",
      model: "openai/test-model",
      statement: "Hold the repeatedly-absent team so the queue can move.",
      reasoning: "The review_exceptions read shows two missed calls for this team.",
      citations: [{ read: "review_exceptions", generatedAt: 1, keys: ["state-1"] }],
      arguments: {
        kind: "hold_review_team",
        teamRoundStateId: "state-1",
        expectedTeamRoundStateVersion: 2,
        reason: "Two calls went unanswered while the queue waited.",
      },
    };
    let received = false;
    const request: typeof fetch = async (input, init) => {
      const outbound = new Request(input, init);
      const body = await outbound.text();
      received = await verifyServiceBody({
        context: operationsCopilotRecommendationSignatureContext,
        secret,
        timestamp: outbound.headers.get("x-c2c-timestamp") ?? "",
        signature: outbound.headers.get("x-c2c-signature") ?? "",
        body,
        now: Date.now(),
        maximumAgeMs: 60_000,
      });
      return Response.json({ state: "accepted" }, { status: 202 });
    };

    const receipt = await deliverProposal(
      proposal,
      {
        CONVEX_INTELLIGENCE_RECOMMENDATION_URL: "https://example.test/recommendations",
        INTELLIGENCE_CALLBACK_SECRET: secret,
      },
      request,
    );
    expect(received).toBe(true);
    expect(receipt).toEqual({ state: "accepted" });
  });

  test("rejects unknown fields at the conversational ingress boundary", () => {
    const parsed = v.safeParse(operationsCopilotRequestSchema, {
      protocolVersion: operationsIntelligenceProtocolVersion,
      conversationId,
      turnId: "turn-1",
      eventSlug: "code2create-7",
      message: "How is review going?",
      unexpected: true,
    });
    expect(parsed.success).toBe(false);
  });

  test("requires a bounded stable turn id at the conversational ingress boundary", () => {
    const request = {
      protocolVersion: operationsIntelligenceProtocolVersion,
      conversationId,
      turnId: "turn-018fa6c1",
      eventSlug: "code2create-7",
      message: "How is review going?",
    };
    expect(v.safeParse(operationsCopilotRequestSchema, request).success).toBe(true);
    expect(
      v.safeParse(operationsCopilotRequestSchema, { ...request, turnId: "different turn" }).success,
    ).toBe(false);
    expect(
      v.safeParse(operationsCopilotRequestSchema, {
        protocolVersion: request.protocolVersion,
        conversationId: request.conversationId,
        eventSlug: request.eventSlug,
        message: request.message,
      }).success,
    ).toBe(false);
  });
});
