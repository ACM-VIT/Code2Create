import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import type { FunctionReturnType } from "convex/server";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, components, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import {
  admissionReviewClaimMs,
  cancelAdmissionReviewAssignment,
  countHumanReviewScore,
  createAdmissionReviewAssignment,
  saveAdmissionHumanReview,
} from "./admissions.ts";
import { permissionCatalog } from "./lib/permissionCatalog.ts";
import { defaultParticipantPolicy, participantPolicyChecksum } from "./lib/participantPolicy.ts";
import { insertPermissionGrant } from "./lib/permissions.ts";
import { createTestSubmissionSnapshot } from "./lib/testSubmissionSnapshot.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;
type ReviewerClient = ReturnType<BackendTest["withIdentity"]>;
type ReviewAssignmentCountPage = FunctionReturnType<
  typeof api.admissions.myReviewAssignmentCountRows
>;

describe("admission review deck", () => {
  test("fills four cards, prioritizes partially reviewed submissions, and replaces saved reviews", async () => {
    const { backend, fixture, reviewer } = await deckFixture();
    const ids = await cloneDeckApplications(backend, fixture, 6);
    await backend.run(async (ctx) => {
      const application = await ctx.db.get(fixture.applicationId);
      if (!application) throw new Error("Missing deck fixture.");
      await ctx.db.patch(application.admissionPolicyVersionId, { minimumHumanReviews: 2 });
      await ctx.db.patch(ids[4]!, { completedReviewCount: 1 });
    });
    const args = { eventSlug: fixture.eventSlug, now: Date.now() };
    const before = await reviewer.query(api.admissions.reviewDeck, args);
    expect(before).toHaveLength(4);
    expect(before?.[0]).toMatchObject({ applicationId: ids[4], completedReviewCount: 1, minimumHumanReviews: 2 });
    const claimed = await reviewer.mutation(api.admissions.claimReview, {
      eventSlug: fixture.eventSlug, applicationId: fixture.applicationId, clientOperationId: "deck-claim",
    });
    expect((await reviewer.query(api.admissions.reviewDeck, args))?.[0]).toMatchObject({
      applicationId: fixture.applicationId, assignment: { id: claimed.assignmentId },
    });
    await reviewer.mutation(api.admissions.saveReview, {
      eventSlug: fixture.eventSlug, applicationId: fixture.applicationId,
      expectedApplicationContentVersion: 1, recommendation: "accept", reasonCode: "clear_intent", clientOperationId: "deck-save",
    });
    const after = await reviewer.query(api.admissions.reviewDeck, args);
    expect(after).toHaveLength(4);
    expect(after?.some((item) => item.applicationId === fixture.applicationId)).toBe(false);
    expect((await assignmentState(backend, fixture, claimed.assignmentId)).assignment?.state).toBe("completed");
  });

  test("excludes completed, withdrawn, decided, reserved, and already-reviewed submissions", async () => {
    const { backend, fixture, reviewer } = await deckFixture();
    const ids = await cloneDeckApplications(backend, fixture, 5);
    await backend.run(async (ctx) => {
      const application = await ctx.db.get(fixture.applicationId);
      if (!application) throw new Error("Missing deck fixture.");
      await ctx.db.patch(application.admissionPolicyVersionId, { minimumHumanReviews: 2 });
      await ctx.db.patch(ids[0]!, { completedReviewCount: 2 });
      await ctx.db.patch(ids[1]!, { state: "withdrawn" });
      await ctx.db.patch(ids[2]!, { decisionStage: "recorded" });
      await ctx.db.patch(ids[3]!, { completedReviewCount: 1, assignedReviewCount: 1 });
      await ctx.db.insert("admissionReviewAssignments", {
        eventId: fixture.eventId, applicationId: ids[3]!, applicationContentVersion: 1,
        reviewerPersonId: fixture.secondReviewerPersonId, assignedByPersonId: fixture.managerPersonId,
        state: "active", version: 1, assignedAt: Date.now(),
      });
      await ctx.db.patch(ids[4]!, { completedReviewCount: 1 });
      await ctx.db.insert("admissionHumanReviews", {
        eventId: fixture.eventId, applicationId: ids[4]!, applicationContentVersion: 1,
        reviewerPersonId: fixture.reviewerPersonId, recommendation: "accept", reasonCode: "clear_intent",
        status: "active", createdAt: Date.now(),
      });
    });
    const args = { eventSlug: fixture.eventSlug, now: Date.now() };
    expect((await reviewer.query(api.admissions.reviewDeck, args))?.map((item) => item.applicationId)).toEqual([fixture.applicationId]);
    expect(await reviewer.query(api.admissions.reviewDeck, { ...args, excludeApplicationId: fixture.applicationId })).toEqual([]);
    expect(await reviewer.query(api.admissions.reviewDeck, { ...args, origin: "internal" })).toEqual([]);
    expect(await reviewer.query(api.admissions.reviewDeck, { ...args, origin: "external" })).toHaveLength(1);
    for (const applicationId of ids.slice(0, 3)) {
      await expect(reviewer.mutation(api.admissions.claimReview, {
        eventSlug: fixture.eventSlug, applicationId, clientOperationId: `unreviewable:${applicationId}`,
      })).rejects.toThrow("no reviews remaining");
    }
  });

  test("read access alone cannot claim; scoped and assigned reviewers only see their applications", async () => {
    const { backend, fixture, reviewer } = await deckFixture("none");
    await cloneDeckApplications(backend, fixture, 2);
    const args = { eventSlug: fixture.eventSlug, now: Date.now() };
    expect(await reviewer.query(api.admissions.reviewDeck, args)).toBeNull();
    await expect(reviewer.mutation(api.admissions.claimReview, {
      eventSlug: fixture.eventSlug, applicationId: fixture.applicationId, clientOperationId: "read-only",
    })).rejects.toThrow();
    const assignment = await assignFixtureReviewer(backend, fixture, fixture.reviewerSubjectId);
    expect((await reviewer.query(api.admissions.reviewDeck, args))?.map((item) => item.applicationId)).toEqual([fixture.applicationId]);
    expect((await reviewer.query(api.admissions.reviewDeck, args))?.[0]?.assignment?.id).toBe(assignment.assignmentId);
  });

  test("claims are idempotent and only one reviewer can take the final slot", async () => {
    const { backend, fixture, reviewer, manager } = await deckFixture();
    const command = { eventSlug: fixture.eventSlug, applicationId: fixture.applicationId, clientOperationId: "claim-final-slot" };
    const claims = await Promise.allSettled([
      reviewer.mutation(api.admissions.claimReview, command),
      manager.mutation(api.admissions.claimReview, command),
    ]);
    expect(claims.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = claims[0]?.status === "fulfilled" ? reviewer : manager;
    const first = await winner.mutation(api.admissions.claimReview, command);
    expect(await winner.mutation(api.admissions.claimReview, { ...command, clientOperationId: "another-click" })).toEqual(first);
    expect((await backend.run((ctx) => ctx.db.get(fixture.applicationId)))?.assignedReviewCount).toBe(1);
  });

  test("reviewers can release their own claim, freeing the slot, but cannot release someone else's", async () => {
    const { backend, fixture, reviewer, manager } = await deckFixture();
    const claim = await reviewer.mutation(api.admissions.claimReview, {
      eventSlug: fixture.eventSlug, applicationId: fixture.applicationId, clientOperationId: "claim-to-release",
    });
    const command = {
      eventSlug: fixture.eventSlug, applicationId: fixture.applicationId, expectedApplicationVersion: 2,
      assignmentId: claim.assignmentId, expectedAssignmentVersion: 1, reason: "Released my review claim", clientOperationId: "release-own",
    };
    await expect(manager.mutation(api.admissions.cancelReviewAssignment, command)).rejects.toThrow();
    const released = await reviewer.mutation(api.admissions.cancelReviewAssignment, command);
    expect(released.assignmentState).toBe("cancelled");
    expect(await reviewer.mutation(api.admissions.cancelReviewAssignment, command)).toEqual(released);
    const state = await assignmentState(backend, fixture, claim.assignmentId);
    expect(state.application?.assignedReviewCount).toBe(0);
    expect(state.assignmentGrants.every((grant) => grant.status === "revoked")).toBe(true);
    expect(await manager.query(api.admissions.reviewDeck, { eventSlug: fixture.eventSlug, now: Date.now() })).toHaveLength(1);
    await manager.mutation(api.admissions.claimReview, {
      eventSlug: fixture.eventSlug, applicationId: fixture.applicationId, clientOperationId: "claim-released-slot",
    });
  });

  test("expired reservations do not block a new claim before the expiry sweep", async () => {
    const { backend, fixture, reviewer } = await deckFixture();
    const command = { eventSlug: fixture.eventSlug, applicationId: fixture.applicationId, clientOperationId: "first-claim" };
    const claim = await reviewer.mutation(api.admissions.claimReview, command);
    await backend.run((ctx) => ctx.db.patch(claim.assignmentId, { assignedAt: Date.now() - admissionReviewClaimMs - 1 }));
    expect((await reviewer.query(api.admissions.reviewDeck, { eventSlug: fixture.eventSlug, now: Date.now() }))?.[0]?.assignment).toBeNull();
    const renewed = await reviewer.mutation(api.admissions.claimReview, { ...command, clientOperationId: "new-claim" });
    expect(renewed.assignmentId).not.toBe(claim.assignmentId);
    expect((await assignmentState(backend, fixture, claim.assignmentId)).assignment?.state).toBe("cancelled");
    expect((await assignmentState(backend, fixture, renewed.assignmentId)).application?.assignedReviewCount).toBe(1);
  });
});

async function deckFixture(reviewAccess: "event" | "none" | "empty" = "event") {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  const reviewerAuth = await createReviewerAuth(backend);
  const managerAuth = await createReviewerAuth(backend);
  const fixture = await seedAssignmentFixture(backend, {
    reviewerAuthUserId: reviewerAuth.authUserId, managerAuthUserId: managerAuth.authUserId,
  });
  await backend.run(async (ctx) => {
    for (const [personId, subjectId] of [
      [fixture.reviewerPersonId, fixture.reviewerSubjectId], [fixture.managerPersonId, fixture.managerSubjectId],
    ] as const) {
      const permissions = reviewAccess === "empty" ? [] : reviewAccess === "none" ? ["application.read"] as const : ["application.read", "application.review"] as const;
      for (const permissionKey of permissions) {
        await insertPermissionGrant(ctx, {
          eventId: fixture.eventId, personId, eventAccessSubjectId: subjectId, permissionKey,
          scopeType: "event", sourceType: "manual", sourceId: `deck:${permissionKey}:${personId}`, reason: "Review deck fixture",
        });
      }
    }
  });
  return {
    backend, fixture,
    reviewer: backend.withIdentity({ subject: reviewerAuth.authUserId, sessionId: reviewerAuth.authSessionId }),
    manager: backend.withIdentity({ subject: managerAuth.authUserId, sessionId: managerAuth.authSessionId }),
  };
}

async function cloneDeckApplications(backend: BackendTest, fixture: AssignmentFixture, count: number) {
  return backend.run(async (ctx) => {
    const application = await ctx.db.get(fixture.applicationId);
    if (!application) throw new Error("Missing deck fixture.");
    const { _id, _creationTime, ...fields } = application;
    const ids = [];
    for (let index = 0; index < count; index += 1) {
      ids.push(await ctx.db.insert("applications", { ...fields, submittedAt: application.submittedAt + index + 1 }));
    }
    return ids;
  });
}

async function emergencyReviewsFixture() {
  const context = await deckFixture("empty");
  const { backend, fixture, manager } = context;
  await backend.run(async (ctx) => {
    for (const permissionKey of [
      "access.permissions.read", "access.permissions.revoke_any",
      "access.permission_bundles.read", "access.permission_bundles.publish", "access.permission_bundles.apply",
    ] as const) {
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId, personId: fixture.managerPersonId,
        eventAccessSubjectId: fixture.managerSubjectId, permissionKey, scopeType: "event",
        sourceType: "manual", sourceId: `emergency-setup:${permissionKey}`, reason: "Prepare emergency review access",
      });
    }
  });
  const command = { eventSlug: fixture.eventSlug, clientOperationId: "create-emergency-reviews" };
  const created = await manager.mutation(api.permissionBundles.createEmergencyReviews, command);
  expect(await manager.mutation(api.permissionBundles.createEmergencyReviews, command)).toEqual(created);
  const bundle = await manager.query(api.permissionBundles.detail, { eventSlug: fixture.eventSlug, bundleId: created.bundleId });
  if (!bundle.published) throw new Error("Emergency Reviews must be ready to assign.");
  expect(bundle.bundle).toMatchObject({ key: "emergency_reviews", label: "Emergency Reviews", defaultRole: "jc" });
  expect(bundle.published.entries).toEqual(expect.arrayContaining([{
    permissionKey: "application.review_deck.use", scopeType: "event", scopeSource: "event", validityRule: "bundle",
  }, {
    permissionKey: "application.profile_context.read", scopeType: "event", scopeSource: "event", validityRule: "bundle",
  }]));
  expect(bundle.published.entries).toHaveLength(2);
  const target = {
    eventSlug: fixture.eventSlug, targetPersonId: fixture.reviewerPersonId,
    bundleVersionId: bundle.published.id, bindings: [],
  };
  const preview = await manager.query(api.permissionBundles.previewApplication, target);
  const applied = await manager.mutation(api.permissionBundles.apply, {
    ...target, expectedAccessVersion: preview.expectedAccessVersion, previewChecksum: preview.previewChecksum,
    reason: "Add the JC to Emergency Reviews", clientOperationId: "apply-emergency-reviews",
  });
  expect(applied.createdCount).toBe(2);
  const grantId = await backend.run(async (ctx) => (await ctx.db.query("permissionGrants")
    .withIndex("by_subject_permission_status", (index) => index
      .eq("eventAccessSubjectId", fixture.reviewerSubjectId)
      .eq("permissionKey", "application.review_deck.use").eq("status", "active"))
    .unique())?._id);
  if (!grantId) throw new Error("Emergency Reviews did not grant its deck permission.");
  return { ...context, grantId };
}

describe("Emergency Reviews bundle", () => {
  test("allows claimed projects, past reviews, and review submission without admissions lists or stats", async () => {
    const { backend, fixture, reviewer } = await emergencyReviewsFixture();
    const [otherId] = await cloneDeckApplications(backend, fixture, 1);
    if (!otherId) throw new Error("Missing second project.");
    await backend.run(async (ctx) => {
      const application = await ctx.db.get(fixture.applicationId);
      if (!application) throw new Error("Missing application.");
      for (const permissionKey of ["integration.read", "project.checkpoint.read"] as const) {
        await insertPermissionGrant(ctx, {
          eventId: fixture.eventId, personId: fixture.reviewerPersonId,
          eventAccessSubjectId: fixture.reviewerSubjectId, permissionKey,
          scopeType: "team", scopeId: application.teamId,
          sourceType: "team_membership", sourceId: "reviewer-participant-team",
          reason: "Keep the reviewer's existing participant team access",
        });
      }
      await ctx.db.patch(application.admissionPolicyVersionId, { minimumHumanReviews: 2 });
      await ctx.db.patch(application._id, { completedReviewCount: 1 });
      await ctx.db.insert("admissionHumanReviews", {
        eventId: fixture.eventId, applicationId: application._id, applicationContentVersion: 1,
        reviewerPersonId: fixture.secondReviewerPersonId, recommendation: "accept", reasonCode: "clear_intent",
        note: "The project addresses a specific campus need.", status: "active", createdAt: Date.now(),
      });
    });
    const query = { eventSlug: fixture.eventSlug };
    const capabilities = await reviewer.query(api.access.operationsCapabilities, query);
    expect(Object.entries(capabilities ?? {}).filter(([, enabled]) => enabled).map(([key]) => key).sort())
      .toEqual(["admissions", "applicationReviewDeck"]);
    expect(await reviewer.query(api.admissions.reviewDeck, { ...query, now: Date.now() })).toHaveLength(2);
    await expect(reviewer.query(api.admissions.detail, { ...query, applicationId: fixture.applicationId })).rejects.toThrow();
    const claim = await reviewer.mutation(api.admissions.claimReview, {
      ...query, applicationId: fixture.applicationId, clientOperationId: "emergency-claim-project",
    });
    const detail = await reviewer.query(api.admissions.detail, { ...query, applicationId: fixture.applicationId });
    expect(detail?.permissions).toEqual({
      deckOnly: true, review: true, assign: false, decide: false, offerManage: false, participantDeliveryRead: false,
    });
    expect(detail?.project.initialIdea).toBeTruthy();
    expect(detail?.humanReviews).toMatchObject([{ own: false, note: "The project addresses a specific campus need." }]);
    expect(detail?.aiRecommendation).toBeNull();
    expect(detail?.currentOffer).toBeNull();
    expect(detail?.capacity).toBeNull();
    expect(detail?.reviewAssignments).toBeUndefined();
    expect(detail?.application.aiDisposition).toBeUndefined();
    const paginationOpts = { cursor: null, numItems: 25 };
    expect((await reviewer.query(api.admissions.list, { ...query, paginationOpts })).page).toEqual([]);
    expect((await reviewer.query(api.admissions.myReviewAssignments, { ...query, state: "active", paginationOpts })).page).toEqual([]);
    expect((await reviewer.query(api.admissions.myReviewAssignmentCountRows, { ...query, paginationOpts })).page).toEqual([]);
    await expect(reviewer.query(api.admissions.admissionSummary, query)).rejects.toThrow();
    await expect(reviewer.query(api.admissions.reviewerWorkload, query)).rejects.toThrow();
    const members = await reviewer.query(api.admissions.members, { ...query, applicationId: fixture.applicationId, paginationOpts });
    expect(members.page).toHaveLength(1);
    expect(members.page[0]?.profileContext).toEqual({
      participantClass: "external_participant", yearOfStudy: "not_applicable", institution: "Fixture institution",
    });
    expect(detail?.application.cohort).toBeDefined();
    await expect(reviewer.query(api.admissions.members, { ...query, applicationId: otherId, paginationOpts })).rejects.toThrow();
    await expect(reviewer.query(api.admissions.detail, { ...query, applicationId: otherId })).rejects.toThrow();
    await expect(reviewer.mutation(api.admissions.saveReview, {
      ...query, applicationId: otherId, expectedApplicationContentVersion: 1,
      recommendation: "accept", reasonCode: "clear_intent", clientOperationId: "unclaimed-emergency-review",
    })).rejects.toThrow();
    const save = {
      ...query, applicationId: fixture.applicationId, expectedApplicationContentVersion: 1,
      recommendation: "accept" as const, reasonCode: "clear_intent", clientOperationId: "save-emergency-review",
    };
    const saved = await reviewer.mutation(api.admissions.saveReview, save);
    expect(await reviewer.mutation(api.admissions.saveReview, save)).toEqual(saved);
    expect((await reviewer.query(api.admissions.detail, { ...query, applicationId: fixture.applicationId }))?.humanReviews).toHaveLength(2);
    expect((await assignmentState(backend, fixture, claim.assignmentId)).assignmentGrants).toEqual([]);
    expect((await reviewer.query(api.admissions.reviewDeck, { ...query, now: Date.now() }))?.map((item) => item.applicationId)).toEqual([otherId]);
    expect(await reviewer.query(api.access.operationsCapabilities, query)).toEqual(capabilities);
  });

  test.each(["revoked", "expired", "claim_expired", "released", "content_changed"] as const)("removes project access when %s", async (change) => {
    const { backend, fixture, reviewer, manager, grantId } = await emergencyReviewsFixture();
    const query = { eventSlug: fixture.eventSlug, applicationId: fixture.applicationId };
    const claim = await reviewer.mutation(api.admissions.claimReview, { ...query, clientOperationId: "emergency-claim-access" });
    const state = await assignmentState(backend, fixture, claim.assignmentId);
    if (!state.application || !state.assignment) throw new Error("Missing claim state.");
    const application = state.application;
    if (change === "revoked") {
      const subject = await backend.run((ctx) => ctx.db.get(fixture.reviewerSubjectId));
      if (!subject) throw new Error("Missing reviewer.");
      await manager.mutation(api.access.revokeBatch, {
        eventSlug: fixture.eventSlug, targetPersonId: fixture.reviewerPersonId, grantIds: [grantId],
        expectedAccessVersion: subject.accessVersion, reason: "Emergency review duty ended", clientOperationId: "end-emergency-review-duty",
      });
    } else if (change === "released") {
      const command = {
        ...query, assignmentId: claim.assignmentId, expectedApplicationVersion: state.application.version,
        expectedAssignmentVersion: state.assignment.version, reason: "Release my emergency review", clientOperationId: "release-emergency-review",
      };
      await expect(manager.mutation(api.admissions.cancelReviewAssignment, command)).rejects.toThrow();
      await reviewer.mutation(api.admissions.cancelReviewAssignment, command);
    } else {
      await backend.run((ctx) => change === "expired"
        ? ctx.db.patch(grantId, { validUntil: Date.now() - 1 })
        : change === "claim_expired"
          ? ctx.db.patch(claim.assignmentId, { assignedAt: Date.now() - admissionReviewClaimMs })
          : ctx.db.patch(fixture.applicationId, { contentVersion: application.contentVersion + 1 }));
    }
    await expect(reviewer.query(api.admissions.detail, query)).rejects.toThrow();
    await expect(reviewer.query(api.admissions.members, { ...query, paginationOpts: { cursor: null, numItems: 25 } })).rejects.toThrow();
    await expect(reviewer.mutation(api.admissions.saveReview, {
      ...query, expectedApplicationContentVersion: 1, recommendation: "accept", reasonCode: "clear_intent", clientOperationId: "review-after-access-ended",
    })).rejects.toThrow();
    if (change === "revoked" || change === "expired") {
      expect(await reviewer.query(api.admissions.reviewDeck, { eventSlug: fixture.eventSlug, now: 0 })).toBeNull();
    }
  });

  test("reviewers cannot create access bundles", async () => {
    const { fixture, reviewer } = await deckFixture("empty");
    await expect(reviewer.mutation(api.permissionBundles.createEmergencyReviews, {
      eventSlug: fixture.eventSlug, clientOperationId: "unprivileged-emergency-setup",
    })).rejects.toThrow();
  });
});

describe("admission review assignments", () => {
  test("origin filters fill pages past assignments and applications from the other origin", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const { authUserId, authSessionId } = await createReviewerAuth(backend);
    const fixture = await seedAssignmentFixture(backend, { reviewerAuthUserId: authUserId });
    const liveRows = await backend.run(async (ctx) => {
      const externalApplication = await ctx.db.get(fixture.applicationId);
      if (!externalApplication) throw new Error("Assignment fixture is incomplete.");
      const externalProject = await ctx.db.get(externalApplication.submittedProjectVersionId);
      if (!externalProject) throw new Error("Assignment fixture project is missing.");
      const internalTeamId = await ctx.db.insert("teams", {
        eventId: fixture.eventId,
        name: "Internal team",
        publicCode: "INTERNAL1",
        leadMembershipId: externalProject.lockedLeadMembershipId,
        status: "submitted",
        activeMemberCount: 1,
        activeVitMemberCount: 1,
        activeExternalMemberCount: 0,
        membershipLocked: true,
        version: 1,
        createdAt: fixture.now - 1,
        updatedAt: fixture.now - 1,
      });
      const { _id: _projectId, _creationTime: _projectCreatedAt, ...projectFields } =
        externalProject;
      const internalProjectId = await ctx.db.insert("projectVersions", {
        ...projectFields,
        teamId: internalTeamId,
        submittedAt: fixture.now - 1,
      });
      const {
        _id: _applicationId,
        _creationTime: _applicationCreatedAt,
        ...applicationFields
      } = externalApplication;
      const internalApplicationId = await ctx.db.insert("applications", {
        ...applicationFields,
        teamId: internalTeamId,
        submittedProjectVersionId: internalProjectId,
        submittedAt: fixture.now - 1,
      });
      const secondExternalTeamId = await ctx.db.insert("teams", {
        eventId: fixture.eventId,
        name: "Second external team",
        publicCode: "EXTERNAL2",
        leadMembershipId: externalProject.lockedLeadMembershipId,
        status: "submitted",
        activeMemberCount: 1,
        activeVitMemberCount: 0,
        activeExternalMemberCount: 1,
        membershipLocked: true,
        version: 1,
        createdAt: fixture.now + 2,
        updatedAt: fixture.now + 2,
      });
      const secondExternalProjectId = await ctx.db.insert("projectVersions", {
        ...projectFields,
        teamId: secondExternalTeamId,
        submittedAt: fixture.now + 2,
      });
      const secondExternalApplicationId = await ctx.db.insert("applications", {
        ...applicationFields,
        teamId: secondExternalTeamId,
        submittedProjectVersionId: secondExternalProjectId,
        submittedAt: fixture.now + 2,
      });
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.reviewerPersonId,
        eventAccessSubjectId: fixture.reviewerSubjectId,
        permissionKey: "application.read",
        scopeType: "event",
        sourceType: "manual",
        sourceId: "fixture-application-read",
        grantedByPersonId: fixture.managerPersonId,
        reason: "Read origin-filter fixtures",
      });
      for (const [applicationId, sourceId] of [
        [fixture.applicationId, "fixture-external-review"],
        [internalApplicationId, "fixture-internal-review"],
        [secondExternalApplicationId, "fixture-second-external-review"],
      ] as const) {
        await insertPermissionGrant(ctx, {
          eventId: fixture.eventId,
          personId: fixture.reviewerPersonId,
          eventAccessSubjectId: fixture.reviewerSubjectId,
          permissionKey: "application.review.read",
          scopeType: "application",
          scopeId: applicationId,
          sourceType: "manual",
          sourceId,
          grantedByPersonId: fixture.managerPersonId,
          reason: "Read origin-filter assignment fixture",
        });
      }
      const secondExternalAssignmentId = await ctx.db.insert("admissionReviewAssignments", {
        eventId: fixture.eventId,
        applicationId: secondExternalApplicationId,
        applicationContentVersion: 1,
        reviewerPersonId: fixture.reviewerPersonId,
        assignedByPersonId: fixture.managerPersonId,
        state: "active",
        version: 1,
        assignedAt: fixture.now + 2,
      });
      await ctx.db.insert("admissionReviewAssignments", {
        eventId: fixture.eventId,
        applicationId: fixture.applicationId,
        applicationContentVersion: 1,
        reviewerPersonId: fixture.reviewerPersonId,
        assignedByPersonId: fixture.managerPersonId,
        state: "active",
        version: 1,
        assignedAt: fixture.now,
      });
      await ctx.db.insert("admissionReviewAssignments", {
        eventId: fixture.eventId,
        applicationId: internalApplicationId,
        applicationContentVersion: 1,
        reviewerPersonId: fixture.reviewerPersonId,
        assignedByPersonId: fixture.managerPersonId,
        state: "active",
        version: 1,
        assignedAt: fixture.now + 1,
      });
      return { secondExternalAssignmentId };
    });
    const reviewer = backend.withIdentity({ subject: authUserId, sessionId: authSessionId });
    const paginationOpts = { cursor: null, numItems: 1 };
    const firstApplications = await reviewer.query(api.admissions.list, {
      eventSlug: fixture.eventSlug,
      state: "submitted",
      origin: "external",
      paginationOpts,
    });
    expect(firstApplications.page.map((application) => application.teamName)).toEqual([
      "Assigned team",
    ]);
    expect(firstApplications.isDone).toBe(false);

    await backend.run((ctx) => ctx.db.patch(fixture.applicationId, { state: "under_review" }));
    const secondApplications = await reviewer.query(api.admissions.list, {
      eventSlug: fixture.eventSlug,
      state: "submitted",
      origin: "external",
      paginationOpts: { cursor: firstApplications.continueCursor, numItems: 1 },
    });
    expect(secondApplications.page.map((application) => application.teamName)).toEqual([
      "Second external team",
    ]);

    const firstAssignments = await reviewer.query(api.admissions.myReviewAssignments, {
      eventSlug: fixture.eventSlug,
      state: "active",
      origin: "external",
      paginationOpts,
    });
    expect(firstAssignments.page.map((assignment) => assignment.teamName)).toEqual([
      "Second external team",
    ]);
    expect(firstAssignments.isDone).toBe(false);

    await backend.run((ctx) =>
      ctx.db.patch(liveRows.secondExternalAssignmentId, { state: "completed" }),
    );
    const secondAssignments = await reviewer.query(api.admissions.myReviewAssignments, {
      eventSlug: fixture.eventSlug,
      state: "active",
      origin: "external",
      paginationOpts: { cursor: firstAssignments.continueCursor, numItems: 1 },
    });
    const assignmentCounts = await reviewAssignmentCounts(reviewer, {
      eventSlug: fixture.eventSlug,
      origin: "external",
    });

    expect(secondAssignments.page.map((assignment) => assignment.teamName)).toEqual([
      "Assigned team",
    ]);
    expect(assignmentCounts).toEqual({ active: 1, completed: 1 });
  });

  test("origin-filtered workload counts hide assignments without review access", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const { authUserId, authSessionId } = await createReviewerAuth(backend);
    const fixture = await seedAssignmentFixture(backend, { reviewerAuthUserId: authUserId });
    await backend.run((ctx) =>
      ctx.db.insert("admissionReviewAssignments", {
        eventId: fixture.eventId,
        applicationId: fixture.applicationId,
        applicationContentVersion: 1,
        reviewerPersonId: fixture.reviewerPersonId,
        assignedByPersonId: fixture.managerPersonId,
        state: "active",
        version: 1,
        assignedAt: fixture.now,
      }),
    );

    const reviewer = backend.withIdentity({ subject: authUserId, sessionId: authSessionId });
    const assignments = await reviewer.query(api.admissions.myReviewAssignments, {
      eventSlug: fixture.eventSlug,
      state: "active",
      origin: "external",
      paginationOpts: { cursor: null, numItems: 100 },
    });
    const assignmentCounts = await reviewAssignmentCounts(reviewer, {
      eventSlug: fixture.eventSlug,
      origin: "external",
    });

    expect(assignments.page).toEqual([]);
    expect(assignmentCounts).toEqual({ active: 0, completed: 0 });
  });

  test("expires unfinished review claims after 30 minutes", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedAssignmentFixture(backend);
    const assigned = await assignFixtureReviewer(backend, fixture, fixture.reviewerSubjectId);
    await backend.run((ctx) =>
      ctx.db.patch(assigned.assignmentId, {
        assignedAt: Date.now() - admissionReviewClaimMs,
      }),
    );

    await backend.mutation(internal.admissions.expireReviewAssignments, {});

    const state = await assignmentState(backend, fixture, assigned.assignmentId);
    expect(state.assignment).toMatchObject({
      state: "cancelled",
      cancellationReason: "The 30-minute review claim expired before a review was submitted.",
    });
    expect(state.application?.assignedReviewCount).toBe(0);
    expect(state.assignmentGrants).toHaveLength(2);
    expect(state.assignmentGrants.every((grant) => grant.status === "revoked")).toBe(true);
  });

  test("does not expire a claim after its review was submitted", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedAssignmentFixture(backend);
    const assigned = await assignFixtureReviewer(backend, fixture, fixture.reviewerSubjectId);
    await saveFixtureReview(backend, fixture, fixture.reviewerPersonId, "accept");
    await backend.run((ctx) =>
      ctx.db.patch(assigned.assignmentId, {
        assignedAt: Date.now() - admissionReviewClaimMs,
      }),
    );

    await backend.mutation(internal.admissions.expireReviewAssignments, {});

    const state = await assignmentState(backend, fixture, assigned.assignmentId);
    expect(state.assignment).toMatchObject({ state: "completed" });
  });

  test("rejects a late review before the next expiry sweep", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedAssignmentFixture(backend);
    await assignFixtureReviewer(backend, fixture, fixture.reviewerSubjectId);

    await expect(
      backend.run(async (ctx) => {
        const application = await ctx.db.get(fixture.applicationId);
        if (!application) throw new Error("Assignment fixture is incomplete.");
        return saveAdmissionHumanReview(ctx, {
          application,
          expectedApplicationContentVersion: 1,
          reviewerPersonId: fixture.reviewerPersonId,
          recommendation: "accept",
          reasonCode: "clear_intent",
          now: fixture.now + admissionReviewClaimMs,
        });
      }),
    ).rejects.toThrow("This 30-minute review assignment expired");
  });

  test("origin counts include matching assignments beyond 4,000 rows", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const { authUserId, authSessionId } = await createReviewerAuth(backend);
    const fixture = await seedAssignmentFixture(backend, { reviewerAuthUserId: authUserId });

    await backend.run(async (ctx) => {
      const externalApplication = await ctx.db.get(fixture.applicationId);
      if (!externalApplication) throw new Error("Assignment fixture is incomplete.");
      const externalTeam = await ctx.db.get(externalApplication.teamId);
      if (!externalTeam) throw new Error("Assignment fixture team is missing.");
      const internalTeamId = await ctx.db.insert("teams", {
        eventId: fixture.eventId,
        name: "Internal count team",
        publicCode: "INTERNALCOUNT",
        leadMembershipId: externalTeam.leadMembershipId,
        status: "submitted",
        activeMemberCount: 1,
        activeVitMemberCount: 1,
        activeExternalMemberCount: 0,
        membershipLocked: true,
        version: 1,
        createdAt: fixture.now,
        updatedAt: fixture.now,
      });
      const {
        _id: _applicationId,
        _creationTime: _applicationCreatedAt,
        ...applicationFields
      } = externalApplication;
      const internalApplicationId = await ctx.db.insert("applications", {
        ...applicationFields,
        teamId: internalTeamId,
        submittedAt: fixture.now + 4_002,
      });
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.reviewerPersonId,
        eventAccessSubjectId: fixture.reviewerSubjectId,
        permissionKey: "application.review.read",
        scopeType: "application",
        scopeId: internalApplicationId,
        sourceType: "manual",
        sourceId: "fixture-internal-count-review",
        grantedByPersonId: fixture.managerPersonId,
        reason: "Read internal count assignment fixture",
      });
      for (let index = 0; index < 4_001; index += 1) {
        await ctx.db.insert("admissionReviewAssignments", {
          eventId: fixture.eventId,
          applicationId: fixture.applicationId,
          applicationContentVersion: 1,
          reviewerPersonId: fixture.reviewerPersonId,
          assignedByPersonId: fixture.managerPersonId,
          state: "active",
          version: 1,
          assignedAt: fixture.now + index,
        });
      }
      await ctx.db.insert("admissionReviewAssignments", {
        eventId: fixture.eventId,
        applicationId: internalApplicationId,
        applicationContentVersion: 1,
        reviewerPersonId: fixture.reviewerPersonId,
        assignedByPersonId: fixture.managerPersonId,
        state: "active",
        version: 1,
        assignedAt: fixture.now + 4_001,
      });
    });

    const reviewer = backend.withIdentity({ subject: authUserId, sessionId: authSessionId });
    await expect(
      reviewAssignmentCounts(reviewer, {
        eventSlug: fixture.eventSlug,
        origin: "internal",
      }),
    ).resolves.toEqual({ active: 1, completed: 0 });
  });

  test("keeps routing, profile context, and AI analysis behind separate exact scopes", () => {
    expect(permissionCatalog["application.review.read"]).toEqual({
      scopes: ["application"],
      eventWide: true,
    });
    expect(permissionCatalog["application.review"]).toEqual({
      scopes: ["application"],
      eventWide: true,
    });
    expect(permissionCatalog["application.assign"]).toEqual({
      scopes: ["application"],
      eventWide: true,
    });
    expect(permissionCatalog["application.profile_context.read"]).toEqual({
      scopes: ["application"],
      eventWide: true,
    });
    expect(permissionCatalog["application.ai_recommendation.read"]).toEqual({
      scopes: ["application"],
      eventWide: true,
    });
    expect(permissionCatalog["application.ai_recommendation.run"]).toEqual({
      scopes: ["application"],
      eventWide: true,
    });
  });

  test("opens the last review with the immutable idea version it reviewed", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const authUserId = await createAuthUser(backend);
    const authSessionId = await createAuthSession(backend, authUserId);
    const fixture = await seedAssignmentFixture(backend, { managerAuthUserId: authUserId });
    const assigned = await assignFixtureReviewer(backend, fixture, fixture.reviewerSubjectId);

    await backend.run(async (ctx) => {
      const application = await ctx.db.get(fixture.applicationId);
      if (!application) throw new Error("Assignment fixture is incomplete.");
      await saveAdmissionHumanReview(ctx, {
        application,
        expectedApplicationContentVersion: 1,
        reviewerPersonId: fixture.reviewerPersonId,
        recommendation: "accept",
        reasonCode: "clear_intent",
        note: "The first review note.",
        now: fixture.now + 1,
      });
    });
    const lastReview = await backend.run(async (ctx) => {
      const application = await ctx.db.get(fixture.applicationId);
      if (!application) throw new Error("Assignment fixture is incomplete.");
      return saveAdmissionHumanReview(ctx, {
        application,
        expectedApplicationContentVersion: 1,
        reviewerPersonId: fixture.reviewerPersonId,
        recommendation: "waitlist",
        reasonCode: "clear_intent",
        note: "The later review note.",
        now: fixture.now + 2,
      });
    });

    await backend.run(async (ctx) => {
      const [application, currentProject] = await Promise.all([
        ctx.db.get(fixture.applicationId),
        ctx.db
          .query("projectVersions")
          .withIndex("by_team_version", (index) => index.eq("teamId", fixture.teamId))
          .order("desc")
          .first(),
      ]);
      if (!application || !currentProject) {
        throw new Error("Assignment fixture is incomplete.");
      }
      const revisedProjectId = await ctx.db.insert("projectVersions", {
        eventId: currentProject.eventId,
        teamId: currentProject.teamId,
        version: currentProject.version + 1,
        initialIdea: "A revised fixture project.",
        intakePolicyVersionId: currentProject.intakePolicyVersionId,
        intakeResponses: currentProject.intakeResponses,
        lockedRosterSnapshotId: currentProject.lockedRosterSnapshotId,
        lockedMemberCount: currentProject.lockedMemberCount,
        lockedLeadMembershipId: currentProject.lockedLeadMembershipId,
        freshForEventAttestation: currentProject.freshForEventAttestation,
        finalConfirmation: currentProject.finalConfirmation,
        participantPolicyVersionId: currentProject.participantPolicyVersionId,
        admissionPolicyVersionId: currentProject.admissionPolicyVersionId,
        proposalRevision: {
          sourceProjectVersionId: currentProject._id,
          editedByMembershipId: currentProject.submittedByMembershipId,
          editedAt: fixture.now + 3,
        },
        sourceDraftVersion: currentProject.sourceDraftVersion + 1,
        submittedByMembershipId: currentProject.submittedByMembershipId,
        submittedAt: fixture.now + 3,
      });
      const activeReviews = await ctx.db
        .query("admissionHumanReviews")
        .withIndex("by_application_status", (index) =>
          index.eq("applicationId", fixture.applicationId).eq("status", "active"),
        )
        .collect();
      await Promise.all([
        ...activeReviews.map((review) => ctx.db.patch(review._id, { status: "superseded" })),
        ctx.db.patch(fixture.applicationId, {
          submittedProjectVersionId: revisedProjectId,
          contentVersion: 2,
          completedReviewCount: 0,
          version: application.version + 1,
        }),
        insertPermissionGrant(ctx, {
          eventId: fixture.eventId,
          personId: fixture.managerPersonId,
          eventAccessSubjectId: fixture.managerSubjectId,
          permissionKey: "application.read",
          scopeType: "application",
          scopeId: fixture.applicationId,
          sourceType: "manual",
          sourceId: "historical-review-test",
          grantedByPersonId: fixture.managerPersonId,
          reason: "Read historical review evidence",
        }),
        insertPermissionGrant(ctx, {
          eventId: fixture.eventId,
          personId: fixture.managerPersonId,
          eventAccessSubjectId: fixture.managerSubjectId,
          permissionKey: "application.assign",
          scopeType: "application",
          scopeId: fixture.applicationId,
          sourceType: "manual",
          sourceId: "historical-review-assignment-test",
          grantedByPersonId: fixture.managerPersonId,
          reason: "Inspect review assignments",
        }),
      ]);
    });

    const manager = backend.withIdentity({ subject: authUserId, sessionId: authSessionId });
    const detail = await manager.query(api.admissions.detail, {
      eventSlug: fixture.eventSlug,
      applicationId: fixture.applicationId,
    });
    const evidence = await manager.query(api.admissions.reviewAssignmentEvidence, {
      eventSlug: fixture.eventSlug,
      applicationId: fixture.applicationId,
      assignmentId: assigned.assignmentId,
    });

    expect(
      detail?.reviewAssignments?.find((assignment) => assignment.id === assigned.assignmentId),
    ).toMatchObject({ evidenceAvailable: true });
    expect(evidence).toMatchObject({
      applicationContentVersion: 1,
      project: {
        version: 1,
        initialIdea: "A fixture project.",
      },
      review: {
        id: lastReview.reviewId,
        recommendation: "waitlist",
        note: "The later review note.",
      },
    });
  });

  test("assigning one active event account creates only exact review access", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedAssignmentFixture(backend);

    const result = await backend.run(async (ctx) => {
      const [application, reviewerSubject] = await Promise.all([
        ctx.db.get(fixture.applicationId),
        ctx.db.get(fixture.reviewerSubjectId),
      ]);
      if (!application || !reviewerSubject) throw new Error("Assignment fixture is incomplete.");
      return createAdmissionReviewAssignment(ctx, {
        application,
        expectedApplicationVersion: 1,
        reviewerSubject,
        assignedByPersonId: fixture.managerPersonId,
        grantReviewPermissions: true,
        now: fixture.now,
      });
    });

    const state = await assignmentState(backend, fixture, result.assignmentId);
    expect(result).toEqual({
      assignmentId: result.assignmentId,
      assignmentVersion: 1,
      applicationVersion: 2,
    });
    expect(state.application).toMatchObject({
      state: "under_review",
      assignedReviewCount: 1,
      completedReviewCount: 0,
      version: 2,
    });
    expect(state.assignment).toMatchObject({
      reviewerPersonId: fixture.reviewerPersonId,
      state: "active",
      version: 1,
    });
    expect(state.assignmentGrants).toHaveLength(2);
    expect(state.assignmentGrants.map((grant) => grant.permissionKey).sort()).toEqual([
      "application.review",
      "application.review.read",
    ]);
    expect(
      state.assignmentGrants.every(
        (grant) =>
          grant.status === "active" &&
          grant.scopeType === "application" &&
          grant.scopeId === fixture.applicationId,
      ),
    ).toBe(true);
    expect(state.reviewerSubject?.accessVersion).toBe(2);
  });

  test.each([
    { minimumHumanReviews: 1, completedReviews: 1 },
    { minimumHumanReviews: 2, completedReviews: 2 },
    { minimumHumanReviews: 1, completedReviews: 2 },
  ])("rejects assignments after $completedReviews reviews meet a minimum of $minimumHumanReviews", async ({ minimumHumanReviews, completedReviews }) => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const authUserId = await createAuthUser(backend);
    const authSessionId = await createAuthSession(backend, authUserId);
    const fixture = await seedAssignmentFixture(backend, { managerAuthUserId: authUserId });
    await backend.run(async (ctx) => {
      const application = await ctx.db.get(fixture.applicationId);
      if (!application) throw new Error("Assignment fixture is incomplete.");
      await ctx.db.patch(application.admissionPolicyVersionId, { minimumHumanReviews });
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.managerPersonId,
        eventAccessSubjectId: fixture.managerSubjectId,
        permissionKey: "application.assign",
        scopeType: "application",
        scopeId: fixture.applicationId,
        sourceType: "manual",
        sourceId: "review-coverage-test",
        grantedByPersonId: fixture.managerPersonId,
        reason: "Assign review coverage fixtures",
      });
    });
    for (const reviewer of [fixture.secondReviewerPersonId, fixture.managerPersonId].slice(0, completedReviews)) {
      await saveFixtureReview(backend, fixture, reviewer, "accept");
    }
    const manager = backend.withIdentity({ subject: authUserId, sessionId: authSessionId });
    const before = await backend.run((ctx) => ctx.db.get(fixture.applicationId));
    if (!before) throw new Error("Assignment fixture is incomplete.");

    await expect(manager.mutation(api.admissions.assignReview, {
      eventSlug: fixture.eventSlug,
      applicationId: fixture.applicationId,
      expectedApplicationVersion: before.version,
      reviewerEmail: "reviewer@example.test",
      clientOperationId: crypto.randomUUID(),
    })).rejects.toThrow("This application has already met its human review minimum.");

    const after = await backend.run(async (ctx) => ({
      application: await ctx.db.get(fixture.applicationId),
      assignments: await ctx.db.query("admissionReviewAssignments").collect(),
      grants: await ctx.db.query("permissionGrants")
        .withIndex("by_source", (index) => index.eq("eventId", fixture.eventId).eq("sourceType", "application_assignment"))
        .collect(),
      reviewer: await ctx.db.get(fixture.reviewerSubjectId),
    }));
    expect(after.application).toEqual(before);
    expect(after.assignments).toEqual([]);
    expect(after.grants).toEqual([]);
    expect(after.reviewer?.accessVersion).toBe(1);
  });

  test("allows assigning the remaining review required by the application policy", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedAssignmentFixture(backend);
    await backend.run(async (ctx) => {
      const application = await ctx.db.get(fixture.applicationId);
      if (!application) throw new Error("Assignment fixture is incomplete.");
      await ctx.db.patch(application.admissionPolicyVersionId, { minimumHumanReviews: 2 });
    });
    await saveFixtureReview(backend, fixture, fixture.secondReviewerPersonId, "accept");

    const result = await assignFixtureReviewer(backend, fixture, fixture.reviewerSubjectId, 2);
    const state = await assignmentState(backend, fixture, result.assignmentId);
    expect(state.assignment).toMatchObject({ state: "active" });
    expect(state.application).toMatchObject({ completedReviewCount: 1, assignedReviewCount: 1 });
  });

  test("cancelling pending work revokes only assignment-sourced grants", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedAssignmentFixture(backend);
    const assignment = await backend.run(async (ctx) => {
      const [application, reviewerSubject] = await Promise.all([
        ctx.db.get(fixture.applicationId),
        ctx.db.get(fixture.reviewerSubjectId),
      ]);
      if (!application || !reviewerSubject) throw new Error("Assignment fixture is incomplete.");
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.reviewerPersonId,
        eventAccessSubjectId: fixture.reviewerSubjectId,
        permissionKey: "application.review",
        scopeType: "application",
        scopeId: fixture.applicationId,
        sourceType: "manual",
        sourceId: "fixture-manual-review",
        grantedByPersonId: fixture.managerPersonId,
        reason: "Independent direct grant",
      });
      return createAdmissionReviewAssignment(ctx, {
        application,
        expectedApplicationVersion: 1,
        reviewerSubject,
        assignedByPersonId: fixture.managerPersonId,
        grantReviewPermissions: true,
        now: fixture.now,
      });
    });

    await backend.run(async (ctx) => {
      const [application, assignmentRow] = await Promise.all([
        ctx.db.get(fixture.applicationId),
        ctx.db.get(assignment.assignmentId),
      ]);
      if (!application || !assignmentRow) throw new Error("Assignment fixture is incomplete.");
      await cancelAdmissionReviewAssignment(ctx, {
        application,
        expectedApplicationVersion: 2,
        assignment: assignmentRow,
        expectedAssignmentVersion: 1,
        cancelledByPersonId: fixture.managerPersonId,
        reason: "Reviewer is unavailable",
        now: fixture.now + 1,
      });
    });

    const state = await assignmentState(backend, fixture, assignment.assignmentId);
    expect(state.application).toMatchObject({
      assignedReviewCount: 0,
      completedReviewCount: 0,
      version: 3,
    });
    expect(state.assignment).toMatchObject({
      state: "cancelled",
      version: 2,
      cancellationReason: "Reviewer is unavailable",
    });
    expect(state.assignmentGrants.every((grant) => grant.status === "revoked")).toBe(true);
    expect(state.manualGrants).toHaveLength(1);
    expect(state.manualGrants[0]).toMatchObject({
      permissionKey: "application.review",
      status: "active",
    });
    expect(state.reviewerSubject?.accessVersion).toBe(3);
  });

  test("saving and replacing a review keeps one completion and preserves routed read access", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedAssignmentFixture(backend);
    const assigned = await assignFixtureReviewer(backend, fixture, fixture.reviewerSubjectId);

    const firstReview = await backend.run(async (ctx) => {
      const application = await ctx.db.get(fixture.applicationId);
      if (!application) throw new Error("Assignment fixture is incomplete.");
      return saveAdmissionHumanReview(ctx, {
        application,
        expectedApplicationContentVersion: 1,
        reviewerPersonId: fixture.reviewerPersonId,
        recommendation: "accept",
        reasonCode: "clear_intent",
        note: "The intent is clear.",
        now: fixture.now + 1,
      });
    });
    await backend.run(async (ctx) => {
      const application = await ctx.db.get(fixture.applicationId);
      if (!application) throw new Error("Assignment fixture is incomplete.");
      await saveAdmissionHumanReview(ctx, {
        application,
        expectedApplicationContentVersion: 1,
        reviewerPersonId: fixture.reviewerPersonId,
        recommendation: "waitlist",
        reasonCode: "clear_intent",
        note: "The intent is clear, but one detail remains.",
        now: fixture.now + 2,
      });
    });

    const state = await assignmentState(backend, fixture, assigned.assignmentId);
    expect(state.assignment).toMatchObject({
      state: "completed",
      version: 2,
      completedAt: fixture.now + 1,
    });
    expect(state.assignmentGrants.every((grant) => grant.status === "active")).toBe(true);
    expect(state.application).toMatchObject({
      assignedReviewCount: 1,
      completedReviewCount: 1,
      version: 4,
    });
    const reviews = await backend.run((ctx) =>
      ctx.db
        .query("admissionHumanReviews")
        .withIndex("by_application_reviewer_status", (index) =>
          index
            .eq("applicationId", fixture.applicationId)
            .eq("reviewerPersonId", fixture.reviewerPersonId),
        )
        .collect(),
    );
    expect(reviews).toHaveLength(2);
    expect(reviews.find((review) => review._id === firstReview.reviewId)?.status).toBe(
      "superseded",
    );
    expect(reviews.find((review) => review.status === "active")).toMatchObject({
      recommendation: "waitlist",
      applicationContentVersion: 1,
    });
  });

  test.each([
    "accepted",
    "offer_sent",
    "confirmed",
    "waitlisted",
    "declined",
    "offer_expired",
    "withdrawn",
  ] as const)("rejects ordinary review writes after the application becomes %s", async (state) => {
    const backend = convexTest(schema, modules);
    const fixture = await seedAssignmentFixture(backend);
    await backend.run((ctx) => ctx.db.patch(fixture.applicationId, { state }));

    await expect(
      saveFixtureReview(backend, fixture, fixture.reviewerPersonId, "accept"),
    ).rejects.toThrow("This application no longer accepts ordinary reviews.");
  });

  test("two stale managers cannot both cross one application version", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedAssignmentFixture(backend);
    const attempts = await Promise.allSettled([
      assignFixtureReviewer(backend, fixture, fixture.reviewerSubjectId),
      assignFixtureReviewer(backend, fixture, fixture.secondReviewerSubjectId),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const state = await backend.run(async (ctx) => ({
      application: await ctx.db.get(fixture.applicationId),
      assignments: await ctx.db
        .query("admissionReviewAssignments")
        .withIndex("by_application_state_assigned", (index) =>
          index.eq("applicationId", fixture.applicationId).eq("state", "active"),
        )
        .collect(),
    }));
    expect(state.application).toMatchObject({ assignedReviewCount: 1, version: 2 });
    expect(state.assignments).toHaveLength(1);
  });

  test("independent reviewers can submit together without losing a completion", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedAssignmentFixture(backend);
    await assignFixtureReviewer(backend, fixture, fixture.reviewerSubjectId, 1);
    await assignFixtureReviewer(backend, fixture, fixture.secondReviewerSubjectId, 2);

    await Promise.all([
      saveFixtureReview(backend, fixture, fixture.reviewerPersonId, "accept"),
      saveFixtureReview(backend, fixture, fixture.secondReviewerPersonId, "waitlist"),
    ]);

    const state = await backend.run(async (ctx) => ({
      application: await ctx.db.get(fixture.applicationId),
      assignments: await ctx.db
        .query("admissionReviewAssignments")
        .withIndex("by_application_state_assigned", (index) =>
          index.eq("applicationId", fixture.applicationId).eq("state", "completed"),
        )
        .collect(),
      reviews: await ctx.db
        .query("admissionHumanReviews")
        .withIndex("by_application_status", (index) =>
          index.eq("applicationId", fixture.applicationId).eq("status", "active"),
        )
        .collect(),
    }));
    expect(state.application).toMatchObject({
      assignedReviewCount: 2,
      completedReviewCount: 2,
      version: 5,
    });
    expect(state.assignments).toHaveLength(2);
    expect(state.reviews).toHaveLength(2);
  });

  test("counts current human recommendations as accept, waitlist, and reject totals", () => {
    expect(
      countHumanReviewScore(
        [
          { applicationContentVersion: 1, recommendation: "accept" },
          { applicationContentVersion: 1, recommendation: "accept" },
          { applicationContentVersion: 1, recommendation: "accept" },
          { applicationContentVersion: 1, recommendation: "waitlist" },
          { applicationContentVersion: 1, recommendation: "decline" },
          { applicationContentVersion: 0, recommendation: "accept" },
        ],
        1,
      ),
    ).toEqual({ accept: 3, waitlist: 1, reject: 1 });
  });
});

type AssignmentFixture = Awaited<ReturnType<typeof seedAssignmentFixture>>;

async function assignFixtureReviewer(
  backend: BackendTest,
  fixture: AssignmentFixture,
  reviewerSubjectId: Id<"eventAccessSubjects">,
  expectedApplicationVersion = 1,
) {
  return backend.run(async (ctx) => {
    const [application, reviewerSubject] = await Promise.all([
      ctx.db.get(fixture.applicationId),
      ctx.db.get(reviewerSubjectId),
    ]);
    if (!application || !reviewerSubject) throw new Error("Assignment fixture is incomplete.");
    return createAdmissionReviewAssignment(ctx, {
      application,
      expectedApplicationVersion,
      reviewerSubject,
      assignedByPersonId: fixture.managerPersonId,
      grantReviewPermissions: true,
      now: fixture.now,
    });
  });
}

async function saveFixtureReview(
  backend: BackendTest,
  fixture: AssignmentFixture,
  reviewerPersonId: Id<"people">,
  recommendation: "accept" | "waitlist",
) {
  return backend.run(async (ctx) => {
    const application = await ctx.db.get(fixture.applicationId);
    if (!application) throw new Error("Assignment fixture is incomplete.");
    return saveAdmissionHumanReview(ctx, {
      application,
      expectedApplicationContentVersion: 1,
      reviewerPersonId,
      recommendation,
      reasonCode: "clear_intent",
      now: fixture.now + 1,
    });
  });
}

async function assignmentState(
  backend: BackendTest,
  fixture: AssignmentFixture,
  assignmentId: Id<"admissionReviewAssignments">,
) {
  return backend.run(async (ctx) => ({
    application: await ctx.db.get(fixture.applicationId),
    assignment: await ctx.db.get(assignmentId),
    reviewerSubject: await ctx.db.get(fixture.reviewerSubjectId),
    assignmentGrants: await ctx.db
      .query("permissionGrants")
      .withIndex("by_source", (index) =>
        index
          .eq("eventId", fixture.eventId)
          .eq("sourceType", "application_assignment")
          .eq("sourceId", assignmentId),
      )
      .collect(),
    manualGrants: await ctx.db
      .query("permissionGrants")
      .withIndex("by_source", (index) =>
        index
          .eq("eventId", fixture.eventId)
          .eq("sourceType", "manual")
          .eq("sourceId", "fixture-manual-review"),
      )
      .collect(),
  }));
}

async function seedAssignmentFixture(
  backend: BackendTest,
  auth: { managerAuthUserId?: string; reviewerAuthUserId?: string } = {},
) {
  const now = Date.UTC(2027, 1, 2, 3, 4, 5);
  const eventSlug = `assignment-${now}-${crypto.randomUUID()}`;
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Assignment fixture",
      timezone: "Asia/Kolkata",
      status: "registration_closed",
      vitEmailDomains: ["vitstudent.ac.in"],
      applicationsCloseAt: Date.now() + 86_400_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const managerPersonId = await insertPerson(ctx, "manager", now, auth.managerAuthUserId);
    const reviewerPersonId = await insertPerson(ctx, "reviewer", now, auth.reviewerAuthUserId);
    const secondReviewerPersonId = await insertPerson(ctx, "reviewer-two", now);
    const leadPersonId = await insertPerson(ctx, "lead", now);
    const participantPolicyId = await ctx.db.insert("participantPolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...defaultParticipantPolicy,
      checksum: participantPolicyChecksum(defaultParticipantPolicy),
      createdByPersonId: managerPersonId,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.patch(eventId, { publishedParticipantPolicyId: participantPolicyId });
    const managerSubjectId = await insertSubject(ctx, eventId, managerPersonId, "manager", now);
    const reviewerSubjectId = await insertSubject(ctx, eventId, reviewerPersonId, "reviewer", now);
    const secondReviewerSubjectId = await insertSubject(
      ctx,
      eventId,
      secondReviewerPersonId,
      "reviewer-two",
      now,
    );
    const leadSubjectId = await insertSubject(ctx, eventId, leadPersonId, "lead", now);
    const membershipId = await ctx.db.insert("eventMemberships", {
      eventId,
      personId: leadPersonId,
      eventAccessSubjectId: leadSubjectId,
      participantClass: "external_participant",
      eligibilityStatus: "eligible",
      onboardingStatus: "submitted",
      acceptedParticipantPolicyVersionIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const teamId = await ctx.db.insert("teams", {
      eventId,
      name: "Assigned team",
      publicCode: "ASSIGNED1",
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
    const intakePolicyId = await ctx.db.insert("intakePolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      openingText: "Hello.",
      initialPrompt: "What is your project about?",
      initialHelpText: "Describe the project.",
      initialIdeaMinLength: 1,
      initialIdeaMaxLength: 1_000,
      followUpAnswerMinLength: 1,
      followUpAnswerMaxLength: 500,
      minimumFollowUpCount: 2,
      maximumFollowUpCount: 2,
      deterministicFollowUpCount: 1,
      questionMaxLength: 160,
      allowedPurposeKeys: ["user"],
      fallbackQuestions: [],
      blockedTerms: [],
      commonIdeaPatterns: [],
      model: { mode: "deterministic" },
      checksum: "intake-checksum",
      createdByPersonId: managerPersonId,
      createdAt: now,
      publishedAt: now,
    });
    const policyId = await ctx.db.insert("admissionPolicyVersions", {
      eventId,
      version: "admission-v1",
      status: "published",
      aiRecommendationMode: "disabled",
      minimumHumanReviews: 1,
      overallParticipantCapacity: 100,
      criteria: [],
      decisionReasonCodes: [
        {
          key: "clear_intent",
          label: "Clear intent",
          allowedDecisions: ["accept", "waitlist", "decline"],
        },
      ],
      checksum: "admission-checksum",
      createdByPersonId: managerPersonId,
      createdAt: now,
      publishedAt: now,
    });
    const lockedRosterSnapshotId = await createTestSubmissionSnapshot(ctx, {
      eventId,
      teamId,
      teamMemberIds: [teamMemberId],
      intakePolicyVersionId: intakePolicyId,
      participantPolicyVersionId: participantPolicyId,
      admissionPolicyVersionId: policyId,
      submittedAt: now,
    });
    const projectId = await ctx.db.insert("projectVersions", {
      eventId,
      teamId,
      version: 1,
      initialIdea: "A fixture project.",
      intakePolicyVersionId: intakePolicyId,
      intakeResponses: [],
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
      admissionPolicyVersionId: policyId,
      sourceDraftVersion: 1,
      submittedByMembershipId: membershipId,
      submittedAt: now,
    });
    const applicationId = await ctx.db.insert("applications", {
      eventId,
      teamId,
      submittedProjectVersionId: projectId,
      admissionPolicyVersionId: policyId,
      state: "submitted",
      decisionStage: "unrecorded",
      experienceBand: "mixed_or_external",
      assignedReviewCount: 0,
      completedReviewCount: 0,
      contentVersion: 1,
      version: 1,
      submittedAt: now,
    });
    return {
      now,
      eventSlug,
      eventId,
      teamId,
      applicationId,
      managerPersonId,
      managerSubjectId,
      reviewerPersonId,
      reviewerSubjectId,
      secondReviewerPersonId,
      secondReviewerSubjectId,
    };
  });
}

async function reviewAssignmentCounts(
  reviewer: ReviewerClient,
  args: { eventSlug: string; origin?: "internal" | "external" },
) {
  const totals = { active: 0, completed: 0 };
  let cursor: string | null = null;
  for (;;) {
    const page: ReviewAssignmentCountPage = await reviewer.query(
      api.admissions.myReviewAssignmentCountRows,
      {
        eventSlug: args.eventSlug,
        ...(args.origin === undefined ? {} : { origin: args.origin }),
        paginationOpts: { cursor, numItems: 100 },
      },
    );
    for (const row of page.page) totals[row.state] += 1;
    if (page.isDone) return totals;
    cursor = page.continueCursor;
  }
}

function insertPerson(ctx: MutationCtx, key: string, now: number, authUserId?: string) {
  return ctx.db.insert("people", {
    authUserId: authUserId ?? `auth-${key}`,
    googleSubject: `google-${key}`,
    verifiedEmail: `${key}@example.test`,
    displayName: key,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
}

async function createAuthUser(backend: BackendTest) {
  const now = Date.now();
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Assignment manager",
        email: `assignment-manager-${crypto.randomUUID()}@example.test`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  return documentId(result, "Better Auth user");
}

async function createAuthSession(backend: BackendTest, userId: string) {
  const now = Date.now();
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        expiresAt: now + 60 * 60 * 1_000,
        token: `assignment-manager-${crypto.randomUUID()}`,
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

async function createReviewerAuth(backend: BackendTest) {
  const authUserId = await createAuthUser(backend);
  const authSessionId = await createAuthSession(backend, authUserId);
  return { authUserId, authSessionId };
}

function insertSubject(
  ctx: MutationCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
  key: string,
  now: number,
) {
  return ctx.db.insert("eventAccessSubjects", {
    eventId,
    personId,
    emailNormalized: `${key}@example.test`,
    displayName: key,
    status: "active",
    linkedBy: "access_invitation",
    accessVersion: 1,
    createdAt: now,
    updatedAt: now,
  });
}
