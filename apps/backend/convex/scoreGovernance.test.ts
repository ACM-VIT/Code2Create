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
import { reviewProgressionBlocker } from "./lib/reviewProgression";

describe("project-specific review planning", () => {
  test("briefs account for all sources; assignments are retryable, conflict checked and resolved before closing", async () => {
    const backend = seededBackend();
    const f = await seedCorrectionFixture(backend);
    const setup = await backend.run(async ctx => {
      for (const permissionKey of ["round.manage", "round.read", "round.close", "review.configuration.publish"] as const) await insertPermissionGrant(ctx, { eventId: f.eventId, personId: f.personId, eventAccessSubjectId: f.subjectId, permissionKey, scopeType: "event", sourceType: "manual", sourceId: "planning-test", grantedByPersonId: f.personId, reason: "Plan competitive projects" });
      const applicationId = await ctx.db.insert("applications", { eventId: f.eventId, teamId: f.teamId, submittedProjectVersionId: f.projectVersionId, admissionPolicyVersionId: f.admissionPolicyVersionId, humanDecision: "accept", state: "offer_sent", decisionStage: "released", experienceBand: "mixed_or_external", assignedReviewCount: 0, completedReviewCount: 0, contentVersion: 1, version: 1, submittedAt: f.now });
      const session = await ctx.db.get(f.reviewSessionId);
      if (!session) throw new Error("Session missing");
      const reviewer = await ctx.db.insert("people", { authUserId: "independent-planning-reviewer", verifiedEmail: "reviewer@example.test", displayName: "Independent reviewer", status: "active", createdAt: f.now, updatedAt: f.now });
      await ctx.db.insert("reviewPanelMembers", { eventId: f.eventId, roundId: f.roundId, panelId: session.panelId, personId: reviewer, eventAccessSubjectId: f.subjectId, assignedCriterionIds: [], isCoordinator: true, status: "active", assignedAt: f.now, seatSeniority: "lead" });
      return { applicationId, panelId: session.panelId, reviewer };
    });
    const actor = reviewerClient(backend, f);
    const finding = { text: "A proposal described in the submitted idea.", sourceIds: ["idea"] };
    const brief = { eventSlug: f.eventSlug, teamId: f.teamId, projectVersionId: f.projectVersionId, assessment: { examinedSourceIds: ["idea"], title: "Fixture project", summary: finding, users: finding, minimumDeliverable: finding, architecture: finding, implementationEvidence: finding, primaryPool: "Web/App/Backend", secondaryPools: [], specialistSkills: ["Backend"], panelFitReason: "Backend implementation and product scope", risksToProbe: [finding], suggestedQuestions: [{ criterionKey: "technical_execution", question: "What is implemented?", why: "Separate the proposal from evidence.", sourceIds: ["idea"] }], limitations: ["Intake evidence only"] }, sourceChecksum: "a".repeat(64), model: "analysis-model", expectedVersion: 0, reason: "Read every submitted source", clientOperationId: "save-planning-brief" };
    await expect(actor.mutation(api.reviewPlanning.saveBrief, { ...brief, assessment: { ...brief.assessment, examinedSourceIds: [] }, clientOperationId: "missing-source" })).rejects.toThrow("every submission source");
    expect(await actor.mutation(api.reviewPlanning.saveBrief, brief)).toEqual({ version: 1 });
    expect(await actor.mutation(api.reviewPlanning.saveBrief, brief)).toEqual({ version: 1 });
    const assign = { eventSlug: f.eventSlug, teamId: f.teamId, roundId: f.roundId, panelId: setup.panelId, rationale: "Independent reviewer covers the project's backend workflow", expectedVersion: 0, expectedRoundVersion: 1, clientOperationId: "assign-planning-team" };
    expect(await actor.mutation(api.reviewPlanning.assign, assign)).toEqual({ version: 1 });
    expect(await actor.mutation(api.reviewPlanning.assign, assign)).toEqual({ version: 1 });
    let view = await actor.query(api.reviewPlanning.workspace, { eventSlug: f.eventSlug, roundId: f.roundId });
    expect(view.teams[0]).toMatchObject({ briefCurrent: true, inQueue: false, status: "offer_sent", plan: { panelId: setup.panelId, version: 1 } });
    await expect(actor.mutation(api.reviewPlanning.assign, { ...assign, clientOperationId: "stale-plan" })).rejects.toThrow("changed");
    await expect(actor.mutation(api.roundExports.start, { eventSlug: f.eventSlug, roundId: f.roundId, expectedRoundVersion: 1, reason: "Attempt closing without outcome", clientOperationId: "close-unresolved-plan" })).rejects.toThrow("planned teams have no review outcome");
    await backend.run(async ctx => {
      const ownMembership = await ctx.db.insert("eventMemberships", { eventId: f.eventId, personId: setup.reviewer, eventAccessSubjectId: f.subjectId, participantClass: "vit_student", eligibilityStatus: "eligible", onboardingStatus: "accepted", acceptedParticipantPolicyVersionIds: [], createdAt: f.now, updatedAt: f.now });
      await ctx.db.insert("teamMembers", { eventId: f.eventId, teamId: f.teamId, membershipId: ownMembership, role: "member", source: "created", status: "active", joinedAt: f.now });
    });
    await expect(actor.mutation(api.reviewPlanning.assign, { ...assign, expectedVersion: 1, clientOperationId: "own-team-conflict" })).rejects.toThrow("conflict");
    await backend.run(ctx => ctx.db.patch(f.teamId, { competitionCategory: "oc" }));
    view = await actor.query(api.reviewPlanning.workspace, { eventSlug: f.eventSlug, roundId: f.roundId });
    expect(view.teams).toEqual([]);
    await expect(actor.mutation(api.reviewPlanning.saveBrief, { ...brief, expectedVersion: 1, clientOperationId: "oc-brief" })).rejects.toThrow("competitive");
    await expect(actor.mutation(api.reviewPlanning.assign, { ...assign, expectedVersion: 1, clientOperationId: "oc-plan" })).rejects.toThrow("competitive");
  });
});

describe("review round progression", () => {
  async function fixture() {
    const backend = seededBackend();
    const source = await seedCorrectionFixture(backend);
    await prepareCorrectionSubmission(backend, source);
    const setup = await backend.run(async ctx => {
      for (const permissionKey of ["round.read", "round.close", "score.values.read"] as const) await insertPermissionGrant(ctx, {
        eventId: source.eventId, personId: source.personId, eventAccessSubjectId: source.subjectId, permissionKey, scopeType: "round", scopeId: source.roundId,
        sourceType: "manual", sourceId: "progression-test", grantedByPersonId: source.personId, reason: "Review progression decisions",
      });
      const original = await ctx.db.get(source.roundId);
      const team = await ctx.db.get(source.teamId);
      if (!original || !team) throw new Error("Fixture missing.");
      const { _id, _creationTime, ...fields } = original;
      const laterId = await ctx.db.insert("reviewRounds", { ...fields, stableKey: "later", name: "Later review", sequence: original.sequence + 1, status: "published" });
      const { _id: _teamId, _creationTime: _teamCreated, ...teamFields } = team;
      const otherId = await ctx.db.insert("teams", { ...teamFields, name: "Other competitor" });
      const ocId = await ctx.db.insert("teams", { ...teamFields, name: "OC", competitionCategory: "oc" });
      const evaluation = await ctx.db.query("reviewEvaluations").withIndex("by_session", q => q.eq("reviewSessionId", source.reviewSessionId)).unique();
      if (!evaluation) throw new Error("Evaluation missing.");
      const snapshotId = await ctx.db.insert("roundCloseSnapshots", {
        eventId: source.eventId, roundId: source.roundId, rubricVersionId: source.rubricVersionId, revision: 1,
        roundConfigurationChecksum: "configuration", resultCount: 3, exclusionCount: 0, withdrawnCount: 0, checksum: "snapshot", createdByPersonId: source.personId, createdAt: source.now,
      });
      for (const [id, points] of [[source.teamId, 80], [otherId, 70], [ocId, 99]] as const) await ctx.db.insert("roundCloseEntries", {
        eventId: source.eventId, roundId: source.roundId, closeSnapshotId: snapshotId, teamId: id, createdAt: source.now,
        payload: { kind: "result", reviewSessionId: source.reviewSessionId, evaluationId: evaluation._id, evaluationInputChecksum: evaluation.inputChecksum, criterionResults: [], totalPoints: points },
      });
      await ctx.db.patch(source.roundId, { status: "closed", activeCloseSnapshotId: snapshotId });
      return { laterId, otherId, ocId, snapshotId, roundVersion: original.version };
    });
    const actor = reviewerClient(backend, source);
    const common = { eventSlug: source.eventSlug, roundId: source.roundId, expectedRoundVersion: setup.roundVersion, reason: "Board reviewed the finalized results" };
    const blocker = (teamId: Id<"teams">) => backend.run(async ctx => {
      const later = await ctx.db.get(setup.laterId);
      if (!later) throw new Error("Later round missing");
      return reviewProgressionBlocker(ctx, later, teamId);
    });
    return { backend, source, ...setup, actor, common, blocker };
  }

  test("non-eliminatory rounds continue; elimination requires complete explicit decisions and excludes OC", async () => {
    const f = await fixture();
    expect(await f.blocker(f.source.teamId)).toBeNull();
    const settings = { ...f.common, mode: "elimination" as const, expectedVersion: 0, clientOperationId: "configure-elimination" };
    expect(await f.actor.mutation(api.reviewProgression.configure, settings)).toEqual({ version: 1 });
    expect(await f.actor.mutation(api.reviewProgression.configure, settings)).toEqual({ version: 1 });
    expect(await f.blocker(f.source.teamId)).toContain("publish its progression decisions");
    const workspace = await f.actor.query(api.reviewProgression.workspace, { eventSlug: f.source.eventSlug, roundId: f.source.roundId });
    expect(workspace.teams.map(t => t.teamId)).toEqual([f.source.teamId, f.otherId]);
    const decisions = [
      { teamId: f.source.teamId, outcome: "advance" as const, reason: "Strong finalized review and viable prototype scope" },
      { teamId: f.otherId, outcome: "eliminate" as const, reason: "Board approved the cutoff after reviewing scores" },
    ];
    const publication = { ...f.common, closeSnapshotId: f.snapshotId, expectedVersion: 1, decisions, clientOperationId: "apply-progression" };
    for (const [key, invalid] of [["missing", decisions.slice(0, 1)], ["duplicate", [decisions[0]!, decisions[0]!]], ["oc", [...decisions, { teamId: f.ocId, outcome: "advance" as const, reason: "OC must never enter competition" }]]] as const) {
      await expect(f.actor.mutation(api.reviewProgression.publish, { ...publication, decisions: [...invalid], clientOperationId: key })).rejects.toThrow("every competitive team");
    }
    await expect(f.actor.mutation(api.reviewProgression.publish, { ...publication, decisions: decisions.map(d => ({ ...d, reason: "" })), clientOperationId: "no-reasons" })).rejects.toThrow();
    expect(await f.backend.run(ctx => ctx.db.query("reviewProgressionEntries").collect())).toHaveLength(0);
    expect(await f.actor.mutation(api.reviewProgression.publish, publication)).toEqual({ version: 2 });
    expect(await f.actor.mutation(api.reviewProgression.publish, publication)).toEqual({ version: 2 });
    expect(await f.blocker(f.source.teamId)).toBeNull();
    expect(await f.blocker(f.otherId)).toContain("has not advanced");
    expect(await f.blocker(f.ocId)).toContain("has not advanced");
    await expect(f.actor.mutation(api.reviewProgression.publish, { ...publication, clientOperationId: "stale" })).rejects.toThrow("changed");
    await f.backend.run(ctx => ctx.db.patch(f.source.roundId, { status: "open", activeCloseSnapshotId: undefined }));
    expect(await f.blocker(f.source.teamId)).toContain("publish its progression decisions");
    expect((await f.actor.query(api.reviewProgression.workspace, { eventSlug: f.source.eventSlug, roundId: f.source.roundId })).published).toBe(false);
  });

  test("combined-score references reject changed weights and snapshots before applying outcomes", async () => {
    const f = await fixture();
    await f.actor.mutation(api.reviewProgression.configure, { ...f.common, mode: "elimination", expectedVersion: 0, clientOperationId: "configure-reference" });
    await f.backend.run(ctx => ctx.db.insert("reviewAggregationPolicies", { eventId: f.source.eventId, version: 3, status: "published", rounds: [{ roundId: f.source.roundId, weight: 100 }], checksum: "weights", publishedByPersonId: f.source.personId, publishedAt: f.source.now, reason: "Finalized score reference" }));
    const args = { ...f.common, expectedVersion: 1, closeSnapshotId: f.snapshotId, decisions: [{ teamId: f.source.teamId, outcome: "advance" as const, reason: "Reviewed the final score and evidence" }, { teamId: f.otherId, outcome: "eliminate" as const, reason: "Reviewed the agreed competitive cutoff" }], scoreReference: { policyVersion: 3, rounds: [{ roundId: f.source.roundId, closeSnapshotId: f.snapshotId }] }, clientOperationId: "apply-reference" };
    await expect(f.actor.mutation(api.reviewProgression.publish, { ...args, scoreReference: { ...args.scoreReference, policyVersion: 2 }, clientOperationId: "old-weights" })).rejects.toThrow("weights changed");
    const differentSnapshot = await f.backend.run(async ctx => {
      const snapshot = await ctx.db.get(f.snapshotId);
      if (!snapshot) throw new Error("Snapshot missing");
      const { _id, _creationTime, ...fields } = snapshot;
      return ctx.db.insert("roundCloseSnapshots", { ...fields, revision: 2 });
    });
    await expect(f.actor.mutation(api.reviewProgression.publish, { ...args, scoreReference: { policyVersion: 3, rounds: [{ roundId: f.source.roundId, closeSnapshotId: differentSnapshot }] }, clientOperationId: "old-source" })).rejects.toThrow("contributing round changed");
    expect(await f.backend.run(ctx => ctx.db.query("reviewProgressionEntries").collect())).toHaveLength(0);
    expect(await f.actor.mutation(api.reviewProgression.publish, args)).toEqual({ version: 2 });
  });

  test("a planned skip in a later round does not prevent deciding the preceding round", async () => {
    const f = await fixture();
    const stateId = await f.backend.run(ctx => ctx.db.insert("teamRoundStates", { eventId: f.source.eventId, roundId: f.laterId, teamId: f.otherId, state: "skipped", priority: 0, callAttemptCount: 0, version: 1, updatedByPersonId: f.source.personId, updatedAt: f.source.now }));
    expect(await f.actor.mutation(api.reviewProgression.configure, { ...f.common, mode: "elimination", expectedVersion: 0, clientOperationId: "configure-with-future-skip" })).toEqual({ version: 1 });
    await f.backend.run(ctx => ctx.db.patch(stateId, { state: "queued" }));
    await expect(f.actor.mutation(api.reviewProgression.configure, { ...f.common, mode: "all_advance", expectedVersion: 1, clientOperationId: "change-after-queue" })).rejects.toThrow("already has activity");
    await f.backend.run(async ctx => {
      await ctx.db.patch(stateId, { state: "skipped" });
      const session = await ctx.db.get(f.source.reviewSessionId);
      if (!session) throw new Error("Session missing");
      const { _id, _creationTime, ...fields } = session;
      await ctx.db.insert("reviewSessions", { ...fields, roundId: f.laterId, teamId: f.otherId, status: "cancelled" });
    });
    await expect(f.actor.mutation(api.reviewProgression.configure, { ...f.common, mode: "all_advance", expectedVersion: 1, clientOperationId: "change-after-session-skip" })).rejects.toThrow("already has activity");
  });

  test("opening an empty later round still allows configuring and publishing progression", async () => {
    const f = await fixture();
    await f.backend.run(ctx => insertPermissionGrant(ctx, {
      eventId: f.source.eventId, personId: f.source.personId,
      eventAccessSubjectId: f.source.subjectId, permissionKey: "round.manage",
      scopeType: "round", scopeId: f.laterId, sourceType: "manual",
      sourceId: "open-later-round", grantedByPersonId: f.source.personId,
      reason: "Open the next review round",
    }));
    await f.actor.mutation(api.reviewOperations.openRound, {
      eventSlug: f.source.eventSlug, roundId: f.laterId, expectedVersion: f.roundVersion,
      reason: "Prepare the next review round", clientOperationId: "open-empty-round",
    });
    await f.actor.mutation(api.reviewProgression.configure, {
      ...f.common, mode: "elimination", expectedVersion: 0, clientOperationId: "configure-after-open",
    });
    expect(await f.blocker(f.source.teamId)).toContain("publish its progression decisions");
    await f.actor.mutation(api.reviewProgression.publish, {
      ...f.common, expectedVersion: 1, closeSnapshotId: f.snapshotId,
      decisions: [
        { teamId: f.source.teamId, outcome: "advance", reason: "Reviewed the final score and evidence" },
        { teamId: f.otherId, outcome: "eliminate", reason: "Reviewed the agreed competitive cutoff" },
      ],
      clientOperationId: "publish-after-open",
    });
    expect(await f.blocker(f.source.teamId)).toBeNull();
    expect(await f.blocker(f.otherId)).toContain("has not advanced");
  });

  test("published combined-score decisions expire with their inputs and cannot be invalidated after later activity", async () => {
    const f = await fixture();
    const earlier = await f.backend.run(async ctx => {
      const round = await ctx.db.get(f.source.roundId);
      const snapshot = await ctx.db.get(f.snapshotId);
      if (!round || !snapshot) throw new Error("Fixture missing");
      const { _id, _creationTime, ...roundFields } = round;
      const roundId = await ctx.db.insert("reviewRounds", {
        ...roundFields, stableKey: "earlier", name: "Earlier review", sequence: round.sequence - 1,
      });
      const { _id: _snapshotId, _creationTime: _snapshotCreated, ...snapshotFields } = snapshot;
      const snapshotId = await ctx.db.insert("roundCloseSnapshots", { ...snapshotFields, roundId });
      const entries = await ctx.db.query("roundCloseEntries").withIndex("by_snapshot_team", q => q.eq("closeSnapshotId", f.snapshotId)).collect();
      for (const { _id: _entryId, _creationTime: _entryCreated, ...entry } of entries) {
        await ctx.db.insert("roundCloseEntries", { ...entry, roundId, closeSnapshotId: snapshotId });
      }
      await ctx.db.patch(roundId, { activeCloseSnapshotId: snapshotId });
      for (const permissionKey of ["score.values.read", "review.configuration.publish"] as const) {
        await insertPermissionGrant(ctx, {
          eventId: f.source.eventId, personId: f.source.personId, eventAccessSubjectId: f.source.subjectId,
          permissionKey, scopeType: "event", sourceType: "manual", sourceId: "score-reference-test",
          grantedByPersonId: f.source.personId, reason: "Verify combined-score progression",
        });
      }
      return { roundId, snapshotId };
    });
    const weights = {
      eventSlug: f.source.eventSlug,
      rounds: [{ roundId: earlier.roundId, weight: 50 }, { roundId: f.source.roundId, weight: 50 }],
      expectedVersion: 0, reason: "Combine the two finalized reviews", clientOperationId: "initial-weights",
    };
    await f.actor.mutation(api.reviewAggregation.publish, weights);
    await f.actor.mutation(api.reviewProgression.configure, {
      ...f.common, mode: "elimination", expectedVersion: 0, clientOperationId: "configure-combined",
    });
    const publication = {
      ...f.common, expectedVersion: 1, closeSnapshotId: f.snapshotId,
      decisions: [
        { teamId: f.source.teamId, outcome: "advance" as const, reason: "Reviewed the final score and evidence" },
        { teamId: f.otherId, outcome: "eliminate" as const, reason: "Reviewed the agreed competitive cutoff" },
      ],
      scoreReference: {
        policyVersion: 1,
        rounds: [
          { roundId: earlier.roundId, closeSnapshotId: earlier.snapshotId },
          { roundId: f.source.roundId, closeSnapshotId: f.snapshotId },
        ],
      },
      clientOperationId: "publish-combined",
    };
    const assertPublication = async (published: boolean) => {
      const workspace = await f.actor.query(api.reviewProgression.workspace, {
        eventSlug: f.source.eventSlug, roundId: f.source.roundId,
      });
      expect(workspace.published).toBe(published);
      const result = await f.actor.query(api.reviewAggregation.results, { eventSlug: f.source.eventSlug });
      expect(result.state).toBe("ready");
      expect(result.teams.find(team => team.teamId === f.source.teamId)).toMatchObject({
        competitionStatus: published ? "eligible" : "awaiting_decision",
        totalPoints: published ? 80 : null,
      });
      expect(result.teams.find(team => team.teamId === f.otherId)?.competitionStatus)
        .toBe(published ? "eliminated" : "awaiting_decision");
      if (published) expect(await f.blocker(f.source.teamId)).toBeNull();
      else expect(await f.blocker(f.source.teamId)).toContain("publish its progression decisions");
    };
    await f.actor.mutation(api.reviewProgression.publish, publication);
    await assertPublication(true);

    await f.actor.mutation(api.reviewAggregation.publish, {
      ...weights, expectedVersion: 1, clientOperationId: "changed-weights",
      rounds: [{ roundId: earlier.roundId, weight: 25 }, { roundId: f.source.roundId, weight: 75 }],
    });
    await assertPublication(false);
    await f.actor.mutation(api.reviewProgression.publish, {
      ...publication, expectedVersion: 2,
      scoreReference: { ...publication.scoreReference, policyVersion: 2 },
      clientOperationId: "review-new-weights",
    });
    await assertPublication(true);

    const replacementId = await f.backend.run(async ctx => {
      const snapshot = await ctx.db.get(earlier.snapshotId);
      if (!snapshot) throw new Error("Snapshot missing");
      const { _id, _creationTime, ...fields } = snapshot;
      const snapshotId = await ctx.db.insert("roundCloseSnapshots", { ...fields, revision: 2 });
      const entries = await ctx.db.query("roundCloseEntries").withIndex("by_snapshot_team", q => q.eq("closeSnapshotId", earlier.snapshotId)).collect();
      for (const { _id: _entryId, _creationTime: _entryCreated, ...entry } of entries) {
        await ctx.db.insert("roundCloseEntries", { ...entry, closeSnapshotId: snapshotId });
      }
      await ctx.db.patch(earlier.roundId, { activeCloseSnapshotId: snapshotId });
      return snapshotId;
    });
    await assertPublication(false);
    await f.actor.mutation(api.reviewProgression.publish, {
      ...publication, expectedVersion: 3,
      scoreReference: {
        policyVersion: 2,
        rounds: [{ roundId: earlier.roundId, closeSnapshotId: replacementId }, publication.scoreReference.rounds[1]!],
      },
      clientOperationId: "review-new-snapshot",
    });
    await assertPublication(true);

    await f.backend.run(ctx => ctx.db.insert("teamRoundStates", {
      eventId: f.source.eventId, roundId: f.laterId, teamId: f.source.teamId, state: "queued",
      priority: 0, callAttemptCount: 0, version: 1, updatedByPersonId: f.source.personId, updatedAt: f.source.now,
    }));
    await expect(f.actor.mutation(api.reviewAggregation.publish, {
      ...weights, expectedVersion: 2, clientOperationId: "change-locked-weights",
    })).rejects.toThrow("already has activity");
    await assertPublication(true);
  });

  test("later-round activity locks progression and score access is required to publish", async () => {
    const f = await fixture();
    await f.actor.mutation(api.reviewProgression.configure, { ...f.common, mode: "elimination", expectedVersion: 0, clientOperationId: "configure" });
    const stateId = await f.backend.run(ctx => ctx.db.insert("teamRoundStates", {
      eventId: f.source.eventId, roundId: f.laterId, teamId: f.source.teamId, state: "queued",
      priority: 0, callAttemptCount: 0, version: 1, updatedByPersonId: f.source.personId, updatedAt: f.source.now,
    }));
    await expect(f.actor.mutation(api.reviewProgression.configure, { ...f.common, mode: "all_advance", expectedVersion: 1, clientOperationId: "change-late" })).rejects.toThrow("already has activity");
    await f.backend.run(async ctx => {
      await ctx.db.delete(stateId);
      const grants = await ctx.db.query("permissionGrants").collect();
      for (const grant of grants) if (grant.permissionKey === "score.values.read" && grant.eventAccessSubjectId === f.source.subjectId) await ctx.db.patch(grant._id, { status: "revoked" });
    });
    const workspace = await f.actor.query(api.reviewProgression.workspace, { eventSlug: f.source.eventSlug, roundId: f.source.roundId });
    expect(workspace.canReadScores).toBe(false);
    expect(workspace.teams).toEqual([]);
    await expect(f.actor.mutation(api.reviewProgression.publish, { ...f.common, expectedVersion: 1, closeSnapshotId: f.snapshotId, decisions: [], clientOperationId: "without-scores" })).rejects.toThrow();
  });
});

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
    const progressionId = await backend.run(async ctx => {
      const round = await ctx.db.get(secondRoundId);
      if (!round?.activeCloseSnapshotId) throw new Error("Snapshot missing");
      return ctx.db.insert("reviewProgressions", { eventId: fixture.eventId, roundId: secondRoundId, mode: "elimination", version: 1, updatedByPersonId: fixture.personId, updatedAt: fixture.now, reason: "Finalists pending" });
    });
    expect((await read()).teams[0]).toMatchObject({ totalPoints: null, weightedPoints: 66, competitionStatus: "awaiting_decision" });
    await backend.run(async ctx => {
      const round = await ctx.db.get(secondRoundId);
      await ctx.db.patch(progressionId, { closeSnapshotId: round?.activeCloseSnapshotId });
      await ctx.db.insert("reviewProgressionEntries", { eventId: fixture.eventId, roundId: secondRoundId, progressionId, teamId: fixture.teamId, outcome: "eliminate", reason: "Operator chose the final cutoff" });
    });
    expect((await read()).teams[0]).toMatchObject({ totalPoints: null, weightedPoints: 66, competitionStatus: "eliminated" });
    await backend.run(ctx => ctx.db.patch(progressionId, { mode: "all_advance" }));

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
    await backend.run(ctx => ctx.db.patch(fixture.teamId, { competitionCategory: "oc" }));
    expect((await read()).teams).toEqual([]);
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
