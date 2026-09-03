/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "./_generated/api";
import {
  comparisonSummary,
  exactSourceText,
  similarityBand,
} from "./admissionIdeaSimilarity";
import { defaultDeterministicIntakePolicy, intakePolicyChecksum } from "./lib/intakePolicy";
import { noveltyEmbeddingDimensions, noveltyInputFingerprint } from "./lib/novelty";
import {
  defaultParticipantPolicy,
  normalizeParticipantPolicy,
  participantPolicyChecksum,
} from "./lib/participantPolicy";
import { createTestSubmissionSnapshot } from "./lib/testSubmissionSnapshot";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const projectionSources = {
  initialIdea: "A campus queue planner for students.",
  additionalInformation: "The first pilot is the library desk.",
  intakeResponses: [
    {
      sourceRef: "follow_up_1",
      question: "How does it work?",
      answer: "Students report wait time and staff confirm service capacity.",
    },
    {
      sourceRef: "follow_up_2",
      question: "What is different?",
      answer: "It joins student reports with staff-confirmed capacity.",
    },
  ],
};

describe("admission idea similarity boundaries", () => {
  test("builds a comparison query only from exact authorized source refs", () => {
    expect(exactSourceText(projectionSources, ["initial_idea", "follow_up_2"])).toBe(
      [
        projectionSources.initialIdea,
        projectionSources.intakeResponses[1]?.answer,
      ].join("\n\n"),
    );
    expect(exactSourceText(projectionSources, ["missing_source"])).toBeNull();
    expect(exactSourceText(projectionSources, ["initial_idea", "initial_idea"])).toBeNull();
    expect(exactSourceText(projectionSources, [])).toBeNull();
  });

  test("redacts contact details, identifiers, secrets, and links from comparison summaries", () => {
    expect(
      comparisonSummary(
        "Contact maker@example.com or +91 98765 43210 about 24BCE1234 at https://example.com. sk-test_123456789012",
      ),
    ).toBe(
      "Contact [email removed] or [phone removed] about [identifier removed] at [link removed] [secret removed]",
    );
  });

  test("returns coarse retrieval bands and drops weak vector matches", () => {
    expect(similarityBand(0.53)).toBeNull();
    expect(similarityBand(0.54)).toBe("moderate");
    expect(similarityBand(0.68)).toBe("high");
    expect(similarityBand(0.78)).toBe("very_high");
    expect(similarityBand(Number.NaN)).toBeNull();
  });

  test("hydrates only another team's current submitted project and removes private text", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await backend.run(async (ctx) => {
      const now = Date.UTC(2026, 8, 4, 0, 0, 0);
      const personId = await ctx.db.insert("people", {
        authUserId: "similarity-person",
        googleSubject: "similarity-google",
        verifiedEmail: "reviewer@example.test",
        displayName: "Similarity Reviewer",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const eventId = await ctx.db.insert("events", {
        slug: "similarity-event",
        name: "Similarity event",
        timezone: "Asia/Kolkata",
        status: "registration_open",
        vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: now + 86_400_000,
        externalApplicationsCloseAt: now + 86_400_000,
        createdByPersonId: personId,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const subjectId = await ctx.db.insert("eventAccessSubjects", {
        eventId,
        personId,
        emailNormalized: "reviewer@example.test",
        displayName: "Similarity Reviewer",
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
        participantClass: "external_participant",
        eligibilityStatus: "eligible",
        onboardingStatus: "project_required",
        acceptedParticipantPolicyVersionIds: [],
        createdAt: now,
        updatedAt: now,
      });
      const currentTeamId = await ctx.db.insert("teams", {
        eventId,
        name: "Current team",
        publicCode: "CURRENT",
        leadMembershipId: membershipId,
        status: "submitted",
        activeMemberCount: 1,
        activeVitMemberCount: 0,
        activeExternalMemberCount: 1,
        membershipLocked: false,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const otherTeamId = await ctx.db.insert("teams", {
        eventId,
        name: "Other team",
        publicCode: "OTHER1",
        leadMembershipId: membershipId,
        status: "submitted",
        activeMemberCount: 1,
        activeVitMemberCount: 0,
        activeExternalMemberCount: 1,
        membershipLocked: false,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const otherMemberId = await ctx.db.insert("teamMembers", {
        eventId,
        teamId: otherTeamId,
        membershipId,
        role: "lead",
        status: "active",
        joinedAt: now,
        source: "created",
      });
      const intakePolicy = defaultDeterministicIntakePolicy;
      const intakePolicyId = await ctx.db.insert("intakePolicyVersions", {
        eventId,
        version: 1,
        status: "published",
        ...intakePolicy,
        checksum: intakePolicyChecksum(intakePolicy),
        createdByPersonId: personId,
        createdAt: now,
        publishedAt: now,
      });
      const participantPolicy = normalizeParticipantPolicy(defaultParticipantPolicy);
      const participantPolicyId = await ctx.db.insert("participantPolicyVersions", {
        eventId,
        version: 1,
        status: "published",
        ...participantPolicy,
        checksum: participantPolicyChecksum(participantPolicy),
        createdByPersonId: personId,
        createdAt: now,
        publishedAt: now,
      });
      const admissionPolicyId = await ctx.db.insert("admissionPolicyVersions", {
        eventId,
        version: "1",
        status: "published",
        aiRecommendationMode: "enabled",
        minimumHumanReviews: 1,
        overallParticipantCapacity: 825,
        criteria: [],
        decisionReasonCodes: [],
        checksum: "similarity-admission-policy",
        createdByPersonId: personId,
        createdAt: now,
        publishedAt: now,
      });
      const submissionAttemptId = await createTestSubmissionSnapshot(ctx, {
        eventId,
        teamId: otherTeamId,
        teamMemberIds: [otherMemberId],
        intakePolicyVersionId: intakePolicyId,
        participantPolicyVersionId: participantPolicyId,
        admissionPolicyVersionId: admissionPolicyId,
        submittedAt: now,
      });
      const idea =
        "A queue planner. Contact maker@example.com and see https://private.example.test/demo";
      const projectVersionId = await ctx.db.insert("projectVersions", {
        eventId,
        teamId: otherTeamId,
        version: 1,
        initialIdea: idea,
        intakePolicyVersionId: intakePolicyId,
        intakeResponses: [],
        lockedRosterSnapshotId: submissionAttemptId,
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
      await ctx.db.insert("applications", {
        eventId,
        teamId: otherTeamId,
        submittedProjectVersionId: projectVersionId,
        admissionPolicyVersionId: admissionPolicyId,
        state: "submitted",
        experienceBand: "mixed_or_external",
        decisionStage: "unrecorded",
        assignedReviewCount: 0,
        completedReviewCount: 0,
        contentVersion: 1,
        version: 1,
        submittedAt: now,
      });
      const embedding = Array.from({ length: noveltyEmbeddingDimensions }, (_, index) =>
        index === 0 ? 1 : 0,
      );
      const currentIdeaId = await ctx.db.insert("noveltyTeamIdeas", {
        eventId,
        teamId: currentTeamId,
        inputFingerprint: "current-fingerprint",
        lifecycle: "submitted",
        embedding,
        sourceUpdatedAt: now,
        updatedAt: now,
      });
      const otherIdeaId = await ctx.db.insert("noveltyTeamIdeas", {
        eventId,
        teamId: otherTeamId,
        inputFingerprint: noveltyInputFingerprint(idea),
        lifecycle: "submitted",
        embedding,
        sourceUpdatedAt: now,
        updatedAt: now,
      });
      const savedIdeaId = await ctx.db.insert("noveltyTeamIdeas", {
        eventId,
        teamId: otherTeamId,
        inputFingerprint: noveltyInputFingerprint(idea),
        lifecycle: "saved",
        embedding,
        sourceUpdatedAt: now,
        updatedAt: now,
      });
      return { eventId, currentTeamId, currentIdeaId, otherIdeaId, savedIdeaId };
    });

    await expect(
      backend.query(internal.admissionIdeaSimilarity.readCurrentSubmissionMatchMetadata, {
        eventId: fixture.eventId,
        excludedTeamId: fixture.currentTeamId,
        ideaIds: [fixture.currentIdeaId, fixture.savedIdeaId, fixture.otherIdeaId],
      }),
    ).resolves.toEqual([
      {
        id: fixture.otherIdeaId,
        summary: "A queue planner. Contact [email removed] and see [link removed]",
      },
    ]);
  });
});
