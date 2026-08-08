import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import {
  defaultParticipantPolicy,
  isProfileCompleteForPolicy,
  normalizeParticipantPolicy,
  participantClassesMeetPolicy,
  participantPolicyChecksum,
  publishParticipantPolicy,
  saveParticipantPolicyDraft,
  type ParticipantPolicy,
} from "./lib/participantPolicy.ts";
import { permissionCatalog } from "./lib/permissionCatalog.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

describe("participant policy lifecycle", () => {
  test("keeps participant-policy capabilities independently event scoped", () => {
    expect(permissionCatalog["configuration.participant.read"]).toEqual({
      scopes: [],
      eventWide: true,
    });
    expect(permissionCatalog["configuration.participant.draft.create"]).toEqual({
      scopes: [],
      eventWide: true,
    });
    expect(permissionCatalog["configuration.participant.validate"]).toEqual({
      scopes: [],
      eventWide: true,
    });
    expect(permissionCatalog["configuration.participant.publish"]).toEqual({
      scopes: [],
      eventWide: true,
    });
  });

  test("preserves the fresh-build rule and explicit team-lock warning", () => {
    expect(() => normalizeParticipantPolicy({
      ...defaultParticipantPolicy,
      freshProjectAttestation: "We might start the project whenever it is convenient for us.",
    })).toThrow("fixed fresh-build rule");
    expect(() => normalizeParticipantPolicy({
      ...defaultParticipantPolicy,
      finalSubmissionWarning: "Please check everything carefully before submitting this application.",
    })).toThrow("team and track lock");
    expect(participantClassesMeetPolicy(
      ["vit_student", "external_participant"],
      { ...defaultParticipantPolicy, mixedParticipantClassesAllowed: false },
    )).toBe(false);
  });

  test("allows one competing draft from the same observed state", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "draft-race");
    const attempts = await Promise.allSettled([
      backend.run((ctx) => saveParticipantPolicyDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        policy: policy("Alpha", 4),
        now: fixture.now + 1,
      })),
      backend.run((ctx) => saveParticipantPolicyDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        policy: policy("Beta", 5),
        now: fixture.now + 1,
      })),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const drafts = await backend.run((ctx) => ctx.db
      .query("participantPolicyVersions")
      .withIndex("by_event_status", (index) =>
        index.eq("eventId", fixture.event._id).eq("status", "draft"),
      )
      .collect());
    expect(drafts).toHaveLength(1);
  });

  test("publication makes current-policy acceptance and new required fields explicit", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "publication");
    const before = await backend.run(async (ctx) => {
      const profile = await ctx.db.get(fixture.profileId);
      const membership = await ctx.db.get(fixture.membershipId);
      const policy = await ctx.db.get(fixture.policyId);
      if (!membership || !policy) throw new Error("The fixture policy state is missing.");
      return isProfileCompleteForPolicy(profile, membership, policy);
    });
    expect(before).toBe(true);

    const nextPolicy = { ...policy("Second", 5), phoneField: "required" as const };
    const draft = await backend.run((ctx) => saveParticipantPolicyDraft(ctx, {
      event: fixture.event,
      actorPersonId: fixture.personId,
      policy: nextPolicy,
      now: fixture.now + 1,
    }));
    await backend.run((ctx) => publishParticipantPolicy(ctx, {
      event: fixture.event,
      draftPolicyId: draft.policyVersionId,
      expectedDraftChecksum: draft.checksum,
      now: fixture.now + 2,
    }));

    const afterPublication = await backend.run(async (ctx) => {
      const profile = await ctx.db.get(fixture.profileId);
      const membership = await ctx.db.get(fixture.membershipId);
      const published = await ctx.db.get(draft.policyVersionId);
      const previous = await ctx.db.get(fixture.policyId);
      if (!membership || !published) {
        throw new Error("The published participant policy state is missing.");
      }
      return {
        complete: isProfileCompleteForPolicy(profile, membership, published),
        previousStatus: previous?.status,
      };
    });
    expect(afterPublication).toEqual({ complete: false, previousStatus: "superseded" });

    await backend.run(async (ctx) => {
      const profile = await ctx.db.get(fixture.profileId);
      const membership = await ctx.db.get(fixture.membershipId);
      if (!profile || !membership) throw new Error("The participant profile state is missing.");
      await ctx.db.patch(profile._id, {
        phone: "+91 90000 00000",
        profileVersion: profile.profileVersion + 1,
        updatedAt: fixture.now + 3,
      });
      await ctx.db.patch(membership._id, {
        acceptedParticipantPolicyVersionIds: [fixture.policyId, draft.policyVersionId],
        updatedAt: fixture.now + 3,
      });
    });
    const afterAcceptance = await backend.run(async (ctx) => {
      const profile = await ctx.db.get(fixture.profileId);
      const membership = await ctx.db.get(fixture.membershipId);
      const published = await ctx.db.get(draft.policyVersionId);
      if (!membership || !published) {
        throw new Error("The published participant policy state is missing.");
      }
      return isProfileCompleteForPolicy(profile, membership, published);
    });
    expect(afterAcceptance).toBe(true);
  });
});

function policy(label: string, teamMaximumSize: number): ParticipantPolicy {
  return {
    ...defaultParticipantPolicy,
    label: `Participant policy · ${label}`,
    teamMaximumSize,
  };
}

async function seedFixture(backend: BackendTest, slug: string) {
  const now = Date.UTC(2027, 6, 1, 9, 0);
  return backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId: `participant-policy-${slug}`,
      googleSubject: `participant-policy-${slug}`,
      verifiedEmail: `${slug}@example.test`,
      displayName: "Participant policy fixture",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: `participant-policy-${slug}`,
      name: "Code2Create participant-policy fixture",
      timezone: "Asia/Kolkata",
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
      createdByPersonId: personId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const initialPolicy = normalizeParticipantPolicy(policy("Initial", 4));
    const policyId = await ctx.db.insert("participantPolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...initialPolicy,
      checksum: participantPolicyChecksum(initialPolicy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.patch(eventId, { publishedParticipantPolicyId: policyId });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: `${slug}@example.test`,
      displayName: "Participant policy fixture",
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
      onboardingStatus: "team_required",
      acceptedParticipantPolicyVersionIds: [policyId],
      createdAt: now,
      updatedAt: now,
    });
    const profileId = await ctx.db.insert("participantProfiles", {
      eventId,
      membershipId,
      participantClass: "external_participant",
      fullName: "Aarav Menon",
      institution: "Example University",
      yearOfStudy: "third",
      externalCountry: "India",
      profileVersion: 1,
      updatedAt: now,
    });
    const event = await ctx.db.get(eventId);
    if (!event) throw new Error("The participant-policy fixture event did not persist.");
    return { now, event, personId, policyId, membershipId, profileId };
  });
}
