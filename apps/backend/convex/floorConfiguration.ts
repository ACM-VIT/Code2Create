import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import {
  configurationPublicationResultJson,
  storedConfigurationPublicationResult,
} from "./lib/configurationOperationResult";
import {
  floorConfigurationChecksum,
  floorCoordinate,
  floorStableKey,
  maximumFloorLandmarksPerZone,
  maximumFloorZones,
  teamCanBeMapped,
} from "./lib/floor";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
} from "./lib/operations";
import { normalizedText } from "./lib/strings";
import { floorMappingState, floorPlanStatus } from "./values";

/** Publishes zone shapes and fixed landmarks because tables have no stable addresses. */
const landmarkInput = v.object({
  stableKey: v.string(),
  name: v.string(),
  x: v.number(),
  y: v.number(),
  displayOrder: v.number(),
});

const zoneInput = v.object({
  stableKey: v.string(),
  name: v.string(),
  widthMeters: v.number(),
  depthMeters: v.number(),
  displayOrder: v.number(),
  landmarks: v.array(landmarkInput),
});

const planSummary = v.object({
  id: v.id("floorPlanVersions"),
  planNumber: v.number(),
  name: v.string(),
  status: floorPlanStatus,
  mappingState: floorMappingState,
  version: v.number(),
  zoneCount: v.number(),
  landmarkCount: v.number(),
  zones: v.array(zoneInput),
  publishedAt: v.optional(v.number()),
});

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    eventVersion: v.number(),
    draftPlan: v.union(v.null(), planSummary),
    publishedPlan: v.union(v.null(), planSummary),
    canCreate: v.boolean(),
    canPublish: v.boolean(),
    canFreeze: v.boolean(),
    freezeReadiness: v.optional(
      v.object({
        eligibleTeamCount: v.number(),
        unmappedTeamCount: v.number(),
        ready: v.boolean(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const draftPlan = await ctx.db
      .query("floorPlanVersions")
      .withIndex("by_event_status", (index) => index.eq("eventId", event._id).eq("status", "draft"))
      .unique();
    const publishedPlan = event.publishedFloorPlanVersionId
      ? await ctx.db.get(event.publishedFloorPlanVersionId)
      : null;
    const [
      createGrantIds,
      draftReadGrantIds,
      publishedReadGrantIds,
      publishGrantIds,
      freezeGrantIds,
    ] = await Promise.all([
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "floor.plan.create",
        scopeType: "event",
      }),
      draftPlan
        ? matchingPermissionGrantIds(ctx, {
            eventId: event._id,
            eventAccessSubjectId: subject._id,
            permissionKey: "floor.plan.read",
            scopeType: "floor_plan",
            scopeId: draftPlan._id,
          })
        : matchingPermissionGrantIds(ctx, {
            eventId: event._id,
            eventAccessSubjectId: subject._id,
            permissionKey: "floor.plan.read",
            scopeType: "event",
          }),
      publishedPlan
        ? matchingPermissionGrantIds(ctx, {
            eventId: event._id,
            eventAccessSubjectId: subject._id,
            permissionKey: "floor.plan.read",
            scopeType: "floor_plan",
            scopeId: publishedPlan._id,
          })
        : matchingPermissionGrantIds(ctx, {
            eventId: event._id,
            eventAccessSubjectId: subject._id,
            permissionKey: "floor.plan.read",
            scopeType: "event",
          }),
      draftPlan
        ? matchingPermissionGrantIds(ctx, {
            eventId: event._id,
            eventAccessSubjectId: subject._id,
            permissionKey: "floor.plan.publish",
            scopeType: "floor_plan",
            scopeId: draftPlan._id,
          })
        : matchingPermissionGrantIds(ctx, {
            eventId: event._id,
            eventAccessSubjectId: subject._id,
            permissionKey: "floor.plan.publish",
            scopeType: "event",
          }),
      publishedPlan
        ? matchingPermissionGrantIds(ctx, {
            eventId: event._id,
            eventAccessSubjectId: subject._id,
            permissionKey: "floor.plan.freeze",
            scopeType: "floor_plan",
            scopeId: publishedPlan._id,
          })
        : matchingPermissionGrantIds(ctx, {
            eventId: event._id,
            eventAccessSubjectId: subject._id,
            permissionKey: "floor.plan.freeze",
            scopeType: "event",
          }),
    ]);
    if (
      createGrantIds.length === 0 &&
      draftReadGrantIds.length === 0 &&
      publishedReadGrantIds.length === 0 &&
      publishGrantIds.length === 0 &&
      freezeGrantIds.length === 0
    ) {
      throw new ConvexError({ code: "ACCESS_DENIED", message: "This account cannot access floor configuration." });
    }
    const freezeReadiness =
      publishedPlan &&
      publishedPlan.eventId === event._id &&
      publishedPlan.status === "published" &&
      publishedPlan.mappingState === "open" &&
      freezeGrantIds.length > 0
        ? await readFloorFreezeReadiness(ctx, event._id, publishedPlan._id)
        : undefined;
    return {
      eventVersion: event.version,
      draftPlan:
        draftPlan && (draftReadGrantIds.length > 0 || publishGrantIds.length > 0)
          ? await summarizePlan(ctx, draftPlan)
          : null,
      publishedPlan:
        publishedPlan &&
        publishedPlan.eventId === event._id &&
        publishedPlan.status === "published" &&
        (publishedReadGrantIds.length > 0 || freezeGrantIds.length > 0)
          ? await summarizePlan(ctx, publishedPlan)
          : null,
      canCreate: createGrantIds.length > 0,
      canPublish: publishGrantIds.length > 0,
      canFreeze: freezeGrantIds.length > 0,
      ...(freezeReadiness ? { freezeReadiness } : {}),
    };
  },
});

export const createDraft = mutation({
  args: {
    eventSlug: v.string(),
    name: v.string(),
    zones: v.array(zoneInput),
    expectedEventVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    planVersionId: v.id("floorPlanVersions"),
    planNumber: v.number(),
    eventVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.expectedEventVersion,
      args.reason,
      JSON.stringify({ name: args.name, zones: args.zones }),
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "floor.plan.create",
      requestFingerprint,
    });
    if (prior) {
      const planVersionId = ctx.db.normalizeId("floorPlanVersions", prior.targetId);
      if (!planVersionId) throw new Error("The stored floor-plan creation is invalid.");
      const stored = storedConfigurationPublicationResult(
        prior.resultJson,
        "floor-plan creation",
      );
      return {
        planVersionId,
        planNumber: stored.version,
        eventVersion: stored.eventVersion,
      };
    }
    if (event.version !== args.expectedEventVersion) throw configurationChanged();
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "floor.plan.create",
      scopeType: "event",
    });
    if (args.zones.length < 1 || args.zones.length > maximumFloorZones) {
      throw new ConvexError({ code: "INVALID_FLOOR_PLAN", message: `Use between one and ${maximumFloorZones} hall zones.` });
    }
    const zones = args.zones.map((zone) => ({
      stableKey: floorStableKey(zone.stableKey, "Zone key"),
      name: normalizedText(zone.name, "Zone name", 1, 80),
      widthMeters: zoneSide(zone.widthMeters, "Zone width"),
      depthMeters: zoneSide(zone.depthMeters, "Zone depth"),
      displayOrder: requiredOrder(zone.displayOrder, "Zone order"),
      // A mapper holding a plain rectangle cannot tell which way it faces, so
      // a zone without a landmark is a zone nobody can map into.
      landmarks: requireLandmarks(zone.landmarks, zone.name),
    }));
    requireUnique(zones.map((zone) => zone.stableKey), "Zone keys");
    requireUnique(zones.map((zone) => zone.displayOrder), "Zone orders");
    requireUnique(
      zones.flatMap((zone) => zone.landmarks.map((landmark) => landmark.stableKey)),
      "Landmark keys",
    );

    const priorDraft = await ctx.db
      .query("floorPlanVersions")
      .withIndex("by_event_status", (index) => index.eq("eventId", event._id).eq("status", "draft"))
      .unique();
    const latest = await ctx.db
      .query("floorPlanVersions")
      .withIndex("by_event_number", (index) => index.eq("eventId", event._id))
      .order("desc")
      .first();
    const planNumber = (latest?.planNumber ?? 0) + 1;
    const now = Date.now();
    if (priorDraft) await ctx.db.patch(priorDraft._id, { status: "retired" });
    const name = normalizedText(args.name, "Plan name", 2, 100);
    const planVersionId = await ctx.db.insert("floorPlanVersions", {
      eventId: event._id,
      planNumber,
      name,
      status: "draft",
      mappingState: "setup",
      checksum: floorConfigurationChecksum({ name, zones }),
      version: 1,
      createdByPersonId: person._id,
      createdAt: now,
    });
    let landmarkCount = 0;
    for (const zone of zones) {
      const zoneId = await ctx.db.insert("floorZones", {
        eventId: event._id,
        planVersionId,
        stableKey: zone.stableKey,
        name: zone.name,
        widthMeters: zone.widthMeters,
        depthMeters: zone.depthMeters,
        displayOrder: zone.displayOrder,
        createdAt: now,
      });
      for (const landmark of zone.landmarks) {
        await ctx.db.insert("floorLandmarks", {
          eventId: event._id,
          planVersionId,
          zoneId,
          stableKey: landmark.stableKey,
          name: landmark.name,
          x: landmark.x,
          y: landmark.y,
          displayOrder: landmark.displayOrder,
          createdAt: now,
        });
        landmarkCount += 1;
      }
    }
    const eventVersion = event.version + 1;
    await ctx.db.patch(event._id, { version: eventVersion, updatedAt: now });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "floor.plan.create",
      requestFingerprint,
      targetType: "floor_plan",
      targetId: planVersionId,
      resultJson: configurationPublicationResultJson({
        version: planNumber,
        eventVersion,
      }),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "floor.plan.create",
      grantIds,
      scopeType: "event",
      action: "floor.plan_draft_created",
      targetType: "floor_plan",
      targetId: planVersionId,
      nextSummary: JSON.stringify({ planNumber, zoneCount: zones.length, landmarkCount }),
      reason: normalizedText(args.reason, "Reason", 5, 300),
    });
    return { planVersionId, planNumber, eventVersion };
  },
});

export const publish = mutation({
  args: {
    eventSlug: v.string(),
    planVersionId: v.id("floorPlanVersions"),
    expectedPlanVersion: v.number(),
    expectedEventVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ planVersionId: v.id("floorPlanVersions"), planVersion: v.number(), eventVersion: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.planVersionId,
      args.expectedPlanVersion,
      args.expectedEventVersion,
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "floor.plan.publish",
      requestFingerprint,
    });
    if (prior) {
      const planVersionId = ctx.db.normalizeId("floorPlanVersions", prior.targetId);
      if (!planVersionId) throw new Error("The stored floor-plan publication is invalid.");
      const stored = storedConfigurationPublicationResult(
        prior.resultJson,
        "floor-plan publication",
      );
      return {
        planVersionId,
        planVersion: stored.version,
        eventVersion: stored.eventVersion,
      };
    }
    if (event.version !== args.expectedEventVersion) throw configurationChanged();
    const plan = await ctx.db.get(args.planVersionId);
    if (!plan || plan.eventId !== event._id || plan.status !== "draft" || plan.mappingState !== "setup") {
      throw new ConvexError({ code: "FLOOR_PLAN_NOT_DRAFT", message: "Choose this event's current floor-plan draft." });
    }
    if (plan.version !== args.expectedPlanVersion) throw configurationChanged();
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "floor.plan.publish",
      scopeType: "floor_plan",
      scopeId: plan._id,
    });
    const zones = await ctx.db
      .query("floorZones")
      .withIndex("by_plan_order", (index) => index.eq("planVersionId", plan._id))
      .collect();
    if (zones.length === 0) {
      throw new ConvexError({ code: "FLOOR_PLAN_INCOMPLETE", message: "The floor plan needs at least one zone." });
    }
    const previousPublished = event.publishedFloorPlanVersionId
      ? await ctx.db.get(event.publishedFloorPlanVersionId)
      : null;
    if (previousPublished) {
      const activeLocations = await ctx.db
        .query("teamFloorLocations")
        .withIndex("by_plan_state", (index) => index.eq("planVersionId", previousPublished._id).eq("state", "active"))
        .first();
      if (activeLocations) {
        throw new ConvexError({
          code: "FLOOR_PLAN_IN_USE",
          message: "A published plan cannot be replaced after team mapping begins.",
        });
      }
    }
    const now = Date.now();
    if (previousPublished) {
      await ctx.db.patch(previousPublished._id, { status: "superseded", version: previousPublished.version + 1 });
    }
    const planVersion = plan.version + 1;
    await ctx.db.patch(plan._id, {
      status: "published",
      mappingState: "open",
      version: planVersion,
      publishedByPersonId: person._id,
      publishedAt: now,
    });
    const eventVersion = event.version + 1;
    await ctx.db.patch(event._id, {
      publishedFloorPlanVersionId: plan._id,
      version: eventVersion,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "floor.plan.publish",
      requestFingerprint,
      targetType: "floor_plan",
      targetId: plan._id,
      resultJson: configurationPublicationResultJson({
        version: planVersion,
        eventVersion,
      }),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "floor.plan.publish",
      grantIds,
      scopeType: "floor_plan",
      scopeId: plan._id,
      action: "floor.plan_published",
      targetType: "floor_plan",
      targetId: plan._id,
      previousSummary: JSON.stringify({ status: "draft", version: plan.version }),
      nextSummary: JSON.stringify({ status: "published", mappingState: "open", version: planVersion }),
      reason: normalizedText(args.reason, "Reason", 5, 300),
    });
    return { planVersionId: plan._id, planVersion, eventVersion };
  },
});

export const freeze = mutation({
  args: {
    eventSlug: v.string(),
    planVersionId: v.id("floorPlanVersions"),
    expectedPlanVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ planVersionId: v.id("floorPlanVersions"), planVersion: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const requestFingerprint = operationFingerprint([
      args.planVersionId,
      args.expectedPlanVersion,
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "floor.plan.freeze",
      requestFingerprint,
    });
    if (prior) {
      const planVersionId = ctx.db.normalizeId("floorPlanVersions", prior.targetId);
      if (!planVersionId) throw new Error("The stored floor-plan freeze is invalid.");
      return {
        planVersionId,
        planVersion: storedOperationVersion(prior.resultJson, "floor-plan"),
      };
    }
    const plan = await ctx.db.get(args.planVersionId);
    if (
      !plan ||
      plan.eventId !== event._id ||
      event.publishedFloorPlanVersionId !== plan._id ||
      plan.status !== "published" ||
      plan.mappingState !== "open"
    ) {
      throw new ConvexError({ code: "FLOOR_PLAN_NOT_OPEN", message: "Only the current open floor plan can be frozen." });
    }
    if (plan.version !== args.expectedPlanVersion) throw configurationChanged();
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "floor.plan.freeze",
      scopeType: "floor_plan",
      scopeId: plan._id,
    });
    const readiness = await readFloorFreezeReadiness(ctx, event._id, plan._id);
    if (!readiness.ready) {
      throw new ConvexError({
        code: "FLOOR_MAPPING_INCOMPLETE",
        message:
          readiness.eligibleTeamCount === 0
            ? "At least one eligible team is required before locations can be frozen."
            : `${readiness.unmappedTeamCount} eligible teams still need a hall location.`,
      });
    }
    const now = Date.now();
    const planVersion = plan.version + 1;
    const reason = normalizedText(args.reason, "Freeze reason", 5, 300);
    await ctx.db.patch(plan._id, {
      mappingState: "frozen",
      version: planVersion,
      frozenByPersonId: person._id,
      frozenAt: now,
      freezeReason: reason,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "floor.plan.freeze",
      requestFingerprint,
      targetType: "floor_plan",
      targetId: plan._id,
      resultJson: String(planVersion),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "floor.plan.freeze",
      grantIds,
      scopeType: "floor_plan",
      scopeId: plan._id,
      action: "floor.mapping_frozen",
      targetType: "floor_plan",
      targetId: plan._id,
      previousSummary: JSON.stringify({ mappingState: "open", version: plan.version }),
      nextSummary: JSON.stringify({
        mappingState: "frozen",
        version: planVersion,
        mappedTeams: readiness.eligibleTeamCount,
      }),
      reason,
    });
    return { planVersionId: plan._id, planVersion };
  },
});

async function readFloorFreezeReadiness(
  ctx: QueryCtx | MutationCtx,
  eventId: Id<"events">,
  planVersionId: Id<"floorPlanVersions">,
) {
  const [teams, locations] = await Promise.all([
    ctx.db
      .query("teams")
      .withIndex("by_event_status", (index) => index.eq("eventId", eventId))
      .collect(),
    ctx.db
      .query("teamFloorLocations")
      .withIndex("by_plan_state", (index) =>
        index.eq("planVersionId", planVersionId).eq("state", "active"),
      )
      .collect(),
  ]);
  const eligibleTeamIds = new Set(
    teams.filter((team) => teamCanBeMapped(team.status)).map((team) => team._id),
  );
  const mappedEligibleTeamIds = new Set(
    locations
      .filter((location) => eligibleTeamIds.has(location.teamId))
      .map((location) => location.teamId),
  );
  const unmappedTeamCount = eligibleTeamIds.size - mappedEligibleTeamIds.size;
  return {
    eligibleTeamCount: eligibleTeamIds.size,
    unmappedTeamCount,
    ready: eligibleTeamIds.size > 0 && unmappedTeamCount === 0,
  };
}

async function summarizePlan(
  ctx: QueryCtx,
  plan: Doc<"floorPlanVersions">,
) {
  const [zones, landmarks] = await Promise.all([
    ctx.db
      .query("floorZones")
      .withIndex("by_plan_order", (index) => index.eq("planVersionId", plan._id))
      .collect(),
    ctx.db
      .query("floorLandmarks")
      .withIndex("by_plan_order", (index) => index.eq("planVersionId", plan._id))
      .collect(),
  ]);
  return {
    id: plan._id,
    planNumber: plan.planNumber,
    name: plan.name,
    status: plan.status,
    mappingState: plan.mappingState,
    version: plan.version,
    zoneCount: zones.length,
    landmarkCount: landmarks.length,
    zones: zones.map((zone) => ({
      stableKey: zone.stableKey,
      name: zone.name,
      widthMeters: zone.widthMeters,
      depthMeters: zone.depthMeters,
      displayOrder: zone.displayOrder,
      landmarks: landmarks
        .filter((landmark) => landmark.zoneId === zone._id)
        .sort((left, right) => left.displayOrder - right.displayOrder)
        .map((landmark) => ({
          stableKey: landmark.stableKey,
          name: landmark.name,
          x: landmark.x,
          y: landmark.y,
          displayOrder: landmark.displayOrder,
        })),
    })),
    ...(plan.publishedAt !== undefined ? { publishedAt: plan.publishedAt } : {}),
  };
}

function requiredOrder(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0 || value > 1_000) {
    throw new ConvexError({ code: "INVALID_ORDER", message: `${label} must be an integer from 0 through 1,000.` });
  }
  return value;
}

/** A hall side in metres, paced out rather than surveyed. */
function zoneSide(value: number, label: string) {
  if (!Number.isFinite(value) || value < 2 || value > 300) {
    throw new ConvexError({
      code: "INVALID_ZONE_SIZE",
      message: `${label} must be from 2 through 300 metres.`,
    });
  }
  return Math.round(value * 10) / 10;
}

function requireLandmarks(
  landmarks: readonly { stableKey: string; name: string; x: number; y: number; displayOrder: number }[],
  zoneName: string,
) {
  if (landmarks.length < 1 || landmarks.length > maximumFloorLandmarksPerZone) {
    throw new ConvexError({
      code: "INVALID_FLOOR_ZONE",
      message: `${zoneName} needs between one and ${maximumFloorLandmarksPerZone} landmarks so floor staff can tell which way the zone faces.`,
    });
  }
  const checked = landmarks.map((landmark) => ({
    stableKey: floorStableKey(landmark.stableKey, "Landmark key"),
    name: normalizedText(landmark.name, "Landmark name", 1, 40),
    x: floorCoordinate(landmark.x, "Landmark x coordinate"),
    y: floorCoordinate(landmark.y, "Landmark y coordinate"),
    displayOrder: requiredOrder(landmark.displayOrder, "Landmark order"),
  }));
  requireUnique(checked.map((landmark) => landmark.name.toLocaleLowerCase("en-IN")), "Landmark names");
  requireUnique(checked.map((landmark) => landmark.displayOrder), "Landmark orders");
  return checked;
}

function requireUnique(values: readonly (string | number)[], label: string) {
  if (new Set(values).size !== values.length) {
    throw new ConvexError({ code: "DUPLICATE_FLOOR_VALUE", message: `${label} must be unique.` });
  }
}

function configurationChanged() {
  return new ConvexError({ code: "FLOOR_CONFIGURATION_CHANGED", message: "Floor configuration changed. Refresh and try again." });
}
