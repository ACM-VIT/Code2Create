import { ConvexError, v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import {
  floorConfigurationChecksum,
  floorCoordinate,
  floorStableKey,
  teamCanBeMapped,
} from "./lib/floor";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { normalizedText } from "./lib/strings";
import { floorMappingState, floorPlanStatus } from "./values";

/**
 * A published plan is no longer a seating chart. The tables in this hall are
 * dragged around by the people using them and carry no numbers, so a plan of
 * addressable spots would be a list of places nobody can point at. What the
 * plan publishes instead is the shape of each zone and the fixed things inside
 * it, which is all a mapper needs to align a drawn rectangle with the room.
 */
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
    const [createGrantIds, readGrantIds, publishGrantIds, freezeGrantIds] = await Promise.all([
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "floor.plan.create",
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
      readGrantIds.length === 0 &&
      publishGrantIds.length === 0 &&
      freezeGrantIds.length === 0
    ) {
      throw new ConvexError({ code: "ACCESS_DENIED", message: "This account cannot access floor configuration." });
    }
    return {
      eventVersion: event.version,
      draftPlan: draftPlan ? await summarizePlan(ctx, draftPlan) : null,
      publishedPlan:
        publishedPlan && publishedPlan.eventId === event._id && publishedPlan.status === "published"
          ? await summarizePlan(ctx, publishedPlan)
          : null,
      canCreate: createGrantIds.length > 0,
      canPublish: publishGrantIds.length > 0,
      canFreeze: freezeGrantIds.length > 0,
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
      const plan = planVersionId ? await ctx.db.get(planVersionId) : null;
      const currentEvent = await ctx.db.get(event._id);
      if (!planVersionId || !plan || !currentEvent) throw new Error("Prior floor-plan result is unavailable.");
      return { planVersionId, planNumber: plan.planNumber, eventVersion: currentEvent.version };
    }
    if (event.version !== args.expectedEventVersion) throw configurationChanged();
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "floor.plan.create",
      scopeType: "event",
    });
    if (args.zones.length < 1 || args.zones.length > 30) {
      throw new ConvexError({ code: "INVALID_FLOOR_PLAN", message: "Use between one and 30 hall zones." });
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
      const plan = planVersionId ? await ctx.db.get(planVersionId) : null;
      const currentEvent = await ctx.db.get(event._id);
      if (!planVersionId || !plan || !currentEvent) throw new Error("Prior publication result is unavailable.");
      return { planVersionId, planVersion: plan.version, eventVersion: currentEvent.version };
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
      const plan = planVersionId ? await ctx.db.get(planVersionId) : null;
      if (!planVersionId || !plan) throw new Error("Prior freeze result is unavailable.");
      return { planVersionId, planVersion: plan.version };
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
    const [teams, locations] = await Promise.all([
      ctx.db.query("teams").withIndex("by_event_status", (index) => index.eq("eventId", event._id)).collect(),
      ctx.db
        .query("teamFloorLocations")
        .withIndex("by_plan_state", (index) => index.eq("planVersionId", plan._id).eq("state", "active"))
        .collect(),
    ]);
    const eligibleTeamIds = new Set(teams.filter((team) => teamCanBeMapped(team.status)).map((team) => team._id));
    const mappedEligibleIds = new Set(
      locations.filter((location) => eligibleTeamIds.has(location.teamId)).map((location) => location.teamId),
    );
    if (eligibleTeamIds.size === 0 || mappedEligibleIds.size !== eligibleTeamIds.size) {
      throw new ConvexError({
        code: "FLOOR_MAPPING_INCOMPLETE",
        message: `${eligibleTeamIds.size - mappedEligibleIds.size} eligible teams still need a hall location.`,
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
      nextSummary: JSON.stringify({ mappingState: "frozen", version: planVersion, mappedTeams: mappedEligibleIds.size }),
      reason,
    });
    return { planVersionId: plan._id, planVersion };
  },
});

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
  if (landmarks.length < 1 || landmarks.length > 12) {
    throw new ConvexError({
      code: "INVALID_FLOOR_ZONE",
      message: `${zoneName} needs between one and 12 landmarks so floor staff can tell which way the zone faces.`,
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
