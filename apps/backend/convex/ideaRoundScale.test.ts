import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import {
  createAdmissionReviewAssignment,
  saveAdmissionHumanReview,
} from "./admissions.ts";
import {
  defaultParticipantPolicy,
  participantPolicyChecksum,
} from "./lib/participantPolicy.ts";
import { insertPermissionGrant } from "./lib/permissions.ts";
import {
  createTestSubmissionSnapshot,
  linkTestSubmissionSnapshot,
} from "./lib/testSubmissionSnapshot.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

const teamCount = 300;
const scCount = 8;
const jcCount = 24;

describe("idea submission round scale rehearsal", () => {
  test("routes 300 submitted teams through exact SC and JC review scopes", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedScaleFixture(backend);

    await Promise.all(fixture.applications.map((application, index) =>
      backend.run(async (ctx) => {
        const sc = fixture.scReviewers[index % fixture.scReviewers.length];
        const jc = fixture.jcReviewers[index % fixture.jcReviewers.length];
        if (!sc || !jc) throw new Error("The SC and JC rehearsal roster is incomplete.");
        const [applicationRow, scSubject, jcSubject] = await Promise.all([
          ctx.db.get(application.applicationId),
          ctx.db.get(sc.subjectId),
          ctx.db.get(jc.subjectId),
        ]);
        if (!applicationRow || !scSubject || !jcSubject) {
          throw new Error("The admission routing rehearsal fixture is incomplete.");
        }
        const scAssignment = await createAdmissionReviewAssignment(ctx, {
          application: applicationRow,
          expectedApplicationVersion: 1,
          reviewerSubject: scSubject,
          assignedByPersonId: fixture.scReviewers[0]?.personId ?? sc.personId,
          now: fixture.now + index,
        });
        const afterSc = await ctx.db.get(application.applicationId);
        if (!afterSc) throw new Error("The application disappeared during SC routing.");
        const jcAssignment = await createAdmissionReviewAssignment(ctx, {
          application: afterSc,
          expectedApplicationVersion: scAssignment.applicationVersion,
          reviewerSubject: jcSubject,
          assignedByPersonId: fixture.scReviewers[0]?.personId ?? sc.personId,
          now: fixture.now + index,
        });
        return { scAssignment, jcAssignment };
      }),
    ));

    await Promise.all(fixture.applications.map((application, index) =>
      backend.run(async (ctx) => {
        const sc = fixture.scReviewers[index % fixture.scReviewers.length];
        const jc = fixture.jcReviewers[index % fixture.jcReviewers.length];
        if (!sc || !jc) throw new Error("The SC and JC rehearsal roster is incomplete.");
        const beforeSc = await ctx.db.get(application.applicationId);
        if (!beforeSc) throw new Error("The application disappeared before SC review.");
        await saveAdmissionHumanReview(ctx, {
          application: beforeSc,
          expectedApplicationContentVersion: 1,
          reviewerPersonId: sc.personId,
          recommendation: index % 5 === 0 ? "waitlist" : "accept",
          reasonCode: "round_rehearsal",
          note: `SC review for deterministic team ${index + 1}.`,
          now: fixture.now + teamCount + index,
        });
        const beforeJc = await ctx.db.get(application.applicationId);
        if (!beforeJc) throw new Error("The application disappeared before JC review.");
        await saveAdmissionHumanReview(ctx, {
          application: beforeJc,
          expectedApplicationContentVersion: 1,
          reviewerPersonId: jc.personId,
          recommendation: index % 7 === 0 ? "decline" : "accept",
          reasonCode: "round_rehearsal",
          note: `JC review for deterministic team ${index + 1}.`,
          now: fixture.now + (teamCount * 2) + index,
        });
      }),
    ));

    const state = await backend.run(async (ctx) => {
      const [applications, assignments, reviews, grants, roles] = await Promise.all([
        ctx.db.query("applications").collect(),
        ctx.db.query("admissionReviewAssignments").collect(),
        ctx.db.query("admissionHumanReviews").collect(),
        ctx.db.query("permissionGrants").collect(),
        ctx.db.query("eventRoles").collect(),
      ]);
      return { applications, assignments, reviews, grants, roles };
    });

    expect(state.applications).toHaveLength(teamCount);
    expect(state.applications.every((application) => (
      application.state === "under_review" &&
      application.assignedReviewCount === 2 &&
      application.completedReviewCount === 2 &&
      application.version === 5
    ))).toBe(true);
    expect(state.assignments).toHaveLength(teamCount * 2);
    expect(state.assignments.every((assignment) => (
      assignment.state === "completed" && assignment.version === 2
    ))).toBe(true);
    expect(state.reviews).toHaveLength(teamCount * 2);
    expect(state.reviews.every((review) => (
      review.status === "active" && review.applicationContentVersion === 1
    ))).toBe(true);

    const assignmentGrants = state.grants.filter(
      (grant) => grant.sourceType === "application_assignment",
    );
    expect(assignmentGrants).toHaveLength(teamCount * 4);
    expect(assignmentGrants.every((grant) => (
      grant.status === "active" &&
      grant.scopeType === "application" &&
      grant.scopeId !== undefined &&
      (grant.permissionKey === "application.review" ||
        grant.permissionKey === "application.review.read")
    ))).toBe(true);

    expect(state.roles.filter((role) => role.role === "sc")).toHaveLength(scCount);
    expect(state.roles.filter((role) => role.role === "jc")).toHaveLength(jcCount);
    const jcPersonIds = new Set(fixture.jcReviewers.map((reviewer) => reviewer.personId));
    expect(state.grants.some((grant) => (
      jcPersonIds.has(grant.personId) && grant.permissionKey === "application.decide"
    ))).toBe(false);
    const scDecisionGrants = state.grants.filter(
      (grant) => grant.permissionKey === "application.decide",
    );
    expect(scDecisionGrants).toHaveLength(scCount);
    expect(scDecisionGrants.every((grant) => grant.scopeType === "event")).toBe(true);

    const jcWorkloads = fixture.jcReviewers.map((reviewer) => (
      state.assignments.filter((assignment) => assignment.reviewerPersonId === reviewer.personId).length
    ));
    expect(Math.max(...jcWorkloads) - Math.min(...jcWorkloads)).toBeLessThanOrEqual(1);
    const scWorkloads = fixture.scReviewers.map((reviewer) => (
      state.assignments.filter((assignment) => assignment.reviewerPersonId === reviewer.personId).length
    ));
    expect(Math.max(...scWorkloads) - Math.min(...scWorkloads)).toBeLessThanOrEqual(1);
  }, 90_000);
});

type ScaleReviewer = {
  personId: Id<"people">;
  subjectId: Id<"eventAccessSubjects">;
};

async function seedScaleFixture(backend: BackendTest) {
  const now = Date.UTC(2026, 7, 30, 8, 0, 0);
  return backend.run(async (ctx) => {
    const bootstrapPersonId = await insertPerson(ctx, "bootstrap", now);
    const eventId = await ctx.db.insert("events", {
      slug: "idea-round-scale-rehearsal",
      name: "Code2Create idea round scale rehearsal",
      timezone: "Asia/Kolkata",
      status: "registration_closed",
      vitEmailDomains: ["vitstudent.ac.in"],
      applicationsCloseAt: now,
      createdByPersonId: bootstrapPersonId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const participantPolicyId = await ctx.db.insert("participantPolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...defaultParticipantPolicy,
      checksum: participantPolicyChecksum(defaultParticipantPolicy),
      createdByPersonId: bootstrapPersonId,
      createdAt: now,
      publishedAt: now,
    });
    const intakePolicyId = await insertIntakePolicy(ctx, eventId, bootstrapPersonId, now);
    const admissionPolicyId = await ctx.db.insert("admissionPolicyVersions", {
      eventId,
      version: "idea-round-scale-v1",
      status: "published",
      aiRecommendationMode: "disabled",
      minimumHumanReviews: 2,
      overallParticipantCapacity: 1_200,
      criteria: [],
      decisionReasonCodes: [{
        key: "round_rehearsal",
        label: "Round rehearsal",
        allowedDecisions: ["accept", "waitlist", "decline"],
      }],
      checksum: "idea-round-scale-policy",
      createdByPersonId: bootstrapPersonId,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.patch(eventId, {
      publishedParticipantPolicyId: participantPolicyId,
      publishedIntakePolicyId: intakePolicyId,
      publishedAdmissionPolicyId: admissionPolicyId,
    });

    const scReviewers = await insertReviewers(ctx, {
      count: scCount,
      eventId,
      now,
      role: "sc",
      assignedByPersonId: bootstrapPersonId,
    });
    const jcReviewers = await insertReviewers(ctx, {
      count: jcCount,
      eventId,
      now,
      role: "jc",
      assignedByPersonId: bootstrapPersonId,
    });
    for (const reviewer of scReviewers) {
      for (const permissionKey of ["application.assign", "application.decide"] as const) {
        await insertPermissionGrant(ctx, {
          eventId,
          personId: reviewer.personId,
          eventAccessSubjectId: reviewer.subjectId,
          permissionKey,
          scopeType: "event",
          sourceType: "manual",
          sourceId: `scale-sc:${reviewer.personId}:${permissionKey}`,
          grantedByPersonId: bootstrapPersonId,
          reason: "SC idea-round rehearsal authority",
        });
      }
    }

    const experienceBands = [
      "first_year",
      "early_year",
      "later_year",
      "postgraduate_or_professional",
      "mixed_or_external",
    ] as const;
    const applications: Array<{ applicationId: Id<"applications"> }> = [];
    for (let index = 0; index < teamCount; index += 1) {
      const participant = await insertParticipant(ctx, eventId, participantPolicyId, index, now);
      const teamId = await ctx.db.insert("teams", {
        eventId,
        name: `Scale team ${String(index + 1).padStart(3, "0")}`,
        publicCode: `S${String(index + 1).padStart(7, "0")}`,
        leadMembershipId: participant.membershipId,
        status: "submitted",
        activeMemberCount: 1,
        activeVitMemberCount: index % 2 === 0 ? 1 : 0,
        activeExternalMemberCount: index % 2 === 0 ? 0 : 1,
        membershipLocked: true,
        version: 1,
        createdAt: now + index,
        updatedAt: now + index,
      });
      const teamMemberId = await ctx.db.insert("teamMembers", {
        eventId,
        teamId,
        membershipId: participant.membershipId,
        role: "lead",
        status: "active",
        joinedAt: now + index,
        source: "created",
      });
      const submissionAttemptId = await createTestSubmissionSnapshot(ctx, {
        eventId,
        teamId,
        teamMemberIds: [teamMemberId],
        intakePolicyVersionId: intakePolicyId,
        participantPolicyVersionId: participantPolicyId,
        admissionPolicyVersionId: admissionPolicyId,
        submittedAt: now + index,
      });
      const projectVersionId = await ctx.db.insert("projectVersions", {
        eventId,
        teamId,
        version: 1,
        initialIdea: `Deterministic rehearsal idea ${index + 1}.`,
        intakePolicyVersionId: intakePolicyId,
        intakeResponses: [],
        lockedRosterSnapshotId: submissionAttemptId,
        lockedMemberCount: 1,
        lockedLeadMembershipId: participant.membershipId,
        freshForEventAttestation: {
          participantPolicyVersionId: participantPolicyId,
          acceptedByMembershipId: participant.membershipId,
          acceptedAt: now + index,
        },
        finalConfirmation: {
          participantPolicyVersionId: participantPolicyId,
          previewedDraftVersion: 1,
          previewedTeamVersion: 1,
          confirmedByMembershipId: participant.membershipId,
          confirmedAt: now + index,
        },
        participantPolicyVersionId: participantPolicyId,
        admissionPolicyVersionId: admissionPolicyId,
        sourceDraftVersion: 1,
        submittedByMembershipId: participant.membershipId,
        submittedAt: now + index,
      });
      const applicationId = await ctx.db.insert("applications", {
        eventId,
        teamId,
        submittedProjectVersionId: projectVersionId,
        admissionPolicyVersionId: admissionPolicyId,
        state: "submitted",
        experienceBand: experienceBands[index % experienceBands.length] ?? "mixed_or_external",
        assignedReviewCount: 0,
        completedReviewCount: 0,
        contentVersion: 1,
        version: 1,
        submittedAt: now + index,
      });
      await linkTestSubmissionSnapshot(ctx, {
        submissionAttemptId,
        projectVersionId,
        applicationId,
      });
      applications.push({ applicationId });
    }
    return { now, eventId, scReviewers, jcReviewers, applications };
  });
}

function insertIntakePolicy(
  ctx: MutationCtx,
  eventId: Id<"events">,
  createdByPersonId: Id<"people">,
  now: number,
) {
  return ctx.db.insert("intakePolicyVersions", {
    eventId,
    version: 1,
    status: "published",
    openingText: "Hello.",
    initialPrompt: "What do you want to build?",
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
    checksum: "idea-round-scale-intake",
    createdByPersonId,
    createdAt: now,
    publishedAt: now,
  });
}

async function insertReviewers(
  ctx: MutationCtx,
  args: {
    count: number;
    eventId: Id<"events">;
    now: number;
    role: "sc" | "jc";
    assignedByPersonId: Id<"people">;
  },
) {
  const reviewers: ScaleReviewer[] = [];
  for (let index = 0; index < args.count; index += 1) {
    const key = `${args.role}-${index + 1}`;
    const personId = await insertPerson(ctx, key, args.now);
    const subjectId = await insertSubject(ctx, args.eventId, personId, key, args.now);
    await ctx.db.insert("eventRoles", {
      eventId: args.eventId,
      personId,
      eventAccessSubjectId: subjectId,
      role: args.role,
      validFrom: args.now,
      status: "active",
      sourceType: "manual",
      sourceId: `scale-role:${key}`,
      assignedByPersonId: args.assignedByPersonId,
      createdAt: args.now,
    });
    reviewers.push({ personId, subjectId });
  }
  return reviewers;
}

async function insertParticipant(
  ctx: MutationCtx,
  eventId: Id<"events">,
  participantPolicyId: Id<"participantPolicyVersions">,
  index: number,
  now: number,
) {
  const key = `participant-${index + 1}`;
  const personId = await insertPerson(ctx, key, now + index);
  const subjectId = await insertSubject(ctx, eventId, personId, key, now + index);
  const membershipId = await ctx.db.insert("eventMemberships", {
    eventId,
    personId,
    eventAccessSubjectId: subjectId,
    participantClass: index % 2 === 0 ? "vit_student" : "external_participant",
    eligibilityStatus: "eligible",
    onboardingStatus: "submitted",
    acceptedParticipantPolicyVersionIds: [participantPolicyId],
    createdAt: now + index,
    updatedAt: now + index,
  });
  return { membershipId };
}

function insertPerson(ctx: MutationCtx, key: string, now: number) {
  return ctx.db.insert("people", {
    authUserId: `scale-auth-${key}`,
    googleSubject: `scale-google-${key}`,
    verifiedEmail: `${key}@scale.example.test`,
    displayName: key,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
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
    emailNormalized: `${key}@scale.example.test`,
    displayName: key,
    status: "active",
    linkedBy: "access_invitation",
    accessVersion: 1,
    createdAt: now,
    updatedAt: now,
  });
}
