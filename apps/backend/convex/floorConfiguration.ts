import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import {
  floorConfigurationChecksum,
  floorStableKey,
  teamCanBeMapped,
} from "./lib/floor";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { normalizedText } from "./lib/strings";

const zoneInput = v.object({
  stableKey: v.string(),
  name: v.string(),
  displayOrder: v.number(),
});

const spotInput = v.object({
  stableKey: v.string(),
  zoneKey: v.string(),
  label: v.string(),
  x: v.number(),
  y: v.number(),
  accessible: v.boolean(),
  status: v.union(v.literal("available"), v.literal("closed")),
  displayOrder: v.number(),
});

const planSummary = v.object({
  id: v.id("floorPlanVersions"),
  planNumber: v.number(),
  name: v.string(),
  status: v.string(),
  mappingState: v.string(),
  version: v.number(),
  zoneCount: v.number(),
  spotCount: v.number(),
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
    spots: v.array(spotInput),
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
      JSON.stringify({ name: args.name, zones: args.zones, spots: args.spots }),
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
    if (args.spots.length < 1 || args.spots.length > 500) {
      throw new ConvexError({ code: "INVALID_FLOOR_PLAN", message: "Use between one and 500 team spots." });
    }
    const zones = args.zones.map((zone) => ({
      stableKey: floorStableKey(zone.stableKey, "Zone key"),
      name: normalizedText(zone.name, "Zone name", 1, 80),
      displayOrder: requiredOrder(zone.displayOrder, "Zone order"),
    }));
    const spots = args.spots.map((spot) => ({
      stableKey: floorStableKey(spot.stableKey, "Spot key"),
      zoneKey: floorStableKey(spot.zoneKey, "Spot zone key"),
      label: normalizedText(spot.label, "Spot label", 1, 40),
      x: coordinate(spot.x, "Spot x coordinate"),
      y: coordinate(spot.y, "Spot y coordinate"),
      accessible: spot.accessible,
      status: spot.status,
      displayOrder: requiredOrder(spot.displayOrder, "Spot order"),
    }));
    requireUnique(zones.map((zone) => zone.stableKey), "Zone keys");
    requireUnique(zones.map((zone) => zone.displayOrder), "Zone orders");
    requireUnique(spots.map((spot) => spot.stableKey), "Spot keys");
    requireUnique(spots.map((spot) => spot.label.toLocaleLowerCase("en-IN")), "Spot labels");
    requireUnique(spots.map((spot) => `${spot.x}:${spot.y}`), "Spot coordinates");
    const zoneKeys = new Set(zones.map((zone) => zone.stableKey));
    if (spots.some((spot) => !zoneKeys.has(spot.zoneKey))) {
      throw new ConvexError({ code: "UNKNOWN_FLOOR_ZONE", message: "Every spot must reference a zone in this plan." });
    }

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
      checksum: floorConfigurationChecksum({ name, zones, spots }),
      version: 1,
      createdByPersonId: person._id,
      createdAt: now,
    });
    const zoneIds = new Map<string, Id<"floorZones">>();
    for (const zone of zones) {
      const zoneId = await ctx.db.insert("floorZones", {
        eventId: event._id,
        planVersionId,
        ...zone,
        createdAt: now,
      });
      zoneIds.set(zone.stableKey, zoneId);
    }
    for (const spot of spots) {
      const zoneId = zoneIds.get(spot.zoneKey);
      if (!zoneId) throw new Error("Validated floor zone is missing.");
      await ctx.db.insert("floorSpots", {
        eventId: event._id,
        planVersionId,
        zoneId,
        stableKey: spot.stableKey,
        label: spot.label,
        x: spot.x,
        y: spot.y,
        accessible: spot.accessible,
        status: spot.status,
        displayOrder: spot.displayOrder,
        createdAt: now,
      });
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
      nextSummary: JSON.stringify({ planNumber, zoneCount: zones.length, spotCount: spots.length }),
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
    const [zones, spots] = await Promise.all([
      ctx.db.query("floorZones").withIndex("by_plan_order", (index) => index.eq("planVersionId", plan._id)).collect(),
      ctx.db.query("floorSpots").withIndex("by_plan_order", (index) => index.eq("planVersionId", plan._id)).collect(),
    ]);
    if (zones.length === 0 || spots.length === 0) {
      throw new ConvexError({ code: "FLOOR_PLAN_INCOMPLETE", message: "The floor plan needs at least one zone and spot." });
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
  const [zones, spots] = await Promise.all([
    ctx.db
      .query("floorZones")
      .withIndex("by_plan_order", (index) => index.eq("planVersionId", plan._id))
      .collect(),
    ctx.db
      .query("floorSpots")
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
    spotCount: spots.length,
    ...(plan.publishedAt !== undefined ? { publishedAt: plan.publishedAt } : {}),
  };
}

function requiredOrder(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0 || value > 1_000) {
    throw new ConvexError({ code: "INVALID_ORDER", message: `${label} must be an integer from 0 through 1,000.` });
  }
  return value;
}

function coordinate(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new ConvexError({ code: "INVALID_COORDINATE", message: `${label} must be from 0 through 100.` });
  }
  return Math.round(value * 100) / 100;
}

function requireUnique(values: readonly (string | number)[], label: string) {
  if (new Set(values).size !== values.length) {
    throw new ConvexError({ code: "DUPLICATE_FLOOR_VALUE", message: `${label} must be unique.` });
  }
}

function configurationChanged() {
  return new ConvexError({ code: "FLOOR_CONFIGURATION_CHANGED", message: "Floor configuration changed. Refresh and try again." });
}
