import {
  defaultVitHostelResidenceCatalog,
  findVitHostelResidenceCatalogEntry,
  participantProfileCodeConfiguration,
  type VitHostelResidenceCatalogEntry,
  type VitHostelResidenceKind,
} from "@code2create/domain";
import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { maximumApplicantTeamsPerEvent } from "./reviewLimits";
import { fingerprintText, normalizedLongText, normalizedText } from "./strings";

type ReadCtx = QueryCtx | MutationCtx;

export const vitHostelResidenceKind = v.union(v.literal("mens"), v.literal("ladies"));

export const vitHostelResidenceCatalogEntry = v.object({
  stableKey: v.string(),
  label: v.string(),
  kind: vitHostelResidenceKind,
});

export const participantPolicyInput = v.object({
  label: v.string(),
  teamMinimumSize: v.number(),
  teamMaximumSize: v.number(),
  mixedParticipantClassesAllowed: v.boolean(),
  vitHostelResidenceCatalog: v.array(vitHostelResidenceCatalogEntry),
  profileNotice: v.string(),
  projectTextNotice: v.string(),
  privacyNoticeUrl: v.string(),
  freshProjectAttestation: v.string(),
  finalSubmissionWarning: v.string(),
});

export type ParticipantPolicy = {
  label: string;
  teamMinimumSize: number;
  teamMaximumSize: number;
  mixedParticipantClassesAllowed: boolean;
  vitHostelResidenceCatalog: VitHostelResidenceCatalogEntry[];
  profileNotice: string;
  projectTextNotice: string;
  privacyNoticeUrl: string;
  freshProjectAttestation: string;
  finalSubmissionWarning: string;
};

export const freshProjectAttestation =
  "We will begin project-specific implementation and design after Code2Create's official start.";

export const defaultParticipantPolicy: ParticipantPolicy = {
  label: "Participant policy · 1",
  teamMinimumSize: 2,
  teamMaximumSize: 5,
  mixedParticipantClassesAllowed: false,
  vitHostelResidenceCatalog: defaultVitHostelResidenceCatalog,
  profileNotice: "We use these details to run Code2Create.",
  projectTextNotice: "We may process submissions with AI tools to help us review.",
  privacyNoticeUrl: "https://c2c.acmvit.in/privacy",
  freshProjectAttestation,
  finalSubmissionWarning: "You can edit the team and proposal until the final deadline.",
};

function invalidPolicy(message: string): never {
  throw new ConvexError({ code: "INVALID_PARTICIPANT_POLICY", message });
}

function positiveWholeNumber(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalidPolicy(`${label} must be a positive whole number.`);
  }
  return value;
}

function normalizedHttpsUrl(value: string, label: string) {
  const normalized = normalizedText(value, label, 8, 500);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    invalidPolicy(`${label} must be a complete HTTPS URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    invalidPolicy(`${label} must be a complete HTTPS URL without embedded credentials.`);
  }
  return url.toString();
}

const maximumVitHostelResidenceCount = 64;

function normalizeVitHostelResidenceCatalog(catalog: readonly VitHostelResidenceCatalogEntry[]) {
  if (catalog.length < 2 || catalog.length > maximumVitHostelResidenceCount) {
    invalidPolicy(
      `The VIT hostel block catalogue must contain 2 to ${maximumVitHostelResidenceCount} entries.`,
    );
  }
  const stableKeys = new Set<string>();
  let mensCount = 0;
  let ladiesCount = 0;
  const normalized = catalog.map((entry, index) => {
    const stableKey = entry.stableKey.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(stableKey)) {
      invalidPolicy(`VIT residence ${index + 1} needs a 2 to 40 character lowercase stable key.`);
    }
    if (stableKeys.has(stableKey)) {
      invalidPolicy(`VIT residence stable key “${stableKey}” is duplicated.`);
    }
    stableKeys.add(stableKey);
    const kind: VitHostelResidenceKind = entry.kind;
    if (kind === "mens") mensCount += 1;
    if (kind === "ladies") ladiesCount += 1;
    return {
      stableKey,
      label: normalizedText(entry.label, `VIT residence ${index + 1} label`, 2, 80),
      kind,
    };
  });
  if (mensCount === 0 || ladiesCount === 0) {
    invalidPolicy(
      "The VIT hostel block catalogue must contain at least one men's and one ladies' block.",
    );
  }
  return normalized;
}

export function normalizeParticipantPolicy(input: ParticipantPolicy): ParticipantPolicy {
  const teamMinimumSize = positiveWholeNumber(input.teamMinimumSize, "Minimum team size");
  const teamMaximumSize = positiveWholeNumber(input.teamMaximumSize, "Maximum team size");
  if (teamMaximumSize < teamMinimumSize) {
    invalidPolicy("Maximum team size cannot be smaller than minimum team size.");
  }
  if (input.mixedParticipantClassesAllowed) {
    invalidPolicy("VIT students and external participants must form separate teams.");
  }
  const freshAttestation = normalizedLongText(
    input.freshProjectAttestation,
    "Fresh-project attestation",
    40,
    240,
  );
  if (freshAttestation !== freshProjectAttestation) {
    invalidPolicy(
      "The fresh-project attestation must preserve the event's fixed fresh-build rule.",
    );
  }
  const finalSubmissionWarning = normalizedLongText(
    input.finalSubmissionWarning,
    "Final-submission warning",
    40,
    400,
  );
  const warningText = finalSubmissionWarning.toLocaleLowerCase("en");
  if (!["team", "proposal", "edit", "deadline"].every((term) => warningText.includes(term))) {
    invalidPolicy(
      "The final-submission warning must say that the team and proposal remain editable until the deadline.",
    );
  }
  return {
    label: normalizedText(input.label, "Policy label", 3, 80),
    teamMinimumSize,
    teamMaximumSize,
    mixedParticipantClassesAllowed: false,
    vitHostelResidenceCatalog: normalizeVitHostelResidenceCatalog(input.vitHostelResidenceCatalog),
    profileNotice: normalizedLongText(input.profileNotice, "Profile notice", 20, 600),
    projectTextNotice: normalizedLongText(input.projectTextNotice, "Project-text notice", 20, 800),
    privacyNoticeUrl: normalizedHttpsUrl(input.privacyNoticeUrl, "Privacy notice URL"),
    freshProjectAttestation: freshAttestation,
    finalSubmissionWarning,
  };
}

export function participantPolicyChecksum(policy: ParticipantPolicy) {
  return fingerprintText(JSON.stringify(normalizeParticipantPolicy(policy)));
}

export function participantPolicyFromDocument(
  policy: Doc<"participantPolicyVersions">,
): ParticipantPolicy {
  return {
    label: policy.label,
    teamMinimumSize: policy.teamMinimumSize,
    teamMaximumSize: policy.teamMaximumSize,
    mixedParticipantClassesAllowed: policy.mixedParticipantClassesAllowed,
    vitHostelResidenceCatalog: policy.vitHostelResidenceCatalog,
    profileNotice: policy.profileNotice,
    projectTextNotice: policy.projectTextNotice,
    privacyNoticeUrl: policy.privacyNoticeUrl,
    freshProjectAttestation: policy.freshProjectAttestation,
    finalSubmissionWarning: policy.finalSubmissionWarning,
  };
}

export async function loadPublishedParticipantPolicy(ctx: ReadCtx, event: Doc<"events">) {
  const policyId = event.publishedParticipantPolicyId;
  const policy = policyId ? await ctx.db.get(policyId) : null;
  if (!policy || policy.eventId !== event._id || policy.status !== "published") {
    throw new ConvexError({
      code: "PARTICIPANT_POLICY_UNAVAILABLE",
      message: "Participant registration policy is not configured for this event.",
    });
  }
  const normalized = normalizeParticipantPolicy(participantPolicyFromDocument(policy));
  if (participantPolicyChecksum(normalized) !== policy.checksum) {
    throw new Error("The published participant-policy checksum is invalid.");
  }
  return { policy, normalized };
}

export async function loadPublishedParticipantCapacity(ctx: ReadCtx, event: Doc<"events">) {
  const policyId = event.publishedAdmissionPolicyId;
  const policy = policyId ? await ctx.db.get(policyId) : null;
  if (!policy || policy.eventId !== event._id || policy.status !== "published") {
    throw new Error("The event's published admission policy is invalid.");
  }
  if (
    !Number.isSafeInteger(policy.overallParticipantCapacity) ||
    policy.overallParticipantCapacity < 1
  ) {
    throw new Error("The published admission participant capacity is invalid.");
  }
  return policy.overallParticipantCapacity;
}

export async function participantPolicyPublicationIssue(
  ctx: ReadCtx,
  event: Doc<"events">,
  published: ParticipantPolicy,
  candidate: ParticipantPolicy,
) {
  const participantCapacity = await loadPublishedParticipantCapacity(ctx, event);
  if (candidate.teamMaximumSize > participantCapacity) {
    return `Maximum team size cannot exceed the published participant capacity of ${participantCapacity}.`;
  }
  const minimumTightened = candidate.teamMinimumSize > published.teamMinimumSize;
  const maximumTightened = candidate.teamMaximumSize < published.teamMaximumSize;
  const participantClassesRestricted = !candidate.mixedParticipantClassesAllowed;
  if (!minimumTightened && !maximumTightened && !participantClassesRestricted) return null;
  const teams = await ctx.db
    .query("teams")
    .withIndex("by_event_status", (index) => index.eq("eventId", event._id))
    .take(maximumApplicantTeamsPerEvent + 1);
  if (teams.length > maximumApplicantTeamsPerEvent) {
    throw new Error(
      `The event exceeds the supported applicant limit of ${maximumApplicantTeamsPerEvent} teams.`,
    );
  }
  for (const team of teams) {
    if (team.status === "withdrawn") continue;
    if (
      !Number.isSafeInteger(team.activeMemberCount) ||
      !Number.isSafeInteger(team.activeVitMemberCount) ||
      !Number.isSafeInteger(team.activeExternalMemberCount) ||
      team.activeMemberCount < 0 ||
      team.activeVitMemberCount < 0 ||
      team.activeExternalMemberCount < 0 ||
      team.activeMemberCount !== team.activeVitMemberCount + team.activeExternalMemberCount
    ) {
      throw new Error(`Team “${team.name}” has an invalid roster projection.`);
    }
    if (maximumTightened && team.activeMemberCount > candidate.teamMaximumSize) {
      return `Team “${team.name}” has more than ${candidate.teamMaximumSize} active members. Reduce its roster before publishing this team-size limit.`;
    }
    if (minimumTightened && team.activeMemberCount < candidate.teamMinimumSize) {
      return `Team “${team.name}” has fewer than ${candidate.teamMinimumSize} active members. Complete its roster before publishing this team-size limit.`;
    }
    if (
      participantClassesRestricted &&
      team.activeVitMemberCount > 0 &&
      team.activeExternalMemberCount > 0
    ) {
      return `Team “${team.name}” contains both VIT and external participants. Change its roster before publishing the single-class team rule.`;
    }
  }
  return null;
}

function hostelDetailsComplete(
  profile: Doc<"participantProfiles">,
  catalog: readonly VitHostelResidenceCatalogEntry[],
) {
  if (profile.vitResidenceType === "day_scholar") {
    return profile.vitHostelResidence === undefined && profile.vitHostelRoomNumber === undefined;
  }
  if (profile.vitResidenceType !== "hosteller") return false;
  if (profile.vitHostelResidence === undefined) return false;
  const residence = findVitHostelResidenceCatalogEntry(catalog, profile.vitHostelResidence);
  if (!residence) return false;
  const expectedKind = profile.gender === "male" ? "mens" : "ladies";
  return residence.kind === expectedKind && profile.vitHostelRoomNumber !== undefined;
}

export function isProfileCompleteForPolicy(
  profile: Doc<"participantProfiles"> | null,
  membership: Doc<"eventMemberships">,
  policy: Doc<"participantPolicyVersions">,
) {
  if (
    !profile ||
    profile.membershipId !== membership._id ||
    profile.participantClass !== membership.participantClass ||
    !membership.acceptedParticipantPolicyVersionIds.includes(policy._id) ||
    profile.fullName.length === 0 ||
    profile.institution.length === 0 ||
    profile.phone.length === 0 ||
    (participantProfileCodeConfiguration.phoneVerificationEnabled &&
      (profile.phoneVerifiedAt === undefined || profile.phoneVerifiedAt <= 0))
  ) {
    return false;
  }
  if (profile.participantClass === "vit_student") {
    return (
      profile.yearOfStudy !== "not_applicable" &&
      profile.vitRegistrationNumber !== undefined &&
      profile.vitProgramme !== undefined &&
      hostelDetailsComplete(profile, policy.vitHostelResidenceCatalog)
    );
  }
  return (
    profile.yearOfStudy !== "not_applicable" &&
    profile.externalUniversity !== undefined &&
    profile.externalCollege !== undefined
  );
}

export function participantClassesMeetPolicy(
  participantClasses: readonly ("vit_student" | "external_participant")[],
  policy: ParticipantPolicy,
) {
  return policy.mixedParticipantClassesAllowed || new Set(participantClasses).size <= 1;
}

export async function saveParticipantPolicyDraft(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    actorPersonId: Id<"people">;
    policy: ParticipantPolicy;
    expectedDraftPolicyId?: Id<"participantPolicyVersions">;
    now: number;
  },
) {
  const normalized = normalizeParticipantPolicy(args.policy);
  const checksum = participantPolicyChecksum(normalized);
  const currentDraft = await ctx.db
    .query("participantPolicyVersions")
    .withIndex("by_event_status", (index) =>
      index.eq("eventId", args.event._id).eq("status", "draft"),
    )
    .unique();
  if (currentDraft?._id !== args.expectedDraftPolicyId) {
    throw new ConvexError({
      code: "PARTICIPANT_POLICY_DRAFT_CHANGED",
      message: "The participant-policy draft changed in another session.",
    });
  }
  if (currentDraft?.checksum === checksum) {
    return {
      policyVersionId: currentDraft._id,
      policyVersion: currentDraft.version,
      checksum,
      changed: false,
    };
  }
  const latest = await ctx.db
    .query("participantPolicyVersions")
    .withIndex("by_event_version", (index) => index.eq("eventId", args.event._id))
    .order("desc")
    .first();
  if (currentDraft) await ctx.db.patch(currentDraft._id, { status: "retired" });
  const policyVersion = (latest?.version ?? 0) + 1;
  const policyVersionId = await ctx.db.insert("participantPolicyVersions", {
    eventId: args.event._id,
    version: policyVersion,
    status: "draft",
    ...normalized,
    checksum,
    createdByPersonId: args.actorPersonId,
    createdAt: args.now,
  });
  return { policyVersionId, policyVersion, checksum, changed: true };
}

export async function publishParticipantPolicy(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    draftPolicyId: Id<"participantPolicyVersions">;
    expectedDraftChecksum: string;
    now: number;
  },
) {
  const draft = await ctx.db.get(args.draftPolicyId);
  const currentDraft = await ctx.db
    .query("participantPolicyVersions")
    .withIndex("by_event_status", (index) =>
      index.eq("eventId", args.event._id).eq("status", "draft"),
    )
    .unique();
  if (
    !draft ||
    draft.eventId !== args.event._id ||
    currentDraft?._id !== draft._id ||
    draft.checksum !== args.expectedDraftChecksum
  ) {
    throw new ConvexError({
      code: "PARTICIPANT_POLICY_DRAFT_CHANGED",
      message: "The participant-policy draft changed in another session.",
    });
  }
  const normalized = normalizeParticipantPolicy(participantPolicyFromDocument(draft));
  if (participantPolicyChecksum(normalized) !== draft.checksum) {
    throw new Error("The participant-policy draft checksum does not match its content.");
  }
  const previousId = args.event.publishedParticipantPolicyId;
  const previous = previousId ? await ctx.db.get(previousId) : null;
  if (!previous || previous.eventId !== args.event._id || previous.status !== "published") {
    throw new Error("The event's published participant policy is invalid.");
  }
  const previousNormalized = normalizeParticipantPolicy(participantPolicyFromDocument(previous));
  if (participantPolicyChecksum(previousNormalized) !== previous.checksum) {
    throw new Error("The published participant-policy checksum is invalid.");
  }
  const publicationIssue = await participantPolicyPublicationIssue(
    ctx,
    args.event,
    previousNormalized,
    normalized,
  );
  if (publicationIssue) {
    throw new ConvexError({
      code: "PARTICIPANT_POLICY_INCOMPATIBLE",
      message: publicationIssue,
    });
  }
  await ctx.db.patch(previous._id, { status: "superseded" });
  await ctx.db.patch(draft._id, { status: "published", publishedAt: args.now });
  await ctx.db.patch(args.event._id, {
    publishedParticipantPolicyId: draft._id,
    version: args.event.version + 1,
    updatedAt: args.now,
  });
  return { policyVersionId: draft._id, policyVersion: draft.version };
}
