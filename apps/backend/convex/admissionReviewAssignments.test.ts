import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, components } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import {
  cancelAdmissionReviewAssignment,
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

describe("admission review assignments", () => {
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
    const fixture = await seedAssignmentFixture(backend, authUserId);
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

async function seedAssignmentFixture(backend: BackendTest, managerAuthUserId?: string) {
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
    const managerPersonId = await insertPerson(ctx, "manager", now, managerAuthUserId);
    const reviewerPersonId = await insertPerson(ctx, "reviewer", now);
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
