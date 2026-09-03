import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import workpoolTest from "@convex-dev/workpool/test";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, components, internal } from "./_generated/api";
import {
  admissionModelConfigurationChecksum,
  admissionPolicyChecksum,
  admissionPolicyForConfiguration,
  defaultAdmissionCriteria,
  defaultAdmissionReasonCodes,
  normalizeAdmissionConfiguration,
} from "./lib/admissionPolicy";
import { defaultDeterministicIntakePolicy, intakePolicyChecksum } from "./lib/intakePolicy";
import { defaultParticipantPolicy, participantPolicyChecksum } from "./lib/participantPolicy";
import { insertPermissionGrant } from "./lib/permissions";
import { createTestSubmissionSnapshot } from "./lib/testSubmissionSnapshot";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

describe("manual admission analysis retry", () => {
  test("keeps retry authority separate from result visibility", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend);
    const runner = backend.withIdentity({
      subject: fixture.runnerAuthUserId,
      sessionId: fixture.runnerAuthSessionId,
    });
    const reader = backend.withIdentity({
      subject: fixture.readerAuthUserId,
      sessionId: fixture.readerAuthSessionId,
    });

    const runnerView = await runner.query(api.admissions.detail, {
      eventSlug: fixture.eventSlug,
      applicationId: fixture.applicationId,
    });
    expect(runnerView?.aiRecommendationVisible).toBe(false);
    expect(runnerView?.aiRecommendation).toBeNull();
    expect(runnerView?.aiRecommendationRerun).toEqual({
      recommendationId: fixture.failedRecommendationId,
    });

    const readerView = await reader.query(api.admissions.detail, {
      eventSlug: fixture.eventSlug,
      applicationId: fixture.applicationId,
    });
    expect(readerView?.aiRecommendationVisible).toBe(true);
    expect(readerView?.aiRecommendation).toMatchObject({
      id: fixture.failedRecommendationId,
      state: "failed",
    });
    expect(readerView?.aiRecommendationRerun).toBeNull();

    await expect(
      reader.mutation(api.admissions.rerunAiRecommendation, {
        eventSlug: fixture.eventSlug,
        applicationId: fixture.applicationId,
        expectedApplicationVersion: 1,
        expectedRecommendationId: fixture.failedRecommendationId,
        reason: "Retry after the provider failure",
        clientOperationId: "reader-cannot-rerun",
      }),
    ).rejects.toThrow("permission");
  });

  test("creates one immutable replacement and replays the exact operation", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend);
    const runner = backend.withIdentity({
      subject: fixture.runnerAuthUserId,
      sessionId: fixture.runnerAuthSessionId,
    });
    const request = {
      eventSlug: fixture.eventSlug,
      applicationId: fixture.applicationId,
      expectedApplicationVersion: 1,
      expectedRecommendationId: fixture.failedRecommendationId,
      reason: "Retry after the provider failure",
      clientOperationId: "retry-failed-analysis",
    } as const;

    const first = await runner.mutation(api.admissions.rerunAiRecommendation, request);
    const replay = await runner.mutation(api.admissions.rerunAiRecommendation, request);
    expect(replay).toEqual(first);
    expect(first.applicationVersion).toBe(2);
    expect(first.recommendationId).not.toBe(fixture.failedRecommendationId);

    const state = await backend.run(async (ctx) => ({
      application: await ctx.db.get(fixture.applicationId),
      prior: await ctx.db.get(fixture.failedRecommendationId),
      current: await ctx.db.get(first.recommendationId),
      operations: await ctx.db
        .query("operationResults")
        .withIndex("by_actor_operation", (index) =>
          index
            .eq("actorPersonId", fixture.runnerPersonId)
            .eq("clientOperationId", request.clientOperationId),
        )
        .collect(),
      audits: (
        await ctx.db
          .query("auditEvents")
          .withIndex("by_event_time", (index) => index.eq("eventId", fixture.eventId))
          .collect()
      ).filter((entry) => entry.action === "admission.ai_recommendation_rerun"),
    }));
    expect(state.application).toMatchObject({
      aiRecommendationId: first.recommendationId,
      version: 2,
    });
    expect(state.application?.aiDisposition).toBeUndefined();
    expect(state.prior).toMatchObject({ state: "failed", failureCategory: "provider_failure" });
    expect(state.current).toMatchObject({
      state: "pending",
      applicationContentVersion: 1,
      projectVersionId: fixture.projectId,
      admissionPolicyVersionId: fixture.admissionPolicyId,
      modelConfigVersionId: fixture.modelConfigId,
    });
    expect(state.operations).toHaveLength(1);
    expect(state.audits).toHaveLength(1);

    await expect(
      runner.mutation(api.admissions.rerunAiRecommendation, {
        ...request,
        clientOperationId: "retry-stale-page",
      }),
    ).rejects.toThrow("changed");

    await backend.run((ctx) =>
      ctx.db.patch(first.recommendationId, {
        state: "succeeded",
        recommendation: "accept",
        confidence: "medium",
        completedAt: Date.now(),
      }),
    );
    const refreshed = await runner.mutation(api.admissions.rerunAiRecommendation, {
      ...request,
      expectedApplicationVersion: 2,
      expectedRecommendationId: first.recommendationId,
      clientOperationId: "refresh-successful-analysis",
    });
    expect(refreshed).toMatchObject({ applicationVersion: 3 });
    expect(refreshed.recommendationId).not.toBe(first.recommendationId);
  });

  test("keeps one authorized durable-agent run idempotent across reads and callback retries", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend);
    const runner = backend.withIdentity({
      subject: fixture.runnerAuthUserId,
      sessionId: fixture.runnerAuthSessionId,
    });
    const rerun = await runner.mutation(api.admissions.rerunAiRecommendation, {
      eventSlug: fixture.eventSlug,
      applicationId: fixture.applicationId,
      expectedApplicationVersion: 1,
      expectedRecommendationId: fixture.failedRecommendationId,
      reason: "Retry with the durable idea agent",
      clientOperationId: "durable-agent-analysis",
    });
    const prepared = await backend.mutation(internal.admissionAgentActions.prepareDispatch, {
      recommendationId: rerun.recommendationId,
    });
    expect(prepared).toMatchObject({
      applicationId: fixture.applicationId,
      eventId: fixture.eventId,
      modelId: "gpt-4.1-mini",
      promptVersion: "admission-rerun-prompt-v1",
      schemaVersion: "admission-rerun-schema-v1",
      evaluationSuiteVersion: "admission-rerun-eval-v1",
      contentVersion: 1,
    });
    if (!prepared) throw new Error("The durable dispatch was not prepared.");
    expect(
      await backend.mutation(internal.admissionAgentActions.prepareDispatch, {
        recommendationId: rerun.recommendationId,
      }),
    ).toBeNull();
    const firstRead = await backend.mutation(internal.admissionIntelligence.beginRecommendation, {
      recommendationId: rerun.recommendationId,
    });
    expect(firstRead).not.toBeNull();
    expect(
      await backend.mutation(internal.admissionAgentActions.recordDispatchReceipt, {
        recommendationId: rerun.recommendationId,
        attemptId: prepared.attemptId,
        submissionId: "idea-submission-1",
        acceptedAt: 1_000,
      }),
    ).toBe(true);
    expect(
      await backend.mutation(internal.admissionIntelligence.recoverAgentRecommendation, {
        recommendationId: rerun.recommendationId,
        submissionId: "another-submission",
      }),
    ).toBe(false);

    const repeatedRead = await backend.mutation(
      internal.admissionIntelligence.beginRecommendation,
      {
        recommendationId: rerun.recommendationId,
      },
    );
    expect(repeatedRead).toEqual(firstRead);
    if (!firstRead) throw new Error("The idea-agent fixture did not produce a projection.");
    expect(firstRead.overallParticipantCapacity).toBe(100);
    expect(firstRead.additionalInformation).toBe("Demo notes: https://example.com/retry-petals");
    expect(firstRead.intakeResponses.map((response) => response.sourceRef)).toEqual([
      "follow_up_1",
      "follow_up_2",
      "follow_up_3",
      "follow_up_4",
    ]);
    const criterionAssessments = firstRead.criteria.map((criterion) => ({
      criterionKey: criterion.criterionKey,
      assessment: "meets" as const,
      sourceRefs: ["additional_information"],
    }));
    const completion = {
      recommendationId: rerun.recommendationId,
      sourceInputFingerprint: firstRead.sourceInputFingerprint,
      state: "succeeded" as const,
      recommendation: "accept" as const,
      criterionAssessments,
      strengths: ["The proposal identifies a concrete operational handoff."],
      concerns: [],
      confidence: "medium" as const,
      limitations: ["The analysis uses only the submitted project answers."],
      operationId: `idea-analysis:${rerun.recommendationId}`,
      agentVersion: "idea-submission-v1",
      agentModel: "openai/gpt-4.1-mini",
    };
    expect(
      await backend.mutation(internal.admissionIntelligence.finishRecommendation, completion),
    ).toBe("accepted");
    expect(
      await backend.mutation(internal.admissionIntelligence.finishRecommendation, completion),
    ).toBe("already_exists");
    const stored = await backend.run((ctx) => ctx.db.get(rerun.recommendationId));
    expect(stored).toMatchObject({
      state: "succeeded",
      agentOperationId: completion.operationId,
      agentVersion: completion.agentVersion,
      agentModel: completion.agentModel,
    });
    expect(stored?.agentDispatchAttemptId).toBeUndefined();
    expect(stored?.agentSubmissionId).toBeUndefined();
    expect(stored?.agentAcceptedAt).toBeUndefined();

    const reader = backend.withIdentity({
      subject: fixture.readerAuthUserId,
      sessionId: fixture.readerAuthSessionId,
    });
    const detail = await reader.query(api.admissions.detail, {
      eventSlug: fixture.eventSlug,
      applicationId: fixture.applicationId,
    });
    expect(detail?.aiRecommendation).toMatchObject({
      id: rerun.recommendationId,
      state: "succeeded",
      recommendation: "accept",
    });
    expect(detail?.aiRecommendationRerun).toBeNull();
  });

  test("recovers only the exact accepted agent submission and permits one new dispatch", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend);
    const runner = backend.withIdentity({
      subject: fixture.runnerAuthUserId,
      sessionId: fixture.runnerAuthSessionId,
    });
    const rerun = await runner.mutation(api.admissions.rerunAiRecommendation, {
      eventSlug: fixture.eventSlug,
      applicationId: fixture.applicationId,
      expectedApplicationVersion: 1,
      expectedRecommendationId: fixture.failedRecommendationId,
      reason: "Recover an interrupted durable idea analysis",
      clientOperationId: "recover-durable-agent-analysis",
    });
    const first = await backend.mutation(internal.admissionAgentActions.prepareDispatch, {
      recommendationId: rerun.recommendationId,
    });
    if (!first) throw new Error("The first durable dispatch was not prepared.");
    expect(
      await backend.mutation(internal.admissionAgentActions.recordDispatchReceipt, {
        recommendationId: rerun.recommendationId,
        attemptId: first.attemptId,
        submissionId: "accepted-submission-1",
        acceptedAt: 1_000,
      }),
    ).toBe(true);
    expect(
      await backend.mutation(internal.admissionIntelligence.beginRecommendation, {
        recommendationId: rerun.recommendationId,
      }),
    ).not.toBeNull();

    expect(
      await backend.mutation(internal.admissionIntelligence.recoverAgentRecommendation, {
        recommendationId: rerun.recommendationId,
        submissionId: "accepted-submission-1",
      }),
    ).toBe(true);
    const recovered = await backend.run((ctx) => ctx.db.get(rerun.recommendationId));
    expect(recovered).toMatchObject({
      state: "pending",
      failureCategory: "agent_analysis_recovered",
    });
    expect(recovered?.agentSubmissionId).toBeUndefined();

    const second = await backend.mutation(internal.admissionAgentActions.prepareDispatch, {
      recommendationId: rerun.recommendationId,
    });
    expect(second?.attemptId).not.toBe(first.attemptId);
    expect(
      await backend.mutation(internal.admissionAgentActions.prepareDispatch, {
        recommendationId: rerun.recommendationId,
      }),
    ).toBeNull();
  });

  test("rejects prohibited scoring language at the authoritative callback seam", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend);
    const runner = backend.withIdentity({
      subject: fixture.runnerAuthUserId,
      sessionId: fixture.runnerAuthSessionId,
    });
    const rerun = await runner.mutation(api.admissions.rerunAiRecommendation, {
      eventSlug: fixture.eventSlug,
      applicationId: fixture.applicationId,
      expectedApplicationVersion: 1,
      expectedRecommendationId: fixture.failedRecommendationId,
      reason: "Verify authoritative callback policy",
      clientOperationId: "reject-prohibited-agent-output",
    });
    const projection = await backend.mutation(internal.admissionIntelligence.beginRecommendation, {
      recommendationId: rerun.recommendationId,
    });
    if (!projection) throw new Error("The callback-policy fixture has no projection.");
    expect(
      await backend.mutation(internal.admissionIntelligence.finishRecommendation, {
        recommendationId: rerun.recommendationId,
        sourceInputFingerprint: projection.sourceInputFingerprint,
        state: "succeeded",
        recommendation: "accept",
        criterionAssessments: projection.criteria.map((criterion) => ({
          criterionKey: criterion.criterionKey,
          assessment: "meets" as const,
          sourceRefs: ["initial_idea"],
        })),
        strengths: ["This idea deserves the highest score."],
        concerns: [],
        confidence: "high",
        limitations: ["Only submitted evidence was considered."],
        operationId: "idea-analysis:prohibited-language",
        agentVersion: "idea-submission-v1",
        agentModel: "openai/gpt-4.1-mini",
      }),
    ).toBe("accepted");
    const stored = await backend.run((ctx) => ctx.db.get(rerun.recommendationId));
    expect(stored).toMatchObject({
      state: "invalid",
      failureCategory: "invalid_completion_payload",
      criterionAssessments: [],
    });
  });

  test("preserves a late agent completion when its dispatch receipt fails", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend);
    const runner = backend.withIdentity({
      subject: fixture.runnerAuthUserId,
      sessionId: fixture.runnerAuthSessionId,
    });
    const rerun = await runner.mutation(api.admissions.rerunAiRecommendation, {
      eventSlug: fixture.eventSlug,
      applicationId: fixture.applicationId,
      expectedApplicationVersion: 1,
      expectedRecommendationId: fixture.failedRecommendationId,
      reason: "Retry with the durable idea agent",
      clientOperationId: "dispatch-receipt-failure",
    });
    const prepared = await backend.mutation(internal.admissionAgentActions.prepareDispatch, {
      recommendationId: rerun.recommendationId,
    });
    if (!prepared) throw new Error("The durable dispatch was not prepared.");
    expect(
      await backend.mutation(internal.admissionIntelligence.beginRecommendation, {
        recommendationId: rerun.recommendationId,
      }),
    ).not.toBeNull();

    expect(
      await backend.mutation(internal.admissionAgentActions.recordDispatchFailure, {
        recommendationId: rerun.recommendationId,
        attemptId: prepared.attemptId,
        workerMayHaveAccepted: true,
      }),
    ).toBe(true);
    const running = await backend.run((ctx) => ctx.db.get(rerun.recommendationId));
    expect(running).toMatchObject({
      state: "running",
      agentDispatchAttemptId: prepared.attemptId,
    });

    const projection = await backend.mutation(
      internal.admissionIntelligence.beginRecommendation,
      { recommendationId: rerun.recommendationId },
    );
    if (!projection) throw new Error("The late agent completion has no projection.");
    expect(
      await backend.mutation(internal.admissionIntelligence.finishRecommendation, {
        recommendationId: rerun.recommendationId,
        sourceInputFingerprint: projection.sourceInputFingerprint,
        state: "succeeded",
        recommendation: "accept",
        criterionAssessments: projection.criteria.map((criterion) => ({
          criterionKey: criterion.criterionKey,
          assessment: "meets" as const,
          sourceRefs: ["initial_idea"],
        })),
        strengths: ["The proposal identifies a concrete operational handoff."],
        concerns: [],
        confidence: "medium",
        limitations: ["The analysis uses only the submitted project answers."],
        operationId: `idea-analysis:${rerun.recommendationId}`,
        agentVersion: "idea-submission-v1",
        agentModel: "openai/gpt-4.1-mini",
      }),
    ).toBe("accepted");
  });

  test("recovers only the exact running dispatch attempt after its lease", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend);
    const runner = backend.withIdentity({
      subject: fixture.runnerAuthUserId,
      sessionId: fixture.runnerAuthSessionId,
    });
    const rerun = await runner.mutation(api.admissions.rerunAiRecommendation, {
      eventSlug: fixture.eventSlug,
      applicationId: fixture.applicationId,
      expectedApplicationVersion: 1,
      expectedRecommendationId: fixture.failedRecommendationId,
      reason: "Recover an interrupted agent dispatch",
      clientOperationId: "recover-agent-dispatch-attempt",
    });
    const prepared = await backend.mutation(internal.admissionAgentActions.prepareDispatch, {
      recommendationId: rerun.recommendationId,
    });
    if (!prepared) throw new Error("The durable dispatch was not prepared.");
    const projection = await backend.mutation(
      internal.admissionIntelligence.beginRecommendation,
      { recommendationId: rerun.recommendationId },
    );
    if (!projection) throw new Error("The running dispatch has no projection.");
    expect(
      await backend.mutation(internal.admissionAgentActions.recordDispatchFailure, {
        recommendationId: rerun.recommendationId,
        attemptId: prepared.attemptId,
        workerMayHaveAccepted: true,
      }),
    ).toBe(true);
    expect(await backend.run((ctx) => ctx.db.get(rerun.recommendationId))).toMatchObject({
      state: "running",
      agentDispatchAttemptId: prepared.attemptId,
    });

    expect(
      await backend.mutation(internal.admissionIntelligence.recoverAgentDispatchAttempt, {
        recommendationId: rerun.recommendationId,
        attemptId: "another-attempt",
      }),
    ).toBe(false);
    expect(
      await backend.mutation(internal.admissionIntelligence.recoverAgentDispatchAttempt, {
        recommendationId: rerun.recommendationId,
        attemptId: prepared.attemptId,
      }),
    ).toBe(true);
    const recovered = await backend.run((ctx) => ctx.db.get(rerun.recommendationId));
    expect(recovered).toMatchObject({
      state: "pending",
      failureCategory: "agent_dispatch_recovered",
    });
    expect(recovered?.agentDispatchAttemptId).toBeUndefined();

    expect(
      await backend.mutation(internal.admissionIntelligence.finishRecommendation, {
        recommendationId: rerun.recommendationId,
        sourceInputFingerprint: projection.sourceInputFingerprint,
        state: "succeeded",
        recommendation: "accept",
        criterionAssessments: projection.criteria.map((criterion) => ({
          criterionKey: criterion.criterionKey,
          assessment: "meets" as const,
          sourceRefs: ["initial_idea"],
        })),
        strengths: ["The proposal identifies a concrete operational handoff."],
        concerns: [],
        confidence: "medium",
        limitations: ["The analysis uses only the submitted project answers."],
        operationId: `idea-analysis:${rerun.recommendationId}`,
        agentVersion: "idea-submission-v1",
        agentModel: "openai/gpt-4.1-mini",
      }),
    ).toBe("accepted");

    expect(
      await backend.mutation(internal.admissionAgentActions.prepareDispatch, {
        recommendationId: rerun.recommendationId,
      }),
    ).toBeNull();
  });

  test("releases a dispatch attempt that failed before reaching the worker", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend);
    const runner = backend.withIdentity({
      subject: fixture.runnerAuthUserId,
      sessionId: fixture.runnerAuthSessionId,
    });
    const rerun = await runner.mutation(api.admissions.rerunAiRecommendation, {
      eventSlug: fixture.eventSlug,
      applicationId: fixture.applicationId,
      expectedApplicationVersion: 1,
      expectedRecommendationId: fixture.failedRecommendationId,
      reason: "Retry after a local dispatch failure",
      clientOperationId: "local-agent-dispatch-failure",
    });
    const prepared = await backend.mutation(internal.admissionAgentActions.prepareDispatch, {
      recommendationId: rerun.recommendationId,
    });
    if (!prepared) throw new Error("The durable dispatch was not prepared.");

    expect(
      await backend.mutation(internal.admissionAgentActions.recordDispatchFailure, {
        recommendationId: rerun.recommendationId,
        attemptId: prepared.attemptId,
        workerMayHaveAccepted: false,
      }),
    ).toBe(true);
    const released = await backend.run((ctx) => ctx.db.get(rerun.recommendationId));
    expect(released).toMatchObject({ state: "pending" });
    expect(released?.agentDispatchAttemptId).toBeUndefined();
  });
});

function seededBackend() {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  workpoolTest.register(backend, "admissionWorkpool");
  return backend;
}

async function seedFixture(backend: BackendTest) {
  const now = Date.now();
  const eventSlug = `admission-rerun-${crypto.randomUUID()}`;
  const runnerAuthUserId = await createAuthUser(backend, now, "runner");
  const readerAuthUserId = await createAuthUser(backend, now, "reader");
  const runnerAuthSessionId = await createAuthSession(backend, runnerAuthUserId, now, "runner");
  const readerAuthSessionId = await createAuthSession(backend, readerAuthUserId, now, "reader");
  return backend.run(async (ctx) => {
    const runnerPersonId = await ctx.db.insert("people", {
      authUserId: runnerAuthUserId,
      googleSubject: `google-${runnerAuthUserId}`,
      verifiedEmail: `${runnerAuthUserId}@example.test`,
      displayName: "Analysis operator",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const readerPersonId = await ctx.db.insert("people", {
      authUserId: readerAuthUserId,
      googleSubject: `google-${readerAuthUserId}`,
      verifiedEmail: `${readerAuthUserId}@example.test`,
      displayName: "Analysis reader",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Admission retry fixture",
      timezone: "Asia/Kolkata",
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
      applicationsCloseAt: Date.now() + 86_400_000,
      createdByPersonId: runnerPersonId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const runnerSubjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId: runnerPersonId,
      emailNormalized: `${runnerAuthUserId}@example.test`,
      displayName: "Analysis operator",
      status: "active",
      linkedBy: "access_invitation",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    const readerSubjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId: readerPersonId,
      emailNormalized: `${readerAuthUserId}@example.test`,
      displayName: "Analysis reader",
      status: "active",
      linkedBy: "access_invitation",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    const participantPolicyId = await ctx.db.insert("participantPolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...defaultParticipantPolicy,
      checksum: participantPolicyChecksum(defaultParticipantPolicy),
      createdByPersonId: runnerPersonId,
      createdAt: now,
      publishedAt: now,
    });
    const intakePolicyId = await ctx.db.insert("intakePolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...defaultDeterministicIntakePolicy,
      checksum: intakePolicyChecksum(defaultDeterministicIntakePolicy),
      createdByPersonId: runnerPersonId,
      createdAt: now,
      publishedAt: now,
    });
    const membershipId = await ctx.db.insert("eventMemberships", {
      eventId,
      personId: runnerPersonId,
      eventAccessSubjectId: runnerSubjectId,
      participantClass: "external_participant",
      eligibilityStatus: "eligible",
      onboardingStatus: "submitted",
      acceptedParticipantPolicyVersionIds: [participantPolicyId],
      createdAt: now,
      updatedAt: now,
    });
    const teamId = await ctx.db.insert("teams", {
      eventId,
      name: "Retry Petals",
      publicCode: "RETRY001",
      leadMembershipId: membershipId,
      status: "submitted",
      activeMemberCount: 1,
      activeVitMemberCount: 0,
      activeExternalMemberCount: 1,
      membershipLocked: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const teamMemberId = await ctx.db.insert("teamMembers", {
      eventId,
      teamId,
      membershipId,
      role: "lead",
      status: "active",
      joinedAt: now,
      source: "created",
    });
    const configuration = normalizeAdmissionConfiguration({
      version: "admission-rerun-v1",
      minimumHumanReviews: 1,
      overallParticipantCapacity: 100,
      criteria: defaultAdmissionCriteria,
      decisionReasonCodes: defaultAdmissionReasonCodes,
      model: {
        version: "admission-rerun-model-v1",
        modelId: "gpt-4.1-mini",
        promptVersion: "admission-rerun-prompt-v1",
        schemaVersion: "admission-rerun-schema-v1",
        evaluationSuiteVersion: "admission-rerun-eval-v1",
      },
    });
    const admissionPolicy = admissionPolicyForConfiguration(configuration);
    const admissionPolicyId = await ctx.db.insert("admissionPolicyVersions", {
      eventId,
      ...admissionPolicy,
      status: "published",
      checksum: admissionPolicyChecksum(admissionPolicy),
      createdByPersonId: runnerPersonId,
      createdAt: now,
      publishedAt: now,
    });
    const model = configuration.model;
    if (!model) throw new Error("The admission retry fixture model is missing.");
    const modelConfigId = await ctx.db.insert("admissionModelConfigVersions", {
      eventId,
      admissionPolicyVersionId: admissionPolicyId,
      ...model,
      status: "published",
      checksum: admissionModelConfigurationChecksum(model),
      createdByPersonId: runnerPersonId,
      createdAt: now,
      publishedAt: now,
    });
    const draftId = await ctx.db.insert("projectDrafts", {
      eventId,
      teamId,
      intakePolicyVersionId: intakePolicyId,
      stage: "submitted",
      initialIdea: "A calm handoff tool for volunteers at a busy venue.",
      additionalInformation: "Demo notes: https://example.com/retry-petals",
      version: 1,
      lastEditedByMembershipId: membershipId,
      updatedAt: now,
    });
    const initialAnswerId = await ctx.db.insert("intakeAnswerVersions", {
      eventId,
      teamId,
      draftId,
      promptKey: "initial_idea",
      answerVersion: 1,
      value: "A calm handoff tool for volunteers at a busy venue.",
      status: "active",
      writtenByMembershipId: membershipId,
      writtenAt: now,
      clientOperationId: "admission-rerun-initial",
    });
    const responseFixtures = [
      {
        question: "Who uses it first?",
        purposeKey: "user" as const,
        answer: "Volunteer coordinators use it first.",
      },
      {
        question: "What problem does it solve?",
        purposeKey: "problem" as const,
        answer: "It prevents handoff details from getting lost during a busy event.",
      },
      {
        question: "What is the most important tradeoff?",
        purposeKey: "tradeoff" as const,
        answer: "It favors a clear shared state over highly customized workflows.",
      },
      {
        question: "What could stop it from working well?",
        purposeKey: "risk" as const,
        answer: "Volunteers may forget to record a handoff during a rush.",
      },
    ];
    const intakeResponses = [];
    for (const [index, response] of responseFixtures.entries()) {
      const ordinal = index + 1;
      const questionId = await ctx.db.insert("intakeGeneratedQuestions", {
        eventId,
        teamId,
        draftId,
        ordinal,
        text: response.question,
        purposeKey: response.purposeKey,
        answerLength: "short",
        source: ordinal <= 2 ? "fixed" : "fallback",
        sourceAnswerVersionIds: [initialAnswerId],
        intakePolicyVersionId: intakePolicyId,
        state: "answered",
        validationCategory: "test_fixture",
        answeredAt: now,
        createdAt: now,
      });
      intakeResponses.push({
        questionId,
        ordinal,
        question: response.question,
        purposeKey: response.purposeKey,
        answerLength: "short" as const,
        source: ordinal <= 2 ? ("fixed" as const) : ("fallback" as const),
        answer: response.answer,
      });
    }
    const lockedRosterSnapshotId = await createTestSubmissionSnapshot(ctx, {
      eventId,
      teamId,
      teamMemberIds: [teamMemberId],
      intakePolicyVersionId: intakePolicyId,
      participantPolicyVersionId: participantPolicyId,
      admissionPolicyVersionId: admissionPolicyId,
      submittedAt: now,
    });
    const projectId = await ctx.db.insert("projectVersions", {
      eventId,
      teamId,
      version: 1,
      initialIdea: "A calm handoff tool for volunteers at a busy venue.",
      additionalInformation: "Demo notes: https://example.com/retry-petals",
      intakePolicyVersionId: intakePolicyId,
      intakeResponses,
      lockedRosterSnapshotId,
      lockedMemberCount: 1,
      lockedLeadMembershipId: membershipId,
      freshForEventAttestation: {
        participantPolicyVersionId: participantPolicyId,
        acceptedByMembershipId: membershipId,
        acceptedAt: now,
      },
      finalConfirmation: {
        participantPolicyVersionId: participantPolicyId,
        previewedDraftVersion: 1,
        previewedTeamVersion: 1,
        confirmedByMembershipId: membershipId,
        confirmedAt: now,
      },
      participantPolicyVersionId: participantPolicyId,
      admissionPolicyVersionId: admissionPolicyId,
      sourceDraftVersion: 1,
      submittedByMembershipId: membershipId,
      submittedAt: now,
    });
    await ctx.db.patch(teamId, { lockedProjectVersionId: projectId });
    const applicationId = await ctx.db.insert("applications", {
      eventId,
      teamId,
      submittedProjectVersionId: projectId,
      admissionPolicyVersionId: admissionPolicyId,
      state: "under_review",
      decisionStage: "unrecorded",
      experienceBand: "mixed_or_external",
      aiDisposition: "unavailable",
      assignedReviewCount: 0,
      completedReviewCount: 0,
      contentVersion: 1,
      version: 1,
      submittedAt: now,
    });
    const failedRecommendationId = await ctx.db.insert("admissionAIRecommendations", {
      eventId,
      applicationId,
      teamId,
      projectVersionId: projectId,
      admissionPolicyVersionId: admissionPolicyId,
      modelConfigVersionId: modelConfigId,
      applicationContentVersion: 1,
      sourceInputFingerprint: "failed-admission-analysis",
      experienceBand: "mixed_or_external",
      state: "failed",
      criterionAssessments: [],
      strengths: [],
      concerns: [],
      limitations: ["The provider request failed."],
      failureCategory: "provider_failure",
      createdAt: now,
      completedAt: now,
    });
    await ctx.db.patch(applicationId, { aiRecommendationId: failedRecommendationId });
    await ctx.db.patch(eventId, {
      publishedParticipantPolicyId: participantPolicyId,
      publishedIntakePolicyId: intakePolicyId,
      publishedAdmissionPolicyId: admissionPolicyId,
      publishedAdmissionModelConfigId: modelConfigId,
    });
    for (const permissionKey of [
      "application.read",
      "application.ai_recommendation.run",
    ] as const) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: runnerPersonId,
        eventAccessSubjectId: runnerSubjectId,
        permissionKey,
        scopeType: "application",
        scopeId: applicationId,
        sourceType: "manual",
        sourceId: `runner:${permissionKey}`,
        grantedByPersonId: runnerPersonId,
        reason: "Admission retry fixture",
      });
    }
    for (const permissionKey of [
      "application.read",
      "application.ai_recommendation.read",
    ] as const) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: readerPersonId,
        eventAccessSubjectId: readerSubjectId,
        permissionKey,
        scopeType: "application",
        scopeId: applicationId,
        sourceType: "manual",
        sourceId: `reader:${permissionKey}`,
        grantedByPersonId: runnerPersonId,
        reason: "Admission retry fixture",
      });
    }
    return {
      eventId,
      eventSlug,
      runnerAuthUserId,
      runnerAuthSessionId,
      runnerPersonId,
      readerAuthUserId,
      readerAuthSessionId,
      applicationId,
      projectId,
      admissionPolicyId,
      modelConfigId,
      failedRecommendationId,
    };
  });
}

async function createAuthUser(backend: BackendTest, now: number, key: "runner" | "reader") {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: key === "runner" ? "Analysis operator" : "Analysis reader",
        email: `admission-${key}-${crypto.randomUUID()}@example.test`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  return documentId(result, "Better Auth user");
}

async function createAuthSession(
  backend: BackendTest,
  userId: string,
  now: number,
  key: "runner" | "reader",
) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        expiresAt: now + 60 * 60 * 1_000,
        token: `admission-${key}-${crypto.randomUUID()}`,
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
