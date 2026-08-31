import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import {
  admissionPolicyChecksum,
  defaultAdmissionCriteria,
  defaultAdmissionReasonCodes,
} from "./lib/admissionPolicy.ts";
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

  test("preserves the fresh-build rule and explicit team-lock and edit-deadline warning", () => {
    expect(() => normalizeParticipantPolicy({
      ...defaultParticipantPolicy,
      freshProjectAttestation: "We might start the project whenever it is convenient for us.",
    })).toThrow("fixed fresh-build rule");
    expect(() => normalizeParticipantPolicy({
      ...defaultParticipantPolicy,
      finalSubmissionWarning: "Please check everything carefully before submitting this application.",
    })).toThrow("team and proposal remain editable until the deadline");
    expect(participantClassesMeetPolicy(
      ["vit_student", "external_participant"],
      { ...defaultParticipantPolicy, mixedParticipantClassesAllowed: false },
    )).toBe(false);
    expect(() => normalizeParticipantPolicy({
      ...defaultParticipantPolicy,
      mixedParticipantClassesAllowed: true,
    })).toThrow("must form separate teams");
    expect(normalizeParticipantPolicy({
      ...defaultParticipantPolicy,
      teamMaximumSize: 24,
    }).teamMaximumSize).toBe(24);
    expect(() => normalizeParticipantPolicy({
      ...defaultParticipantPolicy,
      teamMinimumSize: 0,
    })).toThrow("positive whole number");
  });

  test("normalizes an Ops-managed VIT residence catalogue", () => {
    const policy = normalizeParticipantPolicy({
      ...defaultParticipantPolicy,
      vitHostelResidenceCatalog: [
        { stableKey: " day_scholar ", label: " Day scholar ", kind: "day_scholar" },
        { stableKey: "mh_new_annex", label: " New annex ", kind: "mens" },
      ],
    });
    expect(policy.vitHostelResidenceCatalog).toEqual([
      { stableKey: "day_scholar", label: "Day scholar", kind: "day_scholar" },
      { stableKey: "mh_new_annex", label: "New annex", kind: "mens" },
    ]);
    expect(() => normalizeParticipantPolicy({
      ...defaultParticipantPolicy,
      vitHostelResidenceCatalog: [
        { stableKey: "day_scholar", label: "Day scholar", kind: "day_scholar" },
        { stableKey: "day_scholar", label: "Duplicate", kind: "mens" },
      ],
    })).toThrow("duplicated");
    expect(() => normalizeParticipantPolicy({
      ...defaultParticipantPolicy,
      vitHostelResidenceCatalog: [
        { stableKey: "mh_a", label: "A block", kind: "mens" },
        { stableKey: "lh_a", label: "A block", kind: "ladies" },
      ],
    })).toThrow("exactly one day-scholar");
  });

  test("VIT hostel completeness requires a current block and room, or day scholar", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "hostel-complete");
    await backend.run(async (ctx) => {
      await ctx.db.patch(fixture.membershipId, { participantClass: "vit_student" });
      await ctx.db.patch(fixture.profileId, {
        participantClass: "vit_student",
        yearOfStudy: "third",
        vitRegistrationNumber: "24TST0001",
        vitProgramme: "TST",
        vitCampus: "Vellore",
        currentRole: undefined,
        externalCity: undefined,
        externalCountry: undefined,
      });
      const membership = await ctx.db.get(fixture.membershipId);
      const policy = await ctx.db.get(fixture.policyId);
      if (!membership || !policy) throw new Error("The hostel completeness fixture is missing.");
      const incomplete = await ctx.db.get(fixture.profileId);
      if (!incomplete) throw new Error("The hostel completeness profile is missing.");
      expect(isProfileCompleteForPolicy(incomplete, membership, policy)).toBe(false);
      await ctx.db.patch(incomplete._id, { vitHostelResidence: "mh_b" });
      const blockOnly = await ctx.db.get(incomplete._id);
      if (!blockOnly) throw new Error("The hostel block-only profile is missing.");
      expect(isProfileCompleteForPolicy(blockOnly, membership, policy)).toBe(false);
      await ctx.db.patch(incomplete._id, {
        vitHostelResidence: "mh_b",
        vitHostelRoomNumber: "108",
      });
      const hosteller = await ctx.db.get(incomplete._id);
      if (!hosteller) throw new Error("The hosteller profile is missing.");
      expect(isProfileCompleteForPolicy(hosteller, membership, policy)).toBe(true);
      await ctx.db.patch(incomplete._id, {
        vitHostelResidence: "day_scholar",
        vitHostelRoomNumber: undefined,
      });
      const dayScholar = await ctx.db.get(incomplete._id);
      if (!dayScholar) throw new Error("The day-scholar profile is missing.");
      expect(isProfileCompleteForPolicy(dayScholar, membership, policy)).toBe(true);
    });
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

  test("publication derives its limit from capacity and cannot strand an existing roster", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "team-size-publication", 20, 30, 10);
    await backend.run(async (ctx) => {
      const teamId = await ctx.db.insert("teams", {
        eventId: fixture.event._id,
        name: "Thirteen-member team",
        publicCode: "THIRTEEN",
        leadMembershipId: fixture.membershipId,
        status: "forming",
        activeMemberCount: 13,
        activeVitMemberCount: 0,
        activeExternalMemberCount: 13,
        membershipLocked: false,
        version: 1,
        createdAt: fixture.now,
        updatedAt: fixture.now,
      });
      for (let index = 0; index < 13; index += 1) {
        let membershipId = fixture.membershipId;
        if (index > 0) {
          const personId = await ctx.db.insert("people", {
            authUserId: `team-size-member-auth-${index}`,
            googleSubject: `team-size-member-google-${index}`,
            verifiedEmail: `team-size-member-${index}@example.test`,
            displayName: `Team size member ${index}`,
            status: "active",
            createdAt: fixture.now,
            updatedAt: fixture.now,
          });
          const subjectId = await ctx.db.insert("eventAccessSubjects", {
            eventId: fixture.event._id,
            personId,
            emailNormalized: `team-size-member-${index}@example.test`,
            displayName: `Team size member ${index}`,
            status: "active",
            linkedBy: "participant_provisioning",
            accessVersion: 1,
            createdAt: fixture.now,
            updatedAt: fixture.now,
          });
          membershipId = await ctx.db.insert("eventMemberships", {
            eventId: fixture.event._id,
            personId,
            eventAccessSubjectId: subjectId,
            participantClass: "external_participant",
            eligibilityStatus: "eligible",
            onboardingStatus: "project_required",
            acceptedParticipantPolicyVersionIds: [fixture.policyId],
            createdAt: fixture.now,
            updatedAt: fixture.now,
          });
        }
        await ctx.db.insert("teamMembers", {
          eventId: fixture.event._id,
          teamId,
          membershipId,
          role: index === 0 ? "lead" : "member",
          status: "active",
          joinedAt: fixture.now,
          source: index === 0 ? "created" : "invitation",
        });
      }
    });

    const overCapacity = await backend.run((ctx) => saveParticipantPolicyDraft(ctx, {
      event: fixture.event,
      actorPersonId: fixture.personId,
      policy: policy("Over capacity", 31),
      now: fixture.now + 1,
    }));
    await expect(backend.run((ctx) => publishParticipantPolicy(ctx, {
      event: fixture.event,
      draftPolicyId: overCapacity.policyVersionId,
      expectedDraftChecksum: overCapacity.checksum,
      now: fixture.now + 2,
    }))).rejects.toThrow("cannot exceed the published participant capacity of 30");

    const belowRoster = await backend.run((ctx) => saveParticipantPolicyDraft(ctx, {
      event: fixture.event,
      actorPersonId: fixture.personId,
      expectedDraftPolicyId: overCapacity.policyVersionId,
      policy: policy("Below roster", 12),
      now: fixture.now + 3,
    }));
    await expect(backend.run((ctx) => publishParticipantPolicy(ctx, {
      event: fixture.event,
      draftPolicyId: belowRoster.policyVersionId,
      expectedDraftChecksum: belowRoster.checksum,
      now: fixture.now + 4,
    }))).rejects.toThrow("Thirteen-member team");

    const aboveRosterMinimum = await backend.run((ctx) => saveParticipantPolicyDraft(ctx, {
      event: fixture.event,
      actorPersonId: fixture.personId,
      expectedDraftPolicyId: belowRoster.policyVersionId,
      policy: policy("Above roster minimum", 20, 14),
      now: fixture.now + 5,
    }));
    await expect(backend.run((ctx) => publishParticipantPolicy(ctx, {
      event: fixture.event,
      draftPolicyId: aboveRosterMinimum.policyVersionId,
      expectedDraftChecksum: aboveRosterMinimum.checksum,
      now: fixture.now + 6,
    }))).rejects.toThrow("fewer than 14 active members");

    const loosenedBounds = await backend.run((ctx) => saveParticipantPolicyDraft(ctx, {
      event: fixture.event,
      actorPersonId: fixture.personId,
      expectedDraftPolicyId: aboveRosterMinimum.policyVersionId,
      policy: policy("Loosened bounds", 25, 5),
      now: fixture.now + 7,
    }));
    await backend.run((ctx) => publishParticipantPolicy(ctx, {
      event: fixture.event,
      draftPolicyId: loosenedBounds.policyVersionId,
      expectedDraftChecksum: loosenedBounds.checksum,
      now: fixture.now + 8,
    }));
    const published = await backend.run((ctx) => ctx.db.get(loosenedBounds.policyVersionId));
    expect(published?.status).toBe("published");
    expect(published?.teamMinimumSize).toBe(5);
    expect(published?.teamMaximumSize).toBe(25);
  });

  test("withdrawn team history does not block a new minimum", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "withdrawn-team-history", 4, 30);
    await backend.run((ctx) => ctx.db.insert("teams", {
      eventId: fixture.event._id,
      name: "Withdrawn team",
      publicCode: "WITHDRAWN",
      leadMembershipId: fixture.membershipId,
      status: "withdrawn",
      activeMemberCount: 0,
      activeVitMemberCount: 0,
      activeExternalMemberCount: 0,
      membershipLocked: false,
      version: 2,
      createdAt: fixture.now,
      updatedAt: fixture.now,
    }));
    const draft = await backend.run((ctx) => saveParticipantPolicyDraft(ctx, {
      event: fixture.event,
      actorPersonId: fixture.personId,
      policy: policy("Larger minimum", 4, 2),
      now: fixture.now + 1,
    }));
    await backend.run((ctx) => publishParticipantPolicy(ctx, {
      event: fixture.event,
      draftPolicyId: draft.policyVersionId,
      expectedDraftChecksum: draft.checksum,
      now: fixture.now + 2,
    }));
    const published = await backend.run((ctx) => ctx.db.get(draft.policyVersionId));
    expect(published?.status).toBe("published");
    expect(published?.teamMinimumSize).toBe(2);
  });

  test("a single-class policy cannot strand a current mixed team", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend, "mixed-team-publication", 4, 30);
    const teamId = await backend.run(async (ctx) => {
      const id = await ctx.db.insert("teams", {
        eventId: fixture.event._id,
        name: "Mixed current team",
        publicCode: "MIXEDTEAM",
        leadMembershipId: fixture.membershipId,
        status: "forming",
        activeMemberCount: 2,
        activeVitMemberCount: 1,
        activeExternalMemberCount: 1,
        membershipLocked: false,
        version: 1,
        createdAt: fixture.now,
        updatedAt: fixture.now,
      });
      await ctx.db.insert("teamMembers", {
        eventId: fixture.event._id,
        teamId: id,
        membershipId: fixture.membershipId,
        role: "lead",
        status: "active",
        joinedAt: fixture.now,
        source: "created",
      });
      const personId = await ctx.db.insert("people", {
        authUserId: "mixed-team-vit-auth",
        googleSubject: "mixed-team-vit-google",
        verifiedEmail: "mixed-team-vit@vitstudent.ac.in",
        displayName: "VIT teammate",
        status: "active",
        createdAt: fixture.now,
        updatedAt: fixture.now,
      });
      const subjectId = await ctx.db.insert("eventAccessSubjects", {
        eventId: fixture.event._id,
        personId,
        emailNormalized: "mixed-team-vit@vitstudent.ac.in",
        displayName: "VIT teammate",
        status: "active",
        linkedBy: "participant_provisioning",
        accessVersion: 1,
        createdAt: fixture.now,
        updatedAt: fixture.now,
      });
      const membershipId = await ctx.db.insert("eventMemberships", {
        eventId: fixture.event._id,
        personId,
        eventAccessSubjectId: subjectId,
        participantClass: "vit_student",
        eligibilityStatus: "eligible",
        onboardingStatus: "project_required",
        acceptedParticipantPolicyVersionIds: [fixture.policyId],
        createdAt: fixture.now,
        updatedAt: fixture.now,
      });
      await ctx.db.insert("teamMembers", {
        eventId: fixture.event._id,
        teamId: id,
        membershipId,
        role: "member",
        status: "active",
        joinedAt: fixture.now,
        source: "invitation",
      });
      return id;
    });
    const draft = await backend.run((ctx) => saveParticipantPolicyDraft(ctx, {
      event: fixture.event,
      actorPersonId: fixture.personId,
      policy: {
        ...policy("Single class", 4),
        mixedParticipantClassesAllowed: false,
      },
      now: fixture.now + 1,
    }));
    await expect(backend.run((ctx) => publishParticipantPolicy(ctx, {
      event: fixture.event,
      draftPolicyId: draft.policyVersionId,
      expectedDraftChecksum: draft.checksum,
      now: fixture.now + 2,
    }))).rejects.toThrow("contains both VIT and external participants");

    await backend.run((ctx) => ctx.db.patch(teamId, {
      status: "withdrawn",
      version: 2,
      updatedAt: fixture.now + 3,
    }));
    await backend.run((ctx) => publishParticipantPolicy(ctx, {
      event: fixture.event,
      draftPolicyId: draft.policyVersionId,
      expectedDraftChecksum: draft.checksum,
      now: fixture.now + 4,
    }));
    const published = await backend.run((ctx) => ctx.db.get(draft.policyVersionId));
    expect(published?.status).toBe("published");
    expect(published?.mixedParticipantClassesAllowed).toBe(false);
  });
});

function policy(
  label: string,
  teamMaximumSize: number,
  teamMinimumSize = 1,
): ParticipantPolicy {
  return {
    ...defaultParticipantPolicy,
    label: `Participant policy · ${label}`,
    teamMinimumSize,
    teamMaximumSize,
  };
}

async function seedFixture(
  backend: BackendTest,
  slug: string,
  teamMaximumSize = 4,
  participantCapacity = 100,
  teamMinimumSize = 1,
) {
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
      externalApplicationsCloseAt: Date.now() + 86_400_000,
      applicationsCloseAt: Date.now() + 86_400_000,
      createdByPersonId: personId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const initialPolicy = normalizeParticipantPolicy(
      policy("Initial", teamMaximumSize, teamMinimumSize),
    );
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
    const admissionPolicy = {
      version: "admission-v1",
      aiRecommendationMode: "disabled" as const,
      minimumHumanReviews: 2,
      overallParticipantCapacity: participantCapacity,
      criteria: defaultAdmissionCriteria,
      decisionReasonCodes: defaultAdmissionReasonCodes,
    };
    const admissionPolicyId = await ctx.db.insert("admissionPolicyVersions", {
      eventId,
      ...admissionPolicy,
      status: "published",
      checksum: admissionPolicyChecksum(admissionPolicy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.patch(eventId, {
      publishedParticipantPolicyId: policyId,
      publishedAdmissionPolicyId: admissionPolicyId,
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
    return { now, event, personId, subjectId, policyId, membershipId, profileId };
  });
}
