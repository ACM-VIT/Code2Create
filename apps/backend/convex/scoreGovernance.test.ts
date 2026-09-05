import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { defaultVitHostelResidenceCatalog } from "@code2create/domain";
import { ConvexError } from "convex/values";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { insertPermissionGrant } from "./lib/permissions";
import {
  maximumReviewerAssignmentsPerEvent,
} from "./lib/reviewLimits";
import { requireScoreGovernancePageSize } from "./scoreGovernance";
import { createTestSubmissionSnapshot } from "./lib/testSubmissionSnapshot";
import {
  defaultDeterministicIntakePolicy,
  intakePolicyChecksum,
  normalizeIntakePolicy,
} from "./lib/intakePolicy";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

describe("combined review results", () => {
  test("weights are versioned, retryable, permission scoped, and never turn missing reviews into zero", async () => {
    const backend = seededBackend();
    const fixture = await seedCorrectionFixture(backend);
    await prepareCorrectionSubmission(backend, fixture);
    const secondRoundId = await backend.run(async (ctx) => {
      const original = await ctx.db.get(fixture.roundId);
      if (!original) throw new Error("Fixture round missing");
      const { _id, _creationTime, ...fields } = original;
      const second = await ctx.db.insert("reviewRounds", {
        ...fields,
        stableKey: "round-two",
        name: "Round 2",
        sequence: 2,
      });
      for (const permissionKey of [
        "review.configuration.read",
        "review.configuration.publish",
      ] as const) {
        await insertPermissionGrant(ctx, {
          eventId: fixture.eventId,
          personId: fixture.personId,
          eventAccessSubjectId: fixture.subjectId,
          permissionKey,
          scopeType: "event",
          sourceType: "manual",
          sourceId: "aggregation-test",
          grantedByPersonId: fixture.personId,
          reason: "Configure round weights",
        });
      }
      return second;
    });
    const actor = reviewerClient(backend, fixture);
    const publication = {
      eventSlug: fixture.eventSlug,
      expectedVersion: 0,
      reason: "Use the event round weights",
      rounds: [
        { roundId: fixture.roundId, weight: 30 },
        { roundId: secondRoundId, weight: 70 },
      ],
      clientOperationId: "publish-weights",
    };
    await expect(
      actor.mutation(api.reviewAggregation.publish, {
        ...publication,
        rounds: [{ roundId: fixture.roundId, weight: 30 }],
        clientOperationId: "invalid-weights",
      }),
    ).rejects.toThrow("totaling 100%");
    expect(
      await actor.mutation(api.reviewAggregation.publish, publication),
    ).toEqual({
      version: 1,
    });
    expect(
      await actor.mutation(api.reviewAggregation.publish, publication),
    ).toEqual({
      version: 1,
    });
    await expect(
      actor.mutation(api.reviewAggregation.publish, {
        ...publication,
        clientOperationId: "stale-weights",
      }),
    ).rejects.toThrow("Round weights changed");
    const read = () =>
      actor.query(api.reviewAggregation.results, {
        eventSlug: fixture.eventSlug,
      });
    expect((await read()).state).toBe("hidden");
    await backend.run(async (ctx) => {
      for (const roundId of [fixture.roundId, secondRoundId]) {
        await insertPermissionGrant(ctx, {
          eventId: fixture.eventId,
          personId: fixture.personId,
          eventAccessSubjectId: fixture.subjectId,
          permissionKey: "score.values.read",
          scopeType: "round",
          scopeId: roundId,
          sourceType: "manual",
          sourceId: `aggregation-${roundId}`,
          grantedByPersonId: fixture.personId,
          reason: "Read combined results",
        });
      }
    });
    expect((await read()).state).toBe("awaiting_rounds");
    const secondEntryId = await backend.run(async (ctx) => {
      const evaluation = await ctx.db
        .query("reviewEvaluations")
        .withIndex("by_session", (q) =>
          q.eq("reviewSessionId", fixture.reviewSessionId),
        )
        .unique();
      if (!evaluation) throw new Error("Evaluation fixture missing");
      const entryIds = [];
      for (const [roundId, totalPoints] of [
        [fixture.roundId, 80],
        [secondRoundId, 60],
      ] as const) {
        const snapshotId = await ctx.db.insert("roundCloseSnapshots", {
          eventId: fixture.eventId,
          roundId,
          rubricVersionId: fixture.rubricVersionId,
          revision: 1,
          roundConfigurationChecksum: "round-checksum",
          resultCount: 1,
          exclusionCount: 0,
          withdrawnCount: 0,
          checksum: `snapshot-${roundId}`,
          createdByPersonId: fixture.personId,
          createdAt: fixture.now,
        });
        await ctx.db.patch(roundId, {
          status: "closed",
          activeCloseSnapshotId: snapshotId,
        });
        entryIds.push(
          await ctx.db.insert("roundCloseEntries", {
            eventId: fixture.eventId,
            roundId,
            closeSnapshotId: snapshotId,
            teamId: fixture.teamId,
            payload: {
              kind: "result",
              reviewSessionId: fixture.reviewSessionId,
              evaluationId: evaluation._id,
              evaluationInputChecksum: evaluation.inputChecksum,
              criterionResults: [],
              totalPoints,
            },
            createdAt: fixture.now,
          }),
        );
      }
      return entryIds[1];
    });
    const result = await read();
    expect(result.state).toBe("ready");
    expect(result.teams[0]?.totalPoints).toBe(66);
    expect(
      await actor.mutation(api.reviewAggregation.publish, {
        ...publication,
        expectedVersion: 1,
        rounds: [
          { roundId: fixture.roundId, weight: 50 },
          { roundId: secondRoundId, weight: 50 },
        ],
        clientOperationId: "change-weights",
      }),
    ).toEqual({ version: 2 });
    expect((await read()).teams[0]?.totalPoints).toBe(70);
    const policies = await backend.run((ctx) =>
      ctx.db.query("reviewAggregationPolicies").collect(),
    );
    expect(policies.map((policy) => [policy.version, policy.status])).toEqual([
      [1, "superseded"],
      [2, "published"],
    ]);
    if (!secondEntryId) throw new Error("Second outcome fixture missing");
    await backend.run((ctx) => ctx.db.delete(secondEntryId));
    const incomplete = await read();
    expect(incomplete.teams[0]?.totalPoints).toBeNull();
    expect(incomplete.teams[0]?.rounds[1]?.state).toBe("missing");
  });
});

describe("score governance pagination", () => {
  test.each([true, false])(
    "final comments follow the published requirement (%s) and survive correction",
    async (required) => {
      const backend = seededBackend();
      const fixture = await seedCorrectionFixture(backend);
      await grantCorrectionDecision(backend, fixture);
      await prepareCorrectionSubmission(backend, fixture);
      await backend.run(async (ctx) => {
        await ctx.db.patch(fixture.roundId, { requiresFinalComment: required });
        await insertPermissionGrant(ctx, {
          eventId: fixture.eventId,
          personId: fixture.personId,
          eventAccessSubjectId: fixture.subjectId,
          permissionKey: "scorecard.draft.write",
          scopeType: "scorecard",
          scopeId: fixture.scorecardId,
          sourceType: "panel_assignment",
          sourceId: fixture.assignmentId,
          grantedByPersonId: fixture.personId,
          reason: "Reviewer comment correction test",
        });
      });
      const reviewer = reviewerClient(backend, fixture);
      const request = await reviewer.mutation(
        api.scoreGovernance.requestCorrection,
        correctionRequestArgs(fixture, "request-comment-correction"),
      );
      await reviewer.mutation(api.scoreGovernance.decideCorrection, {
        eventSlug: fixture.eventSlug,
        correctionCaseId: request.correctionCaseId,
        expectedCaseVersion: request.version,
        expectedScorecardVersion: 1,
        decision: "open",
        reason: "Correct the reviewer feedback.",
        clientOperationId: "open-comment-correction",
      });
      const draftArgs = {
        eventSlug: fixture.eventSlug,
        installationId: "correction-boundary-device",
        scorecardId: fixture.scorecardId,
        ratings: [],
        privateNote: "This note must stay separate from final feedback.",
        finalComment: "   ",
        expectedDraftVersion: 1,
        clientOperationId: "save-private-only",
      };
      const saved = await reviewer.mutation(api.reviewer.saveDraft, draftArgs);
      let draftVersion = saved.draftVersion;
      if (required) {
        await expect(
          reviewer.mutation(api.reviewer.submitScorecard, {
            eventSlug: fixture.eventSlug,
            installationId: draftArgs.installationId,
            scorecardId: fixture.scorecardId,
            expectedDraftVersion: draftVersion,
            clientOperationId: "missing-final-comment",
          }),
        ).rejects.toThrow("Leave a final comment");
        const updated = await reviewer.mutation(api.reviewer.saveDraft, {
          ...draftArgs,
          finalComment:
            "  Clear architecture; improve the error recovery flow.  ",
          expectedDraftVersion: draftVersion,
          clientOperationId: "save-final-comment",
        });
        draftVersion = updated.draftVersion;
      }
      const submitArgs = {
        eventSlug: fixture.eventSlug,
        installationId: draftArgs.installationId,
        scorecardId: fixture.scorecardId,
        expectedDraftVersion: draftVersion,
        clientOperationId: "submit-final-comment",
      };
      const submitted = await reviewer.mutation(
        api.reviewer.submitScorecard,
        submitArgs,
      );
      expect(
        await reviewer.mutation(api.reviewer.submitScorecard, submitArgs),
      ).toEqual(submitted);
      const version = await backend.run((ctx) =>
        ctx.db.get(submitted.scorecardVersionId),
      );
      expect(version?.finalComment).toBe(
        required
          ? "Clear architecture; improve the error recovery flow."
          : undefined,
      );
      expect(version?.privateNote).toBe(draftArgs.privateNote);
      expect(version?.supersedesVersionId).toBe(fixture.scorecardVersionId);
    },
  );

  test("accepts only bounded integer page sizes", () => {
    expect(() => requireScoreGovernancePageSize(1)).not.toThrow();
    expect(() => requireScoreGovernancePageSize(30)).not.toThrow();

    for (const pageSize of [0, 31, 1.5, Number.NaN]) {
      expect(() => requireScoreGovernancePageSize(pageSize)).toThrow(ConvexError,
      );
    }
  });

  test("reviewer correction options stay inside one event and return the latest correction", async () => {
    const backend = seededBackend();
    const fixture = await seedCorrectionFixture(backend);
    await backend.run(async (ctx) => {
      await insertCorrectionCase(ctx, fixture, {
        reason: "Earlier correction",
        state: "rejected",
        requestedAt: fixture.now - 1_000,
      });
      const latestCaseId = await insertCorrectionCase(ctx, fixture, {
        reason: "Latest correction",
        state: "closed",
        requestedAt: fixture.now,
      });
      const foreignEventId = await ctx.db.insert("events", {
        slug: `foreign-score-${crypto.randomUUID()}`,
        name: "Foreign score fixture",
        timezone: "Asia/Kolkata",
        status: "live",
        vitEmailDomains: ["vitstudent.ac.in"],
        externalApplicationsCloseAt: Date.now() + 86_400_000,
        applicationsCloseAt: Date.now() + 86_400_000,
        startsAt: fixture.now - 60_000,
        endsAt: fixture.now + 3_600_000,
        version: 1,
        createdAt: fixture.now,
        updatedAt: fixture.now,
      });
      for (let index = 0; index <= maximumReviewerAssignmentsPerEvent; index += 1) {
        await ctx.db.insert("scorecards", {
          eventId: foreignEventId,
          roundId: fixture.roundId,
          reviewSessionId: fixture.reviewSessionId,
          reviewerPersonId: fixture.personId,
          assignmentId: fixture.assignmentId,
          rubricVersionId: fixture.rubricVersionId,
          status: "submitted",
          ratings: [],
          draftVersion: 1,
          submittedVersionId: fixture.scorecardVersionId,
          submittedAt: fixture.now,
          version: 1,
          createdAt: fixture.now,
          updatedAt: fixture.now,
        });
      }
      fixture.latestCaseId = latestCaseId;
    });

    const reviewer = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });
    await expect(
      reviewer.query(api.scoreGovernance.myCorrectionOptions, {
        eventSlug: fixture.eventSlug,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        scorecardId: fixture.scorecardId,
        canRequest: true,
        currentCase: expect.objectContaining({
          id: fixture.latestCaseId,
          reason: "Latest correction",
        }),
      }),
    ]);
  });

  test("correction options fail loudly above the event scorecard owner limit", async () => {
    const backend = seededBackend();
    const fixture = await seedCorrectionFixture(backend);
    await backend.run(async (ctx) => {
      for (let index = 0; index < maximumReviewerAssignmentsPerEvent; index += 1) {
        await ctx.db.insert("scorecards", {
          eventId: fixture.eventId,
          roundId: fixture.roundId,
          reviewSessionId: fixture.reviewSessionId,
          reviewerPersonId: fixture.personId,
          assignmentId: fixture.assignmentId,
          rubricVersionId: fixture.rubricVersionId,
          status: "submitted",
          ratings: [],
          draftVersion: 1,
          submittedVersionId: fixture.scorecardVersionId,
          submittedAt: fixture.now + index + 1,
          version: 1,
          createdAt: fixture.now,
          updatedAt: fixture.now,
        });
      }
    });
    const reviewer = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });
    await expect(
      reviewer.query(api.scoreGovernance.myCorrectionOptions, {
        eventSlug: fixture.eventSlug,
      }),
    ).rejects.toThrow("event scorecard limit");
  });

  test("a correction request succeeds at the inclusive deadline", async () => {
    const backend = seededBackend();
    const fixture = await seedCorrectionFixture(backend);
    const deadline = fixture.now + 10_000;
    await setCorrectionDeadline(backend, fixture, deadline);
    const clock = vi.spyOn(Date, "now").mockReturnValue(deadline);
    try {
      const result = await reviewerClient(backend, fixture).mutation(
        api.scoreGovernance.requestCorrection,
        correctionRequestArgs(fixture, "request-at-deadline"),
      );
      await expect(
        backend.run((ctx) => ctx.db.get(result.correctionCaseId)),
      ).resolves.toMatchObject({
        state: "requested",
        requestedAt: deadline,
        version: 1,
      });
    } finally {
      clock.mockRestore();
    }
  });

  test("a correction request after the deadline fails without mutations", async () => {
    const backend = seededBackend();
    const fixture = await seedCorrectionFixture(backend);
    const deadline = fixture.now + 10_000;
    await setCorrectionDeadline(backend, fixture, deadline);
    const before = await correctionWriteSnapshot(backend, fixture);
    const clock = vi.spyOn(Date, "now").mockReturnValue(deadline + 1);
    try {
      await expect(
        reviewerClient(backend, fixture).mutation(
          api.scoreGovernance.requestCorrection,
          correctionRequestArgs(fixture, "request-after-deadline"),
        ),
      ).rejects.toThrow("no longer accepts");
      await expect(correctionWriteSnapshot(backend, fixture)).resolves.toEqual(before,
      );
      await expect(
        reviewerClient(backend, fixture).query(api.scoreGovernance.myCorrectionOptions, {
          eventSlug: fixture.eventSlug,
        },
        ),
      ).resolves.toEqual([
        expect.objectContaining({ scorecardId: fixture.scorecardId, canRequest: false,
        }),
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  test("an open decision succeeds at the inclusive correction deadline", async () => {
    const backend = seededBackend();
    const fixture = await seedCorrectionFixture(backend);
    const deadline = fixture.now + 10_000;
    await setCorrectionDeadline(backend, fixture, deadline);
    await grantCorrectionDecision(backend, fixture);
    const clock = vi.spyOn(Date, "now").mockReturnValue(deadline);
    try {
      const request = await reviewerClient(backend, fixture).mutation(
        api.scoreGovernance.requestCorrection,
        correctionRequestArgs(fixture, "request-for-exact-open"),
      );
      await expect(
        reviewerClient(backend, fixture).mutation(api.scoreGovernance.decideCorrection, {
          eventSlug: fixture.eventSlug,
          correctionCaseId: request.correctionCaseId,
          expectedCaseVersion: request.version,
          expectedScorecardVersion: 1,
          decision: "open",
          reason: "Approve at the published deadline",
          clientOperationId: "open-at-deadline",
        },
        ),
      ).resolves.toMatchObject({ state: "open", version: 2 });
    } finally {
      clock.mockRestore();
    }
  });

  test("after the deadline an open decision is atomic but rejection remains available", async () => {
    const backend = seededBackend();
    const fixture = await seedCorrectionFixture(backend);
    const deadline = fixture.now + 10_000;
    await setCorrectionDeadline(backend, fixture, deadline);
    await grantCorrectionDecision(backend, fixture);
    const clock = vi.spyOn(Date, "now").mockReturnValue(deadline);
    try {
      const request = await reviewerClient(backend, fixture).mutation(
        api.scoreGovernance.requestCorrection,
        correctionRequestArgs(fixture, "request-for-late-decision"),
      );
      clock.mockReturnValue(deadline + 1);
      const before = await correctionWriteSnapshot(backend, fixture);
      const decisionArgs = {
        eventSlug: fixture.eventSlug,
        correctionCaseId: request.correctionCaseId,
        expectedCaseVersion: request.version,
        expectedScorecardVersion: 1,
        reason: "Resolve the pending correction request",
      };
      await expect(
        reviewerClient(backend, fixture).mutation(api.scoreGovernance.decideCorrection, {
          ...decisionArgs,
          decision: "open",
          clientOperationId: "late-open",
        },
        ),
      ).rejects.toThrow("no longer accepts");
      await expect(correctionWriteSnapshot(backend, fixture)).resolves.toEqual(before,
      );
      await expect(
        reviewerClient(backend, fixture).mutation(api.scoreGovernance.decideCorrection, {
          ...decisionArgs,
          decision: "reject",
          clientOperationId: "late-reject",
        },
        ),
      ).resolves.toMatchObject({ state: "rejected", version: 2 });
    } finally {
      clock.mockRestore();
    }
  });

  test("an already-open correction can be submitted after the request deadline", async () => {
    const backend = seededBackend();
    const fixture = await seedCorrectionFixture(backend);
    const deadline = fixture.now + 10_000;
    await setCorrectionDeadline(backend, fixture, deadline);
    await grantCorrectionDecision(backend, fixture);
    await prepareCorrectionSubmission(backend, fixture);
    const clock = vi.spyOn(Date, "now").mockReturnValue(deadline);
    try {
      const request = await reviewerClient(backend, fixture).mutation(
        api.scoreGovernance.requestCorrection,
        correctionRequestArgs(fixture, "request-before-late-submit"),
      );
      await reviewerClient(backend, fixture).mutation(api.scoreGovernance.decideCorrection, {
        eventSlug: fixture.eventSlug,
        correctionCaseId: request.correctionCaseId,
        expectedCaseVersion: request.version,
        expectedScorecardVersion: 1,
        decision: "open",
        reason: "Open the correction before the deadline",
        clientOperationId: "open-before-late-submit",
      },
      );
      clock.mockReturnValue(deadline + 1);
      const submission = await reviewerClient(backend, fixture).mutation(
        api.reviewer.submitScorecard,
        {
          eventSlug: fixture.eventSlug,
          installationId: "correction-boundary-device",
          scorecardId: fixture.scorecardId,
          expectedDraftVersion: 1,
          clientOperationId: "submit-open-correction-after-deadline",
        },
      );
      await expect(
        backend.run((ctx) => ctx.db.get(request.correctionCaseId)),
      ).resolves.toMatchObject({
        state: "closed",
        replacementVersionId: submission.scorecardVersionId,
        version: 3,
      });
    } finally {
      clock.mockRestore();
    }
  });

  test("submitted participant view reads the immutable project instead of a mutable draft", async () => {
    const backend = seededBackend({ documentsRead: 30 });
    const fixture = await seedCorrectionFixture(backend);
    const applicationId = await backend.run(async (ctx) => {
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.personId,
        eventAccessSubjectId: fixture.subjectId,
        permissionKey: "team.read",
        scopeType: "team",
        scopeId: fixture.teamId,
        sourceType: "manual",
        sourceId: `${fixture.eventSlug}:submitted-view`,
        grantedByPersonId: fixture.personId,
        reason: "Submitted participant view test",
      });
      await ctx.db.insert("projectDrafts", {
        eventId: fixture.eventId,
        teamId: fixture.teamId,
        intakePolicyVersionId: fixture.intakePolicyVersionId,
        stage: "submitted",
        initialIdea: "A stale mutable draft value that must not reach the submitted view.",
        freshnessAttestedByMembershipId: fixture.membershipId,
        freshnessAttestedAt: fixture.now,
        version: 1,
        lastEditedByMembershipId: fixture.membershipId,
        updatedAt: fixture.now,
      });
      return ctx.db.insert("applications", {
        eventId: fixture.eventId,
        teamId: fixture.teamId,
        submittedProjectVersionId: fixture.projectVersionId,
        admissionPolicyVersionId: fixture.admissionPolicyVersionId,
        state: "confirmed",
        decisionStage: "released",
        experienceBand: "mixed_or_external",
        assignedReviewCount: 0,
        completedReviewCount: 0,
        contentVersion: 1,
        version: 1,
        submittedAt: fixture.now,
      });
    });
    const participant = backend.withIdentity({
      subject: fixture.authUserId,
      sessionId: fixture.authSessionId,
    });
    await expect(
      participant.query(api.intake.submitted, { eventSlug: fixture.eventSlug }),
    ).resolves.toEqual({
      serverNow: expect.any(Number),
      currentRole: "lead",
      project: {
        id: fixture.projectVersionId,
        initialIdea: "A fixture project for score correction tests.",
        intakeResponses: [],
        version: 1,
      },
      editRules: {
        additionalInformationMaxLength: 4_000,
        initialIdeaMinLength: defaultDeterministicIntakePolicy.initialIdeaMinLength,
        initialIdeaMaxLength: defaultDeterministicIntakePolicy.initialIdeaMaxLength,
        followUpAnswerMinLength: defaultDeterministicIntakePolicy.followUpAnswerMinLength,
        followUpAnswerMaxLength: defaultDeterministicIntakePolicy.followUpAnswerMaxLength,
        deterministicFollowUpCount:
          defaultDeterministicIntakePolicy.deterministicFollowUpCount,
        maximumFollowUpCount: defaultDeterministicIntakePolicy.maximumFollowUpCount,
      },
      applicationsCloseAt: expect.any(Number),
      canEdit: false,
      novelty: null,
      noveltySignal: null,
      application: {
        id: applicationId,
        state: "confirmed",
        version: 1,
        contentVersion: 1,
        submittedAt: fixture.now,
        currentOffer: null,
      },
    });
  });
});

function seededBackend(transactionLimits?: { documentsRead: number }) {
  const backend = convexTest({
    schema,
    modules,
    ...(transactionLimits === undefined ? {} : { transactionLimits }),
  });
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return backend;
}

type CorrectionFixture = Awaited<ReturnType<typeof seedCorrectionFixture>>;

function reviewerClient(backend: BackendTest, fixture: CorrectionFixture) {
  return backend.withIdentity({
    subject: fixture.authUserId,
    sessionId: fixture.authSessionId,
  });
}

function correctionRequestArgs(fixture: CorrectionFixture, clientOperationId: string,
) {
  return {
    eventSlug: fixture.eventSlug,
    scorecardId: fixture.scorecardId,
    expectedScorecardVersion: 1,
    category: "reviewer_error" as const,
    reason: "Correct the submitted scorecard evidence",
    clientOperationId,
  };
}

async function setCorrectionDeadline(
  backend: BackendTest,
  fixture: CorrectionFixture,
  correctionRequestsCloseAt: number,
) {
  await backend.run((ctx) => ctx.db.patch(fixture.roundId, { correctionRequestsCloseAt }),
  );
}

async function grantCorrectionDecision(backend: BackendTest, fixture: CorrectionFixture,
) {
  await backend.run((ctx) =>
    insertPermissionGrant(ctx, {
      eventId: fixture.eventId,
      personId: fixture.personId,
      eventAccessSubjectId: fixture.subjectId,
      permissionKey: "scorecard.correction.open",
      scopeType: "scorecard",
      scopeId: fixture.scorecardId,
      sourceType: "manual",
      sourceId: `${fixture.eventSlug}:correction-decision`,
      grantedByPersonId: fixture.personId,
      reason: "Score correction decision boundary test",
    }),
  );
}

async function prepareCorrectionSubmission(backend: BackendTest, fixture: CorrectionFixture,
) {
  await backend.run(async (ctx) => {
    await ctx.db.insert("reviewerDevices", {
      eventId: fixture.eventId,
      personId: fixture.personId,
      installationId: "correction-boundary-device",
      name: "Correction boundary device",
      platform: "android",
      appBuild: 1,
      cameraReady: true,
      encryptedDraftReady: true,
      pushTokenStatus: "not_registered",
      pushTokenUpdatedAt: fixture.now,
      status: "active",
      version: 1,
      registeredAt: fixture.now,
      lastSeenAt: fixture.now,
    });
    await ctx.db.insert("reviewEvaluations", {
      eventId: fixture.eventId,
      roundId: fixture.roundId,
      reviewSessionId: fixture.reviewSessionId,
      teamId: fixture.teamId,
      rubricVersionId: fixture.rubricVersionId,
      criterionResults: [],
      totalPoints: 0,
      state: "complete",
      inputChecksum: "correction-boundary-evaluation",
      version: 1,
      computedAt: fixture.now,
    });
    await insertPermissionGrant(ctx, {
      eventId: fixture.eventId,
      personId: fixture.personId,
      eventAccessSubjectId: fixture.subjectId,
      permissionKey: "scorecard.submit",
      scopeType: "scorecard",
      scopeId: fixture.scorecardId,
      sourceType: "panel_assignment",
      sourceId: fixture.assignmentId,
      grantedByPersonId: fixture.personId,
      reason: "Correction submission boundary test",
    });
  });
}

async function correctionWriteSnapshot(backend: BackendTest, fixture: CorrectionFixture,
) {
  return backend.run(async (ctx) => {
    const [correctionCases, operationResults, auditEvents, scorecard] = await Promise.all([
      ctx.db.query("scorecardCorrectionCases").collect(),
      ctx.db.query("operationResults").collect(),
      ctx.db.query("auditEvents").collect(),
      ctx.db.get(fixture.scorecardId),
    ]);
    return {
      correctionCases,
      operationResults,
      auditEvents,
      scorecard,
    };
  });
}

async function seedCorrectionFixture(backend: BackendTest) {
  const now = Date.now();
  const eventSlug = `score-governance-${crypto.randomUUID()}`;
  const email = `reviewer-${crypto.randomUUID()}@example.test`;
  const authUserId = await createAuthUser(backend, now, email);
  const authSessionId = await createAuthSession(backend, authUserId, now);
  const data = await backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId,
      googleSubject: crypto.randomUUID(),
      verifiedEmail: email,
      displayName: "Correction reviewer",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Score governance fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      externalApplicationsCloseAt: Date.now() + 86_400_000,
      applicationsCloseAt: Date.now() + 86_400_000,
      startsAt: now - 60_000,
      endsAt: now + 3_600_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: email,
      displayName: "Correction reviewer",
      status: "active",
      linkedBy: "access_invitation",
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
      name: "Correction team",
      publicCode: crypto.randomUUID(),
      leadMembershipId: membershipId,
      status: "confirmed",
      activeMemberCount: 1,
      activeVitMemberCount: 0,
      activeExternalMemberCount: 1,
      membershipLocked: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const participantPolicyVersionId = await ctx.db.insert("participantPolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      label: "Correction policy",
      teamMinimumSize: 1,
      teamMaximumSize: 4,
      mixedParticipantClassesAllowed: false,
      phoneVerificationEnabled: false,
      vitHostelResidenceCatalog: defaultVitHostelResidenceCatalog,
      profileNotice: "Correction fixture profile notice",
      projectTextNotice: "Correction fixture project notice",
      privacyNoticeUrl: "https://example.test/privacy",
      freshProjectAttestation: "This project started at the event.",
      finalSubmissionWarning: "Confirm the fixture submission.",
      checksum: crypto.randomUUID(),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    },
    );
    const intakePolicy = normalizeIntakePolicy(defaultDeterministicIntakePolicy,
    );
    const intakePolicyVersionId = await ctx.db.insert("intakePolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...intakePolicy,
      checksum: intakePolicyChecksum(intakePolicy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    const admissionPolicyVersionId = await ctx.db.insert("admissionPolicyVersions", {
      eventId,
      version: "1",
      status: "published",
      aiRecommendationMode: "disabled",
      minimumHumanReviews: 1,
      overallParticipantCapacity: 100,
      criteria: [],
      decisionReasonCodes: [],
      checksum: crypto.randomUUID(),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    },
    );
    const teamMemberId = await ctx.db.insert("teamMembers", {
      eventId,
      teamId,
      membershipId,
      role: "lead",
      status: "active",
      joinedAt: now,
      source: "created",
    });
    const lockedRosterSnapshotId = await createTestSubmissionSnapshot(ctx, {
      eventId,
      teamId,
      teamMemberIds: [teamMemberId],
      intakePolicyVersionId,
      participantPolicyVersionId,
      admissionPolicyVersionId,
      submittedAt: now,
    });
    const projectVersionId = await ctx.db.insert("projectVersions", {
      eventId,
      teamId,
      version: 1,
      initialIdea: "A fixture project for score correction tests.",
      intakePolicyVersionId,
      intakeResponses: [],
      lockedRosterSnapshotId,
      lockedMemberCount: 1,
      lockedLeadMembershipId: membershipId,
      freshForEventAttestation: {
        participantPolicyVersionId,
        acceptedByMembershipId: membershipId,
        acceptedAt: now,
      },
      finalConfirmation: {
        participantPolicyVersionId,
        previewedDraftVersion: 1,
        previewedTeamVersion: 1,
        confirmedByMembershipId: membershipId,
        confirmedAt: now,
      },
      participantPolicyVersionId,
      admissionPolicyVersionId,
      sourceDraftVersion: 1,
      submittedByMembershipId: membershipId,
      submittedAt: now,
    });
    const rubricVersionId = await ctx.db.insert("reviewRubricVersions", {
      eventId,
      version: 1,
      name: "Correction rubric",
      status: "published",
      scoreMinimum: 0,
      scoreMaximum: 4,
      aggregationFormula: "criterion_mean_weighted_v1",
      spreadThreshold: 2,
      checksum: crypto.randomUUID(),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    const roundId = await ctx.db.insert("reviewRounds", {
      eventId,
      rubricVersionId,
      stableKey: "correction-round",
      name: "Correction round",
      sequence: 1,
      status: "open",
      startsAt: now - 60_000,
      endsAt: now + 3_600_000,
      clockInOpensAt: now - 120_000,
      reviewerReportAt: now - 90_000,
      noShowGraceSeconds: 30,
      correctionRequestsCloseAt: now + 3_600_000,
      reviewDurationSeconds: 600,
      ordinaryExtensionSeconds: 120,
      maximumOrdinaryExtensions: 1,
      missedCallGraceSeconds: 60,
      requiredCallAttempts: 1,
      substituteResponseSeconds: 60,
      missedReentryPolicy: "queue_end",
      requiredPanelSize: 1,
      staffing: {
        seniorSeats: 0,
        juniorSeats: 0,
        allowSeniorLeadFallback: true,
        automaticReplacement: false,
        juniorRotationReviews: 0,
        reviewerArrivalSeconds: 90,
        assignmentReminderSeconds: 300,
      },
      minimumScorersPerCriterion: 1,
      minimumPresentParticipants: 1,
      requiresSharedCommitments: false,
      requiresFinalComment: false,
      minimumReviewerBuild: 1,
      requiresCamera: false,
      requiresNotifications: false,
      version: 1,
      configurationChecksum: crypto.randomUUID(),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
      openedAt: now,
    });
    const panelId = await ctx.db.insert("reviewPanels", {
      eventId,
      roundId,
      stableKey: "correction-panel",
      name: "Correction panel",
      coordinatorPersonId: personId,
      status: "ready",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const evidenceCheckpointSetId = await ctx.db.insert("reviewEvidenceCheckpointSets", {
      eventId,
      roundId,
      roundSequence: 1,
      teamId,
      projectVersionId,
      githubEntries: [],
      figmaEntries: [],
      expectedResourceCount: 0,
      capturedResourceCount: 0,
      completeness: "complete",
      checksum: crypto.randomUUID(),
      createdByPersonId: personId,
      createdAt: now,
    },
    );
    const reviewSessionId = await ctx.db.insert("reviewSessions", {
      eventId,
      roundId,
      panelId,
      teamId,
      projectVersionId,
      evidenceCheckpointSetId,
      rubricVersionId,
      panelVersion: 1,
      status: "completed",
      extensionCount: 0,
      extensionSeconds: 0,
      sharedNotesVersion: 0,
      completedAt: now,
      version: 1,
      createdByPersonId: personId,
      createdAt: now,
      updatedAt: now,
    });
    const assignmentId = await ctx.db.insert("reviewAssignments", {
      eventId,
      roundId,
      panelId,
      reviewSessionId,
      reviewerPersonId: personId,
      eventAccessSubjectId: subjectId,
      assignedCriterionIds: [],
      isCoordinator: true,
      status: "assigned",
      assignedAt: now,
    });
    const scorecardId = await ctx.db.insert("scorecards", {
      eventId,
      roundId,
      reviewSessionId,
      reviewerPersonId: personId,
      assignmentId,
      rubricVersionId,
      status: "draft",
      ratings: [],
      draftVersion: 1,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const scorecardVersionId = await ctx.db.insert("scorecardVersions", {
      eventId,
      roundId,
      reviewSessionId,
      scorecardId,
      reviewerPersonId: personId,
      version: 1,
      rubricVersionId,
      ratings: [],
      checksum: crypto.randomUUID(),
      clientOperationId: crypto.randomUUID(),
      submittedAt: now,
    });
    await ctx.db.patch(scorecardId, {
      status: "submitted",
      submittedVersionId: scorecardVersionId,
      submittedAt: now,
    });
    await insertPermissionGrant(ctx, {
      eventId,
      personId,
      eventAccessSubjectId: subjectId,
      permissionKey: "scorecard.correction.request",
      scopeType: "scorecard",
      scopeId: scorecardId,
      sourceType: "panel_assignment",
      sourceId: assignmentId,
      grantedByPersonId: personId,
      reason: "Correction options test",
    });
    return {
      eventId,
      personId,
      subjectId,
      membershipId,
      teamId,
      intakePolicyVersionId,
      admissionPolicyVersionId,
      projectVersionId,
      roundId,
      reviewSessionId,
      assignmentId,
      rubricVersionId,
      scorecardId,
      scorecardVersionId,
    };
  });
  return {
    ...data,
    now,
    eventSlug,
    authUserId,
    authSessionId,
    latestCaseId: "" as Id<"scorecardCorrectionCases">,
  };
}

async function insertCorrectionCase(
  ctx: MutationCtx,
  fixture: Awaited<ReturnType<typeof seedCorrectionFixture>>,
  args: {
    reason: string;
    state: "rejected" | "closed";
    requestedAt: number;
  },
) {
  return ctx.db.insert("scorecardCorrectionCases", {
    eventId: fixture.eventId,
    roundId: fixture.roundId,
    reviewSessionId: fixture.reviewSessionId,
    scorecardId: fixture.scorecardId,
    kind: "correction",
    category: "reviewer_error",
    reason: args.reason,
    state: args.state,
    originalVersionId: fixture.scorecardVersionId,
    requestedByPersonId: fixture.personId,
    requestedAt: args.requestedAt,
    version: 1,
  });
}

async function createAuthUser(backend: BackendTest, now: number, email: string,
) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Correction reviewer",
        email,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  },
  );
  return documentId(result, "Better Auth user");
}

async function createAuthSession(backend: BackendTest, userId: string, now: number,
) {
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
  },
  );
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
