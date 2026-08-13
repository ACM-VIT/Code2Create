/** Opt-in deterministic local seed for a large admission cohort. */

import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, type MutationCtx } from "./_generated/server";
import { initializeAttendanceTeamAvailability } from "./lib/attendanceTeamAvailability";
import { requireLocalDeployment } from "./lib/localBrowserFixtures";
import {
  completeLocalSubmissionSnapshot,
  createLocalSubmissionSnapshot,
} from "./lib/localSubmissionSnapshot";
import { noveltyBandForScore, noveltyInputFingerprint } from "./lib/novelty";
import { appendAdmissionJobReadFactById } from "./lib/operationsAutonomyReadFacts/admissionJobs";

const hour = 60 * 60 * 1_000;
// Adds to the event created by localDevelopment.ts and extended by localDemoSeed.ts.
const cohortEventSlug = "code2create-7";
const cohortSourcePrefix = "local-admission-cohort";
const teamsPerBatch = 15;
const defaultTeamCount = 350;
const maximumTeamCount = 500;

const teamAdjectives = [
  "Quiet",
  "Amber",
  "Restless",
  "Northern",
  "Patient",
  "Vivid",
  "Late",
  "Iron",
  "Gentle",
  "Sudden",
  "Hollow",
  "Bright",
  "Slow",
  "Copper",
  "Distant",
] as const;

const teamNouns = [
  "Circuit",
  "Harbour",
  "Meridian",
  "Lantern",
  "Compass",
  "Furnace",
  "Orchard",
  "Signal",
  "Quarry",
  "Monsoon",
  "Ledger",
  "Gallery",
  "Terrace",
  "Current",
  "Archive",
] as const;

const ideaSubjects = [
  "hostel wardens",
  "campus clinics",
  "first-year students",
  "local transit riders",
  "small farm collectives",
  "night-shift security staff",
  "college librarians",
  "street food vendors",
  "volunteer coordinators",
  "hall electricians",
] as const;

const ideaMechanisms = [
  "a low-bandwidth mobile tool",
  "an offline-first record book",
  "a shared scheduling board",
  "a voice-note triage line",
  "a printable QR workflow",
  "a sensor-free monitoring routine",
  "a peer-verification ledger",
  "a single-screen dispatch view",
  "a paper-compatible sync process",
  "a low-cost alert relay",
] as const;

const ideaOutcomes = [
  "so repeated manual follow-ups stop being lost",
  "so shortages are visible a day earlier",
  "so handovers between shifts keep their context",
  "so the same request is never filed twice",
  "so the busiest hour of the day needs no typing",
  "so small failures surface before they cascade",
  "so newcomers can act without training sessions",
  "so records survive a dead phone battery",
  "so coordinators see load before it piles up",
  "so the follow-up burden falls on the system",
] as const;

const noveltyThemes = [
  "Campus logistics",
  "Community health",
  "Local commerce",
  "Learning support",
  "Sustainable operations",
] as const;

/** Weighted sizes make capacity in people differ from team count. */
const teamSizePattern = [3, 4, 2, 4, 3, 5, 1, 4, 3, 6, 2, 4, 3, 5, 4, 2, 3, 4] as const;

const bandPattern = [
  "first_year",
  "early_year",
  "early_year",
  "later_year",
  "mixed_or_external",
  "first_year",
  "later_year",
  "postgraduate_or_professional",
  "early_year",
  "mixed_or_external",
] as const;

const studyYearForBand: Record<(typeof bandPattern)[number], Doc<"participantProfiles">["yearOfStudy"]> = {
  first_year: "first",
  early_year: "second",
  later_year: "fourth",
  postgraduate_or_professional: "postgraduate",
  mixed_or_external: "not_applicable",
};

// Include review shortfalls so the not-decidable state is exercised.
const reviewCountPattern = [2, 1, 0, 2, 3, 1, 2, 0, 1, 2] as const;

type SeededDecision = "accept" | "waitlist" | "decline";

/** Deterministic cycle through a pattern, total under indexed-access checks. */
function cycle<T>(items: readonly T[], index: number): T {
  const item = items[index % items.length];
  if (item === undefined) throw new Error("A seed pattern is empty.");
  return item;
}

function cohortAuthUserId(key: string) {
  return `${cohortSourcePrefix}:${key}`;
}

async function requireCohortEvent(ctx: MutationCtx) {
  const event = await ctx.db
    .query("events")
    .withIndex("by_slug", (index) => index.eq("slug", cohortEventSlug))
    .unique();
  if (!event) {
    throw new ConvexError({
      code: "LOCAL_EVENT_REQUIRED",
      message: "Seed the local event before seeding the admission cohort.",
    });
  }
  return event;
}

/** Shared deterministic reviewers need person records but no event membership. */
async function ensureCohortReviewers(ctx: MutationCtx, eventId: Id<"events">, now: number) {
  const reviewers: Id<"people">[] = [];
  for (const key of ["reviewer-1", "reviewer-2", "reviewer-3"]) {
    const authUserId = cohortAuthUserId(key);
    const existing = await ctx.db
      .query("people")
      .withIndex("by_auth_user", (index) => index.eq("authUserId", authUserId))
      .unique();
    if (existing) {
      reviewers.push(existing._id);
      continue;
    }
    const email = `${cohortSourcePrefix}-${key}@example.test`;
    const personId = await ctx.db.insert("people", {
      authUserId,
      googleSubject: `${cohortSourcePrefix}-google:${key}`,
      verifiedEmail: email,
      displayName: `Cohort ${key.replace("-", " ")}`,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: email,
      displayName: `Cohort ${key.replace("-", " ")}`,
      status: "active",
      linkedBy: "access_invitation",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    reviewers.push(personId);
  }
  return reviewers;
}

function teamName(teamIndex: number) {
  const adjective = cycle(teamAdjectives, teamIndex);
  const noun = cycle(teamNouns, Math.floor(teamIndex / teamAdjectives.length));
  return `${adjective} ${noun} ${String(teamIndex + 1).padStart(3, "0")}`;
}

function initialIdea(teamIndex: number) {
  const subject = cycle(ideaSubjects, teamIndex);
  const mechanism = cycle(ideaMechanisms, teamIndex * 3 + 1);
  const outcome = cycle(ideaOutcomes, teamIndex * 7 + 2);
  return `We want to build ${mechanism} for ${subject} ${outcome}.`;
}

/** Uses a coprime cycle so quality does not correlate with band or team size. */
function qualityTier(teamIndex: number) {
  return (teamIndex * 13 + 5) % 10;
}

function reviewRecommendation(tier: number, reviewOrdinal: number): SeededDecision {
  if (tier >= 7) return "accept";
  if (tier >= 4) return reviewOrdinal === 0 ? "accept" : "waitlist";
  if (tier >= 2) return reviewOrdinal === 0 ? "waitlist" : "decline";
  return "decline";
}

function aiRecommendationForTier(tier: number): SeededDecision | "needs_information" {
  if (tier >= 7) return "accept";
  if (tier >= 5) return "waitlist";
  if (tier === 4) return "needs_information";
  return "decline";
}

function reasonCodeFor(
  policy: Doc<"admissionPolicyVersions">,
  decision: SeededDecision | "needs_information",
) {
  const reason = policy.decisionReasonCodes.find((candidate) =>
    candidate.allowedDecisions.includes(decision),
  );
  if (!reason) {
    throw new Error(`The published policy has no reason code allowing ${decision}.`);
  }
  return reason.key;
}

async function createCohortTeam(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    teamIndex: number;
    reviewers: Id<"people">[];
    trackVersionIds: Id<"trackVersions">[];
    participantPolicyVersionId: Id<"participantPolicyVersions">;
    trackCatalogVersionId: Id<"trackCatalogVersions">;
    intakePolicyVersionId: Id<"intakePolicyVersions">;
    policy: Doc<"admissionPolicyVersions">;
    now: number;
  },
) {
  const { event, teamIndex, now } = args;
  const publicCode = `CH${String(teamIndex + 1).padStart(4, "0")}`;
  const existing = await ctx.db
    .query("teams")
    .withIndex("by_event_code", (index) =>
      index.eq("eventId", event._id).eq("publicCode", publicCode),
    )
    .unique();
  if (existing) return false;

  const size = cycle(teamSizePattern, teamIndex);
  const band = cycle(bandPattern, teamIndex);
  const external = band === "mixed_or_external";
  const tier = qualityTier(teamIndex);
  const submittedAt = now - 72 * hour + teamIndex * 60_000;

  const memberships: Doc<"eventMemberships">[] = [];
  for (let memberIndex = 0; memberIndex < size; memberIndex += 1) {
    const memberKey = `member-${teamIndex + 1}-${memberIndex + 1}`;
    const email = `${cohortSourcePrefix}-${memberKey}@example.test`;
    const displayName = `Cohort Member ${teamIndex + 1}-${memberIndex + 1}`;
    const personId = await ctx.db.insert("people", {
      authUserId: cohortAuthUserId(memberKey),
      googleSubject: `${cohortSourcePrefix}-google:${memberKey}`,
      verifiedEmail: email,
      displayName,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId: event._id,
      personId,
      emailNormalized: email,
      displayName,
      status: "active",
      linkedBy: "participant_provisioning",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    const membershipId = await ctx.db.insert("eventMemberships", {
      eventId: event._id,
      personId,
      eventAccessSubjectId: subjectId,
      participantClass: external ? "external_participant" : "vit_student",
      eligibilityStatus: "eligible",
      onboardingStatus: "submitted",
      acceptedParticipantPolicyVersionIds: [args.participantPolicyVersionId],
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("participantProfiles", {
      eventId: event._id,
      membershipId,
      participantClass: external ? "external_participant" : "vit_student",
      fullName: displayName,
      institution: external ? "Independent" : "VIT Chennai",
      yearOfStudy: studyYearForBand[band],
      ...(external
        ? { externalCity: "Chennai", externalCountry: "India" }
        : {
            vitRegistrationNumber: `24CH${String(teamIndex * 10 + memberIndex + 1).padStart(5, "0")}`,
            vitProgramme: "B.Tech CSE",
            vitCampus: "Chennai",
          }),
      profileVersion: 1,
      updatedAt: now,
    });
    const membership = await ctx.db.get(membershipId);
    if (!membership) throw new Error("A cohort membership did not persist.");
    memberships.push(membership);
  }
  const leadMembership = memberships[0];
  if (!leadMembership) throw new Error("A cohort team has no lead membership.");

  // Seed a few terminal states so capacity calculations include committed seats.
  const decided: SeededDecision | null =
    (teamIndex + 1) % 23 === 0
      ? "accept"
      : (teamIndex + 1) % 29 === 0
        ? "decline"
        : (teamIndex + 1) % 31 === 0
          ? "waitlist"
          : null;
  const applicationState: Doc<"applications">["state"] =
    decided === "accept"
      ? "accepted"
      : decided === "decline"
        ? "declined"
        : decided === "waitlist"
          ? "waitlisted"
          : teamIndex % 2 === 0
            ? "under_review"
            : "submitted";

  const teamId = await ctx.db.insert("teams", {
    eventId: event._id,
    name: teamName(teamIndex),
    publicCode,
    leadMembershipId: leadMembership._id,
    status: decided === "accept" ? "admitted" : "submitted",
    activeMemberCount: memberships.length,
    activeVitMemberCount: memberships.filter(
      (membership) => membership.participantClass === "vit_student",
    ).length,
    activeExternalMemberCount: memberships.filter(
      (membership) => membership.participantClass === "external_participant",
    ).length,
    membershipLocked: true,
    trackLocked: true,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  const team = await ctx.db.get(teamId);
  if (!team) throw new Error("A cohort team did not persist.");

  const teamMemberIds: Id<"teamMembers">[] = [];
  for (const [memberIndex, membership] of memberships.entries()) {
    const teamMemberId = await ctx.db.insert("teamMembers", {
      eventId: event._id,
      teamId,
      membershipId: membership._id,
      role: memberIndex === 0 ? "lead" : "member",
      status: "active",
      joinedAt: now,
      source: memberIndex === 0 ? "created" : "code",
    });
    teamMemberIds.push(teamMemberId);
  }

  const idea = initialIdea(teamIndex);
  // Leave some teams without the optional novelty signal.
  const noveltyScore = teamIndex % 6 === 5 ? null : (teamIndex * 37 + tier) % 101;
  const projectDraftId = await ctx.db.insert("projectDrafts", {
    eventId: event._id,
    teamId,
    trackCatalogVersionId: args.trackCatalogVersionId,
    intakePolicyVersionId: args.intakePolicyVersionId,
    stage: "submitted",
    initialIdea: idea,
    ...(noveltyScore !== null
      ? {
          noveltyEvaluatedInputFingerprint: noveltyInputFingerprint(idea),
          noveltyScore,
          noveltyBand: noveltyBandForScore(noveltyScore),
          noveltyNearestThemeLabel: cycle(noveltyThemes, teamIndex),
          noveltyReflectionPrompt: "How does the daily routine change for the first user?",
          noveltyEvaluatedAt: submittedAt,
        }
      : {}),
    chosenCoreTrackVersionId: cycle(args.trackVersionIds, teamIndex),
    chosenSponsorTrackVersionIds: [],
    recommendationState: "not_requested",
    freshnessAttestedByMembershipId: leadMembership._id,
    freshnessAttestedAt: submittedAt,
    version: 2,
    lastEditedByMembershipId: leadMembership._id,
    updatedAt: submittedAt,
  });
  const trackVersionId = cycle(args.trackVersionIds, teamIndex);
  const submissionAttemptId = await createLocalSubmissionSnapshot(ctx, {
    eventId: event._id,
    team,
    draftId: projectDraftId,
    teamMemberIds,
    participantPolicyVersionId: args.participantPolicyVersionId,
    admissionPolicyVersionId: args.policy._id,
    coreTrackVersionId: trackVersionId,
    requesterMembershipId: leadMembership._id,
    requesterPersonId: leadMembership.personId,
    submittedAt,
  });
  const projectVersionId = await ctx.db.insert("projectVersions", {
    eventId: event._id,
    teamId,
    version: 1,
    initialIdea: idea,
    intakePolicyVersionId: args.intakePolicyVersionId,
    intakeResponses: [],
    coreTrackVersionId: trackVersionId,
    sponsorTrackVersionIds: [],
    lockedRosterSnapshotId: submissionAttemptId,
    lockedMemberCount: teamMemberIds.length,
    lockedLeadMembershipId: leadMembership._id,
    freshForEventAttestation: {
      participantPolicyVersionId: args.participantPolicyVersionId,
      acceptedByMembershipId: leadMembership._id,
      acceptedAt: submittedAt,
    },
    finalConfirmation: {
      participantPolicyVersionId: args.participantPolicyVersionId,
      previewedDraftVersion: 2,
      previewedTeamVersion: 1,
      previewedTrackVersionId: trackVersionId,
      previewedSponsorTrackVersionIds: [],
      confirmedByMembershipId: leadMembership._id,
      confirmedAt: submittedAt,
    },
    participantPolicyVersionId: args.participantPolicyVersionId,
    admissionPolicyVersionId: args.policy._id,
    sourceDraftVersion: 2,
    submittedByMembershipId: leadMembership._id,
    submittedAt,
  });

  const reviewCount = cycle(reviewCountPattern, teamIndex);
  const applicationId = await ctx.db.insert("applications", {
    eventId: event._id,
    teamId,
    submittedProjectVersionId: projectVersionId,
    admissionPolicyVersionId: args.policy._id,
    state: applicationState,
    experienceBand: band,
    ...(decided
      ? {
          humanDecision: decided,
          humanReasonCode: reasonCodeFor(args.policy, decided),
          decidedByPersonId: cycle(args.reviewers, 0),
          decidedAt: submittedAt + hour,
          aiDisposition: "unavailable" as const,
        }
      : {}),
    assignedReviewCount: reviewCount,
    completedReviewCount: reviewCount,
    contentVersion: 1,
    version: decided ? 2 : 1,
    submittedAt,
  });
  await completeLocalSubmissionSnapshot(ctx, {
    submissionAttemptId,
    projectVersionId,
    applicationId,
    completedAt: submittedAt,
  });

  for (let reviewOrdinal = 0; reviewOrdinal < reviewCount; reviewOrdinal += 1) {
    const recommendation = reviewRecommendation(tier, reviewOrdinal);
    const reviewer = cycle(args.reviewers, reviewOrdinal);
    await ctx.db.insert("admissionHumanReviews", {
      eventId: event._id,
      applicationId,
      applicationContentVersion: 1,
      reviewerPersonId: reviewer,
      recommendation,
      reasonCode: reasonCodeFor(args.policy, recommendation),
      status: "active",
      createdAt: submittedAt + (reviewOrdinal + 1) * 10 * 60_000,
    });
  }

  // Leave some undecided applications without an AI recommendation.
  if (!decided && teamIndex % 3 !== 2) {
    const assessments = ["meets", "partly_meets", "not_yet_clear"] as const;
    const recommendationId = await ctx.db.insert("admissionAIRecommendations", {
      eventId: event._id,
      applicationId,
      teamId,
      projectVersionId,
      admissionPolicyVersionId: args.policy._id,
      applicationContentVersion: 1,
      sourceInputFingerprint: `${cohortSourcePrefix}:${publicCode}`,
      experienceBand: band,
      state: "succeeded",
      recommendation: aiRecommendationForTier(tier),
      criterionAssessments: args.policy.criteria.map((criterion, criterionIndex) => ({
        criterionKey: criterion.criterionKey,
        assessment: cycle(assessments, (tier + criterionIndex) % 3 === 0 ? 2 : tier >= 6 ? 0 : 1),
        sourceRefs: ["initial_idea"],
      })),
      strengths: ["The first user and the daily moment of use are both concrete."],
      concerns: tier < 5 ? ["The event-sized slice of the idea is not yet stated."] : [],
      proposedQuestions: [],
      confidence: tier >= 7 ? "high" : tier >= 4 ? "medium" : "low",
      limitations: [],
      createdAt: submittedAt + 5 * 60_000,
      completedAt: submittedAt + 6 * 60_000,
    });
    await appendAdmissionJobReadFactById(ctx, recommendationId, now);
    await ctx.db.patch(applicationId, { aiRecommendationId: recommendationId });
  }

  await ctx.db.patch(teamId, {
    submissionAttemptId,
    lockedProjectVersionId: projectVersionId,
    lockedAt: submittedAt,
    lockParticipantPolicyVersionId: args.participantPolicyVersionId,
    version: team.version + 1,
    updatedAt: now,
  });
  await initializeAttendanceTeamAvailability(ctx, {
    eventId: event._id,
    teamId,
    activeMemberCount: memberships.length,
    now,
  });
  return true;
}

export const seedCohortBatch = internalMutation({
  args: { startIndex: v.number(), count: v.number() },
  returns: v.number(),
  handler: async (ctx, args) => {
    requireLocalDeployment();
    const event = await requireCohortEvent(ctx);
    const participantPolicyVersionId = event.publishedParticipantPolicyId;
    const trackCatalogVersionId = event.publishedTrackCatalogId;
    const intakePolicyVersionId = event.publishedIntakePolicyId;
    const admissionPolicyVersionId = event.publishedAdmissionPolicyId;
    if (
      !participantPolicyVersionId ||
      !trackCatalogVersionId ||
      !intakePolicyVersionId ||
      !admissionPolicyVersionId
    ) {
      throw new Error("The local event is missing a published policy the cohort seed needs.");
    }
    const policy = await ctx.db.get(admissionPolicyVersionId);
    if (!policy) throw new Error("The published admission policy no longer resolves.");
    const tracks = await ctx.db
      .query("trackVersions")
      .withIndex("by_catalog_type_order", (index) =>
        index.eq("catalogVersionId", trackCatalogVersionId).eq("type", "core"),
      )
      .collect();
    if (tracks.length === 0) throw new Error("The local event has no core tracks to assign.");
    const now = Date.now();
    const reviewers = await ensureCohortReviewers(ctx, event._id, now);
    let created = 0;
    for (let offset = 0; offset < args.count; offset += 1) {
      const wrote = await createCohortTeam(ctx, {
        event,
        teamIndex: args.startIndex + offset,
        reviewers,
        trackVersionIds: tracks.map((track) => track._id),
        participantPolicyVersionId,
        trackCatalogVersionId,
        intakePolicyVersionId,
        policy,
        now,
      });
      if (wrote) created += 1;
    }
    return created;
  },
});

export const seedAdmissionCohort = action({
  args: {
    confirmation: v.literal("seed-code2create-admission-cohort"),
    teamCount: v.optional(v.number()),
  },
  returns: v.object({ requestedTeams: v.number(), createdTeams: v.number() }),
  handler: async (ctx, args) => {
    requireLocalDeployment();
    const requestedTeams = Math.max(
      1,
      Math.min(maximumTeamCount, Math.floor(args.teamCount ?? defaultTeamCount)),
    );
    let createdTeams = 0;
    // A whole cohort exceeds one transaction at roughly 25 writes per team.
    for (let startIndex = 0; startIndex < requestedTeams; startIndex += teamsPerBatch) {
      createdTeams += await ctx.runMutation(internal.localAdmissionCohortSeed.seedCohortBatch, {
        startIndex,
        count: Math.min(teamsPerBatch, requestedTeams - startIndex),
      });
    }
    return { requestedTeams, createdTeams };
  },
});
