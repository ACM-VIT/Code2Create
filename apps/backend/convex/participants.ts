import { ConvexError, v } from "convex/values";
import {
  normalizeParticipantName,
  normalizeParticipantPhone,
  participantNameValidationError,
  participantPhoneValidationError,
} from "@code2create/domain";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { authComponent } from "./auth";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug, requireRegistrationOpen } from "./lib/events";
import {
  ensurePerson,
  findCurrentPerson,
  requireCurrentPerson,
  requireEligibleMembership,
  requireEventSubject,
  requireMembership,
  requireStagingParticipantAccess,
  stagingParticipantAccessAllowed,
} from "./lib/identity";
import {
  addEventSubjectSelfGrants,
  insertPermissionGrant,
  matchingPermissionGrantIds,
  requirePermission,
} from "./lib/permissions";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
} from "./lib/operations";
import {
  isProfileCompleteForPolicy,
  loadPublishedParticipantPolicy,
  participantPolicyInput,
} from "./lib/participantPolicy";
import { normalizedText } from "./lib/strings";
import { parsedHostelDetails } from "./lib/vitHostel";
import {
  isApprovedVitStudentIdentity,
  parseVitStudentGoogleDisplayName,
  vitIdentityReferenceYear,
  vitInstitutionName,
} from "./lib/vitStudentIdentity";
import {
  claimPendingTeamRosterEntry,
  pendingTeamAssignees,
  rosterIdentitiesForPerson,
  teamRosterPendingEntry,
} from "./lib/teamBackfill";
import {
  memberRole,
  participantClass,
  participantEligibilityStatus,
  participantGender,
  participantOnboardingStatus,
  studyYear,
  vitResidenceType,
} from "./values";

const profileView = v.object({
  id: v.id("participantProfiles"),
  participantClass,
  fullName: v.string(),
  phone: v.string(),
  gender: participantGender,
  institution: v.string(),
  yearOfStudy: studyYear,
  vitRegistrationNumber: v.optional(v.string()),
  vitProgramme: v.optional(v.string()),
  vitResidenceType: v.optional(vitResidenceType),
  vitHostelResidence: v.optional(v.string()),
  vitHostelRoomNumber: v.optional(v.string()),
  externalUniversity: v.optional(v.string()),
  externalCollege: v.optional(v.string()),
  isComplete: v.boolean(),
  profileVersion: v.number(),
});

const currentParticipantPolicyView = v.object({
  id: v.id("participantPolicyVersions"),
  version: v.number(),
  accepted: v.boolean(),
  policy: participantPolicyInput,
});

const membershipViewFields = {
  id: v.id("eventMemberships"),
  eligibilityStatus: participantEligibilityStatus,
  onboardingStatus: participantOnboardingStatus,
};

const participantMembershipView = v.union(
  v.object({
    ...membershipViewFields,
    participantClass: v.literal("vit_student"),
    vitStudentIdentity: v.union(
      v.null(),
      v.object({
        fullName: v.string(),
        registrationNumber: v.string(),
        programmeCode: v.string(),
        yearOfStudy: studyYear,
      }),
    ),
  }),
  v.object({
    ...membershipViewFields,
    participantClass: v.literal("external_participant"),
  }),
);

function requireVitStudentProfileIdentity(
  displayName: string,
  event: Doc<"events">,
) {
  const identity = parseVitStudentGoogleDisplayName(
    displayName,
    vitIdentityReferenceYear(event),
  );
  if (!identity) {
    throw new ConvexError({
      code: "VIT_GOOGLE_PROFILE_INVALID",
      message:
        "Your VIT Google account name must end with a valid registration number. Ask VIT to correct the Google profile name, then sign in again.",
    });
  }
  return identity;
}

async function readVitStudentIdentity(
  ctx: QueryCtx | MutationCtx,
  event: Doc<"events">,
  person: Doc<"people">,
  membership: Doc<"eventMemberships">,
) {
  if (membership.participantClass !== "vit_student") {
    throw new Error("A non-VIT membership cannot have a VIT student identity.");
  }
  if (membership.vitStudentIdentity) return membership.vitStudentIdentity;
  const googleIdentity = await ctx.db
    .query("googleIdentityClaims")
    .withIndex("by_auth_user", (index) => index.eq("authUserId", person.authUserId))
    .unique();
  if (!googleIdentity?.displayName) return null;
  return parseVitStudentGoogleDisplayName(
    googleIdentity.displayName,
    vitIdentityReferenceYear(event),
  );
}

async function repairVitStudentIdentity(
  ctx: MutationCtx,
  event: Doc<"events">,
  person: Doc<"people">,
  membership: Doc<"eventMemberships">,
) {
  const identity = await readVitStudentIdentity(ctx, event, person, membership);
  if (!identity) {
    throw new ConvexError({
      code: "GOOGLE_IDENTITY_REFRESH_REQUIRED",
      message: "Sign out and complete Google authentication again before continuing.",
    });
  }
  if (!membership.vitStudentIdentity) {
    await requireAvailableVitRegistrationNumber(ctx, {
      eventId: event._id,
      registrationNumber: identity.registrationNumber,
      membershipId: membership._id,
    });
    await ctx.db.patch(membership._id, {
      vitStudentIdentity: identity,
      updatedAt: Date.now(),
    });
  }
  return identity;
}

async function requireAvailableVitRegistrationNumber(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    registrationNumber: string;
    membershipId?: Id<"eventMemberships">;
  },
) {
  const matches = await ctx.db
    .query("eventMemberships")
    .withIndex("by_event_vit_registration", (index) =>
      index
        .eq("eventId", args.eventId)
        .eq("vitStudentIdentity.registrationNumber", args.registrationNumber),
    )
    .take(2);
  if (matches.some((candidate) => candidate._id !== args.membershipId)) {
    throw new ConvexError({
      code: "VIT_REGISTRATION_NUMBER_IN_USE",
      message:
        "That VIT registration number is already linked to another event account. Ask support to resolve the duplicate identity.",
    });
  }
}

export const entryAllowed = query({
  args: { eventSlug: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const [event, user] = await Promise.all([
      requireEventBySlug(ctx, args.eventSlug),
      authComponent.safeGetAuthUser(ctx),
    ]);
    if (!user?.emailVerified) return false;
    return stagingParticipantAccessAllowed(ctx, event._id, user.email);
  },
});

export const me = query({
  args: { eventSlug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      person: v.object({
        id: v.id("people"),
        displayName: v.string(),
        verifiedEmail: v.string(),
      }),
      membership: v.union(v.null(), participantMembershipView),
      pendingTeam: v.union(
        v.null(),
        v.object({
          id: v.id("teamRosterEntries"),
          version: v.number(),
          teamName: v.string(),
          role: memberRole,
          status: v.union(v.literal("pending"), v.literal("waiting_for_lead")),
          assignees: v.array(
            v.object({
              displayName: v.string(),
              role: memberRole,
              signedIn: v.boolean(),
              isYou: v.boolean(),
            }),
          ),
        }),
      ),
      profile: v.union(v.null(), profileView),
      participantPolicy: currentParticipantPolicyView,
    }),
  ),
  handler: async (ctx, args) => {
    const person = await findCurrentPerson(ctx);
    if (!person) return null;
    const event = await requireEventBySlug(ctx, args.eventSlug);
    if (!(await stagingParticipantAccessAllowed(ctx, event._id, person.verifiedEmail))) {
      return null;
    }
    const participantPolicy = await loadPublishedParticipantPolicy(ctx, event);
    const membership = await ctx.db
      .query("eventMemberships")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", person._id),
      )
      .unique();
    let canReadProfile = false;
    if (membership) {
      const subject = await requireEventSubject(ctx, event._id, person._id);
      const grantIds = await matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "participant.profile.read",
        scopeType: "self",
        scopeId: membership._id,
      });
      canReadProfile = grantIds.length > 0;
    }
    const profile = membership && canReadProfile
      ? await ctx.db
          .query("participantProfiles")
          .withIndex("by_membership", (index) => index.eq("membershipId", membership._id))
          .unique()
      : null;
    const visibleMembership = membership?.participantClass === "vit_student"
      ? {
          id: membership._id,
          participantClass: membership.participantClass,
          eligibilityStatus: membership.eligibilityStatus,
          onboardingStatus: membership.onboardingStatus,
          vitStudentIdentity: await readVitStudentIdentity(ctx, event, person, membership),
        }
      : membership
        ? {
            id: membership._id,
            participantClass: membership.participantClass,
            eligibilityStatus: membership.eligibilityStatus,
            onboardingStatus: membership.onboardingStatus,
          }
        : null;
    const viewerIdentities = [...rosterIdentitiesForPerson(person, membership)];
    const visibleVitStudentIdentity = visibleMembership?.participantClass === "vit_student"
      ? visibleMembership.vitStudentIdentity
      : null;
    if (
      visibleVitStudentIdentity &&
      !viewerIdentities.includes(visibleVitStudentIdentity.registrationNumber)
    ) {
      viewerIdentities.push(visibleVitStudentIdentity.registrationNumber);
    }
    const pendingEntry = await teamRosterPendingEntry(ctx, {
      eventId: event._id,
      identities: viewerIdentities,
    });
    const pendingTeam = pendingEntry
      ? {
          id: pendingEntry._id,
          version: pendingEntry.version,
          teamName: pendingEntry.teamName,
          role: pendingEntry.role,
          status: pendingEntry.status,
          assignees: await pendingTeamAssignees(ctx, {
            eventId: event._id,
            teamName: pendingEntry.teamName,
            viewerIdentities,
          }),
        }
      : null;
    return {
      person: {
        id: person._id,
        displayName: person.displayName,
        verifiedEmail: person.verifiedEmail,
      },
      membership: visibleMembership,
      pendingTeam,
      profile: profile && membership
        ? {
            id: profile._id,
            participantClass: profile.participantClass,
            fullName: profile.fullName,
            phone: profile.phone,
            gender: profile.gender,
            institution: profile.institution,
            yearOfStudy: profile.yearOfStudy,
            ...(profile.vitRegistrationNumber !== undefined
              ? { vitRegistrationNumber: profile.vitRegistrationNumber }
              : {}),
            ...(profile.vitProgramme !== undefined
              ? { vitProgramme: profile.vitProgramme }
              : {}),
            ...(profile.vitResidenceType !== undefined
              ? { vitResidenceType: profile.vitResidenceType }
              : {}),
            ...(profile.vitHostelResidence !== undefined
              ? { vitHostelResidence: profile.vitHostelResidence }
              : {}),
            ...(profile.vitHostelRoomNumber !== undefined
              ? { vitHostelRoomNumber: profile.vitHostelRoomNumber }
              : {}),
            ...(profile.externalUniversity !== undefined
              ? { externalUniversity: profile.externalUniversity }
              : {}),
            ...(profile.externalCollege !== undefined
              ? { externalCollege: profile.externalCollege }
              : {}),
            isComplete: isProfileCompleteForPolicy(profile, membership, participantPolicy.policy),
            profileVersion: profile.profileVersion,
          }
        : null,
      participantPolicy: {
        id: participantPolicy.policy._id,
        version: participantPolicy.policy.version,
        accepted: Boolean(
          membership?.acceptedParticipantPolicyVersionIds.includes(participantPolicy.policy._id),
        ),
        policy: participantPolicy.normalized,
      },
    };
  },
});

export const provision = mutation({
  args: { eventSlug: v.string(), participantClass },
  returns: v.object({ membershipId: v.id("eventMemberships"), created: v.boolean() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person, googleIdentity } = await ensurePerson(ctx);
    await requireStagingParticipantAccess(ctx, event._id, person.verifiedEmail);
    const approvedVitIdentity = isApprovedVitStudentIdentity({
      verifiedEmail: googleIdentity.verifiedEmail,
      ...(googleIdentity.hostedDomain !== undefined
        ? { hostedDomain: googleIdentity.hostedDomain }
        : {}),
      allowedDomains: event.vitEmailDomains,
    });
    if (args.participantClass === "vit_student" && !approvedVitIdentity) {
      throw new ConvexError({
        code: "VIT_EMAIL_REQUIRED",
        message: "VIT student registration requires a verified @vitstudent.ac.in Google Workspace account.",
      });
    }
    const resolvedParticipantClass = approvedVitIdentity
      ? "vit_student"
      : "external_participant";
    requireRegistrationOpen(event, resolvedParticipantClass);

    const existingMembership = await ctx.db
      .query("eventMemberships")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", person._id),
      )
      .unique();
    if (existingMembership) {
      if (existingMembership.participantClass !== resolvedParticipantClass) {
        throw new ConvexError({
          code: "PARTICIPANT_CLASS_LOCKED",
          message: "Participant class is already set. Ask support to correct it.",
        });
      }
      if (existingMembership.participantClass === "vit_student") {
        await repairVitStudentIdentity(ctx, event, person, existingMembership);
      }
      await claimPendingTeamRosterEntry(ctx, {
        event,
        person,
      });
      return { membershipId: existingMembership._id, created: false };
    }

    const vitStudentIdentity = resolvedParticipantClass === "vit_student"
      ? requireVitStudentProfileIdentity(googleIdentity.displayName, event)
      : null;
    if (vitStudentIdentity) {
      await requireAvailableVitRegistrationNumber(ctx, {
        eventId: event._id,
        registrationNumber: vitStudentIdentity.registrationNumber,
      });
    }

    const now = Date.now();
    let subject = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", person._id),
      )
      .unique();
    if (subject && subject.status !== "active") {
      throw new ConvexError({
        code: "EVENT_ACCESS_NOT_ACTIVE",
        message: "This account's event access is not active.",
      });
    }
    const subjectCreated = !subject;
    if (!subject) {
      const subjectId = await ctx.db.insert("eventAccessSubjects", {
        eventId: event._id,
        personId: person._id,
        emailNormalized: person.verifiedEmail,
        displayName: person.displayName,
        status: "active",
        linkedBy: "participant_provisioning",
        accessVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      subject = await ctx.db.get(subjectId);
    }
    if (!subject) throw new Error("Event access subject creation did not persist.");

    await addEventSubjectSelfGrants(ctx, {
      eventId: event._id,
      personId: person._id,
      eventAccessSubjectId: subject._id,
    });

    const membershipId = await ctx.db.insert("eventMemberships", {
      eventId: event._id,
      personId: person._id,
      eventAccessSubjectId: subject._id,
      participantClass: resolvedParticipantClass,
      ...(vitStudentIdentity ? { vitStudentIdentity } : {}),
      eligibilityStatus: "eligible",
      onboardingStatus: "profile_required",
      acceptedParticipantPolicyVersionIds: [],
      ...(googleIdentity.hostedDomain !== undefined
        ? { googleHostedDomain: googleIdentity.hostedDomain }
        : {}),
      createdAt: now,
      updatedAt: now,
    });
    const sourceId = membershipId;
    await insertPermissionGrant(ctx, {
      eventId: event._id,
      personId: person._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "participant.profile.read",
      scopeType: "self",
      scopeId: membershipId,
      sourceType: "participant_membership",
      sourceId,
      reason: "Participant membership",
    });
    await insertPermissionGrant(ctx, {
      eventId: event._id,
      personId: person._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "participant.profile.write",
      scopeType: "self",
      scopeId: membershipId,
      sourceType: "participant_membership",
      sourceId,
      reason: "Participant membership",
    });
    await insertPermissionGrant(ctx, {
      eventId: event._id,
      personId: person._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.join",
      scopeType: "self",
      scopeId: membershipId,
      sourceType: "participant_membership",
      sourceId,
      reason: "Participant membership",
    });
    await insertPermissionGrant(ctx, {
      eventId: event._id,
      personId: person._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "communications.delivery.self.read",
      scopeType: "self",
      scopeId: membershipId,
      sourceType: "participant_membership",
      sourceId,
      reason: "Participant membership",
    });
    await insertPermissionGrant(ctx, {
      eventId: event._id,
      personId: person._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.self.read",
      scopeType: "self",
      scopeId: membershipId,
      sourceType: "participant_membership",
      sourceId,
      reason: "Participant membership",
    });
    await insertPermissionGrant(ctx, {
      eventId: event._id,
      personId: person._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.remedy.self.read",
      scopeType: "self",
      scopeId: membershipId,
      sourceType: "participant_membership",
      sourceId,
      reason: "Participant membership",
    });
    await insertPermissionGrant(ctx, {
      eventId: event._id,
      personId: person._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.remedy.self.open",
      scopeType: "self",
      scopeId: membershipId,
      sourceType: "participant_membership",
      sourceId,
      reason: "Participant membership",
    });
    await insertPermissionGrant(ctx, {
      eventId: event._id,
      personId: person._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "attendance.portal_qr.mint",
      scopeType: "self",
      scopeId: membershipId,
      sourceType: "participant_membership",
      sourceId,
      reason: "Participant membership",
    });

    if (!subjectCreated) {
      await ctx.db.patch("eventAccessSubjects", subject._id, {
        accessVersion: subject.accessVersion + 1,
        updatedAt: now,
      });
    }

    await claimPendingTeamRosterEntry(ctx, {
      event,
      person,
    });

    return { membershipId, created: true };
  },
});

export const acceptPolicy = mutation({
  args: {
    eventSlug: v.string(),
    participantPolicyVersionId: v.id("participantPolicyVersions"),
    accepted: v.boolean(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    membershipId: v.id("eventMemberships"),
    participantPolicyVersionId: v.id("participantPolicyVersions"),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.participantPolicyVersionId,
      args.accepted,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "participant.policy.accept",
      requestFingerprint,
    });
    if (prior) {
      const membershipId = ctx.db.normalizeId("eventMemberships", prior.targetId);
      if (!membershipId) throw new Error("The prior participant-policy result is invalid.");
      return {
        membershipId,
        participantPolicyVersionId: args.participantPolicyVersionId,
      };
    }
    if (!args.accepted) {
      throw new ConvexError({
        code: "POLICY_REQUIRED",
        message: "Accept the current participant policy before continuing.",
      });
    }

    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = requireEligibleMembership(
      await requireMembership(ctx, event._id, person._id),
    );
    requireRegistrationOpen(event, membership.participantClass);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "participant.profile.write",
      scopeType: "self",
      scopeId: membership._id,
    });
    const participantPolicy = await loadPublishedParticipantPolicy(ctx, event);
    if (participantPolicy.policy._id !== args.participantPolicyVersionId) {
      throw new ConvexError({
        code: "PARTICIPANT_POLICY_CHANGED",
        message: "The participant policy changed. Review the current version before continuing.",
      });
    }

    const now = Date.now();
    const alreadyAccepted = membership.acceptedParticipantPolicyVersionIds.includes(
      participantPolicy.policy._id,
    );
    if (!alreadyAccepted) {
      await ctx.db.patch(membership._id, {
        acceptedParticipantPolicyVersionIds: [
          ...membership.acceptedParticipantPolicyVersionIds,
          participantPolicy.policy._id,
        ],
        updatedAt: now,
      });
    }
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "participant.policy.accept",
      requestFingerprint,
      targetType: "event_membership",
      targetId: membership._id,
      resultJson: participantPolicy.policy._id,
      createdAt: now,
    });
    if (!alreadyAccepted) {
      await writeAuditEvent(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        permissionKey: "participant.profile.write",
        grantIds,
        scopeType: "self",
        scopeId: membership._id,
        action: "participant.policy.accepted",
        targetType: "participant_policy_version",
        targetId: participantPolicy.policy._id,
        nextSummary: JSON.stringify({
          participantPolicyVersionId: participantPolicy.policy._id,
          version: participantPolicy.policy.version,
        }),
        reason: "Participant accepted current policy",
      });
    }
    return {
      membershipId: membership._id,
      participantPolicyVersionId: participantPolicy.policy._id,
    };
  },
});

export const saveProfile = mutation({
  args: {
    eventSlug: v.string(),
    participantPolicyVersionId: v.id("participantPolicyVersions"),
    fullName: v.optional(v.string()),
    phone: v.string(),
    gender: participantGender,
    yearOfStudy: v.optional(studyYear),
    vitResidenceType: v.optional(vitResidenceType),
    vitHostelResidence: v.optional(v.string()),
    vitHostelRoomNumber: v.optional(v.string()),
    externalUniversity: v.optional(v.string()),
    externalCollege: v.optional(v.string()),
    expectedProfileVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ profileId: v.id("participantProfiles"), profileVersion: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.participantPolicyVersionId,
      args.fullName ?? null,
      args.phone,
      args.gender,
      args.yearOfStudy ?? null,
      args.vitResidenceType ?? null,
      args.vitHostelResidence ?? null,
      args.vitHostelRoomNumber ?? null,
      args.externalUniversity ?? null,
      args.externalCollege ?? null,
      args.expectedProfileVersion,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "participant.profile.save",
      requestFingerprint,
    });
    if (prior) {
      const profileId = ctx.db.normalizeId("participantProfiles", prior.targetId);
      if (!profileId) throw new Error("The stored participant profile is invalid.");
      return {
        profileId,
        profileVersion: storedOperationVersion(prior.resultJson, "participant profile"),
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = requireEligibleMembership(
      await requireMembership(ctx, event._id, person._id),
    );
    requireRegistrationOpen(event, membership.participantClass);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "participant.profile.write",
      scopeType: "self",
      scopeId: membership._id,
    });
    const participantPolicy = await loadPublishedParticipantPolicy(ctx, event);
    if (participantPolicy.policy._id !== args.participantPolicyVersionId) {
      throw new ConvexError({
        code: "PARTICIPANT_POLICY_CHANGED",
        message: "The participant policy changed. Review it before saving your profile.",
      });
    }
    if (!membership.acceptedParticipantPolicyVersionIds.includes(participantPolicy.policy._id)) {
      throw new ConvexError({
        code: "POLICY_REQUIRED",
        message: "Accept the current participant policy before continuing.",
      });
    }

    const policy = participantPolicy.normalized;
    const vitStudentIdentity = membership.participantClass === "vit_student"
      ? await repairVitStudentIdentity(ctx, event, person, membership)
      : null;
    const fullName = vitStudentIdentity
      ? vitStudentIdentity.fullName
      : normalizeParticipantName(args.fullName ?? "");
    const fullNameError = vitStudentIdentity
      ? null
      : participantNameValidationError(fullName);
    if (fullNameError) {
      throw new ConvexError({ code: "INVALID_PARTICIPANT_NAME", message: fullNameError });
    }
    const phoneError = participantPhoneValidationError(args.phone);
    if (phoneError) {
      throw new ConvexError({ code: "INVALID_PHONE", message: phoneError });
    }
    const phone = normalizeParticipantPhone(args.phone);
    const yearOfStudy = vitStudentIdentity?.yearOfStudy ?? args.yearOfStudy;
    if (!yearOfStudy || yearOfStudy === "not_applicable") {
      throw new ConvexError({
        code: "STUDY_YEAR_REQUIRED",
        message: "Choose your current year of study.",
      });
    }
    let externalUniversity: string | undefined;
    let externalCollege: string | undefined;
    let institution: string;
    if (vitStudentIdentity) {
      institution = vitInstitutionName;
    } else {
      externalUniversity = normalizedText(
        args.externalUniversity ?? "",
        "University",
        2,
        160,
      );
      externalCollege = normalizedText(args.externalCollege ?? "", "College", 2, 160);
      institution = externalCollege === externalUniversity
        ? externalUniversity
        : `${externalCollege}, ${externalUniversity}`;
    }
    const vitRegistrationNumber = vitStudentIdentity?.registrationNumber;
    const vitProgramme = vitStudentIdentity?.programmeCode;
    const {
      vitResidenceType,
      vitHostelResidence,
      vitHostelRoomNumber,
    } = parsedHostelDetails(
      membership.participantClass,
      args.gender,
      args.vitResidenceType,
      args.vitHostelResidence,
      args.vitHostelRoomNumber,
      policy.vitHostelResidenceCatalog,
    );

    const existing = await ctx.db
      .query("participantProfiles")
      .withIndex("by_membership", (index) => index.eq("membershipId", membership._id))
      .unique();
    const teamMembership = await ctx.db
      .query("teamMembers")
      .withIndex("by_event_membership_status", (index) =>
        index
          .eq("eventId", event._id)
          .eq("membershipId", membership._id)
          .eq("status", "active"),
      )
      .unique();
    if (teamMembership) {
      const team = await ctx.db.get(teamMembership.teamId);
      if (!team || team.eventId !== event._id) {
        throw new Error("The participant's active team membership is invalid.");
      }
      if (team.membershipLocked) {
        throw new ConvexError({
          code: "SUBMISSION_LOCKED",
          message: "Profiles cannot change while the team's submission is locked.",
        });
      }
    }
    const currentProfileVersion = existing?.profileVersion ?? 0;
    if (currentProfileVersion !== args.expectedProfileVersion) {
      throw new ConvexError({
        code: "PROFILE_CHANGED",
        message: "Your profile changed in another session. Review it and save again.",
      });
    }
    const now = Date.now();
    const profileVersion = currentProfileVersion + 1;
    let profileId;
    if (existing) {
      await ctx.db.patch(existing._id, {
        participantClass: membership.participantClass,
        fullName,
        phone,
        gender: args.gender,
        institution,
        yearOfStudy,
        vitRegistrationNumber,
        vitProgramme,
        vitResidenceType,
        vitHostelResidence,
        vitHostelRoomNumber,
        externalUniversity,
        externalCollege,
        profileVersion,
        updatedAt: now,
      });
      profileId = existing._id;
    } else {
      profileId = await ctx.db.insert("participantProfiles", {
        eventId: event._id,
        membershipId: membership._id,
        participantClass: membership.participantClass,
        fullName,
        phone,
        gender: args.gender,
        institution,
        yearOfStudy,
        ...(vitRegistrationNumber !== undefined ? { vitRegistrationNumber } : {}),
        ...(vitProgramme !== undefined ? { vitProgramme } : {}),
        ...(vitResidenceType !== undefined ? { vitResidenceType } : {}),
        ...(vitHostelResidence !== undefined ? { vitHostelResidence } : {}),
        ...(vitHostelRoomNumber !== undefined ? { vitHostelRoomNumber } : {}),
        ...(externalUniversity !== undefined ? { externalUniversity } : {}),
        ...(externalCollege !== undefined ? { externalCollege } : {}),
        profileVersion,
        updatedAt: now,
      });
    }

    await ctx.db.patch(membership._id, {
      onboardingStatus: teamMembership ? "project_required" : "github_required",
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "participant.profile.save",
      requestFingerprint,
      targetType: "participant_profile",
      targetId: profileId,
      resultJson: String(profileVersion),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "participant.profile.write",
      grantIds,
      scopeType: "self",
      scopeId: membership._id,
      action: existing ? "participant.profile.updated" : "participant.profile.created",
      targetType: "participant_profile",
      targetId: profileId,
      nextSummary: JSON.stringify({
        profileVersion,
        participantPolicyVersionId: participantPolicy.policy._id,
      }),
      reason: "Participant profile save",
    });

    return { profileId, profileVersion };
  },
});

export const declineAssignedTeam = mutation({
  args: {
    eventSlug: v.string(),
    teamRosterEntryId: v.id("teamRosterEntries"),
    expectedVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    teamRosterEntryId: v.id("teamRosterEntries"),
    status: v.literal("revoked"),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = requireEligibleMembership(
      await requireMembership(ctx, event._id, person._id),
    );
    const operationId = normalizedText(args.clientOperationId, "Client operation ID", 10, 100);
    const requestFingerprint = operationFingerprint([
      args.teamRosterEntryId,
      args.expectedVersion,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "participants.declineAssignedTeam",
      requestFingerprint,
    });
    if (prior) {
      const teamRosterEntryId = ctx.db.normalizeId("teamRosterEntries", prior.targetId);
      if (!teamRosterEntryId) throw new Error("The stored team assignment decline is invalid.");
      return { teamRosterEntryId, status: "revoked" as const };
    }
    requireRegistrationOpen(event, membership.participantClass);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.join",
      scopeType: "self",
      scopeId: membership._id,
    });
    const entry = await ctx.db.get("teamRosterEntries", args.teamRosterEntryId);
    if (!entry || entry.eventId !== event._id) {
      throw new ConvexError({
        code: "TEAM_ASSIGNMENT_NOT_FOUND",
        message: "That team assignment is not available.",
      });
    }
    const entryIdentity = entry.emailNormalized ?? entry.vitRegistrationNumber;
    if (
      entryIdentity === undefined ||
      !rosterIdentitiesForPerson(person, membership).includes(entryIdentity)
    ) {
      throw new ConvexError({
        code: "TEAM_ASSIGNMENT_NOT_YOURS",
        message: "You can only leave your own assigned team.",
      });
    }
    if (entry.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "TEAM_ASSIGNMENT_CHANGED",
        message: "The team assignment changed. Review it and try again.",
      });
    }
    if (entry.status === "claimed") {
      throw new ConvexError({
        code: "TEAM_ASSIGNMENT_ALREADY_JOINED",
        message: "You are already on that team. Leave it from the team panel.",
      });
    }
    if (entry.status !== "pending" && entry.status !== "waiting_for_lead") {
      throw new ConvexError({
        code: "TEAM_ASSIGNMENT_NOT_CURRENT",
        message: "That team assignment is no longer waiting.",
      });
    }
    const now = Date.now();
    await ctx.db.patch("teamRosterEntries", entry._id, {
      status: "revoked",
      version: entry.version + 1,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "team.join",
      grantIds,
      scopeType: "self",
      scopeId: membership._id,
      action: "team.roster_assignment_declined",
      targetType: "team_roster_entry",
      targetId: entry._id,
      previousSummary: JSON.stringify({ status: entry.status, version: entry.version }),
      nextSummary: JSON.stringify({ status: "revoked", version: entry.version + 1 }),
      reason: "Participant left the assigned team before it formed",
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "participants.declineAssignedTeam",
      requestFingerprint,
      targetType: "team_roster_entry",
      targetId: entry._id,
      createdAt: now,
    });
    return { teamRosterEntryId: entry._id, status: "revoked" as const };
  },
});
