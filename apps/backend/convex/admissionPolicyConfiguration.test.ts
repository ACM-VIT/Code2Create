import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Doc, Id } from "./_generated/dataModel.ts";
import type { MutationCtx } from "./_generated/server.ts";
import {
  admissionPolicyChecksum,
  admissionPolicyForConfiguration,
  defaultAdmissionCriteria,
  defaultAdmissionReasonCodes,
  loadPublishedAdmissionConfiguration,
  normalizeAdmissionConfiguration,
  publishAdmissionConfiguration,
  saveAdmissionConfigurationDraft,
  type AdmissionConfiguration,
} from "./lib/admissionPolicy.ts";
import {
  defaultDeterministicIntakePolicy,
  intakePolicyChecksum,
  normalizeIntakePolicy,
} from "./lib/intakePolicy.ts";
import {
  defaultParticipantPolicy,
  normalizeParticipantPolicy,
  participantPolicyChecksum,
} from "./lib/participantPolicy.ts";
import { permissionCatalog } from "./lib/permissionCatalog.ts";
import { createTestSubmissionSnapshot } from "./lib/testSubmissionSnapshot.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;
type Fixture = {
  now: number;
  event: Doc<"events">;
  personId: Id<"people">;
  policyId: Id<"admissionPolicyVersions">;
  participantPolicyId: Id<"participantPolicyVersions">;
};

describe("admission policy configuration", () => {
  test("keeps admission configuration capabilities independently event scoped", () => {
    expect(permissionCatalog["configuration.admission.read"]).toEqual({
      scopes: [],
      eventWide: true,
    });
    expect(permissionCatalog["configuration.admission.draft.create"]).toEqual({
      scopes: [],
      eventWide: true,
    });
    expect(permissionCatalog["configuration.admission.validate"]).toEqual({
      scopes: [],
      eventWide: true,
    });
    expect(permissionCatalog["configuration.admission.publish"]).toEqual({
      scopes: [],
      eventWide: true,
    });
  });

  test("requires complete year bands, decision coverage, and bounded model metadata", () => {
    const valid = configuration("admission-v2", 900, true);
    expect(normalizeAdmissionConfiguration(valid).criteria).toHaveLength(4);
    expect(() => normalizeAdmissionConfiguration({
      ...valid,
      criteria: [{
        ...valid.criteria[0]!,
        guidanceByBand: { ...valid.criteria[0]!.guidanceByBand, firstYear: "Too short" },
      }],
    })).toThrow("First-year guidance");
    expect(() => normalizeAdmissionConfiguration({
      ...valid,
      decisionReasonCodes: valid.decisionReasonCodes.filter((reason) =>
        !reason.allowedDecisions.includes("accept"),
      ),
    })).toThrow("permit accept");
    expect(() => normalizeAdmissionConfiguration({
      ...valid,
      model: valid.model ? { ...valid.model, modelId: "x" } : null,
    })).toThrow("Admission model ID");
  });

  test("allows one competing complete draft from the same observed state", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "draft-race");
    const attempts = await Promise.allSettled([
      backend.run((ctx) => saveAdmissionConfigurationDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        configuration: configuration("admission-alpha", 900, false),
        now: fixture.now + 1,
      })),
      backend.run((ctx) => saveAdmissionConfigurationDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        configuration: configuration("admission-beta", 950, true),
        now: fixture.now + 1,
      })),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const drafts = await backend.run((ctx) => ctx.db
      .query("admissionPolicyVersions")
      .withIndex("by_event_status", (index) =>
        index.eq("eventId", fixture.event._id).eq("status", "draft"),
      )
      .collect());
    expect(drafts).toHaveLength(1);
  });

  test("publishes policy, model, capacity, and pointer together, then freezes", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "publication");
    const draft = await backend.run((ctx) => saveAdmissionConfigurationDraft(ctx, {
      event: fixture.event,
      actorPersonId: fixture.personId,
      configuration: configuration("admission-v2", 900, true),
      now: fixture.now + 1,
    }));
    expect(draft.modelConfigVersionId).not.toBeNull();
    await backend.run((ctx) => publishAdmissionConfiguration(ctx, {
      event: fixture.event,
      draftPolicyId: draft.policyVersionId,
      expectedPolicyChecksum: draft.policyChecksum,
      expectedModelConfigId: draft.modelConfigVersionId,
      expectedModelChecksum: draft.modelChecksum,
      now: fixture.now + 2,
    }));
    const published = await backend.run(async (ctx) => {
      const event = await ctx.db.get(fixture.event._id);
      if (!event) throw new Error("The event is missing after publication.");
      const release = await loadPublishedAdmissionConfiguration(ctx, event);
      const oldPolicy = await ctx.db.get(fixture.policyId);
      const buckets = await ctx.db
        .query("admissionCapacityBuckets")
        .withIndex("by_event", (index) => index.eq("eventId", event._id))
        .collect();
      return {
        version: release.configuration.version,
        modelVersion: release.configuration.model?.version,
        capacity: release.configuration.overallParticipantCapacity,
        oldPolicyStatus: oldPolicy?.status,
        bucketCapacities: buckets.map((bucket) => bucket.capacity).sort((left, right) => left - right),
        eventVersion: event.version,
      };
    });
    expect(published).toEqual({
      version: "admission-v2",
      modelVersion: "admission-model-v2",
      capacity: 900,
      oldPolicyStatus: "superseded",
      bucketCapacities: [900, 1_000],
      eventVersion: 2,
    });

    const nextDraft = await backend.run((ctx) => saveAdmissionConfigurationDraft(ctx, {
      event: fixture.event,
      actorPersonId: fixture.personId,
      configuration: configuration("admission-v3", 950, false),
      now: fixture.now + 3,
    }));
    const currentEvent = await backend.run(async (ctx) => {
      await insertSubmittedApplication(ctx, fixture);
      const event = await ctx.db.get(fixture.event._id);
      if (!event) throw new Error("The event is missing before the freeze check.");
      return event;
    });
    await expect(backend.run((ctx) => publishAdmissionConfiguration(ctx, {
      event: currentEvent,
      draftPolicyId: nextDraft.policyVersionId,
      expectedPolicyChecksum: nextDraft.policyChecksum,
      expectedModelConfigId: nextDraft.modelConfigVersionId,
      expectedModelChecksum: nextDraft.modelChecksum,
      now: fixture.now + 4,
    }))).rejects.toThrow("closes when the first project submission begins");
    await expect(backend.run((ctx) => saveAdmissionConfigurationDraft(ctx, {
      event: currentEvent,
      actorPersonId: fixture.personId,
      configuration: configuration("admission-v4", 975, false),
      now: fixture.now + 5,
    }))).rejects.toThrow("closes when the first project submission begins");
    const afterRejectedPublication = await backend.run((ctx) => ctx.db.get(fixture.event._id));
    expect(afterRejectedPublication?.publishedAdmissionPolicyId).toBe(draft.policyVersionId);
  });

  test("publishing human-only mode removes the prior model pointer", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "disable-model");
    const enabledDraft = await backend.run((ctx) => saveAdmissionConfigurationDraft(ctx, {
      event: fixture.event,
      actorPersonId: fixture.personId,
      configuration: configuration("admission-v2", 900, true),
      now: fixture.now + 1,
    }));
    await backend.run((ctx) => publishAdmissionConfiguration(ctx, {
      event: fixture.event,
      draftPolicyId: enabledDraft.policyVersionId,
      expectedPolicyChecksum: enabledDraft.policyChecksum,
      expectedModelConfigId: enabledDraft.modelConfigVersionId,
      expectedModelChecksum: enabledDraft.modelChecksum,
      now: fixture.now + 2,
    }));
    const eventWithModel = await backend.run(async (ctx) => {
      const event = await ctx.db.get(fixture.event._id);
      if (!event) throw new Error("The event is missing after enabling the model.");
      return event;
    });
    const disabledDraft = await backend.run((ctx) => saveAdmissionConfigurationDraft(ctx, {
      event: eventWithModel,
      actorPersonId: fixture.personId,
      configuration: configuration("admission-v3", 850, false),
      now: fixture.now + 3,
    }));
    await backend.run((ctx) => publishAdmissionConfiguration(ctx, {
      event: eventWithModel,
      draftPolicyId: disabledDraft.policyVersionId,
      expectedPolicyChecksum: disabledDraft.policyChecksum,
      expectedModelConfigId: null,
      expectedModelChecksum: null,
      now: fixture.now + 4,
    }));
    const result = await backend.run(async (ctx) => {
      const event = await ctx.db.get(fixture.event._id);
      if (!event) throw new Error("The event is missing after disabling the model.");
      const release = await loadPublishedAdmissionConfiguration(ctx, event);
      const priorModel = enabledDraft.modelConfigVersionId
        ? await ctx.db.get(enabledDraft.modelConfigVersionId)
        : null;
      return {
        eventModelId: event.publishedAdmissionModelConfigId,
        model: release.configuration.model,
        aiRecommendationMode: release.policy.aiRecommendationMode,
        priorModelStatus: priorModel?.status,
      };
    });
    expect(result).toEqual({
      eventModelId: undefined,
      model: null,
      aiRecommendationMode: "disabled",
      priorModelStatus: "superseded",
    });
  });

  test("a first submission and policy publication leave one matching policy boundary", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "submission-race");
    const draft = await backend.run((ctx) => saveAdmissionConfigurationDraft(ctx, {
      event: fixture.event,
      actorPersonId: fixture.personId,
      configuration: configuration("admission-v2", 900, true),
      now: fixture.now + 1,
    }));
    const attempts = await Promise.allSettled([
      backend.run((ctx) => publishAdmissionConfiguration(ctx, {
        event: fixture.event,
        draftPolicyId: draft.policyVersionId,
        expectedPolicyChecksum: draft.policyChecksum,
        expectedModelConfigId: draft.modelConfigVersionId,
        expectedModelChecksum: draft.modelChecksum,
        now: fixture.now + 2,
      })),
      backend.run((ctx) => insertSubmittedApplication(ctx, fixture)),
    ]);
    expect(attempts[1]?.status).toBe("fulfilled");
    const boundary = await backend.run(async (ctx) => {
      const event = await ctx.db.get(fixture.event._id);
      const application = await ctx.db
        .query("applications")
        .withIndex("by_event_state_submitted", (index) => index.eq("eventId", fixture.event._id))
        .unique();
      return {
        eventPolicyId: event?.publishedAdmissionPolicyId,
        applicationPolicyId: application?.admissionPolicyVersionId,
      };
    });
    expect(boundary.applicationPolicyId).toBe(boundary.eventPolicyId);
  });
});

function configuration(
  version: string,
  capacity: number,
  modelEnabled: boolean,
): AdmissionConfiguration {
  return {
    version,
    minimumHumanReviews: 2,
    overallParticipantCapacity: capacity,
    criteria: defaultAdmissionCriteria,
    decisionReasonCodes: defaultAdmissionReasonCodes,
    model: modelEnabled
      ? {
          version: "admission-model-v2",
          modelId: "gpt-5-mini",
          promptVersion: "admission-recommendation-v2",
          schemaVersion: "admission-recommendation-v1",
          evaluationSuiteVersion: "admission-eval-v2",
        }
      : null,
  };
}

async function seedFixture(backend: BackendTest, slug: string): Promise<Fixture> {
  const now = Date.UTC(2027, 6, 1, 9, 0);
  return backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId: `admission-policy-${slug}`,
      googleSubject: `admission-policy-${slug}`,
      verifiedEmail: `${slug}@example.test`,
      displayName: "Admission policy fixture",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: `admission-policy-${slug}`,
      name: "Code2Create admission-policy fixture",
      timezone: "Asia/Kolkata",
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: Date.now() + 86_400_000,
      createdByPersonId: personId,
      version: 1,
      createdAt: now,
      updatedAt: now,
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
    const initialConfiguration = normalizeAdmissionConfiguration(
      configuration("admission-v1", 1_000, false),
    );
    const admissionPolicy = admissionPolicyForConfiguration(initialConfiguration);
    const policyId = await ctx.db.insert("admissionPolicyVersions", {
      eventId,
      ...admissionPolicy,
      status: "published",
      checksum: admissionPolicyChecksum(admissionPolicy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.insert("admissionCapacityBuckets", {
      eventId,
      admissionPolicyVersionId: policyId,
      capacity: 1_000,
      reserved: 0,
      version: 1,
      updatedAt: now,
    });
    await ctx.db.patch(eventId, {
      publishedParticipantPolicyId: participantPolicyId,
      publishedAdmissionPolicyId: policyId,
    });
    const event = await ctx.db.get(eventId);
    if (!event) throw new Error("The admission-policy fixture event did not persist.");
    return { now, event, personId, policyId, participantPolicyId };
  });
}

async function insertSubmittedApplication(
  ctx: MutationCtx,
  fixture: Fixture,
) {
  const currentEvent = await ctx.db.get(fixture.event._id);
  const policyId = currentEvent?.publishedAdmissionPolicyId;
  if (!policyId) throw new Error("The current admission policy is missing.");
  const subjectId = await ctx.db.insert("eventAccessSubjects", {
    eventId: fixture.event._id,
    personId: fixture.personId,
    emailNormalized: "application@example.test",
    displayName: "Application fixture",
    status: "active",
    linkedBy: "participant_provisioning",
    accessVersion: 1,
    createdAt: fixture.now,
    updatedAt: fixture.now,
  });
  const membershipId = await ctx.db.insert("eventMemberships", {
    eventId: fixture.event._id,
    personId: fixture.personId,
    eventAccessSubjectId: subjectId,
    participantClass: "external_participant",
    eligibilityStatus: "eligible",
    onboardingStatus: "submitted",
    acceptedParticipantPolicyVersionIds: [],
    createdAt: fixture.now,
    updatedAt: fixture.now,
  });
  const teamId = await ctx.db.insert("teams", {
    eventId: fixture.event._id,
    name: "Application fixture team",
    publicCode: "ADMTEST",
    leadMembershipId: membershipId,
    status: "submitted",
    activeMemberCount: 1,
      activeVitMemberCount: 0,
    activeExternalMemberCount: 1,
    membershipLocked: true,
    version: 1,
    createdAt: fixture.now,
    updatedAt: fixture.now,
  });
  const memberId = await ctx.db.insert("teamMembers", {
    eventId: fixture.event._id,
    teamId,
    membershipId,
    role: "lead",
    status: "active",
    joinedAt: fixture.now,
    source: "created",
  });
  const intakePolicy = normalizeIntakePolicy(defaultDeterministicIntakePolicy);
  const intakePolicyId = await ctx.db.insert("intakePolicyVersions", {
    eventId: fixture.event._id,
    version: 1,
    status: "published",
    ...intakePolicy,
    checksum: intakePolicyChecksum(intakePolicy),
    createdByPersonId: fixture.personId,
    createdAt: fixture.now,
    publishedAt: fixture.now,
  });
  const lockedRosterSnapshotId = await createTestSubmissionSnapshot(ctx, {
    eventId: fixture.event._id,
    teamId,
    teamMemberIds: [memberId],
    intakePolicyVersionId: intakePolicyId,
    participantPolicyVersionId: fixture.participantPolicyId,
    admissionPolicyVersionId: fixture.policyId,
    submittedAt: fixture.now,
  });
  const projectId = await ctx.db.insert("projectVersions", {
    eventId: fixture.event._id,
    teamId,
    version: 1,
    initialIdea: "A submitted project freezes the admission policy.",
    intakePolicyVersionId: intakePolicyId,
    intakeResponses: [],
    lockedRosterSnapshotId,
    lockedMemberCount: 1,
    lockedLeadMembershipId: membershipId,
    freshForEventAttestation: {
      participantPolicyVersionId: fixture.participantPolicyId,
      acceptedByMembershipId: membershipId,
      acceptedAt: fixture.now,
    },
    finalConfirmation: {
      participantPolicyVersionId: fixture.participantPolicyId,
      previewedDraftVersion: 1,
      previewedTeamVersion: 1,
      confirmedByMembershipId: membershipId,
      confirmedAt: fixture.now,
    },
    participantPolicyVersionId: fixture.participantPolicyId,
    admissionPolicyVersionId: policyId,
    sourceDraftVersion: 1,
    submittedByMembershipId: membershipId,
    submittedAt: fixture.now,
  });
  await ctx.db.patch(teamId, {
    lockedProjectVersionId: projectId,
    lockParticipantPolicyVersionId: fixture.participantPolicyId,
  });
  await ctx.db.insert("applications", {
    eventId: fixture.event._id,
    teamId,
    submittedProjectVersionId: projectId,
    admissionPolicyVersionId: policyId,
    state: "submitted",
    experienceBand: "mixed_or_external",
    assignedReviewCount: 0,
    completedReviewCount: 0,
    contentVersion: 1,
    version: 1,
    submittedAt: fixture.now,
  });
}
