import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug, requireRegistrationOpen } from "./lib/events";
import {
  ensurePerson,
  findCurrentPerson,
  requireCurrentPerson,
  requireEligibleMembership,
  requireEventSubject,
  requireMembership,
} from "./lib/identity";
import {
  addEventSubjectSelfGrants,
  insertPermissionGrant,
  requirePermission,
} from "./lib/permissions";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import {
  isProfileCompleteForPolicy,
  loadPublishedParticipantPolicy,
  participantPolicyInput,
  type ProfileFieldMode,
} from "./lib/participantPolicy";
import {
  normalizedText,
  optionalNormalizedText,
} from "./lib/strings";
import { participantClass, studyYear } from "./values";

const profileView = v.object({
  id: v.id("participantProfiles"),
  participantClass,
  fullName: v.string(),
  preferredName: v.optional(v.string()),
  phone: v.optional(v.string()),
  institution: v.string(),
  yearOfStudy: studyYear,
  currentRole: v.optional(v.string()),
  vitRegistrationNumber: v.optional(v.string()),
  vitProgramme: v.optional(v.string()),
  vitCampus: v.optional(v.string()),
  externalCity: v.optional(v.string()),
  externalCountry: v.optional(v.string()),
  isComplete: v.boolean(),
  profileVersion: v.number(),
});

const currentParticipantPolicyView = v.object({
  id: v.id("participantPolicyVersions"),
  version: v.number(),
  accepted: v.boolean(),
  policy: participantPolicyInput,
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
      membership: v.union(
        v.null(),
        v.object({
          id: v.id("eventMemberships"),
          participantClass,
          eligibilityStatus: v.string(),
          onboardingStatus: v.string(),
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
    const participantPolicy = await loadPublishedParticipantPolicy(ctx, event);
    const membership = await ctx.db
      .query("eventMemberships")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", person._id),
      )
      .unique();
    if (membership) {
      const subject = await requireEventSubject(ctx, event._id, person._id);
      await requirePermission(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "participant.profile.read",
        scopeType: "self",
        scopeId: membership._id,
      });
    }
    const profile = membership
      ? await ctx.db
          .query("participantProfiles")
          .withIndex("by_membership", (index) => index.eq("membershipId", membership._id))
          .unique()
      : null;
    return {
      person: {
        id: person._id,
        displayName: person.displayName,
        verifiedEmail: person.verifiedEmail,
      },
      membership: membership
        ? {
            id: membership._id,
            participantClass: membership.participantClass,
            eligibilityStatus: membership.eligibilityStatus,
            onboardingStatus: membership.onboardingStatus,
          }
        : null,
      profile: profile && membership
        ? {
            id: profile._id,
            participantClass: profile.participantClass,
            fullName: profile.fullName,
            ...(profile.preferredName !== undefined
              ? { preferredName: profile.preferredName }
              : {}),
            ...(profile.phone !== undefined ? { phone: profile.phone } : {}),
            institution: profile.institution,
            yearOfStudy: profile.yearOfStudy,
            ...(profile.currentRole !== undefined
              ? { currentRole: profile.currentRole }
              : {}),
            ...(profile.vitRegistrationNumber !== undefined
              ? { vitRegistrationNumber: profile.vitRegistrationNumber }
              : {}),
            ...(profile.vitProgramme !== undefined
              ? { vitProgramme: profile.vitProgramme }
              : {}),
            ...(profile.vitCampus !== undefined ? { vitCampus: profile.vitCampus } : {}),
            ...(profile.externalCity !== undefined
              ? { externalCity: profile.externalCity }
              : {}),
            ...(profile.externalCountry !== undefined
              ? { externalCountry: profile.externalCountry }
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
    requireRegistrationOpen(event);
    const { person, googleIdentity } = await ensurePerson(ctx);
    const approvedVitIdentity =
      googleIdentity.hostedDomain !== undefined &&
      event.vitEmailDomains.includes(googleIdentity.hostedDomain);
    if (args.participantClass === "vit_student" && !approvedVitIdentity) {
      throw new ConvexError({
        code: "VIT_EMAIL_REQUIRED",
        message: "VIT Student registration requires Google to verify an approved VIT Workspace account.",
      });
    }
    const resolvedParticipantClass = approvedVitIdentity
      ? "vit_student"
      : "external_participant";

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
      return { membershipId: existingMembership._id, created: false };
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
    requireRegistrationOpen(event);
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

function policyField(
  value: string | undefined,
  mode: ProfileFieldMode,
  label: string,
  maximum: number,
) {
  if (mode === "not_collected") return undefined;
  const normalized = optionalNormalizedText(value, label, maximum);
  if (mode === "required" && normalized === undefined) {
    throw new ConvexError({
      code: "PROFILE_FIELD_REQUIRED",
      message: `${label} is required by the current participant policy.`,
    });
  }
  return normalized;
}

export const saveProfile = mutation({
  args: {
    eventSlug: v.string(),
    participantPolicyVersionId: v.id("participantPolicyVersions"),
    fullName: v.string(),
    preferredName: v.optional(v.string()),
    phone: v.optional(v.string()),
    institution: v.string(),
    yearOfStudy: studyYear,
    currentRole: v.optional(v.string()),
    vitRegistrationNumber: v.optional(v.string()),
    vitProgramme: v.optional(v.string()),
    vitCampus: v.optional(v.string()),
    externalCity: v.optional(v.string()),
    externalCountry: v.optional(v.string()),
    expectedProfileVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ profileId: v.id("participantProfiles"), profileVersion: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.participantPolicyVersionId,
      args.fullName,
      args.preferredName ?? null,
      args.phone ?? null,
      args.institution,
      args.yearOfStudy,
      args.currentRole ?? null,
      args.vitRegistrationNumber ?? null,
      args.vitProgramme ?? null,
      args.vitCampus ?? null,
      args.externalCity ?? null,
      args.externalCountry ?? null,
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
      const profileVersion = Number(prior.resultJson);
      if (!profileId || !Number.isSafeInteger(profileVersion) || profileVersion < 1) {
        throw new Error("The prior participant-profile result is invalid.");
      }
      return { profileId, profileVersion };
    }
    requireRegistrationOpen(event);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const membership = requireEligibleMembership(
      await requireMembership(ctx, event._id, person._id),
    );
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
    const fullName = normalizedText(args.fullName, "Full name", 2, 100);
    const preferredName = optionalNormalizedText(args.preferredName, "Preferred name", 60);
    const phone = policyField(args.phone, policy.phoneField, "Phone", 24);
    const institution = normalizedText(args.institution, "Institution", 2, 160);
    const currentRole = membership.participantClass === "external_participant"
      ? optionalNormalizedText(args.currentRole, "Current role", 100)
      : undefined;
    if (membership.participantClass === "vit_student" && args.yearOfStudy === "not_applicable") {
      throw new ConvexError({
        code: "VIT_STUDY_YEAR_REQUIRED",
        message: "Choose your current year of study.",
      });
    }
    if (
      membership.participantClass === "external_participant" &&
      args.yearOfStudy === "not_applicable" &&
      currentRole === undefined
    ) {
      throw new ConvexError({
        code: "EXTERNAL_ROLE_REQUIRED",
        message: "Enter a current role when year of study does not apply.",
      });
    }
    const vitRegistrationNumber = membership.participantClass === "vit_student"
      ? policyField(
          args.vitRegistrationNumber,
          policy.vitRegistrationNumberField,
          "VIT registration number",
          40,
        )
      : undefined;
    const vitProgramme = membership.participantClass === "vit_student"
      ? policyField(args.vitProgramme, policy.vitProgrammeField, "VIT programme", 100)
      : undefined;
    const vitCampus = membership.participantClass === "vit_student"
      ? policyField(args.vitCampus, policy.vitCampusField, "VIT campus", 80)
      : undefined;
    const externalCity = membership.participantClass === "external_participant"
      ? policyField(args.externalCity, policy.externalCityField, "City", 100)
      : undefined;
    const externalCountry = membership.participantClass === "external_participant"
      ? policyField(args.externalCountry, policy.externalCountryField, "Country", 100)
      : undefined;

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
        preferredName,
        phone,
        institution,
        yearOfStudy: args.yearOfStudy,
        currentRole,
        vitRegistrationNumber,
        vitProgramme,
        vitCampus,
        externalCity,
        externalCountry,
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
        ...(preferredName !== undefined ? { preferredName } : {}),
        ...(phone !== undefined ? { phone } : {}),
        institution,
        yearOfStudy: args.yearOfStudy,
        ...(currentRole !== undefined ? { currentRole } : {}),
        ...(vitRegistrationNumber !== undefined ? { vitRegistrationNumber } : {}),
        ...(vitProgramme !== undefined ? { vitProgramme } : {}),
        ...(vitCampus !== undefined ? { vitCampus } : {}),
        ...(externalCity !== undefined ? { externalCity } : {}),
        ...(externalCountry !== undefined ? { externalCountry } : {}),
        profileVersion,
        updatedAt: now,
      });
    }

    await ctx.db.patch(membership._id, {
      onboardingStatus: teamMembership ? "project_required" : "team_required",
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
