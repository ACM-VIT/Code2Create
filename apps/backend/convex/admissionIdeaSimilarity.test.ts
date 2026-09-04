/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  comparisonSummary,
  exactSourceText,
  similarityBand,
} from "./admissionIdeaSimilarity";
import { defaultDeterministicIntakePolicy, intakePolicyChecksum } from "./lib/intakePolicy";
import {
  activeAdmissionIdeaComparisonScope,
  noveltyEmbeddingDimensions,
  noveltyIdeaComparisonScope,
  noveltyInputFingerprint,
} from "./lib/novelty";
import { synchronizeTeamAdmissionIdeaComparison } from "./lib/noveltyIndex";
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

  test("indexes only active authoritative submissions before the vector result limit", async () => {
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
      const applicationId = await ctx.db.insert("applications", {
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
      const crowdedIdeaIds: Id<"noveltyTeamIdeas">[] = [];
      for (let index = 0; index < 256; index += 1) {
        const crowdedTeamId = await ctx.db.insert("teams", {
          eventId,
          name: `Ineligible team ${index + 1}`,
          publicCode: `INELIGIBLE${index + 1}`,
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
        crowdedIdeaIds.push(
          await ctx.db.insert("noveltyTeamIdeas", {
            eventId,
            teamId: crowdedTeamId,
            inputFingerprint: `ineligible-fingerprint-${index + 1}`,
            lifecycle: "submitted",
            embedding,
            sourceUpdatedAt: now,
            updatedAt: now,
          }),
        );
      }
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
      const duplicateOtherIdeaIds = await Promise.all(
        Array.from({ length: 256 }, () =>
          ctx.db.insert("noveltyTeamIdeas", {
            eventId,
            teamId: otherTeamId,
            inputFingerprint: noveltyInputFingerprint(idea),
            lifecycle: "submitted",
            embedding,
            sourceUpdatedAt: now - 1,
            updatedAt: now - 1,
          }),
        ),
      );
      const savedIdeaId = await ctx.db.insert("noveltyTeamIdeas", {
        eventId,
        teamId: otherTeamId,
        inputFingerprint: noveltyInputFingerprint(idea),
        lifecycle: "saved",
        embedding,
        sourceUpdatedAt: now,
        updatedAt: now,
      });
      return {
        eventId,
        applicationId,
        currentTeamId,
        currentIdeaId,
        otherTeamId,
        otherIdeaId,
        duplicateOtherIdeaIds,
        savedIdeaId,
        crowdedIdeaIds,
      };
    });

    let reconciled = 0;
    do {
      reconciled = await backend.mutation(
        internal.admissionIdeaSimilarity.reconcileLegacyComparisonScopes,
        {
          eventId: fixture.eventId,
        },
      );
    } while (reconciled > 0);
    await expect(
      backend.run(async (ctx) =>
        ctx.db
          .query("noveltyTeamIdeas")
          .withIndex("by_event_comparison_scope", (index) =>
            index
              .eq("eventId", fixture.eventId)
              .eq(
                "comparisonScope",
                activeAdmissionIdeaComparisonScope(fixture.eventId, fixture.otherTeamId),
              ),
          )
          .collect(),
      ),
    ).resolves.toMatchObject([{ _id: fixture.otherIdeaId }]);
    await expect(
      backend.run(async (ctx) =>
        Promise.all(
          fixture.crowdedIdeaIds.map(async (ideaId) => (await ctx.db.get(ideaId))?.comparisonScope),
        ),
      ),
    ).resolves.toEqual(
      Array.from({ length: 256 }, () =>
        noveltyIdeaComparisonScope(fixture.eventId, "submitted"),
      ),
    );
    await expect(
      backend.run(async (ctx) =>
        Promise.all(
          fixture.duplicateOtherIdeaIds.map(
            async (ideaId) => (await ctx.db.get(ideaId))?.comparisonScope,
          ),
        ),
      ),
    ).resolves.toEqual(
      Array.from({ length: 256 }, () => noveltyIdeaComparisonScope(fixture.eventId, "submitted")),
    );
    await expect(
      backend.mutation(internal.admissionIdeaSimilarity.reconcileLegacyComparisonScopes, {
        eventId: fixture.eventId,
      }),
    ).resolves.toBe(0);
    await expect(
      backend.run(async (ctx) =>
        Promise.all(
          [fixture.currentIdeaId, fixture.otherIdeaId, fixture.savedIdeaId].map(
            async (ideaId) => (await ctx.db.get(ideaId))?.comparisonScope,
          ),
        ),
      ),
    ).resolves.toEqual([
      noveltyIdeaComparisonScope(fixture.eventId, "submitted"),
      activeAdmissionIdeaComparisonScope(fixture.eventId, fixture.otherTeamId),
      noveltyIdeaComparisonScope(fixture.eventId, "saved"),
    ]);

    await expect(
      backend.query(internal.admissionIdeaSimilarity.readCurrentSubmissionMatchMetadata, {
        eventId: fixture.eventId,
        excludedTeamId: fixture.currentTeamId,
        ideaIds: [fixture.otherIdeaId],
      }),
    ).resolves.toEqual([
      {
        id: fixture.otherIdeaId,
        summary: "A queue planner. Contact [email removed] and see [link removed]",
      },
    ]);
    await expect(
      backend.query(internal.admissionIdeaSimilarity.readActiveComparisonScopes, {
        eventId: fixture.eventId,
        excludedTeamId: fixture.currentTeamId,
      }),
    ).resolves.toEqual([
      activeAdmissionIdeaComparisonScope(fixture.eventId, fixture.otherTeamId),
    ]);
    await expect(
      backend.query(internal.admissionIdeaSimilarity.readActiveComparisonScopes, {
        eventId: fixture.eventId,
        excludedTeamId: fixture.otherTeamId,
      }),
    ).resolves.toEqual([]);

    await backend.run(async (ctx) => ctx.db.patch(fixture.applicationId, { state: "declined" }));
    await expect(
      backend.query(internal.admissionIdeaSimilarity.readActiveComparisonScopes, {
        eventId: fixture.eventId,
        excludedTeamId: fixture.currentTeamId,
      }),
    ).resolves.toEqual([]);
    await expect(
      backend.query(internal.admissionIdeaSimilarity.readCurrentSubmissionMatchMetadata, {
        eventId: fixture.eventId,
        excludedTeamId: fixture.currentTeamId,
        ideaIds: [fixture.otherIdeaId],
      }),
    ).resolves.toEqual([]);

    await backend.run(async (ctx) => {
      await synchronizeTeamAdmissionIdeaComparison(ctx, {
        eventId: fixture.eventId,
        teamId: fixture.otherTeamId,
      });
    });
    await expect(
      backend.run(async (ctx) => (await ctx.db.get(fixture.otherIdeaId))?.comparisonScope),
    ).resolves.toBe(noveltyIdeaComparisonScope(fixture.eventId, "submitted"));
    await expect(
      backend.run(async (ctx) =>
        ctx.db
          .query("noveltyTeamIdeas")
          .withIndex("by_event_comparison_scope", (index) =>
            index
              .eq("eventId", fixture.eventId)
              .eq(
                "comparisonScope",
                activeAdmissionIdeaComparisonScope(fixture.eventId, fixture.otherTeamId),
              ),
          )
          .collect(),
      ),
    ).resolves.toEqual([]);
    await expect(
      backend.query(internal.admissionIdeaSimilarity.readCurrentSubmissionMatchMetadata, {
        eventId: fixture.eventId,
        excludedTeamId: fixture.currentTeamId,
        ideaIds: [fixture.otherIdeaId],
      }),
    ).resolves.toEqual([]);
  });
});
