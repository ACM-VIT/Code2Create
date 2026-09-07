import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import aggregateTest from "@convex-dev/aggregate/test";
import { defaultVitHostelResidenceCatalog,
  reviewQuestionProtocolVersion,
  reviewQuestionAgentVersion,
  type ReviewQuestionRequest,
} from "@code2create/domain";
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, describe, expect, test } from "vitest";

import { api, components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { initializeAttendanceTeamAvailability } from "./lib/attendanceTeamAvailability.ts";
import { insertPermissionGrant } from "./lib/permissions.ts";
import { createTestSubmissionSnapshot } from "./lib/testSubmissionSnapshot.ts";
import { buildEvidenceCheckpoint } from "./lib/reviewEvidenceCheckpoint.ts";
import {
  nextQueuedTeam,
  insertTeamRoundState,
  participantQueuePosition,
  patchTeamRoundState,
} from "./lib/reviewQueueProjection.ts";
import { notifyReviewTeam } from "./lib/reviewTeamNotices.ts";
import { integrationPolicyChecksum } from "./lib/integrationPolicy.ts";
import { routeReviewTeam } from "./lib/reviewPanelRouting.ts";
import { prepareQuestionSet } from "./reviewQuestions.ts";
import { questionPayloadChecksum } from "./lib/reviewQuestionProtocol.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;
type Fixture = Awaited<ReturnType<typeof seedQueueFixture>>;

const originalAuthSiteUrl = process.env.AUTH_SITE_URL;
const originalParticipantSiteUrl = process.env.PARTICIPANT_SITE_URL;
const originalOperationsSiteUrl = process.env.OPERATIONS_SITE_URL;

process.env.AUTH_SITE_URL = "http://localhost:3211";
process.env.PARTICIPANT_SITE_URL = "http://localhost:4173";
process.env.OPERATIONS_SITE_URL = "http://localhost:4174";

afterAll(() => {
  restoreEnvironment("AUTH_SITE_URL", originalAuthSiteUrl);
  restoreEnvironment("PARTICIPANT_SITE_URL", originalParticipantSiteUrl);
  restoreEnvironment("OPERATIONS_SITE_URL", originalOperationsSiteUrl);
});

describe("participant review queue projection", () => {
  test.each(["missing", "unknown"] as const)("captures repository evidence when the optional topic is %s or from a previous policy", async topicState => {
    const backend = seededBackend();
    const fixture = await seedQueueFixture(backend);
    await seedAwaitingReview(backend, fixture);
    await prepareAutomaticQueue(backend, fixture);
    await backend.run(async ctx => {
      const connectionId = await ctx.db.insert("githubInstallationConnections", {
        eventId: fixture.eventId, teamId: fixture.teamId, installationId: "topic-fixture",
        accountId: "topic-fixture", accountLogin: "topic-fixture", targetType: "User",
        repositorySelection: "selected", state: "active", connectedByPersonId: fixture.personId,
        connectedAt: fixture.now, lastVerifiedAt: fixture.now, version: 1,
      });
      const bindingId = await ctx.db.insert("githubRepositoryBindings", {
        eventId: fixture.eventId, teamId: fixture.teamId, installationConnectionId: connectionId,
        repositoryId: "topic-repo", repositoryNodeId: "topic-repo", owner: "fixture", name: "product",
        fullName: "fixture/product", url: "https://github.com/fixture/product", isPrivate: true,
        isFork: false, defaultBranch: "main", kind: "full_product", purpose: "Product",
        trackedBranch: "main", displayOrder: 1, requiredTopic: "old-suggestion", topicState,
        state: "active", baselineSha: "abc", currentHeadSha: "abc", syncRevision: 1,
        syncedRevision: 1, syncState: "ready", version: 1, providerCreatedAt: fixture.now,
        connectedAt: fixture.now, updatedAt: fixture.now,
      });
      const snapshotId = await ctx.db.insert("githubRepositorySnapshots", {
        eventId: fixture.eventId, teamId: fixture.teamId, repositoryBindingId: bindingId,
        reason: "baseline", headSha: "abc", topicState, commitCount: 0, additions: 0,
        deletions: 0, changedFiles: 0, observedCommitShas: [], commitIdentityComplete: true,
        languageBytes: [], completeness: "complete", compareTruncated: false, capturedAt: fixture.now,
      });
      const team = await ctx.db.get(fixture.teamId);
      const round = await ctx.db.get(fixture.roundId);
      if (!team || !round) throw new Error("Missing review fixture");
      const checkpoint = await buildEvidenceCheckpoint(ctx, {
        eventId: fixture.eventId, team, round, actorPersonId: fixture.personId, createdAt: fixture.now + 1,
      });
      expect(checkpoint).toMatchObject({ completeness: "complete", expectedResourceCount: 1, capturedResourceCount: 1 });
      expect(checkpoint.githubEntries[0]).toMatchObject({ bindingId, snapshotId });
    });
  });

  test("Figma links are versioned, permissioned and excluded from agent evidence", async () => {
    const backend = seededBackend();
    const fixture = await seedQueueFixture(backend);
    const actor = asParticipant(backend, fixture);
    const args = { eventSlug: fixture.eventSlug, fileUrl: "https://www.figma.com/design/Abc123/Project?node-id=1-2", expectedVersion: 0, clientOperationId: "figma-link-save" };
    expect(await actor.query(api.figmaLinks.current, { eventSlug: fixture.eventSlug })).toBeNull();
    await expect(actor.mutation(api.figmaLinks.save, args)).rejects.toThrow("does not have permission");
    await backend.run(async ctx => {
      for (const permissionKey of ["integration.read", "integration.figma.manage"] as const) await insertPermissionGrant(ctx, {
        eventId: fixture.eventId, personId: fixture.personId, eventAccessSubjectId: fixture.subjectId,
        permissionKey, scopeType: "team", scopeId: fixture.teamId, sourceType: "manual", sourceId: permissionKey,
        grantedByPersonId: fixture.personId, reason: "Participant link test",
      });
    });
    expect(await actor.mutation(api.figmaLinks.save, args)).toEqual({ version: 1 });
    expect(await actor.mutation(api.figmaLinks.save, args)).toEqual({ version: 1 });
    expect(await actor.query(api.figmaLinks.current, { eventSlug: fixture.eventSlug })).toEqual({ fileUrl: args.fileUrl, version: 1, canEdit: true });
    await expect(actor.mutation(api.figmaLinks.save, { ...args, clientOperationId: "stale-edit" })).rejects.toThrow("A teammate changed");
    expect(await backend.run(ctx => ctx.db.query("teamFigmaLinks").collect())).toHaveLength(1);
    await seedAwaitingReview(backend, fixture);
    await prepareAutomaticQueue(backend, fixture);
    const prepared = await prepareQuestionFixture(backend, fixture, false);
    const job = await backend.run(ctx => ctx.db.get(prepared.jobId));
    expect(job?.snapshot).toMatchObject({ figmaFileUrl: args.fileUrl, expectedResourceCount: 0 });
    expect(JSON.stringify(prepared.context)).not.toContain(args.fileUrl);
    expect(prepared.context).not.toHaveProperty("figma");
    expect(JSON.parse(prepared.context.projectText)).toMatchObject({ officialEventStartsAt: new Date(fixture.now - 60000).toISOString() });
    await actor.mutation(api.figmaLinks.save, { ...args, fileUrl: "", expectedVersion: 1, clientOperationId: "clear-link" });
    expect(await actor.query(api.figmaLinks.current, { eventSlug: fixture.eventSlug })).toEqual({ fileUrl: null, version: 2, canEdit: true });
    // A review retains the link selected at preparation; subsequent edits do not inspect any file.
    expect((await backend.run(ctx => ctx.db.get(prepared.jobId)))?.snapshot.figmaFileUrl).toBe(args.fileUrl);
    const sameQuestionSet = await backend.run(async ctx => {
      const round = await ctx.db.get(fixture.roundId);
      const team = await ctx.db.get(fixture.teamId);
      if (!round || !team) throw new Error("Review fixture missing");
      return prepareQuestionSet(ctx, round, team);
    });
    expect(sameQuestionSet).toBe(prepared.jobId);
    await backend.run(ctx => ctx.db.patch(fixture.eventId, { status: "complete" }));
    expect(await actor.query(api.figmaLinks.current, { eventSlug: fixture.eventSlug })).toMatchObject({ canEdit: false });
    await expect(actor.mutation(api.figmaLinks.save, { ...args, expectedVersion: 2, clientOperationId: "after-event" })).rejects.toThrow("until the event ends");
  });

  test("synthesizes all batches across odd reduction levels and permits no extra questions", async () => {
    const backend = seededBackend();
    const fixture = await seedQueueFixture(backend);
    await seedAwaitingReview(backend, fixture);
    await prepareAutomaticQueue(backend, fixture);
    const prepared = await prepareQuestionFixture(backend, fixture, false);
    const identity = { jobId: prepared.jobId, attempt: 1 };
    await backend.mutation(internal.reviewQuestionParts.initialize, { ...identity, collections: [], sources: Array.from({ length: 3 }, (_, i) => ({ id: `source-${i}`, kind: "github" as const, title: `File ${i}`, text: "x".repeat(80000), coverage: "captured" as const })) });
    let published = 0;
    for (let step = 0; step < 16; step++) {
      await backend.mutation(internal.reviewQuestionParts.advance, identity);
      const parts = await backend.run(ctx => ctx.db.query("reviewQuestionParts").collect());
      for (const part of parts.filter(p => p.state === "generating")) {
        const checksum = "d".repeat(64);
        await backend.mutation(internal.reviewQuestionParts.saveRequest, { partId: part._id, partAttempt: part.partAttempt, payloadChecksum: checksum });
        await backend.mutation(internal.reviewQuestions.settle, { body: JSON.stringify({ protocolVersion: reviewQuestionProtocolVersion, ...identity, partId: part._id, partAttempt: part.partAttempt, sourceChecksum: prepared.context.sourceChecksum, payloadChecksum: checksum, agentVersion: reviewQuestionAgentVersion, status: "analysed", examinedSourceIds: part.sources.map(source => source.id), summary: "All source sections were inspected; no extra question is necessary.", findings: [] }) });
        published++;
      }
    }
    const job = await backend.run(ctx => ctx.db.get(prepared.jobId));
    expect(job).toMatchObject({ collectionComplete: true, analysisLevel: 2, coverage: { chunks: 6, analysedChunks: 6 } });
    expect(published).toBe(5);
    const ready = await backend.run(ctx => ctx.db.query("reviewQuestionParts").withIndex("by_job_attempt_level_state", q => q.eq("jobId", prepared.jobId).eq("attempt", 1).eq("level", 2).eq("state", "ready")).unique());
    if (!ready) throw new Error("Missing complete synthesis");
    const body = { ...prepared.body, references: [], sources: [{ id: "analysis", kind: "checkpoint" as const, title: "Complete analysis", text: ready.analysis?.summary ?? "", coverage: "partial" as const }] };
    const payloadChecksum = questionPayloadChecksum(body);
    expect(await backend.mutation(internal.reviewQuestions.storeRequest, { ...identity, analysisPartId: ready._id, requestJson: JSON.stringify({ ...body, payloadChecksum }) })).toBe(true);
    expect(await backend.mutation(internal.reviewQuestions.settle, { body: JSON.stringify({ ...prepared.callback, payloadChecksum, questions: [] }) })).toBe("accepted");
    expect(await backend.run(ctx => ctx.db.get(prepared.jobId))).toMatchObject({ state: "ready", questions: [] });
  });

  test("analysis accounts for every section, refuses early publication and reuses unchanged results", async () => {
    const backend = seededBackend();
    const fixture = await seedQueueFixture(backend);
    await seedAwaitingReview(backend, fixture);
    await prepareAutomaticQueue(backend, fixture);
    const prepared = await prepareQuestionFixture(backend, fixture, false);
    const identity = { jobId: prepared.jobId, attempt: 1 };
    await backend.mutation(internal.reviewQuestionParts.initialize, {
      ...identity,
      sources: prepared.body.sources,
      collections: [{ sourceId: "github:pending", kind: "github" }],
    });
    await backend.mutation(internal.reviewQuestionParts.advance, identity);
    const part = await backend.run((ctx) =>
      ctx.db
        .query("reviewQuestionParts")
        .withIndex("by_job_attempt_level_state", (q) =>
          q
            .eq("jobId", prepared.jobId)
            .eq("attempt", 1)
            .eq("level", 0)
            .eq("state", "generating"),
        )
        .unique(),
    );
    if (!part) throw new Error("No analysis was dispatched.");
    const payloadChecksum = "c".repeat(64);
    await backend.mutation(internal.reviewQuestionParts.saveRequest, {
      partId: part._id,
      partAttempt: part.partAttempt,
      payloadChecksum,
    });
    const callback = {
      protocolVersion: reviewQuestionProtocolVersion,
      jobId: prepared.jobId,
      attempt: 1,
      partId: part._id,
      partAttempt: part.partAttempt,
      sourceChecksum: prepared.context.sourceChecksum,
      payloadChecksum,
      agentVersion: reviewQuestionAgentVersion,
      status: "analysed",
      examinedSourceIds: part.sources.map((s) => s.id),
      summary:
        "The submitted idea describes a review queue. Runtime behavior is unverified.",
      findings: [
        {
          category: "architecture",
          observation: "The submitted idea describes a review queue.",
          followUp: "Which queue state transitions are implemented?",
          sourceIds: ["project"],
        },
      ],
    };
    await expect(
      backend.mutation(internal.reviewQuestions.settle, {
        body: JSON.stringify({
          ...callback,
          examinedSourceIds: ["not-inspected"],
        }),
      }),
    ).rejects.toThrow("Every source must be accounted for");
    await expect(
      backend.mutation(internal.reviewQuestions.settle, {
        body: JSON.stringify({
          ...callback,
          findings: [{ ...callback.findings[0], sourceIds: ["another-team"] }],
        }),
      }),
    ).rejects.toThrow("Every source must be accounted for");
    expect(
      await backend.mutation(internal.reviewQuestions.settle, {
        body: JSON.stringify(callback),
      }),
    ).toBe("accepted");
    expect(
      await backend.mutation(internal.reviewQuestions.settle, {
        body: JSON.stringify(callback),
      }),
    ).toBe("already_settled");
    expect(
      await backend.run((ctx) => ctx.db.get(prepared.jobId)),
    ).toMatchObject({
      state: "collecting",
      coverage: { analysedChunks: 1, chunks: 1 },
    });
    expect(
      await backend.mutation(internal.reviewQuestions.storeRequest, {
        ...identity,
        analysisPartId: part._id,
        requestJson: JSON.stringify({
          ...prepared.body,
          payloadChecksum: questionPayloadChecksum(prepared.body),
        }),
      }),
    ).toBe(false);
    await backend.run((ctx) =>
      ctx.db.patch(prepared.jobId, { state: "queued" }),
    );
    expect(
      await backend.mutation(internal.reviewQuestions.claim, {
        jobId: prepared.jobId,
      }),
    ).toMatchObject({ attempt: 2 });
    await backend.mutation(internal.reviewQuestionParts.initialize, {
      jobId: prepared.jobId,
      attempt: 2,
      sources: prepared.body.sources,
      collections: [],
    });
    expect(
      await backend.run((ctx) => ctx.db.get(prepared.jobId)),
    ).toMatchObject({
      collectionComplete: true,
      coverage: { cachedBatches: 1, analysedChunks: 1, chunks: 1 },
    });
    expect(
      await backend.run((ctx) => ctx.db.query("scorecardVersions").collect()),
    ).toHaveLength(0);
  });

  test("question generation deduplicates and rejects references outside the captured sources", async () => {
    const backend = seededBackend();
    const fixture = await seedQueueFixture(backend);
    await seedAwaitingReview(backend, fixture);
    await prepareAutomaticQueue(backend, fixture);
    const prepared = await prepareQuestionFixture(backend, fixture);
    const second = await backend.run(async (ctx) => {
      const round = await ctx.db.get(fixture.roundId);
      const team = await ctx.db.get(fixture.teamId);
      if (!round || !team) throw new Error("Missing fixture");
      return prepareQuestionSet(ctx, round, team);
    });
    expect(second).toBe(prepared.jobId);
    const invalid = {
      ...prepared.callback,
      questions: [
        {
          ...prepared.callback.questions[0],
          sourceIds: ["another-team-secret"],
        },
      ],
    };
    await expect(
      backend.mutation(internal.reviewQuestions.settle, {
        body: JSON.stringify(invalid),
      }),
    ).rejects.toThrow("do not match their frozen sources");
    expect(
      await backend.mutation(internal.reviewQuestions.settle, {
        body: JSON.stringify(prepared.callback),
      }),
    ).toBe("accepted");
    expect(
      await backend.mutation(internal.reviewQuestions.settle, {
        body: JSON.stringify({
          ...prepared.callback,
          questions: [
            {
              ...prepared.callback.questions[0],
              question: "Another question that must not replace the first?",
            },
          ],
        }),
      }),
    ).toBe("already_settled");
    expect(
      await backend.run((ctx) => ctx.db.get(prepared.jobId)),
    ).toMatchObject({
      state: "ready",
      questions: prepared.callback.questions,
    });
    expect(
      await backend.run((ctx) => ctx.db.query("scorecardVersions").collect()),
    ).toHaveLength(0);
  });
  test.each([false, true])(
    "new evidence leaves the original question set fixed when pinned=%s",
    async (pinned) => {
      const backend = seededBackend();
      const fixture = await seedQueueFixture(backend);
      const sessionId = await seedAwaitingReview(backend, fixture);
      await prepareAutomaticQueue(backend, fixture);
      const prepared = await prepareQuestionFixture(backend, fixture);
      await backend.run(async (ctx) => {
        if (pinned)
          await ctx.db.patch(sessionId, {
            questionSetId: prepared.jobId,
            status: "active",
            startedAt: Date.now(),
          });
        const team = await ctx.db.get(fixture.teamId);
        const project = team?.lockedProjectVersionId
          ? await ctx.db.get(team.lockedProjectVersionId)
          : null;
        if (!project) throw new Error("Project missing");
        const { _id: oldId, _creationTime: creationTime, ...fields } = project;
        expect(oldId).toBe(team?.lockedProjectVersionId);
        expect(creationTime).toBeGreaterThan(0);
        const newId = await ctx.db.insert("projectVersions", {
          ...fields,
          version: 2,
          initialIdea: "A materially updated project version for this test.",
        });
        await ctx.db.patch(fixture.teamId, { lockedProjectVersionId: newId });
      });
      expect(
        await backend.mutation(internal.reviewQuestions.settle, {
          body: JSON.stringify(prepared.callback),
        }),
      ).toBe(pinned ? "accepted" : "stale");
    },
  );

  test.each(["expired", "permission_revoked", "disabled"] as const)(
    "question callbacks reject %s work",
    async (boundary) => {
      const backend = seededBackend();
      const fixture = await seedQueueFixture(backend);
      const sessionId = await seedAwaitingReview(backend, fixture);
      await prepareAutomaticQueue(backend, fixture);
      const prepared = await prepareQuestionFixture(backend, fixture);
      await backend.run(async (ctx) => {
        await ctx.db.patch(sessionId, {
          questionSetId: prepared.jobId,
          status: "active",
          startedAt: Date.now(),
        });
        if (boundary === "expired")
          await ctx.db.patch(prepared.jobId, {
            leaseExpiresAt: Date.now() - 1,
          });
        else if (boundary === "permission_revoked")
          await ctx.db.patch(fixture.subjectId, { status: "suspended" });
        else {
          const policy = await ctx.db
            .query("reviewQuestionPolicies")
            .withIndex("by_round", (q) => q.eq("roundId", fixture.roundId))
            .unique();
          if (!policy) throw new Error("Question policy missing");
          await ctx.db.patch(policy._id, {
            policy: { ...policy.policy, enabled: false },
            version: 2,
          });
        }
      });
      expect(
        await backend.query(internal.reviewQuestions.request, {
          jobId: prepared.jobId,
          attempt: 1,
        }),
      ).toBeNull();
      expect(
        await backend.mutation(internal.reviewQuestions.settle, {
          body: JSON.stringify(prepared.callback),
        }),
      ).toBe("stale");
      expect(
        (await backend.run((ctx) => ctx.db.get(prepared.jobId)))?.questions,
      ).toBeUndefined();
    },
  );

  test("automatic placement uses only an authorized, confirmed panel and retries once", async () => {
    const backend = seededBackend();
    const fixture = await seedQueueFixture(backend);
    const sessionId = await seedAwaitingReview(backend, fixture);
    await backend.run((ctx) =>
      ctx.db.patch(sessionId, { status: "cancelled" }),
    );
    const reviewerPersonId = await prepareAutomaticQueue(backend, fixture);
    await backend.run(async (ctx) => {
      const now = Date.now();
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.personId,
        eventAccessSubjectId: fixture.subjectId,
        permissionKey: "queue.manage",
        scopeType: "panel",
        scopeId: fixture.panelId,
        sourceType: "manual",
        sourceId: "routing-test",
        reason: "Test automatic placement",
      });
      const criterionId = await ctx.db.insert("reviewRubricCriteria", {
        eventId: fixture.eventId,
        rubricVersionId: fixture.rubricVersionId,
        stableKey: "technical_execution",
        label: "Technical execution",
        question: "Explain your architecture.",
        guidance: "Use project evidence.",
        weight: 100,
        displayOrder: 0,
        anchors: {
          zero: "None",
          one: "Early",
          two: "Partial",
          three: "Mostly",
          four: "Complete",
        },
        createdAt: now,
      });
      const member = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (q) =>
          q.eq("panelId", fixture.panelId).eq("status", "active"),
        )
        .unique();
      const state = await ctx.db.get(fixture.targetStateId);
      if (!member || !state) throw new Error("Routing fixture missing");
      await ctx.db.patch(member._id, { assignedCriterionIds: [criterionId] });
      await patchTeamRoundState(ctx, state, {
        state: "unassigned",
        panelId: undefined,
        version: 2,
      });
    });
    const operator = asParticipant(backend, fixture);
    const args = {
      eventSlug: fixture.eventSlug,
      roundId: fixture.roundId,
      teamId: fixture.teamId,
      expectedTeamRoundVersion: 2,
      reason: "Automatic walk-up placement",
      clientOperationId: "automatic-walk-up-test",
    };
    const first = await operator.mutation(api.reviewOperations.queueTeam, args);
    expect(
      await operator.mutation(api.reviewOperations.queueTeam, args),
    ).toEqual(first);
    expect(
      await backend.run((ctx) => ctx.db.get(first.teamRoundStateId)),
    ).toMatchObject({
      panelId: fixture.panelId,
      state: "queued",
      version: 3,
    });
    await backend.run(async (ctx) => {
      const confirmation = await ctx.db
        .query("reviewerRoundConfirmations")
        .withIndex("by_roundId_and_personId", (q) =>
          q.eq("roundId", fixture.roundId).eq("personId", reviewerPersonId),
        )
        .unique();
      if (!confirmation) throw new Error("Confirmation missing");
      await ctx.db.patch(confirmation._id, {
        status: "unavailable",
        windows: [],
        version: 2,
      });
      const round = await ctx.db.get(fixture.roundId);
      const team = await ctx.db.get(fixture.teamId);
      const subject = await ctx.db.get(fixture.subjectId);
      if (!round || !team || !subject)
        throw new Error("Routing context missing");
      expect(await routeReviewTeam(ctx, round, team, subject)).toBeUndefined();
    });
  });

  test("next-team notices follow priority, deduplicate and disappear after a queue move", async () => {
    const backend = seededBackend();
    const fixture = await seedQueueFixture(backend);
    const high = await addQueueTeam(backend, fixture, {
      key: "high",
      panelId: fixture.panelId,
      priority: 3,
      queuedAt: fixture.now + 60,
    });
    const low = await addQueueTeam(backend, fixture, {
      key: "low",
      panelId: fixture.panelId,
      priority: 1,
      queuedAt: fixture.now - 60,
    });
    expect(
      await backend.run((ctx) => nextQueuedTeam(ctx, fixture.panelId)),
    ).toMatchObject({
      _id: high,
    });
    await patchState(backend, high, { state: "held" });
    expect(
      await backend.run((ctx) => nextQueuedTeam(ctx, fixture.panelId)),
    ).toMatchObject({
      _id: low,
    });
    await backend.run(async (ctx) => {
      const state = await ctx.db.get(fixture.targetStateId);
      if (!state) throw new Error("State missing");
      const first = await notifyReviewTeam(ctx, state, "up_next", Date.now());
      expect(await notifyReviewTeam(ctx, state, "up_next", Date.now())).toBe(
        first,
      );
    });
    expect((await currentQueue(backend, fixture))?.notice).toMatchObject({
      kind: "up_next",
    });
    await patchState(backend, fixture.targetStateId, {
      panelId: fixture.targetPanelId,
      version: 2,
    });
    expect((await currentQueue(backend, fixture))?.notice).toBeNull();
  });
  test("automatic call-up preserves a live review, then calls exactly once when it ends", async () => {
    const backend = seededBackend();
    const fixture = await seedQueueFixture(backend);
    const sessionId = await seedAwaitingReview(backend, fixture);
    await prepareAutomaticQueue(backend, fixture);
    await backend.run((ctx) =>
      ctx.db.patch(sessionId, {
        status: "scoring",
        startedAt: fixture.now - 600000,
        plannedEndAt: fixture.now - 1000,
      }),
    );
    await backend.mutation(internal.reviewQueueAutomation.advance, {
      panelId: fixture.panelId,
    });
    expect((await currentQueue(backend, fixture))?.notice).toMatchObject({
      kind: "up_next",
    });
    expect(
      await backend.run((ctx) => ctx.db.query("reviewSessions").collect()),
    ).toHaveLength(1);
    await backend.run((ctx) =>
      ctx.db.patch(sessionId, { status: "cancelled" }),
    );
    await backend.mutation(internal.reviewQueueAutomation.advance, {
      panelId: fixture.panelId,
    });
    await backend.mutation(internal.reviewQueueAutomation.advance, {
      panelId: fixture.panelId,
    });
    expect((await currentQueue(backend, fixture))?.state).toBe("called");
    expect((await currentQueue(backend, fixture))?.notice).toMatchObject({
      kind: "called",
    });
    const live = await backend.run((ctx) =>
      ctx.db
        .query("reviewSessions")
        .withIndex("by_panel_status", (q) =>
          q.eq("panelId", fixture.panelId).eq("status", "awaiting_presence"),
        )
        .collect(),
    );
    expect(live).toHaveLength(1);
    expect(
      await backend.run((ctx) => ctx.db.query("reviewAssignments").collect()),
    ).toHaveLength(1);
  });
  test.each(["unchanged", "changed", "removed"])("automatic review calls use the current lead's %s profile phone", async (change) => {
    const backend = seededBackend();
    const fixture = await seedQueueFixture(backend);
    await prepareAutomaticQueue(backend, fixture);
    const profileId = await backend.run(async (ctx) => {
      const policy = await ctx.db.query("reviewQueuePolicies").withIndex("by_round", (q) => q.eq("roundId", fixture.roundId)).unique();
      if (!policy) throw new Error("Missing policy");
      await ctx.db.patch(policy._id, { voiceCalls: true });
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId, personId: fixture.personId,
        eventAccessSubjectId: fixture.subjectId,
        permissionKey: "communications.delivery.manage", scopeType: "event",
        sourceType: "manual", sourceId: "call-test", reason: "Call test",
      });
      const id = await ctx.db.insert("participantProfiles", {
        eventId: fixture.eventId, membershipId: fixture.membershipId,
        participantClass: "vit_student", fullName: "Queue participant",
        phone: "+919876543210", gender: "male", institution: "VIT", yearOfStudy: "third",
        profileVersion: 1, updatedAt: fixture.now,
      });
      const state = await ctx.db.get(fixture.targetStateId);
      if (!state) throw new Error("Missing state");
      await notifyReviewTeam(ctx, state, "up_next", Date.now());
      return id;
    });
    const delivery = await backend.run((ctx) => ctx.db.query("outboundCallDeliveries").unique());
    if (!delivery) throw new Error("Expected queued call");
    expect(delivery.state).toBe("pending");
    expect(delivery.consentId).toBeUndefined();
    expect(await backend.run((ctx) => ctx.db.query("outboundCallConsents").collect())).toEqual([]);
    if (change === "unchanged") {
      expect(await backend.mutation(internal.outboundCallState.claimDelivery, {
        deliveryId: delivery._id, attemptId: crypto.randomUUID(),
      })).toMatchObject({ destinationPhoneE164: "+919876543210" });
      return;
    }
    await backend.run(async (ctx) => {
      if (change === "removed") await ctx.db.delete(profileId);
      else await ctx.db.patch(profileId, { phone: "+918000000000" });
    });
    expect(await backend.mutation(internal.outboundCallState.claimDelivery, {
      deliveryId: delivery._id, attemptId: crypto.randomUUID(),
    })).toBeNull();
    expect(await backend.run((ctx) => ctx.db.get(delivery._id))).toMatchObject({
      state: "cancelled", providerErrorCode: "participant_phone_changed",
    });
    await backend.run(async (ctx) => {
      const state = await ctx.db.get(fixture.targetStateId);
      if (!state) throw new Error("Missing state");
      await notifyReviewTeam(ctx, state, "called", Date.now());
    });
    const calls = await backend.run((ctx) => ctx.db.query("outboundCallDeliveries").collect());
    expect(calls).toHaveLength(change === "removed" ? 1 : 2);
    if (change === "changed") {
      expect(calls.find((call) => call._id !== delivery._id)).toMatchObject({
        state: "pending", destinationPhoneE164: "+918000000000",
      });
    }
  });

  test("lets a participant observe staff placement but not place or call the team", async () => {
    const backend = seededBackend();
    const fixture = await seedQueueFixture(backend);
    await seedAwaitingReview(backend, fixture);
    const participant = asParticipant(backend, fixture);

    const queue = await currentQueue(backend, fixture);
    expect(queue).toMatchObject({
      state: "queued",
      teamsAhead: 0,
    });
    if (!queue?.estimate) throw new Error("The queued team has no wait estimate.");
    expect(queue.serverNow).toBeLessThanOrEqual(queue.estimate.earliestAt);
    expect(queue.estimate.latestAt).toBeGreaterThan(queue.estimate.earliestAt);
    expect("lowerMinutes" in queue.estimate).toBe(false);
    await expect(
      participant.mutation(api.reviewOperations.queueTeam, {
        eventSlug: fixture.eventSlug,
        roundId: fixture.roundId,
        panelId: fixture.panelId,
        teamId: fixture.teamId,
        expectedTeamRoundVersion: 1,
        reason: "Participant cannot place a team",
        clientOperationId: "participant-cannot-queue-team",
      }),
    ).rejects.toThrow("does not have permission for that exact resource");
    await expect(
      participant.mutation(api.reviewOperations.callTeam, {
        eventSlug: fixture.eventSlug,
        roundId: fixture.roundId,
        panelId: fixture.panelId,
        teamId: fixture.teamId,
        expectedTeamRoundVersion: 1,
        reason: "Participant cannot call a team",
        clientOperationId: "participant-cannot-call-team",
      }),
    ).rejects.toThrow("does not have permission for that exact resource");
  });

  test("keeps review status readable without exposing the separately scoped team code", async () => {
    const backend = seededBackend();
    const fixture = await seedQueueFixture(backend, { grantTeamQr: false });
    const reviewSessionId = await seedAwaitingReview(backend, fixture);
    const participant = asParticipant(backend, fixture);

    await expect(currentQueue(backend, fixture)).resolves.toMatchObject({
      review: { id: reviewSessionId, canShowTeamQr: false },
    });
    await expect(
      participant.mutation(api.participantReview.mintTeamQr, {
        eventSlug: fixture.eventSlug,
        reviewSessionId,
      }),
    ).rejects.toThrow("does not have permission for that exact resource");
  });

  test("only exposes an admission link when the operator can read that application", async () => {
    const backend = seededBackend();
    const fixture = await seedQueueFixture(backend);
    await seedAwaitingReview(backend, fixture);
    const applicationId = await backend.run(async (ctx) => {
      const team = await ctx.db.get(fixture.teamId);
      if (!team?.lockedProjectVersionId) throw new Error("The fixture project is missing.");
      const project = await ctx.db.get(team.lockedProjectVersionId);
      if (!project) throw new Error("The fixture project is missing.");
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.personId,
        eventAccessSubjectId: fixture.subjectId,
        permissionKey: "round.read",
        scopeType: "round",
        scopeId: fixture.roundId,
        sourceType: "manual",
        sourceId: `${fixture.eventSlug}:round.read`,
        grantedByPersonId: fixture.personId,
        reason: "Review board access test",
      });
      return ctx.db.insert("applications", {
        eventId: fixture.eventId,
        teamId: fixture.teamId,
        submittedProjectVersionId: project._id,
        admissionPolicyVersionId: project.admissionPolicyVersionId,
        state: "submitted",
        decisionStage: "unrecorded",
        experienceBand: "first_year",
        assignedReviewCount: 0,
        completedReviewCount: 0,
        contentVersion: 1,
        version: 1,
        submittedAt: fixture.now,
      });
    });
    const participant = asParticipant(backend, fixture);
    const boardWithoutApplicationAccess = await participant.query(api.reviewOperations.roundTeams, {
      eventSlug: fixture.eventSlug,
      roundId: fixture.roundId,
      paginationOpts: { cursor: null, numItems: 10 },
    },
    );

    expect(boardWithoutApplicationAccess.page).toHaveLength(1);
    expect(boardWithoutApplicationAccess.page[0]?.applicationId,
    ).toBeUndefined();

    await backend.run(async (ctx) => {
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.personId,
        eventAccessSubjectId: fixture.subjectId,
        permissionKey: "application.read",
        scopeType: "application",
        scopeId: applicationId,
        sourceType: "manual",
        sourceId: `${fixture.eventSlug}:application.read`,
        grantedByPersonId: fixture.personId,
        reason: "Admission link access test",
      });
    });
    const boardWithApplicationAccess = await participant.query(api.reviewOperations.roundTeams, {
      eventSlug: fixture.eventSlug,
      roundId: fixture.roundId,
      paginationOpts: { cursor: null, numItems: 10 },
    },
    );

    expect(boardWithApplicationAccess.page[0]?.applicationId).toBe(applicationId,
    );
  });

  test("preserves priority and time order through reorder, move, start, and completion", async () => {
    const backend = seededBackend();
    const fixture = await seedQueueFixture(backend);
    const olderStateId = await addQueueTeam(backend, fixture, {
      key: "older",
      panelId: fixture.panelId,
      priority: 0,
      queuedAt: fixture.now + 10,
    });
    await addQueueTeam(backend, fixture, {
      key: "priority",
      panelId: fixture.panelId,
      priority: 2,
      queuedAt: fixture.now + 50,
    });
    const targetPanelBlockerId = await addQueueTeam(backend, fixture, {
      key: "target-panel-blocker",
      panelId: fixture.targetPanelId,
      priority: 4,
      queuedAt: fixture.now + 5,
    });

    expect(await currentQueue(backend, fixture)).toMatchObject({
      state: "queued",
      teamsAhead: 2,
    });

    await patchState(backend, fixture.targetStateId, {
      priority: 3,
      updatedAt: fixture.now + 100,
    });
    expect(await currentQueue(backend, fixture)).toMatchObject({ teamsAhead: 0,
    });

    await patchState(backend, fixture.targetStateId, {
      panelId: fixture.targetPanelId,
      updatedAt: fixture.now + 200,
    });
    expect(await currentQueue(backend, fixture)).toMatchObject({
      panel: { id: fixture.targetPanelId, name: "Target panel" },
      teamsAhead: 1,
    });

    await patchState(backend, targetPanelBlockerId, {
      state: "called",
      calledAt: fixture.now + 300,
      updatedAt: fixture.now + 300,
    });
    expect(await currentQueue(backend, fixture)).toMatchObject({ teamsAhead: 0,
    });

    await patchState(backend, fixture.targetStateId, {
      state: "called",
      calledAt: fixture.now + 400,
      updatedAt: fixture.now + 400,
    });
    const called = await currentQueue(backend, fixture);
    expect(called).toMatchObject({ state: "called" });
    expect(called?.teamsAhead).toBeUndefined();

    await patchState(backend, fixture.targetStateId, {
      state: "in_review",
      updatedAt: fixture.now + 500,
    });
    expect(await currentQueue(backend, fixture)).toMatchObject({ state: "in_review",
    });

    await patchState(backend, fixture.targetStateId, {
      state: "completed",
      completedAt: fixture.now + 600,
      updatedAt: fixture.now + 600,
    });
    expect(await currentQueue(backend, fixture)).toBeNull();

    const olderPosition = await backend.run(async (ctx) => {
      const olderState = await ctx.db.get(olderStateId);
      if (!olderState) throw new Error("The older queue state is missing.");
      return participantQueuePosition(ctx, olderState);
    });
    expect(olderPosition).toBe(1);
  });

  test("reads an exact rank and constant participant payload within a strict document budget", async () => {
    const backend = seededBackend(48);
    const fixture = await seedQueueFixture(backend, {
      targetQueuedAt: fixtureNow() + 1_000_000,
    });
    const queuedAhead = 64;
    for (let index = 0; index < queuedAhead; index += 1) {
      await addQueueTeam(backend, fixture, {
        key: `bounded-${index}`,
        panelId: fixture.panelId,
        priority: 0,
        queuedAt: fixture.now + index,
      });
    }

    const current = await currentQueue(backend, fixture);
    expect(current).toMatchObject({ state: "queued", teamsAhead: queuedAhead });
    expect(new TextEncoder().encode(JSON.stringify(current)).byteLength,
    ).toBeLessThan(1_024);
  });

  test("rejects a queued source row that bypassed the aggregate owner", async () => {
    const backend = seededBackend();
    const fixture = await seedQueueFixture(backend);
    const driftedStateId = await backend.run(async (ctx) => {
      const teamId = await ctx.db.insert("teams", {
        eventId: fixture.eventId,
        name: "Drifted queue team",
        publicCode: "DRIFT01",
        leadMembershipId: fixture.membershipId,
        status: "confirmed",
        activeMemberCount: 0,
        activeVitMemberCount: 0,
        activeExternalMemberCount: 0,
        membershipLocked: true,
        version: 1,
        createdAt: fixture.now,
        updatedAt: fixture.now,
      });
      return ctx.db.insert("teamRoundStates", {
        eventId: fixture.eventId,
        roundId: fixture.roundId,
        teamId,
        panelId: fixture.panelId,
        state: "queued",
        queuedAt: fixture.now,
        callAttemptCount: 0,
        priority: 10,
        version: 1,
        updatedByPersonId: fixture.personId,
        updatedAt: fixture.now,
      });
    });

    await expect(
      backend.run(async (ctx) => {
        const drifted = await ctx.db.get(driftedStateId);
        if (!drifted) throw new Error("The drifted queue state is missing.");
        return participantQueuePosition(ctx, drifted);
      }),
    ).rejects.toThrow("missing from its panel queue projection");
  });

  test("mints from one active token and the indexed latest version within a strict read budget", async () => {
    const backend = seededBackend(48);
    const fixture = await seedQueueFixture(backend);
    const reviewSessionId = await seedAwaitingReview(backend, fixture);
    const historicalTokenCount = 70;
    for (let start = 1; start <= historicalTokenCount; start += 10) {
      await backend.run(async (ctx) => {
        for (let tokenVersion = start; tokenVersion < start + 10; tokenVersion += 1) {
          await ctx.db.insert("reviewTeamQrTokens", {
            eventId: fixture.eventId,
            reviewSessionId,
            teamId: fixture.teamId,
            tokenDigest: `historical-token-${tokenVersion}`,
            manualCodeDigest: `historical-code-${tokenVersion}`,
            tokenVersion,
            state: tokenVersion === historicalTokenCount ? "active" : "superseded",
            expiresAt:
              tokenVersion === historicalTokenCount ? fixture.now - 1 : fixture.now + 60_000,
            issuedByMembershipId: fixture.membershipId,
            issuedAt: fixture.now + tokenVersion,
          });
        }
      });
    }

    const participant = asParticipant(backend, fixture);
    const first = await participant.mutation(api.participantReview.mintTeamQr, {
      eventSlug: fixture.eventSlug,
      reviewSessionId,
    });
    const second = await participant.mutation(api.participantReview.mintTeamQr, {
      eventSlug: fixture.eventSlug,
      reviewSessionId,
    },
    );
    expect(first.payload).toMatch(/^c2c-review-v1\.[a-f0-9]{64}$/);
    expect(first.serverNow).toBeLessThan(first.expiresAt);
    expect(second.payload).toMatch(/^c2c-review-v1\.[a-f0-9]{64}$/);
    expect(second.payload).not.toBe(first.payload);
    await expect(
      participant.query(api.participantReview.teamQrState, {
        eventSlug: fixture.eventSlug,
        tokenId: first.tokenId,
      }),
    ).resolves.toMatchObject({ state: "superseded" });
    await expect(
      participant.query(api.participantReview.teamQrState, {
        eventSlug: fixture.eventSlug,
        tokenId: second.tokenId,
      }),
    ).resolves.toMatchObject({ state: "active" });

    await backend.run(async (ctx) => {
      const active = await ctx.db
        .query("reviewTeamQrTokens")
        .withIndex("by_session_state", (index) =>
          index.eq("reviewSessionId", reviewSessionId).eq("state", "active"),
        )
        .take(2);
      const latest = await ctx.db
        .query("reviewTeamQrTokens")
        .withIndex("by_session_version", (index) => index.eq("reviewSessionId", reviewSessionId),
        )
        .order("desc")
        .take(3);
      expect(active).toHaveLength(1);
      expect(active[0]?.tokenVersion).toBe(72);
      expect(latest.map((token) => [token.tokenVersion, token.state])).toEqual([
        [72, "active"],
        [71, "superseded"],
        [70, "expired"],
      ]);
    });

    await backend.run(async (ctx) => {
      const priorToken = await ctx.db
        .query("reviewTeamQrTokens")
        .withIndex("by_session_version", (index) =>
          index.eq("reviewSessionId", reviewSessionId).eq("tokenVersion", 71),
        )
        .unique();
      if (!priorToken) throw new Error("The prior QR token is missing.");
      await ctx.db.patch(priorToken._id, { state: "active" });
    });
    await expect(
      participant.mutation(api.participantReview.mintTeamQr, {
        eventSlug: fixture.eventSlug,
        reviewSessionId,
      }),
    ).rejects.toThrow();
    await backend.run(async (ctx) => {
      const active = await ctx.db
        .query("reviewTeamQrTokens")
        .withIndex("by_session_state", (index) =>
          index.eq("reviewSessionId", reviewSessionId).eq("state", "active"),
        )
        .take(3);
      expect(active.map((token) => token.tokenVersion).sort((left, right) => left - right),
      ).toEqual(
        [71, 72]);
    });
  });
});

function seededBackend(documentsRead?: number) {
  const options =
    documentsRead === undefined
      ? { schema, modules }
      : { schema, modules, transactionLimits: { documentsRead } };
  const backend = convexTest(options);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  aggregateTest.register(backend, "reviewQueue");
  return backend;
}

function asParticipant(backend: BackendTest, fixture: Fixture) {
  return backend.withIdentity({
    subject: fixture.authUserId,
    sessionId: fixture.authSessionId,
  });
}

function currentQueue(backend: BackendTest, fixture: Fixture) {
  return asParticipant(backend, fixture).query(api.participantReview.current, {
    eventSlug: fixture.eventSlug,
  });
}

async function patchState(
  backend: BackendTest,
  stateId: Id<"teamRoundStates">,
  patch: Parameters<typeof patchTeamRoundState>[2],
) {
  await backend.run(async (ctx) => {
    const state = await ctx.db.get(stateId);
    if (!state) throw new Error("The queue state is missing.");
    await patchTeamRoundState(ctx, state, patch);
  });
}

async function addQueueTeam(
  backend: BackendTest,
  fixture: Fixture,
  args: {
    key: string;
    panelId: Id<"reviewPanels">;
    priority: number;
    queuedAt: number;
  },
) {
  return backend.run(async (ctx) => {
    const teamId = await ctx.db.insert("teams", {
      eventId: fixture.eventId,
      name: `Queue team ${args.key}`,
      publicCode: `Q${args.key.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      leadMembershipId: fixture.membershipId,
      status: "confirmed",
      activeMemberCount: 0,
      activeVitMemberCount: 0,
      activeExternalMemberCount: 0,
      membershipLocked: true,
      version: 1,
      createdAt: fixture.now,
      updatedAt: fixture.now,
    });
    return insertTeamRoundState(ctx, {
      eventId: fixture.eventId,
      roundId: fixture.roundId,
      teamId,
      panelId: args.panelId,
      state: "queued",
      queuedAt: args.queuedAt,
      callAttemptCount: 0,
      priority: args.priority,
      version: 1,
      updatedByPersonId: fixture.personId,
      updatedAt: args.queuedAt,
    });
  });
}

async function seedQueueFixture(
  backend: BackendTest,
  { grantTeamQr = true, targetQueuedAt,
  }: { grantTeamQr?: boolean; targetQueuedAt?: number } = {},
) {
  const now = fixtureNow();
  const eventSlug = `participant-review-${crypto.randomUUID()}`;
  const authUserId = await createAuthUser(backend, now);
  const authSessionId = await createAuthSession(backend, authUserId, now);
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Participant review fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      applicationsCloseAt: Date.now() + 86_400_000,
      startsAt: now - 60_000,
      endsAt: now + 3_600_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const email = `participant-${crypto.randomUUID()}@example.test`;
    const personId = await ctx.db.insert("people", {
      authUserId,
      googleSubject: `google-${crypto.randomUUID()}`,
      verifiedEmail: email,
      displayName: "Queue participant",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: email,
      displayName: "Queue participant",
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
      participantClass: "vit_student",
      eligibilityStatus: "eligible",
      onboardingStatus: "accepted",
      acceptedParticipantPolicyVersionIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const teamId = await ctx.db.insert("teams", {
      eventId,
      name: "Projected queue team",
      publicCode: "QUEUE01",
      leadMembershipId: membershipId,
      status: "confirmed",
      activeMemberCount: 1,
      activeVitMemberCount: 1,
      activeExternalMemberCount: 0,
      membershipLocked: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await initializeAttendanceTeamAvailability(ctx, {
      eventId,
      teamId,
      activeMemberCount: 1,
      now,
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
    const rubricVersionId = await ctx.db.insert("reviewRubricVersions", {
      eventId,
      version: 1,
      name: "Queue fixture rubric",
      status: "published",
      scoreMinimum: 0,
      scoreMaximum: 4,
      aggregationFormula: "criterion_mean_weighted_v1",
      spreadThreshold: 2,
      checksum: "queue-fixture-rubric",
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    const roundId = await ctx.db.insert("reviewRounds", {
      eventId,
      rubricVersionId,
      stableKey: "queue_fixture_round",
      name: "Queue fixture round",
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
      missedCallGraceSeconds: 120,
      requiredCallAttempts: 2,
      substituteResponseSeconds: 60,
      missedReentryPolicy: "preserve_queue_time",
      requiredPanelSize: 1,
      staffing: {
        seniorSeats: 0,
        juniorSeats: 0,
        allowSeniorLeadFallback: true,
        automaticReplacement: false,
        juniorRotationReviews: 0,
        reviewerArrivalSeconds: 90,
        assignmentReminderSeconds: 300,
        assignmentReminderCalls: true,
      },
      minimumScorersPerCriterion: 1,
      minimumPresentParticipants: 1,
      requiresSharedCommitments: false,
      requiresFinalComment: false,
      minimumReviewerBuild: 1,
      requiresCamera: false,
      requiresNotifications: false,
      version: 1,
      configurationChecksum: "queue-fixture-round",
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
      openedAt: now,
    });
    const panelId = await ctx.db.insert("reviewPanels", {
      eventId,
      roundId,
      stableKey: "queue_fixture_panel",
      name: "Queue panel",
      coordinatorPersonId: personId,
      status: "ready",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const targetPanelId = await ctx.db.insert("reviewPanels", {
      eventId,
      roundId,
      stableKey: "queue_target_panel",
      name: "Target panel",
      coordinatorPersonId: personId,
      status: "ready",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await insertPermissionGrant(ctx, {
      eventId,
      personId,
      eventAccessSubjectId: subjectId,
      permissionKey: "queue.participant.read",
      scopeType: "team",
      scopeId: teamId,
      sourceType: "manual",
      sourceId: `${eventSlug}:queue.participant.read`,
      grantedByPersonId: personId,
      reason: "Participant review test",
    });
    if (grantTeamQr) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId,
        eventAccessSubjectId: subjectId,
        permissionKey: "review.team_qr.mint",
        scopeType: "team",
        scopeId: teamId,
        sourceType: "manual",
        sourceId: `${eventSlug}:review.team_qr.mint`,
        grantedByPersonId: personId,
        reason: "Participant review test",
      });
    }
    const targetStateId = await insertTeamRoundState(ctx, {
      eventId,
      roundId,
      teamId,
      panelId,
      state: "queued",
      queuedAt: targetQueuedAt ?? now + 30,
      callAttemptCount: 0,
      priority: 0,
      version: 1,
      updatedByPersonId: personId,
      updatedAt: now,
    });
    return {
      now,
      eventSlug,
      eventId,
      personId,
      subjectId,
      membershipId,
      teamId,
      teamMemberId,
      rubricVersionId,
      roundId,
      panelId,
      targetPanelId,
      targetStateId,
      authUserId,
      authSessionId,
    };
  });
}

async function seedAwaitingReview(backend: BackendTest, fixture: Fixture) {
  return backend.run(async (ctx) => {
    const participantPolicyVersionId = await ctx.db.insert("participantPolicyVersions", {
      eventId: fixture.eventId,
      version: 1,
      status: "published",
      label: "QR fixture participant policy",
      teamMinimumSize: 1,
      teamMaximumSize: 4,
      mixedParticipantClassesAllowed: false,
      phoneVerificationEnabled: false,
      vitHostelResidenceCatalog: defaultVitHostelResidenceCatalog,
      profileNotice: "Fixture profile notice.",
      projectTextNotice: "Fixture project notice.",
      privacyNoticeUrl: "https://example.test/privacy",
      freshProjectAttestation: "Fixture attestation.",
      finalSubmissionWarning: "Fixture warning.",
      checksum: "qr-fixture-participant-policy",
      createdByPersonId: fixture.personId,
      createdAt: fixture.now,
      publishedAt: fixture.now,
    },
    );
    const intakePolicyVersionId = await ctx.db.insert("intakePolicyVersions", {
      eventId: fixture.eventId,
      version: 1,
      status: "published",
      openingText: "Fixture opening.",
      initialPrompt: "Describe the idea.",
      initialHelpText: "Fixture help.",
      initialIdeaMinLength: 10,
      initialIdeaMaxLength: 500,
      followUpAnswerMinLength: 10,
      followUpAnswerMaxLength: 500,
      minimumFollowUpCount: 0,
      maximumFollowUpCount: 3,
      deterministicFollowUpCount: 3,
      questionMaxLength: 200,
      allowedPurposeKeys: [],
      fallbackQuestions: [],
      blockedTerms: [],
      commonIdeaPatterns: [],
      model: { mode: "deterministic" },
      checksum: "qr-fixture-intake-policy",
      createdByPersonId: fixture.personId,
      createdAt: fixture.now,
      publishedAt: fixture.now,
    });
    const admissionPolicyVersionId = await ctx.db.insert("admissionPolicyVersions", {
      eventId: fixture.eventId,
      version: "1",
      status: "published",
      aiRecommendationMode: "disabled",
      minimumHumanReviews: 1,
      overallParticipantCapacity: 100,
      criteria: [],
      decisionReasonCodes: [],
      checksum: "qr-fixture-admission-policy",
      createdByPersonId: fixture.personId,
      createdAt: fixture.now,
      publishedAt: fixture.now,
    },
    );
    const lockedRosterSnapshotId = await createTestSubmissionSnapshot(ctx, {
      eventId: fixture.eventId,
      teamId: fixture.teamId,
      teamMemberIds: [fixture.teamMemberId],
      intakePolicyVersionId,
      participantPolicyVersionId,
      admissionPolicyVersionId,
      submittedAt: fixture.now,
    });
    const projectVersionId = await ctx.db.insert("projectVersions", {
      eventId: fixture.eventId,
      teamId: fixture.teamId,
      version: 1,
      initialIdea: "A fixture project idea.",
      intakePolicyVersionId,
      intakeResponses: [],
      lockedRosterSnapshotId,
      lockedMemberCount: 1,
      lockedLeadMembershipId: fixture.membershipId,
      freshForEventAttestation: {
        participantPolicyVersionId,
        acceptedByMembershipId: fixture.membershipId,
        acceptedAt: fixture.now,
      },
      finalConfirmation: {
        participantPolicyVersionId,
        previewedDraftVersion: 1,
        previewedTeamVersion: 1,
        confirmedByMembershipId: fixture.membershipId,
        confirmedAt: fixture.now,
      },
      participantPolicyVersionId,
      admissionPolicyVersionId,
      sourceDraftVersion: 1,
      submittedByMembershipId: fixture.membershipId,
      submittedAt: fixture.now,
    });
    await ctx.db.patch(fixture.teamId, { lockedProjectVersionId: projectVersionId,
    });
    const evidenceCheckpointSetId = await ctx.db.insert("reviewEvidenceCheckpointSets", {
      eventId: fixture.eventId,
      roundId: fixture.roundId,
      roundSequence: 1,
      teamId: fixture.teamId,
      projectVersionId,
      githubEntries: [],

      expectedResourceCount: 0,
      capturedResourceCount: 0,
      completeness: "complete",
      checksum: "qr-fixture-evidence",
      createdByPersonId: fixture.personId,
      createdAt: fixture.now,
    },
    );
    return ctx.db.insert("reviewSessions", {
      eventId: fixture.eventId,
      roundId: fixture.roundId,
      panelId: fixture.panelId,
      teamId: fixture.teamId,
      projectVersionId,
      evidenceCheckpointSetId,
      rubricVersionId: fixture.rubricVersionId,
      panelVersion: 1,
      status: "awaiting_presence",
      extensionCount: 0,
      extensionSeconds: 0,
      sharedNotesVersion: 0,
      version: 1,
      createdByPersonId: fixture.personId,
      createdAt: fixture.now,
      updatedAt: fixture.now,
    });
  });
}

async function createAuthUser(backend: BackendTest, now: number) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Queue participant",
        email: `queue-participant-${crypto.randomUUID()}@example.test`,
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
        expiresAt: now + 60 * 60 * 1_000,
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

function fixtureNow() {
  return Date.now();
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function prepareAutomaticQueue(backend: BackendTest, fixture: Fixture) {
  return backend.run(async (ctx) => {
    const now = Date.now();
    const reviewerPersonId = await ctx.db.insert("people", { authUserId: "independent-queue-reviewer", verifiedEmail: "queue-reviewer@example.test", displayName: "Independent reviewer", status: "active", createdAt: now, updatedAt: now });
    const reviewerSubjectId = await ctx.db.insert("eventAccessSubjects", { eventId: fixture.eventId, personId: reviewerPersonId, accessVersion: 1, displayName: "Independent reviewer", emailNormalized: "queue-reviewer@example.test", linkedBy: "roster_claim", status: "active", createdAt: now, updatedAt: now });
    await ctx.db.insert("reviewerProfiles", { eventId: fixture.eventId, personId: reviewerPersonId, seniority: "board", strength: 4, technicalDomains: ["React"], productDomains: [], languages: [], criterionKeys: ["technical_execution"], status: "active", version: 1, createdAt: now, updatedAt: now });

    await ctx.db.insert("reviewQueuePolicies", {
      routingPreference: "skills_then_wait",
      eventId: fixture.eventId,
      roundId: fixture.roundId,
      automaticCallUp: true,
      teamHeadsUpSeconds: 300,
      voiceCalls: false,
      scoringBufferSeconds: 90,
      operatorPersonId: fixture.personId,
      version: 1,
      updatedAt: now,
    });
    await insertPermissionGrant(ctx, {
      eventId: fixture.eventId,
      personId: fixture.personId,
      eventAccessSubjectId: fixture.subjectId,
      permissionKey: "review.prepare",
      scopeType: "panel",
      scopeId: fixture.panelId,
      sourceType: "manual",
      sourceId: "auto-call-authority",
      reason: "Queue test",
    });
    await ctx.db.insert("reviewPanelMembers", {
      eventId: fixture.eventId,
      roundId: fixture.roundId,
      panelId: fixture.panelId,
      personId: reviewerPersonId,
      eventAccessSubjectId: reviewerSubjectId,
      seatSeniority: "lead",
      assignedCriterionIds: [],
      isCoordinator: true,
      status: "active",
      assignedAt: now,
    });
    const deviceId = await ctx.db.insert("reviewerDevices", {
      eventId: fixture.eventId,
      personId: reviewerPersonId,
      installationId: "queue-phone",
      name: "Queue phone",
      platform: "android",
      appBuild: 1,
      cameraReady: true,
      encryptedDraftReady: true,
      pushTokenStatus: "not_registered",
      pushTokenUpdatedAt: now,
      status: "active",
      version: 1,
      registeredAt: now,
      lastSeenAt: now,
    });
    await ctx.db.insert("reviewerClockIns", {
      eventId: fixture.eventId,
      roundId: fixture.roundId,
      reviewerPersonId,
      reviewerDeviceId: deviceId,
      status: "present",
      clockedInAt: now,
      lastHeartbeatAt: now,
      version: 1,
    });
    await ctx.db.insert("reviewerRoundConfirmations", {
      eventId: fixture.eventId,
      roundId: fixture.roundId,
      personId: reviewerPersonId,
      status: "confirmed",
      windows: [{ startsAt: now - 60000, endsAt: now + 3600000 }],
      version: 1,
      updatedAt: now,
    });
    const availability = await ctx.db
      .query("attendanceTeamAvailability")
      .withIndex("by_event_team", (q) =>
        q.eq("eventId", fixture.eventId).eq("teamId", fixture.teamId),
      )
      .unique();
    if (!availability) throw new Error("Availability missing");
    await ctx.db.patch(availability._id, { insideMemberCount: 1 });
    const policy = {
      policyVersion: "test-1",
      requiredGitHubTopic: "test",
      maxActiveGitHubRepositoriesPerTeam: 3,
      };
    const policyId = await ctx.db.insert("integrationPolicyVersions", {
      eventId: fixture.eventId,
      ...policy,
      version: 1,
      status: "published",
      checksum: integrationPolicyChecksum(policy),
      createdByPersonId: fixture.personId,
      createdAt: now,
      publishedAt: now,
    });
    const planId = await ctx.db.insert("attendancePlanVersions", {
      eventId: fixture.eventId,
      version: 1,
      name: "Test",
      vitBarcodeSymbologies: [],
      vitBarcodeNormalizationVersion: "v1",
      offlineQueueMaxScans: 10,
      offlineQueueMaxAgeSeconds: 60,
      status: "published",
      checksum: "test",
      createdByPersonId: fixture.personId,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.patch(fixture.eventId, {
      publishedIntegrationPolicyId: policyId,
      publishedAttendancePlanVersionId: planId,
    });
    return reviewerPersonId;
  });
}

async function prepareQuestionFixture(
  backend: BackendTest,
  fixture: Fixture,
  finalRequest = true,
) {
  const jobId = await backend.run(async (ctx) => {
    const now = Date.now();
    await insertPermissionGrant(ctx, {
      eventId: fixture.eventId,
      personId: fixture.personId,
      eventAccessSubjectId: fixture.subjectId,
      permissionKey: "operations.intelligence.generate",
      scopeType: "event",
      sourceType: "manual",
      sourceId: "question-test",
      reason: "Prepare questions test",
    });
    await ctx.db.insert("reviewRubricCriteria", {
      eventId: fixture.eventId,
      rubricVersionId: fixture.rubricVersionId,
      stableKey: "technical_execution",
      label: "Technical execution",
      question: "Explain the architecture.",
      guidance: "Use the captured evidence.",
      weight: 100,
      displayOrder: 0,
      anchors: {
        zero: "None",
        one: "Early",
        two: "Partial",
        three: "Mostly",
        four: "Complete",
      },
      createdAt: now,
    });
    const policy = {
      enabled: true,
      maximumQuestions: 6,
      parallelAnalyses: 3,
      batchCharacters: 80000,
      maximumAttempts: 3,
      preparationTimeoutSeconds: 300,
      model: "openai/gpt-5.6-terra",
      instructions: "",
    };
    await ctx.db.insert("reviewQuestionPolicies", {
      eventId: fixture.eventId,
      roundId: fixture.roundId,
      policy,
      operatorPersonId: fixture.personId,
      version: 1,
      updatedAt: now,
    });
    const round = await ctx.db.get(fixture.roundId);
    const team = await ctx.db.get(fixture.teamId);
    if (!round || !team) throw new Error("Missing fixture");
    const id = await prepareQuestionSet(ctx, round, team);
    if (!id) throw new Error("Question set missing");
    return id;
  });
  expect(
    await backend.mutation(internal.reviewQuestions.claim, { jobId }),
  ).toMatchObject({
    attempt: 1,
  });
  const context = await backend.query(internal.reviewQuestions.sourceContext, {
    jobId,
    attempt: 1,
  });
  if (!context) throw new Error("Source context missing");
  const body: Omit<ReviewQuestionRequest, "payloadChecksum"> = {
    protocolVersion: reviewQuestionProtocolVersion,
    jobId,
    attempt: 1,

    stage: "questions",
    partId: "final",
    partAttempt: 1,
    references: [
      {
        id: "project",
        kind: "project",
        title: "Submitted idea",
        coverage: "captured",
      },
    ],
    sourceChecksum: context.sourceChecksum,
    model: context.policy.model,
    maximumQuestions: context.policy.maximumQuestions,
    instructions: context.policy.instructions,
    criteria: context.criteria,
    sources: [
      {
        id: "project",
        kind: "project",
        title: "Submitted idea",
        text: context.projectText,
        coverage: "captured",
      },
    ],
  };
  const payloadChecksum = questionPayloadChecksum(body);
  if (finalRequest) {
    const analysisPartId = await backend.run(async (ctx) => {
      await ctx.db.patch(jobId, {
        collectionComplete: true,
        analysisLevel: 0,
        coverage: {
          discovered: 1,
          captured: 1,
          excluded: 0,
          unavailable: 0,
          chunks: 1,
          analysedChunks: 1,
          cachedBatches: 0,
        },
      });
      return await ctx.db.insert("reviewQuestionParts", {
        jobId,
        teamId: fixture.teamId,
        attempt: 1,
        key: "fixture",
        level: 0,
        state: "ready",
        sources: body.sources,
        references: body.references,
        analysis: {
          examinedSourceIds: ["project"],
          summary: "Submitted project evidence",
          findings: [],
        },
        cacheKey: "fixture",
        cached: false,
        partAttempt: 1,
      });
    });
    expect(
      await backend.mutation(internal.reviewQuestions.storeRequest, {
        jobId,
        attempt: 1,
        analysisPartId,
        requestJson: JSON.stringify({ ...body, payloadChecksum }),
      }),
    ).toBe(true);
  }
  return {
    jobId,
    body,
    context,
    callback: {
      protocolVersion: reviewQuestionProtocolVersion,
      jobId,
      attempt: 1,
      sourceChecksum: context.sourceChecksum,
      payloadChecksum,
      partId: "final",
      partAttempt: 1,
      agentVersion: reviewQuestionAgentVersion,
      status: "ready",
      questions: [
        {
          question: "Why did you choose this architecture?",
          reason: "The submitted idea needs an implementation explanation.",
          criterionKey: "technical_execution",
          sourceIds: ["project"],
        },
      ],
    },
  };
}


async function grantParticipationOperations(backend: BackendTest, fixture: Fixture) {
  await backend.run(async ctx => {
    for (const permissionKey of ["review.configuration.read", "review.configuration.publish", "round.read", "round.manage", "queue.manage", "review.start"] as const) {
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId, personId: fixture.personId, eventAccessSubjectId: fixture.subjectId,
        permissionKey, scopeType: "event", sourceType: "manual", sourceId: `participation:${permissionKey}`,
        grantedByPersonId: fixture.personId, reason: "Manage competition eligibility and skips",
      });
    }
  });
}

describe("OC eligibility and review skips", () => {
  test("marking OC removes a queued team, cancels preparation, preserves admission and participant access, and is retryable", async () => {
    const backend = seededBackend();
    const fixture = await seedQueueFixture(backend);
    const sessionId = await seedAwaitingReview(backend, fixture);
    await grantParticipationOperations(backend, fixture);
    const before = await backend.run(ctx => ctx.db.get(fixture.teamId));
    if (!before) throw new Error("Team missing");
    const actor = asParticipant(backend, fixture);
    const args = { eventSlug: fixture.eventSlug, teamId: fixture.teamId, category: "oc" as const, expectedVersion: before.version, reason: "Matched to organizing committee roster", clientOperationId: "mark-oc" };
    const changed = await actor.mutation(api.reviewParticipation.setCategory, args);
    expect(await actor.mutation(api.reviewParticipation.setCategory, args)).toEqual(changed);
    const after = await backend.run(ctx => ctx.db.get(fixture.teamId));
    expect(after).toMatchObject({ competitionCategory: "oc", status: before.status, leadMembershipId: before.leadMembershipId, activeMemberCount: before.activeMemberCount, membershipLocked: before.membershipLocked });
    expect(await backend.run(ctx => ctx.db.get(sessionId))).toMatchObject({ status: "cancelled" });
    expect(await backend.run(ctx => nextQueuedTeam(ctx, fixture.panelId))).toBeNull();
    expect(await actor.query(api.participantReview.current, { eventSlug: fixture.eventSlug })).toBeNull();
    expect((await actor.query(api.reviewOperations.roundTeams, { eventSlug: fixture.eventSlug, roundId: fixture.roundId, paginationOpts: { numItems: 30, cursor: null } })).page).toEqual([]);
    expect(await actor.query(api.reviewParticipation.teams, { eventSlug: fixture.eventSlug })).toContainEqual(expect.objectContaining({ id: fixture.teamId, category: "oc" }));
    await expect(actor.mutation(api.reviewOperations.queueTeam, { eventSlug: fixture.eventSlug, roundId: fixture.roundId, panelId: fixture.panelId, teamId: fixture.teamId, expectedTeamRoundVersion: 2, reason: "Try to route an OC team", clientOperationId: "route-oc" })).rejects.toThrow("confirmed with a locked project");
    const grants = await backend.run(ctx => ctx.db.query("permissionGrants").withIndex("by_subject_permission_status", q => q.eq("eventAccessSubjectId", fixture.subjectId).eq("permissionKey", "queue.participant.read").eq("status", "active")).collect());
    expect(grants).toHaveLength(1);
  });

  test("skip frees an assigned panel and expires its team QR; restoring requires a fresh desk assignment", async () => {
    const backend = seededBackend();
    const fixture = await seedQueueFixture(backend);
    const sessionId = await seedAwaitingReview(backend, fixture);
    await grantParticipationOperations(backend, fixture);
    const actor = asParticipant(backend, fixture);
    await backend.run(async ctx => {
      const state = await ctx.db.get(fixture.targetStateId);
      if (!state) throw new Error("State missing");
      await patchTeamRoundState(ctx, state, { state: "called", calledAt: Date.now() });
    });
    await actor.mutation(api.participantReview.mintTeamQr, { eventSlug: fixture.eventSlug, reviewSessionId: sessionId });
    const args = { eventSlug: fixture.eventSlug, roundId: fixture.roundId, teamId: fixture.teamId, skipped: true, expectedVersion: 1, reason: "Ops approved skipping this review", clientOperationId: "skip-assigned" };
    expect(await actor.mutation(api.reviewParticipation.setSkipped, args)).toEqual({ version: 2 });
    expect(await actor.mutation(api.reviewParticipation.setSkipped, args)).toEqual({ version: 2 });
    const skipped = await backend.run(ctx => ctx.db.get(fixture.targetStateId));
    expect(skipped).toMatchObject({ state: "skipped", skipReason: args.reason });
    expect(skipped?.panelId).toBeUndefined();
    expect(await backend.run(ctx => ctx.db.get(sessionId))).toMatchObject({ status: "cancelled" });
    expect(await backend.run(ctx => ctx.db.query("reviewTeamQrTokens").collect())).toEqual([expect.objectContaining({ state: "superseded" })]);
    expect(await actor.query(api.participantReview.current, { eventSlug: fixture.eventSlug })).toBeNull();
    expect(await actor.mutation(api.reviewParticipation.setSkipped, { ...args, skipped: false, expectedVersion: 2, clientOperationId: "restore-review" })).toEqual({ version: 3 });
    const restored = await backend.run(ctx => ctx.db.get(fixture.targetStateId));
    expect(restored).toMatchObject({ state: "unassigned" });
    expect(restored?.skipReason).toBeUndefined();
    expect(restored?.panelId).toBeUndefined();
  });

  test.each(["active", "scoring", "completed"] as const)("%s reviews cannot be skipped or silently converted to OC", async status => {
    const backend = seededBackend();
    const fixture = await seedQueueFixture(backend);
    const sessionId = await seedAwaitingReview(backend, fixture);
    await grantParticipationOperations(backend, fixture);
    await backend.run(async ctx => {
      await ctx.db.patch(sessionId, { status });
      const state = await ctx.db.get(fixture.targetStateId);
      if (!state) throw new Error("State missing");
      await patchTeamRoundState(ctx, state, { state: status === "completed" ? "completed" : "in_review" });
    });
    const actor = asParticipant(backend, fixture);
    const team = await backend.run(ctx => ctx.db.get(fixture.teamId));
    if (!team) throw new Error("Team missing");
    await expect(actor.mutation(api.reviewParticipation.setSkipped, { eventSlug: fixture.eventSlug, roundId: fixture.roundId, teamId: fixture.teamId, skipped: true, expectedVersion: 1, reason: "Cannot skip after starting", clientOperationId: "skip-started" })).rejects.toThrow("before discussion starts");
    await expect(actor.mutation(api.reviewParticipation.setCategory, { eventSlug: fixture.eventSlug, teamId: fixture.teamId, category: "oc", expectedVersion: team.version, reason: "Cannot silently remove an active review", clientOperationId: "oc-started" })).rejects.toThrow("before discussion starts");
    expect(await backend.run(ctx => ctx.db.get(fixture.teamId))).toEqual(team);
    expect(await backend.run(ctx => ctx.db.get(sessionId))).toMatchObject({ status });
  });

  test("participants cannot change category or skip reviews; stale versions are rejected", async () => {
    const backend = seededBackend();
    const fixture = await seedQueueFixture(backend);
    const actor = asParticipant(backend, fixture);
    const args = { eventSlug: fixture.eventSlug, roundId: fixture.roundId, teamId: fixture.teamId, skipped: true, expectedVersion: 0, reason: "Skip from the ops desk", clientOperationId: "skip-permission" };
    await expect(actor.mutation(api.reviewParticipation.setSkipped, args)).rejects.toThrow("does not have permission");
    await expect(actor.mutation(api.reviewParticipation.setCategory, { eventSlug: fixture.eventSlug, teamId: fixture.teamId, category: "oc", expectedVersion: 1, reason: "OC roster match", clientOperationId: "oc-permission" })).rejects.toThrow("does not have permission");
    await grantParticipationOperations(backend, fixture);
    await expect(actor.mutation(api.reviewParticipation.setSkipped, args)).rejects.toThrow("review changed");
  });

  test("an OC team cannot restore its skipped review until reclassified; published rounds can skip an unassigned competitor", async () => {
    const backend = seededBackend();
    const fixture = await seedQueueFixture(backend);
    await grantParticipationOperations(backend, fixture);
    const actor = asParticipant(backend, fixture);
    await backend.run(async ctx => {
      await ctx.db.patch(fixture.teamId, { competitionCategory: "oc" });
      const state = await ctx.db.get(fixture.targetStateId);
      if (!state) throw new Error("State missing");
      await patchTeamRoundState(ctx, state, { state: "skipped", skipReason: "Organizing committee team", panelId: undefined, queuedAt: undefined });
    });
    const args = { eventSlug: fixture.eventSlug, roundId: fixture.roundId, teamId: fixture.teamId, skipped: false, expectedVersion: 1, reason: "Restore the review", clientOperationId: "restore-oc" };
    await expect(actor.mutation(api.reviewParticipation.setSkipped, args)).rejects.toThrow("Only a skipped competitor");
    await backend.run(async ctx => {
      await ctx.db.patch(fixture.teamId, { competitionCategory: undefined });
      await ctx.db.delete(fixture.targetStateId);
      await ctx.db.patch(fixture.roundId, { status: "published" });
    });
    expect(await actor.mutation(api.reviewParticipation.setSkipped, { ...args, skipped: true, expectedVersion: 0, clientOperationId: "skip-before-round" })).toEqual({ version: 1 });
    const state = await backend.run(ctx => ctx.db.query("teamRoundStates").withIndex("by_round_team", q => q.eq("roundId", fixture.roundId).eq("teamId", fixture.teamId)).unique());
    expect(state).toMatchObject({ state: "skipped", skipReason: args.reason });
  });
});
