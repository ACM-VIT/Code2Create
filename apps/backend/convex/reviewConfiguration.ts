import {
  validatePanelComposition,
  type ReviewerSeniority,
} from "@code2create/domain";
import { reviewStaffingPolicy } from "./values";
import { reviewerParticipation } from "./lib/reviewerParticipation";

import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { advanceAccessVersion } from "./lib/accessVersion";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
} from "./lib/operations";
import { appendReviewPanelVacancyReadFactById } from "./lib/operationsAutonomyReadFacts";
import { loadPublishedParticipantPolicy } from "./lib/participantPolicy";
import {
  boundedActivePermissionScopeIds,
  insertPermissionGrant,
  matchingPermissionGrantIds,
  requirePermission,
} from "./lib/permissions";
import { grantPanelMemberAccess } from "./lib/reviewAccess";
import { createRoundConfirmationRequest } from "./reviewConfirmations";
import { reviewerPoolDetails } from "./lib/reviewerPool";
import { validateReviewerRoundStaffingPolicy } from "./lib/reviewerAvailability";
import { requireScoreCorrectionPolicy } from "./lib/scoreCorrectionPolicy";
import {
  maximumReviewCriteriaPerRubric,
  maximumReviewerAssignmentsPerEvent,
  maximumReviewRoundsPerEvent,
} from "./lib/reviewLimits";
import { normalizedText } from "./lib/strings";
import { normalizedE164Phone } from "./lib/outboundCalls";

const anchorInput = v.object({
  zero: v.string(),
  one: v.string(),
  two: v.string(),
  three: v.string(),
  four: v.string(),
});

const criterionInput = v.object({
  stableKey: v.string(),
  label: v.string(),
  question: v.string(),
  guidance: v.string(),
  weight: v.number(),
  displayOrder: v.number(),
  anchors: anchorInput,
});

const panelInput = v.object({
  stableKey: v.string(),
  name: v.string(),
  members: v.array(
    v.object({
      personId: v.id("people"),
      criterionKeys: v.array(v.string()),
      isCoordinator: v.boolean(),
    }),
  ),
});

const reviewerCandidateRoles = ["supreme", "board", "sc", "jc", "external_judge",
] as const;

function stableKey(value: string, label: string) {
  const key = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(key)) {
    throw new ConvexError({
      code: "INVALID_STABLE_KEY",
      message: `${label} must use lowercase letters, numbers, and underscores.`,
    });
  }
  return key;
}

function unique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) {
    throw new ConvexError({
      code: "DUPLICATE_REVIEW_CONFIGURATION",
      message: `${label} must be unique.`,
    });
  }
}

export function validateScoreSpreadThreshold(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4) {
    throw new ConvexError({
      code: "INVALID_RUBRIC",
      message: "Score-spread threshold must be a whole number from 1 through 4.",
    });
  }
  return value;
}

function normalizedList(values: readonly string[], label: string, maximumItems: number,
) {
  if (values.length > maximumItems) {
    throw new ConvexError({
      code: "REVIEWER_PROFILE_TOO_LARGE",
      message: `${label} has too many entries.`,
    });
  }
  const normalized = values.map((value) => normalizedText(value, label, 1, 80));
  unique(
    normalized.map((value) => value.toLocaleLowerCase()),
    label,
  );
  return normalized;
}

function integerInRange(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new ConvexError({
      code: "INVALID_REVIEW_CONFIGURATION",
      message: `${label} must be a whole number from ${minimum} to ${maximum}.`,
    });
  return value;
}

export function validateStaffingPolicy(
  policy: Doc<"reviewRounds">["staffing"],
  panelSize: number,
) {
  integerInRange(policy.seniorSeats, "SC seats", 0, 6);
  integerInRange(policy.juniorSeats, "JC seats", 0, 6);
  if (1 + policy.seniorSeats + policy.juniorSeats !== panelSize)
    throw new ConvexError({
      code: "INVALID_PANEL_COMPOSITION",
      message:
        "Panel size must equal one lead plus the configured SC and JC seats.",
    });
  integerInRange(policy.juniorRotationReviews, "JC rotation interval", 0, 100);
  integerInRange(
    policy.reviewerArrivalSeconds,
    "Reviewer arrival window",
    15,
    1800,
  );
  integerInRange(
    policy.assignmentReminderSeconds,
    "Assignment reminder",
    0,
    3600,
  );
}

export const profile = query({
  args: { eventSlug: v.string(), personId: v.id("people") },
  returns: v.union(
    v.null(),
    v.object({
      personId: v.id("people"),
      displayName: v.string(),
      email: v.string(),
      contactPhone: v.optional(v.string()),
      seniority: v.union(v.literal("board"), v.literal("sc"), v.literal("jc")),
      strength: v.number(),
      technicalDomains: v.array(v.string()),
      productDomains: v.array(v.string()),
      languages: v.array(v.string()),
      criterionKeys: v.array(v.string()),
      trainingStatus: v.union(v.literal("pending"), v.literal("complete"), v.literal("blocked"),
      ),
      status: v.union(v.literal("active"), v.literal("inactive")),
      version: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person: actor } = await requireCurrentPerson(ctx);
    const actorSubject = await requireEventSubject(ctx, event._id, actor._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: actorSubject._id,
      permissionKey: "reviewer.profile.read",
      scopeType: "person",
      scopeId: args.personId,
    });
    const [target, targetSubject, reviewerProfile] = await Promise.all([
      ctx.db.get(args.personId),
      ctx.db
        .query("eventAccessSubjects")
        .withIndex("by_event_person", (index) =>
          index.eq("eventId", event._id).eq("personId", args.personId),
        )
        .unique(),
      ctx.db
        .query("reviewerProfiles")
        .withIndex("by_event_person", (index) =>
          index.eq("eventId", event._id).eq("personId", args.personId),
        )
        .unique(),
    ]);
    if (!target || !targetSubject || targetSubject.status !== "active" || !reviewerProfile) {
      return null;
    }
    return {
      personId: target._id,
      displayName: target.displayName,
      email: target.verifiedEmail,
      ...(reviewerProfile.contactPhone !== undefined
        ? { contactPhone: reviewerProfile.contactPhone }
        : {}),
      seniority: reviewerProfile.seniority,
      strength: reviewerProfile.strength,
      technicalDomains: reviewerProfile.technicalDomains,
      productDomains: reviewerProfile.productDomains,
      languages: reviewerProfile.languages,
      criterionKeys: reviewerProfile.criterionKeys,
      trainingStatus: reviewerProfile.trainingStatus,
      status: reviewerProfile.status,
      version: reviewerProfile.version,
    };
  },
});

export const saveProfile = mutation({
  args: {
    eventSlug: v.string(),
    personId: v.id("people"),
    contactPhone: v.optional(v.string()),
    seniority: v.union(v.literal("board"), v.literal("sc"), v.literal("jc")),
    strength: v.number(),
    technicalDomains: v.array(v.string()),
    productDomains: v.array(v.string()),
    languages: v.array(v.string()),
    criterionKeys: v.array(v.string()),
    trainingStatus: v.union(v.literal("pending"), v.literal("complete"), v.literal("blocked"),
    ),
    status: v.union(v.literal("active"), v.literal("inactive")),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ profileId: v.id("reviewerProfiles"), version: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person: actor } = await requireCurrentPerson(ctx);
    const actorSubject = await requireEventSubject(ctx, event._id, actor._id);
    const requestFingerprint = operationFingerprint([
      args.personId,
      args.expectedVersion,
      args.seniority,
      args.strength,
      args.trainingStatus,
      args.status,
      args.contactPhone ?? null,
      JSON.stringify(args.technicalDomains),
      JSON.stringify(args.productDomains),
      JSON.stringify(args.languages),
      JSON.stringify(args.criterionKeys),
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: actor._id,
      clientOperationId: args.clientOperationId,
      commandName: "reviewer.profile.save",
      requestFingerprint,
    });
    if (prior) {
      const profileId = ctx.db.normalizeId("reviewerProfiles", prior.targetId);
      if (!profileId) throw new Error("Prior reviewer profile result is invalid.");
      return {
        profileId,
        version: storedOperationVersion(prior.resultJson, "reviewer-profile"),
      };
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: actorSubject._id,
      permissionKey: "reviewer.profile.manage",
      scopeType: "person",
      scopeId: args.personId,
    });
    const [target, targetSubject, current] = await Promise.all([
      ctx.db.get(args.personId),
      ctx.db
        .query("eventAccessSubjects")
        .withIndex("by_event_person", (index) =>
          index.eq("eventId", event._id).eq("personId", args.personId),
        )
        .unique(),
      ctx.db
        .query("reviewerProfiles")
        .withIndex("by_event_person", (index) =>
          index.eq("eventId", event._id).eq("personId", args.personId),
        )
        .unique(),
    ]);
    if (
      !target ||
      target.status !== "active" ||
      !targetSubject ||
      targetSubject.status !== "active"
    ) {
      throw new ConvexError({
        code: "REVIEWER_NOT_AVAILABLE",
        message: "The reviewer must have active event access.",
      });
    }
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== args.expectedVersion) {
      throw new ConvexError({
        code: "REVIEWER_PROFILE_CHANGED",
        message: "The reviewer profile changed. Refresh before saving.",
      });
    }
    const now = Date.now();
    const contactPhoneInput = args.contactPhone?.trim();
    const contactPhone = normalizedE164Phone(contactPhoneInput);
    if (contactPhoneInput && contactPhone === null) {
      throw new ConvexError({
        code: "INVALID_CONTACT_PHONE",
        message: "Enter the reviewer phone in international format, for example +919876543210.",
      });
    }
    const criterionKeys = normalizedList(args.criterionKeys, "Criterion key", 20,
    ).map((key) =>
      stableKey(key, "Criterion key"));
    const fields = {
      eventId: event._id,
      personId: target._id,
      seniority: args.seniority,
      strength: integerInRange(args.strength, "Reviewer strength", 0, 4),
      technicalDomains: normalizedList(args.technicalDomains, "Technical domain", 20,
      ),
      productDomains: normalizedList(args.productDomains, "Product domain", 20),
      languages: normalizedList(args.languages, "Language", 12),
      criterionKeys,
      trainingStatus: args.trainingStatus,
      status: args.status,
      version: currentVersion + 1,
      updatedAt: now,
    };
    let profileId: Id<"reviewerProfiles">;
    if (current) {
      profileId = current._id;
      await ctx.db.patch(current._id, {
        ...fields,
        contactPhone: contactPhone ?? undefined,
      });
    } else {
      profileId = await ctx.db.insert("reviewerProfiles", {
        ...fields,
        ...(contactPhone !== null ? { contactPhone } : {}),
        createdAt: now,
      });
    }
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: actor._id,
      clientOperationId: args.clientOperationId,
      commandName: "reviewer.profile.save",
      requestFingerprint,
      targetType: "reviewer_profile",
      targetId: profileId,
      resultJson: String(currentVersion + 1),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: actor._id,
      permissionKey: "reviewer.profile.manage",
      grantIds,
      scopeType: "person",
      scopeId: target._id,
      action: "reviewer.profile_saved",
      targetType: "reviewer_profile",
      targetId: profileId,
      ...(current
        ? { previousSummary: JSON.stringify({ version: current.version, status: current.status,
            }),
          }
        : {}),
      nextSummary: JSON.stringify({
        version: currentVersion + 1,
        status: args.status,
      }),
      reason: normalizedText(args.reason, "Reason", 3, 300),
    });
    return { profileId, version: currentVersion + 1 };
  },
});

export const candidates = query({
  args: { eventSlug: v.string() },
  returns: v.array(
    v.object({
      personId: v.id("people"),
      displayName: v.string(),
      email: v.string(),
      canManage: v.boolean(),
      completedReviews: v.number(),
      lastReviewedAt: v.optional(v.number()),
      pool: v.optional(
        reviewerPoolDetails.extend({
          seniority: v.union(
            v.literal("board"),
            v.literal("sc"),
            v.literal("jc"),
          ),
        }),
      ),
      profile: v.union(
        v.null(),
        v.object({
          contactPhone: v.optional(v.string()),
          seniority: v.union(
            v.literal("board"),
            v.literal("sc"),
            v.literal("jc"),
          ),
          strength: v.number(),
          technicalDomains: v.array(v.string()),
          productDomains: v.array(v.string()),
          languages: v.array(v.string()),
          criterionKeys: v.array(v.string()),
          trainingStatus: v.union(
            v.literal("pending"),
            v.literal("complete"),
            v.literal("blocked"),
          ),
          status: v.union(v.literal("active"), v.literal("inactive")),
          version: v.number(),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person: actor } = await requireCurrentPerson(ctx);
    const actorSubject = await requireEventSubject(ctx, event._id, actor._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: actorSubject._id,
      permissionKey: "reviewer.profile.read",
      scopeType: "event",
    });
    const [rosterSubjects, invitedSubjects, profiles, rolesByType] = await Promise.all([
      ctx.db
        .query("eventAccessSubjects")
        .withIndex("by_event_link_status_email", (index) =>
          index.eq("eventId", event._id).eq("linkedBy", "roster_claim").eq("status", "active"),
        )
        .collect(),
      ctx.db
        .query("eventAccessSubjects")
        .withIndex("by_event_link_status_email", (index) =>
          index.eq("eventId", event._id).eq("linkedBy", "access_invitation").eq("status", "active"),
        )
        .collect(),
      ctx.db
        .query("reviewerProfiles")
        .withIndex("by_event_person", (index) => index.eq("eventId", event._id),
          )
        .collect(),
      Promise.all(
        reviewerCandidateRoles.map((role) =>
          ctx.db
            .query("eventRoles")
            .withIndex("by_event_role_status", (index) =>
              index.eq("eventId", event._id).eq("role", role).eq("status", "active"),
            )
            .collect(),
        ),
      ),
    ]);
    const roleSubjects = await Promise.all(
      rolesByType.flat().map((role) => ctx.db.get(role.eventAccessSubjectId)),
    );
    const profileSubjects = await Promise.all(
      profiles.map((profile) =>
        ctx.db
          .query("eventAccessSubjects")
          .withIndex("by_event_person", (index) =>
            index.eq("eventId", event._id).eq("personId", profile.personId),
          )
          .unique(),
      ),
    );
    const subjectsByPersonId = new Map<Id<"people">, Doc<"eventAccessSubjects">>();
    for (const subject of [
      ...rosterSubjects,
      ...invitedSubjects,
      ...roleSubjects,
      ...profileSubjects,
    ]) {
      if (subject?.eventId === event._id && subject.status === "active") {
        subjectsByPersonId.set(subject.personId, subject);
      }
    }
    const profilesByPersonId = new Map(
      profiles.map((profile) => [profile.personId, profile] as const),
    );
    const eventManageGrantIds = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: actorSubject._id,
      permissionKey: "reviewer.profile.manage",
      scopeType: "event",
    });
    const manageablePersonIds =
      eventManageGrantIds.length > 0
        ? null
        : await boundedActivePermissionScopeIds(ctx, {
            eventId: event._id,
            eventAccessSubjectId: actorSubject._id,
            permissionKey: "reviewer.profile.manage",
            scopeType: "person",
            maximumScopeCount: maximumReviewerAssignmentsPerEvent,
          });
    const rows = [...subjectsByPersonId.values()].map((subject) => {
      const profile = profilesByPersonId.get(subject.personId);
      return {
        personId: subject.personId,
        displayName: subject.displayName,
        email: subject.emailNormalized,
        canManage:
          eventManageGrantIds.length > 0 || manageablePersonIds?.has(subject.personId) === true,
        profile: profile
          ? {
              ...(profile.contactPhone !== undefined ? { contactPhone: profile.contactPhone } : {}),
              seniority: profile.seniority,
              strength: profile.strength,
              technicalDomains: profile.technicalDomains,
              productDomains: profile.productDomains,
              languages: profile.languages,
              criterionKeys: profile.criterionKeys,
              trainingStatus: profile.trainingStatus,
              status: profile.status,
              version: profile.version,
            }
          : null,
      };
    });
    const enriched = await Promise.all(
      rows.map(async (row) => {
        const pool = await ctx.db
          .query("reviewerPoolEntries")
          .withIndex("by_eventId_and_emailNormalized", (q) =>
            q.eq("eventId", event._id).eq("emailNormalized", row.email),
          )
          .unique();
        const participation = await reviewerParticipation(
          ctx,
          event._id,
          row.personId,
        );
        return {
          ...row,
          completedReviews: participation.completedReviews,
          ...(participation.lastReviewedAt === undefined
            ? {}
            : { lastReviewedAt: participation.lastReviewedAt }),
          ...(pool
            ? {
                pool: {
                  seniority: pool.seniority,
                  domain: pool.domain,
                  skills: pool.skills,
                  resumeUrl: pool.resumeUrl,
                  githubReference: pool.githubReference,
                },
              }
            : {}),
        };
      }),
    );
    return enriched.sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName) || left.email.localeCompare(right.email),
    );
  },
});

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    rounds: v.array(
      v.object({
        id: v.id("reviewRounds"),
        stableKey: v.string(),
        name: v.string(),
        sequence: v.number(),
        status: v.string(),
        startsAt: v.number(),
        endsAt: v.number(),
        clockInOpensAt: v.number(),
        reviewerReportAt: v.number(),
        noShowGraceSeconds: v.number(),
        correctionRequestsCloseAt: v.number(),
        panelCount: v.number(),
        reviewerCount: v.number(),
        reserveCount: v.number(),
        canReadBoard: v.boolean(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.configuration.read",
      scopeType: "event",
    });
    const rounds = await ctx.db
      .query("reviewRounds")
      .withIndex("by_event_status_start", (index) => index.eq("eventId", event._id),
      )
      .collect();
    const summaries = await Promise.all(
      rounds.map(async (round) => {
        const [panels, roundReadGrantIds] = await Promise.all([
          ctx.db
            .query("reviewPanels")
            .withIndex("by_round_status", (index) => index.eq("roundId", round._id),
            )
            .collect(),
          matchingPermissionGrantIds(ctx, {
            eventId: event._id,
            eventAccessSubjectId: subject._id,
            permissionKey: "round.read",
            scopeType: "round",
            scopeId: round._id,
          }),
        ]);
        const [members, reserves] = await Promise.all([
          Promise.all(
            panels.map((panel) =>
              ctx.db
                .query("reviewPanelMembers")
                .withIndex("by_panel_status", (index) =>
                  index.eq("panelId", panel._id).eq("status", "active"),
                )
                .collect(),
            ),
          ),
          ctx.db
            .query("reviewRoundReserves")
            .withIndex("by_round_status", (index) => index.eq("roundId", round._id),
            )
            .collect(),
        ]);
        return {
          id: round._id,
          stableKey: round.stableKey,
          name: round.name,
          sequence: round.sequence,
          status: round.status,
          startsAt: round.startsAt,
          endsAt: round.endsAt,
          clockInOpensAt: round.clockInOpensAt,
          reviewerReportAt: round.reviewerReportAt,
          noShowGraceSeconds: round.noShowGraceSeconds,
          correctionRequestsCloseAt: round.correctionRequestsCloseAt,
          panelCount: panels.filter((panel) => panel.status !== "closed").length,
          reviewerCount: new Set(members.flat().map((member) => member.personId),
          ).size,
          reserveCount: reserves.filter((reserve) => reserve.status !== "removed",
          ).length,
          canReadBoard: roundReadGrantIds.length > 0,
        };
      }),
    );
    return { rounds: summaries.sort((left, right) => left.sequence - right.sequence),
    };
  },
});

export const publishRound = mutation({
  args: {
    eventSlug: v.string(),
    confirmationOpensAt: v.number(),
    rubric: v.object({
      name: v.string(),
      spreadThreshold: v.number(),
      criteria: v.array(criterionInput),
    }),
    round: v.object({
      stableKey: v.string(),
      name: v.string(),
      sequence: v.number(),
      startsAt: v.number(),
      endsAt: v.number(),
      clockInOpensAt: v.number(),
      reviewerReportAt: v.number(),
      noShowGraceSeconds: v.number(),
      correctionRequestsCloseAt: v.number(),
      reviewDurationSeconds: v.number(),
      ordinaryExtensionSeconds: v.number(),
      maximumOrdinaryExtensions: v.number(),
      missedCallGraceSeconds: v.number(),
      requiredCallAttempts: v.number(),
      substituteResponseSeconds: v.number(),
      missedReentryPolicy: v.union(
        v.literal("preserve_queue_time"),
        v.literal("queue_end"),
        v.literal("manual"),
      ),
      staffing: reviewStaffingPolicy,
      requiredPanelSize: v.number(),
      minimumScorersPerCriterion: v.number(),
      minimumPresentParticipants: v.number(),
      requiresSharedCommitments: v.boolean(),
      requiresFinalComment: v.boolean(),
      minimumReviewerBuild: v.number(),
      requiresCamera: v.boolean(),
      requiresNotifications: v.boolean(),
    }),
    panels: v.array(panelInput),
    reservePersonIds: v.array(v.id("people")),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    roundId: v.id("reviewRounds"),
    rubricVersionId: v.id("reviewRubricVersions"),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person: actor } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, actor._id);
    const requestFingerprint = operationFingerprint([
      args.confirmationOpensAt,
      JSON.stringify(args.rubric),
      JSON.stringify(args.round),
      JSON.stringify(args.panels),
      JSON.stringify(args.reservePersonIds),
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: actor._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.round.publish",
      requestFingerprint,
    });
    if (prior) {
      const roundId = ctx.db.normalizeId("reviewRounds", prior.targetId);
      const rubricVersionId = prior.resultJson
        ? ctx.db.normalizeId("reviewRubricVersions", prior.resultJson)
        : null;
      if (!roundId || !rubricVersionId) throw new Error("Prior round result is invalid.");
      return { roundId, rubricVersionId };
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.configuration.publish",
      scopeType: "event",
    });
    if (event.status === "complete") {
      throw new ConvexError({
        code: "EVENT_COMPLETE",
        message: "A completed event cannot publish a round.",
      });
    }
    const participantPolicy = await loadPublishedParticipantPolicy(ctx, event);
    validateReviewerRoundStaffingPolicy(args.round);
    validateStaffingPolicy(args.round.staffing, args.round.requiredPanelSize);
    if (
      !Number.isSafeInteger(args.confirmationOpensAt) ||
      args.confirmationOpensAt > args.round.clockInOpensAt
    ) {
      throw new ConvexError({
        code: "INVALID_CONFIRMATION_TIME",
        message: "Availability confirmation must open before clock-in.",
      });
    }
    requireScoreCorrectionPolicy(args.round);
    const roundKey = stableKey(args.round.stableKey, "Round key");
    const existingRound = await ctx.db
      .query("reviewRounds")
      .withIndex("by_event_key", (index) =>
        index.eq("eventId", event._id).eq("stableKey", roundKey),
      )
      .unique();
    if (existingRound) {
      throw new ConvexError({
        code: "ROUND_EXISTS",
        message: "That round key is already published.",
      });
    }
    const roundCapacityProbe = await ctx.db
      .query("reviewRounds")
      .withIndex("by_event_status_start", (index) => index.eq("eventId", event._id),
      )
      .take(maximumReviewRoundsPerEvent);
    if (roundCapacityProbe.length === maximumReviewRoundsPerEvent) {
      throw new ConvexError({
        code: "REVIEW_ROUND_LIMIT_REACHED",
        message: `An event can publish at most ${maximumReviewRoundsPerEvent} review rounds.`,
      });
    }
    if (
      !Number.isInteger(args.round.sequence) ||
      args.round.sequence < 1 ||
      !Number.isInteger(args.round.reviewDurationSeconds) ||
      args.round.reviewDurationSeconds < 120 ||
      args.round.reviewDurationSeconds > 3_600 ||
      !Number.isInteger(args.round.ordinaryExtensionSeconds) ||
      args.round.ordinaryExtensionSeconds < 0 ||
      args.round.ordinaryExtensionSeconds > 900 ||
      !Number.isInteger(args.round.maximumOrdinaryExtensions) ||
      args.round.maximumOrdinaryExtensions < 0 ||
      args.round.maximumOrdinaryExtensions > 3 ||
      !Number.isInteger(args.round.missedCallGraceSeconds) ||
      args.round.missedCallGraceSeconds < 30 ||
      args.round.missedCallGraceSeconds > 1_800 ||
      !Number.isInteger(args.round.requiredCallAttempts) ||
      args.round.requiredCallAttempts < 1 ||
      args.round.requiredCallAttempts > 5 ||
      !Number.isInteger(args.round.substituteResponseSeconds) ||
      args.round.substituteResponseSeconds < 30 ||
      args.round.substituteResponseSeconds > 300 ||
      !Number.isInteger(args.round.requiredPanelSize) ||
      args.round.requiredPanelSize < 1 ||
      args.round.requiredPanelSize > 7 ||
      !Number.isInteger(args.round.minimumScorersPerCriterion) ||
      args.round.minimumScorersPerCriterion < 1 ||
      args.round.minimumScorersPerCriterion > args.round.requiredPanelSize ||
      !Number.isInteger(args.round.minimumPresentParticipants) ||
      args.round.minimumPresentParticipants < 1 ||
      args.round.minimumPresentParticipants > participantPolicy.normalized.teamMaximumSize ||
      !Number.isInteger(args.round.minimumReviewerBuild) ||
      args.round.minimumReviewerBuild < 1
    ) {
      throw new ConvexError({
        code: "INVALID_ROUND_CONFIGURATION",
        message: "Round timing, panel, coverage, or participant requirements are invalid.",
      });
    }
    if (
      args.rubric.criteria.length < 1 ||
      args.rubric.criteria.length > maximumReviewCriteriaPerRubric
    ) {
      throw new ConvexError({
        code: "INVALID_RUBRIC",
        message: `A rubric needs between 1 and ${maximumReviewCriteriaPerRubric} criteria.`,
      });
    }
    const criteria = args.rubric.criteria.map((criterion) => ({
      stableKey: stableKey(criterion.stableKey, "Criterion key"),
      label: normalizedText(criterion.label, "Criterion label", 2, 100),
      question: normalizedText(criterion.question, "Criterion question", 5, 240,
      ),
      guidance: normalizedText(criterion.guidance, "Criterion guidance", 5, 1_000,
      ),
      weight: criterion.weight,
      displayOrder: criterion.displayOrder,
      anchors: {
        zero: normalizedText(criterion.anchors.zero, "Score 0 anchor", 2, 240),
        one: normalizedText(criterion.anchors.one, "Score 1 anchor", 2, 240),
        two: normalizedText(criterion.anchors.two, "Score 2 anchor", 2, 240),
        three: normalizedText(criterion.anchors.three, "Score 3 anchor", 2, 240,
        ),
        four: normalizedText(criterion.anchors.four, "Score 4 anchor", 2, 240),
      },
    }));
    const spreadThreshold = validateScoreSpreadThreshold(args.rubric.spreadThreshold,
    );
    unique(
      criteria.map((criterion) => criterion.stableKey),
      "Criterion keys",
    );
    unique(
      criteria.map((criterion) => String(criterion.displayOrder)),
      "Criterion display positions",
    );
    if (
      criteria.some(
        (criterion) =>
          !Number.isInteger(criterion.displayOrder) ||
          criterion.displayOrder < 0 ||
          !Number.isInteger(criterion.weight) ||
          criterion.weight < 1 ||
          criterion.weight > 100,
      ) ||
      criteria.reduce((total, criterion) => total + criterion.weight, 0) !== 100
    ) {
      throw new ConvexError({
        code: "INVALID_RUBRIC",
        message: "Criterion weights must be positive integers totalling 100.",
      });
    }
    if (args.panels.length < 1 || args.panels.length > 100) {
      throw new ConvexError({
        code: "INVALID_PANELS",
        message: "Publish at least one and at most 100 panels.",
      });
    }
    const panels = args.panels.map((panel) => ({
      stableKey: stableKey(panel.stableKey, "Panel key"),
      name: normalizedText(panel.name, "Panel name", 2, 80),
      members: panel.members,
    }));
    unique(
      panels.map((panel) => panel.stableKey),
      "Panel keys",
    );
    unique(
      panels.map((panel) => panel.name.toLocaleLowerCase()),
      "Panel names",
    );
    const allReviewerIds = panels.flatMap((panel) =>
      panel.members.map((member) => member.personId),
    );
    unique(allReviewerIds, "Reviewer assignments across panels");
    unique(args.reservePersonIds, "Reserve reviewers");
    const panelReviewerIds = new Set(allReviewerIds);
    if (args.reservePersonIds.some((personId) => panelReviewerIds.has(personId))) {
      throw new ConvexError({
        code: "REVIEWER_ASSIGNED_TWICE",
        message: "A reviewer cannot hold a panel seat and a reserve seat in the same round.",
      });
    }
    if (args.reservePersonIds.length > 100) {
      throw new ConvexError({
        code: "TOO_MANY_RESERVES",
        message: "A round can publish at most 100 reserve reviewers.",
      });
    }
    const rosteredReviewerIds = [...allReviewerIds, ...args.reservePersonIds];
    if (
      args.round.staffing.automaticReplacement &&
      rosteredReviewerIds.length > 100
    )
      throw new ConvexError({
        code: "REVIEWER_POOL_TOO_LARGE",
        message:
          "Automatic staffing supports a total pool of 100 reviewers, including seated members and reserves.",
      });
    if (rosteredReviewerIds.length > 500) {
      throw new ConvexError({
        code: "REVIEWER_POOL_TOO_LARGE",
        message: "A round can include at most 500 reviewers.",
      });
    }

    const reviewerContexts = new Map<
      Id<"people">,
      {
        personId: Id<"people">;
        subjectId: Id<"eventAccessSubjects">;
        criterionKeys: ReadonlySet<string>;
        seniority?: ReviewerSeniority;
      }
    >();
    for (const reviewerPersonId of rosteredReviewerIds) {
      const [reviewer, reviewerSubject, reviewerProfile] = await Promise.all([
        ctx.db.get(reviewerPersonId),
        ctx.db
          .query("eventAccessSubjects")
          .withIndex("by_event_person", (index) =>
            index.eq("eventId", event._id).eq("personId", reviewerPersonId),
          )
          .unique(),
        ctx.db
          .query("reviewerProfiles")
          .withIndex("by_event_person", (index) =>
            index.eq("eventId", event._id).eq("personId", reviewerPersonId),
          )
          .unique(),
      ]);
      if (
        !reviewer ||
        reviewer.status !== "active" ||
        !reviewerSubject ||
        reviewerSubject.status !== "active" ||
        (allReviewerIds.includes(reviewerPersonId) &&
          (!reviewerProfile ||
        reviewerProfile.status !== "active" ||
        reviewerProfile.trainingStatus !== "complete"
      ))
      ) {
        throw new ConvexError({
          code: "REVIEWER_NOT_READY",
          message: "Every panel member needs active event access and completed reviewer training.",
        });
      }
      reviewerContexts.set(reviewerPersonId, {
        personId: reviewer._id,
        subjectId: reviewerSubject._id,
        criterionKeys: new Set(reviewerProfile?.criterionKeys ?? []),
        ...(reviewerProfile ? { seniority: reviewerProfile.seniority } : {}),
      });
    }

    const criterionKeys = new Set(criteria.map((criterion) => criterion.stableKey),
    );
    for (const panel of panels) {
      validatePanelComposition(
        panel.members.map((member) => {
          const seniority = reviewerContexts.get(member.personId)?.seniority;
          if (!seniority) throw new Error("Reviewer seniority is missing.");
          return { seniority, isCoordinator: member.isCoordinator };
        }),
        args.round.staffing,
      );
      if (panel.members.length !== args.round.requiredPanelSize) {
        throw new ConvexError({
          code: "PANEL_SIZE_MISMATCH",
          message: "Every panel must have the published reviewer count.",
        });
      }
      if (panel.members.filter((member) => member.isCoordinator).length !== 1) {
        throw new ConvexError({
          code: "PANEL_COORDINATOR_REQUIRED",
          message: "Every panel needs exactly one coordinator.",
        });
      }
      for (const member of panel.members) {
        unique(member.criterionKeys, "One reviewer's criterion assignments");
        const reviewer = reviewerContexts.get(member.personId);
        if (!reviewer) throw new Error("Validated reviewer context is missing.");
        if (
          member.criterionKeys.length === 0 ||
          member.criterionKeys.some(
            (key) => !criterionKeys.has(key) || !reviewer.criterionKeys.has(key),
          )
        ) {
          throw new ConvexError({
            code: "INVALID_CRITERION_ASSIGNMENT",
            message: "Every reviewer needs valid criteria covered by their qualification profile.",
          });
        }
      }
      for (const criterion of criteria) {
        const coverage = panel.members.filter((member) =>
          member.criterionKeys.includes(criterion.stableKey),
        ).length;
        if (coverage < args.round.minimumScorersPerCriterion) {
          throw new ConvexError({
            code: "PANEL_COVERAGE_GAP",
            message: `${panel.name} does not meet scorer coverage for ${criterion.label}.`,
          });
        }
      }
    }

    const now = Date.now();
    const previousRubric = await ctx.db
      .query("reviewRubricVersions")
      .withIndex("by_event_version", (index) => index.eq("eventId", event._id))
      .order("desc")
      .first();
    const rubricVersion = (previousRubric?.version ?? 0) + 1;
    const aggregationFormula = "criterion_mean_weighted_v1" as const;
    const rubricChecksum = operationFingerprint([
      args.rubric.name,
      aggregationFormula,
      spreadThreshold,
      JSON.stringify(criteria),
    ]);
    const rubricVersionId = await ctx.db.insert("reviewRubricVersions", {
      eventId: event._id,
      version: rubricVersion,
      name: normalizedText(args.rubric.name, "Rubric name", 2, 100),
      status: "published",
      scoreMinimum: 0,
      scoreMaximum: 4,
      aggregationFormula,
      spreadThreshold,
      checksum: rubricChecksum,
      createdByPersonId: actor._id,
      createdAt: now,
      publishedAt: now,
    });
    const criterionIds = new Map<string, Id<"reviewRubricCriteria">>();
    for (const criterion of criteria) {
      const criterionId = await ctx.db.insert("reviewRubricCriteria", {
        eventId: event._id,
        rubricVersionId,
        ...criterion,
        createdAt: now,
      });
      criterionIds.set(criterion.stableKey, criterionId);
    }
    const configurationChecksum = operationFingerprint([
      rubricChecksum,
      JSON.stringify(args.round),
      JSON.stringify(args.panels),
      JSON.stringify(args.reservePersonIds),
    ]);
    const roundId = await ctx.db.insert("reviewRounds", {
      eventId: event._id,
      rubricVersionId,
      stableKey: roundKey,
      name: normalizedText(args.round.name, "Round name", 2, 100),
      sequence: args.round.sequence,
      status: "published",
      startsAt: args.round.startsAt,
      endsAt: args.round.endsAt,
      clockInOpensAt: args.round.clockInOpensAt,
      reviewerReportAt: args.round.reviewerReportAt,
      noShowGraceSeconds: args.round.noShowGraceSeconds,
      correctionRequestsCloseAt: args.round.correctionRequestsCloseAt,
      reviewDurationSeconds: args.round.reviewDurationSeconds,
      ordinaryExtensionSeconds: args.round.ordinaryExtensionSeconds,
      maximumOrdinaryExtensions: args.round.maximumOrdinaryExtensions,
      missedCallGraceSeconds: args.round.missedCallGraceSeconds,
      requiredCallAttempts: args.round.requiredCallAttempts,
      substituteResponseSeconds: args.round.substituteResponseSeconds,
      missedReentryPolicy: args.round.missedReentryPolicy,
      staffing: args.round.staffing,
      requiredPanelSize: args.round.requiredPanelSize,
      minimumScorersPerCriterion: args.round.minimumScorersPerCriterion,
      minimumPresentParticipants: args.round.minimumPresentParticipants,
      requiresSharedCommitments: args.round.requiresSharedCommitments,
      requiresFinalComment: args.round.requiresFinalComment,
      minimumReviewerBuild: args.round.minimumReviewerBuild,
      requiresCamera: args.round.requiresCamera,
      requiresNotifications: args.round.requiresNotifications,
      version: 1,
      configurationChecksum,
      createdByPersonId: actor._id,
      createdAt: now,
      publishedAt: now,
    });
    await createRoundConfirmationRequest(ctx, {
      eventId: event._id,
      roundId,
      opensAt: args.confirmationOpensAt,
      endsAt: args.round.endsAt,
      personIds: rosteredReviewerIds,
      now,
    });
    for (const panel of panels) {
      const coordinator = panel.members.find((member) => member.isCoordinator);
      if (!coordinator) throw new Error("Validated panel coordinator is missing.");
      const panelId = await ctx.db.insert("reviewPanels", {
        eventId: event._id,
        roundId,
        stableKey: panel.stableKey,
        name: panel.name,
        coordinatorPersonId: coordinator.personId,
        status: "ready",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      await appendReviewPanelVacancyReadFactById(ctx, panelId, now);
      for (const member of panel.members) {
        const reviewer = reviewerContexts.get(member.personId);
        if (!reviewer) throw new Error("Validated reviewer context is missing.");
        const assignedCriterionIds = member.criterionKeys.map((key) => {
          const criterionId = criterionIds.get(key);
          if (!criterionId) throw new Error("Validated criterion mapping is missing.");
          return criterionId;
        });
        const panelMemberId = await ctx.db.insert("reviewPanelMembers", {
          eventId: event._id,
          roundId,
          panelId,
          personId: reviewer.personId,
          eventAccessSubjectId: reviewer.subjectId,
          assignedCriterionIds,
          isCoordinator: member.isCoordinator,
          status: "active",
          assignedAt: now,
          seatSeniority: member.isCoordinator
            ? "lead"
            : reviewer.seniority === "jc"
              ? "jc"
              : "sc",
        });
        await grantPanelMemberAccess(ctx, {
          eventId: event._id,
          roundId,
          panelId,
          panelMemberId,
          reviewerPersonId: reviewer.personId,
          eventAccessSubjectId: reviewer.subjectId,
          grantedByPersonId: actor._id,
          isCoordinator: member.isCoordinator,
          reason: "Published review panel assignment",
        });
      }
    }
    for (const reservePersonId of args.reservePersonIds) {
      const reviewer = reviewerContexts.get(reservePersonId);
      if (!reviewer) throw new Error("Validated reserve reviewer context is missing.");
      const reserveId = await ctx.db.insert("reviewRoundReserves", {
        eventId: event._id,
        roundId,
        personId: reviewer.personId,
        eventAccessSubjectId: reviewer.subjectId,
        status: "available",
        pageCount: 0,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      let createdGrantCount = 0;
      for (const permissionKey of [
        "reviewer.device.register",
        "communications.call_consent.manage",
      ] as const) {
        const result = await insertPermissionGrant(ctx, {
          eventId: event._id,
          personId: reviewer.personId,
          eventAccessSubjectId: reviewer.subjectId,
          permissionKey,
          scopeType: "self",
          scopeId: reviewer.subjectId,
          sourceType: "reserve_assignment",
          sourceId: reserveId,
          grantedByPersonId: actor._id,
          reason: "Published reserve reviewer assignment",
        });
        if (result.created) createdGrantCount += 1;
      }
      for (const permissionKey of ["reviewer.clock_in", "round.read",
      ] as const) {
        const result = await insertPermissionGrant(ctx, {
          eventId: event._id,
          personId: reviewer.personId,
          eventAccessSubjectId: reviewer.subjectId,
          permissionKey,
          scopeType: "round",
          scopeId: roundId,
          sourceType: "reserve_assignment",
          sourceId: reserveId,
          grantedByPersonId: actor._id,
          reason: "Published reserve reviewer assignment",
        });
        if (result.created) createdGrantCount += 1;
      }
      if (createdGrantCount > 0) {
        await advanceAccessVersion(ctx, reviewer.subjectId, now);
      }
    }
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: actor._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.round.publish",
      requestFingerprint,
      targetType: "review_round",
      targetId: roundId,
      resultJson: rubricVersionId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: actor._id,
      permissionKey: "review.configuration.publish",
      grantIds,
      scopeType: "event",
      action: "review.round_published",
      targetType: "review_round",
      targetId: roundId,
      nextSummary: JSON.stringify({
        roundKey,
        rubricVersion,
        panelCount: panels.length,
        reviewerCount: reviewerContexts.size,
        panelReviewerCount: allReviewerIds.length,
        reserveCount: args.reservePersonIds.length,
        configurationChecksum,
      }),
      reason: normalizedText(args.reason, "Reason", 3, 300),
    });
    return { roundId, rubricVersionId };
  },
});
