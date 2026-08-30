import {
  findVitHostelResidenceCatalogEntry,
  vitHostelResidenceCatalogLabel,
} from "@code2create/domain";
import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { DataModel, Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { loadPublishedCommunicationsPolicy } from "./lib/communicationsPolicy";
import { requireEventBySlug } from "./lib/events";
import { floorLocationDescription, nearestLandmarkName } from "./lib/floor";
import {
  requireCurrentPerson,
  requireEventSubject,
  requireFreshAuthSession,
  sensitiveCommandSessionMaxAgeMs,
} from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
} from "./lib/operations";
import { requirePermission } from "./lib/permissions";
import { loadPublishedParticipantPolicy } from "./lib/participantPolicy";
import { normalizedText } from "./lib/strings";
import { appendEmergencyPackReadFactById } from "./lib/operationsAutonomyReadFacts/incidentReadiness";
import {
  attendanceSessionRequirement,
  attendanceSessionStatus,
  attendanceStationStatus,
  eventStatus,
  participantClass,
  participantEligibilityStatus,
  reviewPanelStatus,
  reviewRoundStatus,
  teamStatus,
  venuePresenceState,
} from "./values";
import { exportWorkpool } from "./workpools";

const maximumRosterRows = 1_200;
const maximumEventTeams = 400;
const maximumEventStations = 100;
const maximumActiveRounds = 10;
const maximumCurrentPanels = 400;
const maximumSpareSheets = 20;
const packLifetimeMs = 4 * 60 * 60 * 1_000;
const packIdValidator = v.id("emergencyPacks");
const skipGenerationKind = "skip" as const;
const generateGenerationKind = "generate" as const;
const expiredPackStatus = "expired" as const;

const rosterRow = v.object({
  participantReference: v.string(),
  name: v.string(),
  phone: v.optional(v.string()),
  vitRegistrationNumber: v.optional(v.string()),
  vitHostelResidence: v.optional(v.string()),
  vitHostelRoomNumber: v.optional(v.string()),
  participantClass,
  eligibilityStatus: participantEligibilityStatus,
  teamName: v.optional(v.string()),
  teamCode: v.optional(v.string()),
  teamStatus: v.optional(teamStatus),
  attendanceState: venuePresenceState,
  attendanceZoneName: v.optional(v.string()),
  attendanceUpdatedAt: v.optional(v.number()),
  hallZoneName: v.optional(v.string()),
  hallLocation: v.optional(v.string()),
});

const stationSnapshot = v.object({
  id: v.string(),
  stableKey: v.string(),
  name: v.string(),
  zoneId: v.string(),
  zoneName: v.string(),
  status: attendanceStationStatus,
  configurationVersion: v.number(),
  deviceName: v.optional(v.string()),
});

const sessionSnapshot = v.object({
  id: v.string(),
  name: v.string(),
  status: attendanceSessionStatus,
  requirement: attendanceSessionRequirement,
  zoneId: v.string(),
  zoneName: v.string(),
  startsAt: v.number(),
  endsAt: v.number(),
  expectationCount: v.number(),
  version: v.number(),
});

const criterionSnapshot = v.object({
  id: v.string(),
  label: v.string(),
  question: v.string(),
  displayOrder: v.number(),
});

const panelSnapshot = v.object({
  id: v.string(),
  name: v.string(),
  status: reviewPanelStatus,
  version: v.number(),
  coordinatorName: v.string(),
  reviewerNames: v.array(v.string()),
});

const roundSnapshot = v.object({
  id: v.string(),
  name: v.string(),
  status: reviewRoundStatus,
  startsAt: v.number(),
  endsAt: v.number(),
  version: v.number(),
  rubricName: v.string(),
  scoreMinimum: v.number(),
  scoreMaximum: v.number(),
  requiresSharedCommitments: v.boolean(),
  criteria: v.array(criterionSnapshot),
  panels: v.array(panelSnapshot),
});

const snapshot = v.object({
  event: v.object({
    name: v.string(),
    slug: v.string(),
    timezone: v.string(),
    status: eventStatus,
    venue: v.optional(v.string()),
    startsAt: v.optional(v.number()),
    endsAt: v.optional(v.number()),
    version: v.number(),
  }),
  snapshotAt: v.number(),
  roster: v.array(rosterRow),
  stations: v.array(stationSnapshot),
  sessions: v.array(sessionSnapshot),
  rounds: v.array(roundSnapshot),
});

const packCounts = v.object({
  participants: v.number(),
  teams: v.number(),
  stations: v.number(),
  sessions: v.number(),
  rounds: v.number(),
  panels: v.number(),
  attendanceSheets: v.number(),
  reviewSheets: v.number(),
});

const packView = v.object({
  id: v.id("emergencyPacks"),
  requestedByName: v.string(),
  purpose: v.string(),
  spareAttendanceSheetCount: v.number(),
  spareReviewSheetCount: v.number(),
  status: v.union(
    v.literal("pending"),
    v.literal("ready"),
    v.literal("failed"),
    v.literal("expired"),
  ),
  expiresAt: v.number(),
  requestedAt: v.number(),
  snapshotAt: v.optional(v.number()),
  snapshotChecksum: v.optional(v.string()),
  counts: v.optional(packCounts),
  byteCount: v.optional(v.number()),
  sha256: v.optional(v.string()),
  completedAt: v.optional(v.number()),
  version: v.number(),
});

function validateSpareCount(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximumSpareSheets) {
    throw new ConvexError({
      code: "INVALID_EMERGENCY_PACK_SHEET_COUNT",
      message: `${label} must be a whole number from zero to ${maximumSpareSheets}.`,
    });
  }
}

function mapById<T extends { _id: string }>(rows: readonly T[]) {
  return new Map(rows.map((row) => [row._id, row]));
}

function activeRoundStatus(status: Doc<"reviewRounds">["status"]) {
  return status === "published" || status === "open" || status === "closing";
}

function activeSessionStatus(status: Doc<"attendanceSessions">["status"]) {
  return status === "ready" || status === "open" || status === "closing";
}

async function buildSnapshot(
  ctx: QueryCtx,
  event: Doc<"events">,
) {
  const [
    { normalized: communicationsPolicy },
    { normalized: participantPolicy },
  ] = await Promise.all([
    loadPublishedCommunicationsPolicy(ctx, event),
    loadPublishedParticipantPolicy(ctx, event),
  ]);
  const attendancePlanId = event.publishedAttendancePlanVersionId;
  const floorPlanId = event.publishedFloorPlanVersionId;
  const snapshotAt = Date.now();
  const memberships = await ctx.db
    .query("eventMemberships")
    .withIndex("by_event_onboarding_status", (index) =>
      index.eq("eventId", event._id).eq("onboardingStatus", "accepted"),
    )
    .take(maximumRosterRows + 1);
  if (memberships.length > maximumRosterRows) {
    throw new ConvexError({
      code: "EMERGENCY_PACK_ROSTER_TOO_LARGE",
      message: `The emergency roster exceeds the ${maximumRosterRows}-participant pack limit.`,
    });
  }

  const membershipRows = await Promise.all(
    memberships.map(async (membership) => {
      const [profile, teamMember, venueState] = await Promise.all([
        ctx.db
          .query("participantProfiles")
          .withIndex("by_membership", (index) =>
            index.eq("membershipId", membership._id),
          )
          .unique(),
        ctx.db
          .query("teamMembers")
          .withIndex("by_event_membership_status", (index) =>
            index
              .eq("eventId", event._id)
              .eq("membershipId", membership._id)
              .eq("status", "active"),
          )
          .unique(),
        ctx.db
          .query("attendanceVenueStates")
          .withIndex("by_event_membership", (index) =>
            index.eq("eventId", event._id).eq("membershipId", membership._id),
          )
          .unique(),
      ]);
      return { membership, profile, teamMember, venueState };
    }),
  );
  const teamIds = [...new Set(
    membershipRows.flatMap(({ teamMember }) =>
      teamMember === null ? [] : [teamMember.teamId],
    ),
  )];
  if (teamIds.length > maximumEventTeams) {
    throw new ConvexError({
      code: "EMERGENCY_PACK_TEAM_COUNT_TOO_LARGE",
      message: `The emergency pack supports at most ${maximumEventTeams} event teams.`,
    });
  }
  const teams = (await Promise.all(teamIds.map((teamId) => ctx.db.get(teamId)))).filter(
    (team): team is Doc<"teams"> => team !== null,
  );
  const teamsById = mapById(teams);
  const teamByMembership = new Map<Id<"eventMemberships">, Doc<"teams">>();
  for (const { membership, teamMember } of membershipRows) {
    if (!teamMember) continue;
    const team = teamsById.get(teamMember.teamId);
    if (!team) continue;
    teamByMembership.set(membership._id, team);
  }

  const attendanceZones = attendancePlanId
    ? await ctx.db
        .query("attendanceZones")
        .withIndex("by_plan_key", (index) =>
          index.eq("planVersionId", attendancePlanId),
        )
        .collect()
    : [];
  const attendanceZonesById = mapById(attendanceZones);

  const [floorZones, floorLandmarks, floorLocations] = floorPlanId
    ? await Promise.all([
        ctx.db
          .query("floorZones")
          .withIndex("by_plan_order", (index) =>
            index.eq("planVersionId", floorPlanId),
          )
          .collect(),
        ctx.db
          .query("floorLandmarks")
          .withIndex("by_plan_order", (index) =>
            index.eq("planVersionId", floorPlanId),
          )
          .collect(),
        ctx.db
          .query("teamFloorLocations")
          .withIndex("by_plan_state", (index) =>
            index
              .eq("planVersionId", floorPlanId)
              .eq("state", "active"),
          )
          .collect(),
      ])
    : [[], [], []];
  const floorZonesById = mapById(floorZones);
  const floorLocationByTeam = new Map(
    floorLocations.map((location) => [location.teamId, location]),
  );

  const roster = membershipRows
    .map(({ membership, profile, venueState }) => {
      const team = teamByMembership.get(membership._id);
      const location = team ? floorLocationByTeam.get(team._id) : undefined;
      const attendanceZone = venueState?.zoneId
        ? attendanceZonesById.get(venueState.zoneId)
        : undefined;
      const hallZone = location ? floorZonesById.get(location.zoneId) : undefined;
      const hallLocation =
        location && hallZone
          ? floorLocationDescription(
              hallZone.name,
              location.area,
              nearestLandmarkName(
                hallZone,
                floorLandmarks.filter((landmark) => landmark.zoneId === hallZone._id),
                location.x,
                location.y,
              ),
            )
          : undefined;
      return {
        participantReference: membership._id,
        name: profile?.preferredName ?? profile?.fullName ?? "Profile incomplete",
        ...(profile?.phone ? { phone: profile.phone } : {}),
        ...(profile?.vitRegistrationNumber
          ? { vitRegistrationNumber: profile.vitRegistrationNumber }
          : {}),
        ...(profile?.vitHostelResidence !== undefined
          ? {
              vitHostelResidence: vitHostelResidenceLabel(
                participantPolicy.vitHostelResidenceCatalog,
                profile.vitHostelResidence,
              ),
            }
          : {}),
        ...(profile?.vitHostelRoomNumber !== undefined
          ? { vitHostelRoomNumber: profile.vitHostelRoomNumber }
          : {}),
        participantClass: membership.participantClass,
        eligibilityStatus: membership.eligibilityStatus,
        ...(team
          ? {
              teamName: team.name,
              teamCode: team.publicCode,
              teamStatus: team.status,
            }
          : {}),
        attendanceState: venueState?.state ?? "unknown",
        ...(attendanceZone ? { attendanceZoneName: attendanceZone.name } : {}),
        ...(venueState ? { attendanceUpdatedAt: venueState.updatedAt } : {}),
        ...(hallZone ? { hallZoneName: hallZone.name } : {}),
        ...(hallLocation !== undefined ? { hallLocation } : {}),
      };
    })
    .sort(
      (left, right) =>
        (left.teamName ?? "\uffff").localeCompare(right.teamName ?? "\uffff") ||
        left.name.localeCompare(right.name),
    );

  const [allSessions, allStations] = attendancePlanId
    ? await Promise.all([
        ctx.db
          .query("attendanceSessions")
          .withIndex("by_plan_key", (index) =>
            index.eq("planVersionId", attendancePlanId),
          )
          .collect(),
        ctx.db
          .query("attendanceStations")
          .withIndex("by_plan_key", (index) =>
            index.eq("planVersionId", attendancePlanId),
          )
          .take(maximumEventStations + 1),
      ])
    : [[], []];
  if (allStations.length > maximumEventStations) {
    throw new ConvexError({
      code: "EMERGENCY_PACK_STATION_COUNT_TOO_LARGE",
      message: `The emergency pack supports at most ${maximumEventStations} stations.`,
    });
  }
  const deviceRows = await Promise.all(
    allStations.map((station) =>
      station.deviceInstallationId
        ? ctx.db.get(station.deviceInstallationId)
        : Promise.resolve(null),
    ),
  );
  const sessions = allSessions
    .filter((session) => activeSessionStatus(session.status))
    .sort((left, right) => left.startsAt - right.startsAt)
    .map((session) => ({
      id: session._id,
      name: session.name,
      status: session.status,
      requirement: session.requirement,
      zoneId: session.zoneId,
      zoneName: attendanceZonesById.get(session.zoneId)?.name ?? "Unknown zone",
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      expectationCount: session.expectationCount,
      version: session.version,
    }));
  const stations = allStations
    .map((station, index) => {
      const device = deviceRows[index];
      return {
        id: station._id,
        stableKey: station.stableKey,
        name: station.name,
        zoneId: station.zoneId,
        zoneName: attendanceZonesById.get(station.zoneId)?.name ?? "Unknown zone",
        status: station.status,
        configurationVersion: station.configurationVersion,
        ...(device ? { deviceName: device.name } : {}),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const allRounds = await ctx.db
    .query("reviewRounds")
    .withIndex("by_event_status_start", (index) => index.eq("eventId", event._id))
    .collect();
  const activeRounds = allRounds.filter((round) => activeRoundStatus(round.status));
  if (activeRounds.length > maximumActiveRounds) {
    throw new ConvexError({
      code: "EMERGENCY_PACK_ROUND_COUNT_TOO_LARGE",
      message: `The emergency pack supports at most ${maximumActiveRounds} active review rounds.`,
    });
  }
  const rounds = await Promise.all(
    activeRounds
      .sort((left, right) => left.sequence - right.sequence)
      .map(async (round) => {
        const [rubric, criteria, panels] = await Promise.all([
          ctx.db.get(round.rubricVersionId),
          ctx.db
            .query("reviewRubricCriteria")
            .withIndex("by_rubric_order", (index) =>
              index.eq("rubricVersionId", round.rubricVersionId),
            )
            .collect(),
          ctx.db
            .query("reviewPanels")
            .withIndex("by_round_status", (index) => index.eq("roundId", round._id))
            .take(maximumCurrentPanels + 1),
        ]);
        if (!rubric || rubric.eventId !== event._id) {
          throw new Error("An active emergency-pack round has no event rubric.");
        }
        const panelRows = await Promise.all(
          panels
            .sort((left, right) => left.name.localeCompare(right.name))
            .map(async (panel) => {
              const members = await ctx.db
                .query("reviewPanelMembers")
                .withIndex("by_panel_status", (index) =>
                  index.eq("panelId", panel._id).eq("status", "active"),
                )
                .collect();
              const people = await Promise.all(
                [panel.coordinatorPersonId, ...members.map((member) => member.personId)].map(
                  (personId) => ctx.db.get(personId),
                ),
              );
              const coordinator = people[0];
              const reviewerNames = [...new Set(
                people
                  .filter((person): person is Doc<"people"> => person !== null)
                  .map((person) => person.displayName),
              )].sort((left, right) => left.localeCompare(right));
              return {
                id: panel._id,
                name: panel.name,
                status: panel.status,
                version: panel.version,
                coordinatorName: coordinator?.displayName ?? "Coordinator unavailable",
                reviewerNames,
              };
            }),
        );
        return {
          id: round._id,
          name: round.name,
          status: round.status,
          startsAt: round.startsAt,
          endsAt: round.endsAt,
          version: round.version,
          rubricName: rubric.name,
          scoreMinimum: rubric.scoreMinimum,
          scoreMaximum: rubric.scoreMaximum,
          requiresSharedCommitments: round.requiresSharedCommitments,
          criteria: criteria.map((criterion) => ({
            id: criterion._id,
            label: criterion.label,
            question: criterion.question,
            displayOrder: criterion.displayOrder,
          })),
          panels: panelRows,
        };
      }),
  );
  const currentPanelCount = rounds.reduce(
    (count, round) => count + round.panels.length,
    0,
  );
  if (currentPanelCount > maximumCurrentPanels) {
    throw new ConvexError({
      code: "EMERGENCY_PACK_PANEL_COUNT_TOO_LARGE",
      message: `The emergency pack supports at most ${maximumCurrentPanels} current panel tables.`,
    });
  }

  return {
    event: {
      name: event.name,
      slug: event.slug,
      timezone: event.timezone,
      status: event.status,
      venue: communicationsPolicy.venueName,
      startsAt: communicationsPolicy.startsAt,
      endsAt: communicationsPolicy.endsAt,
      version: event.version,
    },
    snapshotAt,
    roster,
    stations,
    sessions,
    rounds,
  };
}

function vitHostelResidenceLabel(
  catalog: readonly {
    stableKey: string;
    label: string;
    kind: "day_scholar" | "mens" | "ladies";
  }[],
  stableKey: string,
) {
  const residence = findVitHostelResidenceCatalogEntry(catalog, stableKey);
  return residence ? vitHostelResidenceCatalogLabel(residence) : stableKey;
}

export const generationFinished = exportWorkpool.defineOnComplete<
  DataModel,
  typeof packIdValidator
>({
  context: packIdValidator,
  handler: async (ctx, { context: packId, result }) => {
    if (result.kind === "success") return;
    const pack = await ctx.db.get(packId);
    if (!pack || pack.status !== "pending") return;
    const now = Date.now();
    await ctx.db.patch(pack._id, {
      status: "failed",
      failedAt: now,
      failureCode: result.kind === "canceled" ? "generation_canceled" : "generation_failed",
      version: pack.version + 1,
    });
    await appendEmergencyPackReadFactById(ctx, pack._id, now);
  },
});

export const request = mutation({
  args: {
    eventSlug: v.string(),
    purpose: v.string(),
    spareAttendanceSheetCount: v.number(),
    spareReviewSheetCount: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ packId: v.id("emergencyPacks"), version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const purpose = normalizedText(args.purpose, "Emergency-pack purpose", 10, 240);
    validateSpareCount(args.spareAttendanceSheetCount, "Spare attendance-sheet count");
    validateSpareCount(args.spareReviewSheetCount, "Spare review-sheet count");
    const requestFingerprint = operationFingerprint([
      purpose,
      args.spareAttendanceSheetCount,
      args.spareReviewSheetCount,
    ]);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "emergency_pack.prepare",
      scopeType: "event",
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "emergency_pack.prepare",
      requestFingerprint,
    });
    if (prior) {
      const packId = ctx.db.normalizeId("emergencyPacks", prior.targetId);
      if (!packId) throw new Error("The stored emergency-pack request is invalid.");
      return {
        packId,
        version: storedOperationVersion(prior.resultJson, "emergency pack"),
      };
    }
    const requestedAt = Date.now();
    const expiresAt = requestedAt + packLifetimeMs;
    const serialPrefix = operationFingerprint([
      event._id,
      person._id,
      args.clientOperationId,
    ]).slice(0, 16).toUpperCase();
    const existingSerialPrefix = await ctx.db
      .query("emergencyPacks")
      .withIndex("by_event_serial_prefix", (index) =>
        index.eq("eventId", event._id).eq("serialPrefix", serialPrefix),
      )
      .unique();
    if (existingSerialPrefix) {
      throw new ConvexError({
        code: "EMERGENCY_PACK_SERIAL_COLLISION",
        message: "This operation ID resolves to an existing paper serial. Retry with a new operation.",
      });
    }
    const packId = await ctx.db.insert("emergencyPacks", {
      eventId: event._id,
      requestedByPersonId: person._id,
      purpose,
      serialPrefix,
      spareAttendanceSheetCount: args.spareAttendanceSheetCount,
      spareReviewSheetCount: args.spareReviewSheetCount,
      status: "pending",
      expiresAt,
      requestedAt,
      version: 1,
    });
    await appendEmergencyPackReadFactById(ctx, packId, requestedAt);
    const workId = await exportWorkpool.enqueueAction(
      ctx,
      internal.emergencyPackActions.generate,
      { packId },
      {
        retry: true,
        onComplete: internal.emergencyPacks.generationFinished,
        context: packId,
      },
    );
    await ctx.db.patch(packId, { workId });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "emergency_pack.prepare",
      requestFingerprint,
      targetType: "emergency_pack",
      targetId: packId,
      resultJson: "1",
      createdAt: requestedAt,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "emergency_pack.prepare",
      grantIds,
      scopeType: "event",
      action: "emergency_pack_requested",
      targetType: "emergency_pack",
      targetId: packId,
      nextSummary: JSON.stringify({
        expiresAt,
        spareAttendanceSheetCount: args.spareAttendanceSheetCount,
        spareReviewSheetCount: args.spareReviewSheetCount,
      }),
      reason: purpose,
    });
    return { packId, version: 1 };
  },
});

export const list = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    serverNow: v.number(),
    packs: v.array(packView),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "emergency_pack.read",
      scopeType: "event",
    });
    const packs = await ctx.db
      .query("emergencyPacks")
      .withIndex("by_event_created", (index) => index.eq("eventId", event._id))
      .order("desc")
      .take(10);
    const requesters = await Promise.all(
      packs.map((pack) => ctx.db.get(pack.requestedByPersonId)),
    );
    const now = Date.now();
    return {
      serverNow: now,
      packs: packs.map((pack, index) => ({
        id: pack._id,
        requestedByName: requesters[index]?.displayName ?? "Unknown operator",
        purpose: pack.purpose,
        spareAttendanceSheetCount: pack.spareAttendanceSheetCount,
        spareReviewSheetCount: pack.spareReviewSheetCount,
        status: pack.expiresAt <= now ? expiredPackStatus : pack.status,
        expiresAt: pack.expiresAt,
        requestedAt: pack.requestedAt,
        ...(pack.snapshotAt !== undefined ? { snapshotAt: pack.snapshotAt } : {}),
        ...(pack.snapshotChecksum !== undefined
          ? { snapshotChecksum: pack.snapshotChecksum }
          : {}),
        ...(pack.counts !== undefined ? { counts: pack.counts } : {}),
        ...(pack.byteCount !== undefined ? { byteCount: pack.byteCount } : {}),
        ...(pack.sha256 !== undefined ? { sha256: pack.sha256 } : {}),
        ...(pack.completedAt !== undefined ? { completedAt: pack.completedAt } : {}),
        version: pack.version,
      })),
    };
  },
});

export const generationContext = internalQuery({
  args: { packId: v.id("emergencyPacks") },
  returns: v.union(
    v.object({ kind: v.literal("skip") }),
    v.object({
      kind: v.literal("generate"),
      eventId: v.id("events"),
      packId: v.id("emergencyPacks"),
      purpose: v.string(),
      expiresAt: v.number(),
      spareAttendanceSheetCount: v.number(),
      spareReviewSheetCount: v.number(),
      serialPrefix: v.string(),
      snapshot,
    }),
  ),
  handler: async (ctx, args) => {
    const pack = await ctx.db.get(args.packId);
    if (!pack) {
      throw new ConvexError({ code: "EMERGENCY_PACK_NOT_FOUND", message: "Emergency pack not found." });
    }
    if (pack.status !== "pending") return { kind: skipGenerationKind };
    if (pack.expiresAt <= Date.now()) {
      throw new ConvexError({
        code: "EMERGENCY_PACK_EXPIRED",
        message: "The emergency pack expired before generation completed.",
      });
    }
    const event = await ctx.db.get(pack.eventId);
    if (!event) throw new Error("Emergency-pack event no longer resolves.");
    return {
      kind: generateGenerationKind,
      eventId: event._id,
      packId: pack._id,
      purpose: pack.purpose,
      expiresAt: pack.expiresAt,
      spareAttendanceSheetCount: pack.spareAttendanceSheetCount,
      spareReviewSheetCount: pack.spareReviewSheetCount,
      serialPrefix: pack.serialPrefix,
      snapshot: await buildSnapshot(ctx, event),
    };
  },
});

export const complete = internalMutation({
  args: {
    packId: v.id("emergencyPacks"),
    snapshotAt: v.number(),
    snapshotChecksum: v.string(),
    counts: packCounts,
    objectKey: v.string(),
    objectVersionId: v.string(),
    storageRegion: v.string(),
    storageBucket: v.string(),
    byteCount: v.number(),
    sha256: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const pack = await ctx.db.get(args.packId);
    if (!pack) throw new Error("Emergency pack no longer resolves.");
    if (pack.status === "ready") {
      if (
        pack.sha256 !== args.sha256 ||
        pack.objectKey !== args.objectKey ||
        pack.objectVersionId !== args.objectVersionId ||
        pack.snapshotChecksum !== args.snapshotChecksum
      ) {
        throw new Error("Emergency-pack completion does not match the stored artifact.");
      }
      return null;
    }
    if (pack.status !== "pending") return null;
    const now = Date.now();
    if (pack.expiresAt <= now) {
      await ctx.db.patch(pack._id, {
        status: "failed",
        failedAt: now,
        failureCode: "expired_before_completion",
        version: pack.version + 1,
      });
      await appendEmergencyPackReadFactById(ctx, pack._id, now);
      return null;
    }
    await ctx.db.patch(pack._id, {
      status: "ready",
      snapshotAt: args.snapshotAt,
      snapshotChecksum: args.snapshotChecksum,
      counts: args.counts,
      objectKey: args.objectKey,
      objectVersionId: args.objectVersionId,
      storageRegion: args.storageRegion,
      storageBucket: args.storageBucket,
      byteCount: args.byteCount,
      sha256: args.sha256,
      completedAt: now,
      version: pack.version + 1,
    });
    await appendEmergencyPackReadFactById(ctx, pack._id, now);
    return null;
  },
});

async function requirePrintAccess(
  ctx: QueryCtx | MutationCtx,
  args: { eventSlug: string; packId: Id<"emergencyPacks"> },
) {
  const event = await requireEventBySlug(ctx, args.eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const pack = await ctx.db.get(args.packId);
  if (!pack || pack.eventId !== event._id) {
    throw new ConvexError({
      code: "EMERGENCY_PACK_NOT_FOUND",
      message: "Emergency pack not found.",
    });
  }
  const grantIds = await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey: "emergency_pack.print",
    scopeType: "event",
  });
  await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
  if (pack.status !== "ready" || pack.expiresAt <= Date.now()) {
    throw new ConvexError({
      code: "EMERGENCY_PACK_NOT_AVAILABLE",
      message: "This emergency pack is not ready or has expired.",
    });
  }
  if (
    pack.objectKey === undefined ||
    pack.objectVersionId === undefined ||
    pack.storageRegion === undefined ||
    pack.storageBucket === undefined ||
    pack.sha256 === undefined ||
    pack.snapshotChecksum === undefined
  ) {
    throw new Error("Ready emergency pack has no complete storage manifest.");
  }
  return {
    event,
    person,
    pack,
    grantIds,
    manifest: {
      objectKey: pack.objectKey,
      objectVersionId: pack.objectVersionId,
      storageRegion: pack.storageRegion,
      storageBucket: pack.storageBucket,
      sha256: pack.sha256,
      snapshotChecksum: pack.snapshotChecksum,
    },
  };
}

export const printContext = internalQuery({
  args: {
    eventSlug: v.string(),
    packId: v.id("emergencyPacks"),
  },
  returns: v.object({
    objectKey: v.string(),
    objectVersionId: v.string(),
    storageRegion: v.string(),
    storageBucket: v.string(),
    sha256: v.string(),
    snapshotChecksum: v.string(),
    version: v.number(),
    packExpiresAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const { pack, manifest } = await requirePrintAccess(ctx, args);
    return {
      ...manifest,
      version: pack.version,
      packExpiresAt: pack.expiresAt,
    };
  },
});

export const recordPrint = internalMutation({
  args: {
    eventSlug: v.string(),
    packId: v.id("emergencyPacks"),
    expectedVersion: v.number(),
    expectedSha256: v.string(),
    expectedSnapshotChecksum: v.string(),
    signedUrlExpiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { event, person, pack, grantIds, manifest } = await requirePrintAccess(ctx, args);
    if (
      pack.version !== args.expectedVersion ||
      manifest.sha256 !== args.expectedSha256 ||
      manifest.snapshotChecksum !== args.expectedSnapshotChecksum
    ) {
      throw new ConvexError({
        code: "EMERGENCY_PACK_CHANGED",
        message: "This emergency pack changed. Open it again from the current row.",
      });
    }
    if (
      !Number.isSafeInteger(args.signedUrlExpiresAt) ||
      args.signedUrlExpiresAt <= Date.now() ||
      args.signedUrlExpiresAt > pack.expiresAt
    ) {
      throw new ConvexError({
        code: "EMERGENCY_PACK_PRINT_EXPIRY_INVALID",
        message: "This emergency-pack print link would outlive the pack.",
      });
    }
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "emergency_pack.print",
      grantIds,
      scopeType: "event",
      action: "emergency_pack_print_opened",
      targetType: "emergency_pack",
      targetId: pack._id,
      nextSummary: JSON.stringify({
        snapshotAt: pack.snapshotAt,
        snapshotChecksum: manifest.snapshotChecksum,
        sha256: manifest.sha256,
        counts: pack.counts,
        signedUrlExpiresAt: args.signedUrlExpiresAt,
      }),
      reason: pack.purpose,
    });
    return null;
  },
});
