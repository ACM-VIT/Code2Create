import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireEventSubject,
  requireMembership,
} from "./lib/identity";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { requirePermission } from "./lib/permissions";
import { normalizeEmail, normalizedText, optionalNormalizedText } from "./lib/strings";

type ReadCtx = QueryCtx | MutationCtx;

const maximumBenefits = 100;
const maximumCodesPerBenefit = 2_000;
const grantBatchSize = 50;
const grantTeamStatuses = ["confirmed", "checked_in", "active"] as const;

const benefitScope = v.union(v.literal("team"), v.literal("person"));
const benefitCodeMode = v.union(v.literal("shared"), v.literal("unique"));
const benefitGrantRunStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("complete"),
);

const benefitGrantRunView = v.object({
  id: v.id("benefitGrantRuns"),
  status: benefitGrantRunStatus,
  scanned: v.number(),
  granted: v.number(),
  alreadyHad: v.number(),
  outOfCodes: v.number(),
});

const benefitView = v.object({
  id: v.id("benefits"),
  name: v.string(),
  description: v.optional(v.string()),
  link: v.optional(v.string()),
  scope: benefitScope,
  codeMode: benefitCodeMode,
  sharedCode: v.optional(v.string()),
  status: v.union(v.literal("active"), v.literal("archived")),
  version: v.number(),
  availableCodes: v.number(),
  grantCount: v.number(),
  latestGrantRun: v.optional(benefitGrantRunView),
  createdAt: v.number(),
});

const grantTarget = v.union(
  v.object({ kind: v.literal("team"), publicCode: v.string() }),
  v.object({ kind: v.literal("person"), email: v.string() }),
);

async function staffContext(ctx: ReadCtx, eventSlug: string) {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  return { event, person, subject };
}

function normalizedCodes(values: readonly string[]) {
  const codes = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  for (const code of codes) {
    if (code.length > 120) {
      throw new ConvexError({ code: "INVALID_CODE", message: "Codes must be at most 120 characters." });
    }
  }
  return codes;
}

function normalizedLink(value: string | undefined) {
  const link = optionalNormalizedText(value, "Link", 500);
  if (link === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new ConvexError({ code: "INVALID_LINK", message: "The link must be a full web address." });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConvexError({ code: "INVALID_LINK", message: "The link must start with http or https." });
  }
  return url.toString();
}

async function requireBenefit(ctx: ReadCtx, eventId: Id<"events">, benefitId: Id<"benefits">) {
  const benefit = await ctx.db.get("benefits", benefitId);
  if (!benefit || benefit.eventId !== eventId) {
    throw new ConvexError({ code: "BENEFIT_NOT_FOUND", message: "Benefit not found." });
  }
  return benefit;
}

function grantRunView(run: Doc<"benefitGrantRuns">) {
  return {
    id: run._id,
    status: run.status,
    scanned: run.scannedCount,
    granted: run.grantedCount,
    alreadyHad: run.alreadyHadCount,
    outOfCodes: run.outOfCodesCount,
  };
}

function view(benefit: Doc<"benefits">, latestGrantRun: Doc<"benefitGrantRuns"> | null) {
  return {
    id: benefit._id,
    name: benefit.name,
    ...(benefit.description !== undefined ? { description: benefit.description } : {}),
    ...(benefit.link !== undefined ? { link: benefit.link } : {}),
    scope: benefit.scope,
    codeMode: benefit.codeMode,
    ...(benefit.sharedCode !== undefined ? { sharedCode: benefit.sharedCode } : {}),
    status: benefit.status,
    version: benefit.version,
    availableCodes: benefit.availableCodeCount,
    grantCount: benefit.grantCount,
    ...(latestGrantRun !== null ? { latestGrantRun: grantRunView(latestGrantRun) } : {}),
    createdAt: benefit.createdAt,
  };
}

/** Takes one code for a grant: the shared code, or the next unused one. */
async function takeCode(ctx: MutationCtx, benefit: Doc<"benefits">) {
  if (benefit.codeMode === "shared") {
    if (benefit.sharedCode === undefined) throw new Error("A shared-code benefit has no code.");
    return { code: benefit.sharedCode, codeRow: null };
  }
  const codeRow = await ctx.db
    .query("benefitCodes")
    .withIndex("by_benefit_state", (index) => index.eq("benefitId", benefit._id).eq("state", "available"))
    .first();
  if ((codeRow === null) !== (benefit.availableCodeCount === 0)) {
    throw new Error("The benefit code counters are inconsistent.");
  }
  return codeRow ? { code: codeRow.code, codeRow } : null;
}

async function existingGrant(
  ctx: ReadCtx,
  benefit: Doc<"benefits">,
  target: { teamId: Id<"teams"> } | { membershipId: Id<"eventMemberships"> },
) {
  return "teamId" in target
    ? ctx.db
        .query("benefitGrants")
        .withIndex("by_benefit_team", (index) => index.eq("benefitId", benefit._id).eq("teamId", target.teamId))
        .unique()
    : ctx.db
        .query("benefitGrants")
        .withIndex("by_benefit_membership", (index) =>
          index.eq("benefitId", benefit._id).eq("membershipId", target.membershipId),
        )
        .unique();
}

/** Grants a benefit once to one target. Returns null when no code is left. */
async function grantTo(
  ctx: MutationCtx,
  args: {
    benefitId: Id<"benefits">;
    target: { teamId: Id<"teams"> } | { membershipId: Id<"eventMemberships"> };
    actorPersonId: Id<"people">;
    now: number;
  },
) {
  const benefit = await ctx.db.get("benefits", args.benefitId);
  if (!benefit || benefit.status !== "active") {
    throw new Error("The active benefit being granted no longer exists.");
  }
  const { target } = args;
  const existing = await existingGrant(ctx, benefit, target);
  if (existing) return { grantId: existing._id, created: false };
  const taken = await takeCode(ctx, benefit);
  if (!taken) return null;
  const grantId = await ctx.db.insert("benefitGrants", {
    eventId: benefit.eventId,
    benefitId: benefit._id,
    ...target,
    code: taken.code,
    grantedByPersonId: args.actorPersonId,
    createdAt: args.now,
  });
  if (taken.codeRow) await ctx.db.patch(taken.codeRow._id, { state: "assigned", grantId });
  await ctx.db.patch(benefit._id, {
    availableCodeCount:
      benefit.codeMode === "unique"
        ? benefit.availableCodeCount - 1
        : benefit.availableCodeCount,
    grantCount: benefit.grantCount + 1,
  });
  return { grantId, created: true };
}

export const list = query({
  args: { eventSlug: v.string() },
  returns: v.object({ canManage: v.boolean(), benefits: v.array(benefitView) }),
  handler: async (ctx, args) => {
    const { event, subject } = await staffContext(ctx, args.eventSlug);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "benefit.read",
      scopeType: "event",
    });
    const manageGrants = await ctx.db
      .query("permissionGrants")
      .withIndex("by_subject_permission_status_scope", (index) =>
        index
          .eq("eventAccessSubjectId", subject._id)
          .eq("permissionKey", "benefit.manage")
          .eq("status", "active")
          .eq("scopeType", "event"),
      )
      .take(1);
    const benefits = await ctx.db
      .query("benefits")
      .withIndex("by_event_status", (index) => index.eq("eventId", event._id))
      .order("desc")
      .take(maximumBenefits);
    const views = await Promise.all(benefits.map(async (benefit) => {
      const latestGrantRun = benefit.latestGrantRunId
        ? await ctx.db.get("benefitGrantRuns", benefit.latestGrantRunId)
        : null;
      if (latestGrantRun && latestGrantRun.benefitId !== benefit._id) {
        throw new Error("The latest benefit grant run belongs to another benefit.");
      }
      return view(benefit, latestGrantRun);
    }));
    return { canManage: manageGrants.length > 0, benefits: views };
  },
});

export const create = mutation({
  args: {
    eventSlug: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    link: v.optional(v.string()),
    scope: benefitScope,
    codeMode: benefitCodeMode,
    sharedCode: v.optional(v.string()),
    codes: v.array(v.string()),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ benefitId: v.id("benefits") }),
  handler: async (ctx, args) => {
    const { event, person, subject } = await staffContext(ctx, args.eventSlug);
    const name = normalizedText(args.name, "Benefit name", 2, 80);
    const description = optionalNormalizedText(args.description, "Description", 300);
    const link = normalizedLink(args.link);
    const sharedCode = optionalNormalizedText(args.sharedCode, "Shared code", 120);
    const codes = normalizedCodes(args.codes);
    const reason = normalizedText(args.reason, "Reason", 5, 200);
    if (args.codeMode === "shared" && sharedCode === undefined) {
      throw new ConvexError({ code: "SHARED_CODE_REQUIRED", message: "A shared-code benefit needs its code." });
    }
    if (args.codeMode === "unique" && codes.length === 0) {
      throw new ConvexError({ code: "CODES_REQUIRED", message: "Paste at least one code, one per line." });
    }
    if (codes.length > maximumCodesPerBenefit) {
      throw new ConvexError({ code: "TOO_MANY_CODES", message: `A benefit holds at most ${maximumCodesPerBenefit} codes.` });
    }
    const requestFingerprint = operationFingerprint([
      name,
      description ?? null,
      link ?? null,
      args.scope,
      args.codeMode,
      sharedCode ?? null,
      ...codes,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "benefit.create",
      requestFingerprint,
    });
    if (prior) {
      const benefitId = ctx.db.normalizeId("benefits", prior.targetId);
      if (!benefitId) throw new Error("The stored benefit result is invalid.");
      return { benefitId };
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "benefit.manage",
      scopeType: "event",
    });
    const existing = await ctx.db
      .query("benefits")
      .withIndex("by_event_status", (index) => index.eq("eventId", event._id))
      .take(maximumBenefits + 1);
    if (existing.length >= maximumBenefits) {
      throw new ConvexError({ code: "BENEFIT_LIMIT", message: `An event holds at most ${maximumBenefits} benefits.` });
    }
    const now = Date.now();
    const benefitId = await ctx.db.insert("benefits", {
      eventId: event._id,
      name,
      ...(description !== undefined ? { description } : {}),
      ...(link !== undefined ? { link } : {}),
      scope: args.scope,
      codeMode: args.codeMode,
      ...(args.codeMode === "shared" && sharedCode !== undefined ? { sharedCode } : {}),
      codeCount: args.codeMode === "unique" ? codes.length : 0,
      availableCodeCount: args.codeMode === "unique" ? codes.length : 0,
      grantCount: 0,
      status: "active",
      version: 1,
      createdByPersonId: person._id,
      updatedByPersonId: person._id,
      createdAt: now,
      updatedAt: now,
    });
    if (args.codeMode === "unique") {
      for (const code of codes) {
        await ctx.db.insert("benefitCodes", { eventId: event._id, benefitId, code, state: "available", createdAt: now });
      }
    }
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "benefit.create",
      requestFingerprint,
      targetType: "benefit",
      targetId: benefitId,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "benefit.manage",
      grantIds,
      scopeType: "event",
      action: "benefit.created",
      targetType: "benefit",
      targetId: benefitId,
      nextSummary: JSON.stringify({ name, scope: args.scope, codeMode: args.codeMode, codes: codes.length }),
      reason,
    });
    return { benefitId };
  },
});

export const addCodes = mutation({
  args: {
    eventSlug: v.string(),
    benefitId: v.id("benefits"),
    codes: v.array(v.string()),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ added: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, subject } = await staffContext(ctx, args.eventSlug);
    const codes = normalizedCodes(args.codes);
    if (codes.length > maximumCodesPerBenefit) {
      throw new ConvexError({
        code: "TOO_MANY_CODES",
        message: `Add at most ${maximumCodesPerBenefit} codes at a time.`,
      });
    }
    const reason = normalizedText(args.reason, "Reason", 5, 200);
    const requestFingerprint = operationFingerprint([args.benefitId, ...codes, reason]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "benefit.codes.add",
      requestFingerprint,
    });
    if (prior) return { added: Number(prior.resultJson ?? 0) };
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "benefit.manage",
      scopeType: "event",
    });
    const benefit = await requireBenefit(ctx, event._id, args.benefitId);
    if (benefit.codeMode !== "unique") {
      throw new ConvexError({ code: "SHARED_BENEFIT", message: "This benefit uses one shared code." });
    }
    const storedCodes = await ctx.db
      .query("benefitCodes")
      .withIndex("by_benefit_code", (index) => index.eq("benefitId", benefit._id))
      .take(maximumCodesPerBenefit);
    const storedCodeValues = new Set(storedCodes.map((code) => code.code));
    const newCodes = codes.filter((code) => !storedCodeValues.has(code));
    if (benefit.codeCount + newCodes.length > maximumCodesPerBenefit) {
      throw new ConvexError({
        code: "TOO_MANY_CODES",
        message: `A benefit holds at most ${maximumCodesPerBenefit} unique codes.`,
      });
    }
    const now = Date.now();
    for (const code of newCodes) {
      await ctx.db.insert("benefitCodes", { eventId: event._id, benefitId: benefit._id, code, state: "available", createdAt: now });
    }
    const added = newCodes.length;
    await ctx.db.patch(benefit._id, {
      codeCount: benefit.codeCount + added,
      availableCodeCount: benefit.availableCodeCount + added,
      version: benefit.version + 1,
      updatedByPersonId: person._id,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "benefit.codes.add",
      requestFingerprint,
      targetType: "benefit",
      targetId: benefit._id,
      resultJson: String(added),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "benefit.manage",
      grantIds,
      scopeType: "event",
      action: "benefit.codes_added",
      targetType: "benefit",
      targetId: benefit._id,
      nextSummary: JSON.stringify({ added }),
      reason,
    });
    return { added };
  },
});

export const archive = mutation({
  args: { eventSlug: v.string(), benefitId: v.id("benefits"), reason: v.string(), clientOperationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { event, person, subject } = await staffContext(ctx, args.eventSlug);
    const reason = normalizedText(args.reason, "Reason", 5, 200);
    const requestFingerprint = operationFingerprint([args.benefitId, reason]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "benefit.archive",
      requestFingerprint,
    });
    if (prior) return null;
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "benefit.manage",
      scopeType: "event",
    });
    const benefit = await requireBenefit(ctx, event._id, args.benefitId);
    const latestGrantRun = benefit.latestGrantRunId
      ? await ctx.db.get("benefitGrantRuns", benefit.latestGrantRunId)
      : null;
    if (latestGrantRun && latestGrantRun.status !== "complete") {
      throw new ConvexError({
        code: "BENEFIT_GRANT_IN_PROGRESS",
        message: "Wait for the current grant-all run to finish before archiving this benefit.",
      });
    }
    const now = Date.now();
    await ctx.db.patch(benefit._id, {
      status: "archived",
      version: benefit.version + 1,
      updatedByPersonId: person._id,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "benefit.archive",
      requestFingerprint,
      targetType: "benefit",
      targetId: benefit._id,
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "benefit.manage",
      grantIds,
      scopeType: "event",
      action: "benefit.archived",
      targetType: "benefit",
      targetId: benefit._id,
      previousSummary: JSON.stringify({ status: benefit.status }),
      nextSummary: JSON.stringify({ status: "archived" }),
      reason,
    });
    return null;
  },
});

/** Hands a benefit to one team (by its join code) or one person (by email). */
export const grant = mutation({
  args: {
    eventSlug: v.string(),
    benefitId: v.id("benefits"),
    target: grantTarget,
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ created: v.boolean(), code: v.string() }),
  handler: async (ctx, args) => {
    const { event, person, subject } = await staffContext(ctx, args.eventSlug);
    const reason = normalizedText(args.reason, "Reason", 5, 200);
    const targetKey = args.target.kind === "team" ? args.target.publicCode.trim().toUpperCase() : normalizeEmail(args.target.email);
    const requestFingerprint = operationFingerprint([args.benefitId, args.target.kind, targetKey, reason]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "benefit.grant",
      requestFingerprint,
    });
    if (prior) {
      const grantId = ctx.db.normalizeId("benefitGrants", prior.targetId);
      const stored = grantId ? await ctx.db.get("benefitGrants", grantId) : null;
      if (!stored) throw new Error("The stored benefit grant is invalid.");
      return { created: prior.resultJson === "created", code: stored.code };
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "benefit.manage",
      scopeType: "event",
    });
    const benefit = await requireBenefit(ctx, event._id, args.benefitId);
    if (benefit.status !== "active") {
      throw new ConvexError({ code: "BENEFIT_ARCHIVED", message: "That benefit is archived." });
    }
    let target: { teamId: Id<"teams"> } | { membershipId: Id<"eventMemberships"> };
    if (args.target.kind === "team") {
      if (benefit.scope !== "team") {
        throw new ConvexError({ code: "SCOPE_MISMATCH", message: "This benefit goes to individual people, not teams." });
      }
      const team = await ctx.db
        .query("teams")
        .withIndex("by_event_code", (index) => index.eq("eventId", event._id).eq("publicCode", targetKey))
        .unique();
      if (!team) throw new ConvexError({ code: "TEAM_NOT_FOUND", message: "No team has that code." });
      target = { teamId: team._id };
    } else {
      if (benefit.scope !== "person") {
        throw new ConvexError({ code: "SCOPE_MISMATCH", message: "This benefit goes to teams, not individual people." });
      }
      const targetPerson = await ctx.db
        .query("people")
        .withIndex("by_verified_email", (index) => index.eq("verifiedEmail", targetKey))
        .unique();
      const membership = targetPerson
        ? await ctx.db
            .query("eventMemberships")
            .withIndex("by_event_person", (index) => index.eq("eventId", event._id).eq("personId", targetPerson._id))
            .unique()
        : null;
      if (!membership) throw new ConvexError({ code: "PERSON_NOT_FOUND", message: "No participant has that email." });
      target = { membershipId: membership._id };
    }
    const now = Date.now();
    const result = await grantTo(ctx, {
      benefitId: benefit._id,
      target,
      actorPersonId: person._id,
      now,
    });
    if (!result) throw new ConvexError({ code: "NO_CODES_LEFT", message: "Every code for this benefit is already handed out. Add more codes." });
    const stored = await ctx.db.get("benefitGrants", result.grantId);
    if (!stored) throw new Error("The benefit grant did not persist.");
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "benefit.grant",
      requestFingerprint,
      targetType: "benefit_grant",
      targetId: result.grantId,
      resultJson: result.created ? "created" : "existing",
      createdAt: now,
    });
    if (result.created) {
      await writeAuditEvent(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        permissionKey: "benefit.manage",
        grantIds,
        scopeType: "event",
        action: "benefit.granted",
        targetType: "benefit_grant",
        targetId: result.grantId,
        nextSummary: JSON.stringify({ benefitId: benefit._id, target: args.target.kind, key: targetKey }),
        reason,
      });
    }
    return { created: result.created, code: stored.code };
  },
});

/** Starts a durable grant to every confirmed team, or every accepted participant. */
export const grantAll = mutation({
  args: { eventSlug: v.string(), benefitId: v.id("benefits"), reason: v.string(), clientOperationId: v.string() },
  returns: benefitGrantRunView,
  handler: async (ctx, args) => {
    const { event, person, subject } = await staffContext(ctx, args.eventSlug);
    const reason = normalizedText(args.reason, "Reason", 5, 200);
    const requestFingerprint = operationFingerprint([args.benefitId, "all", reason]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "benefit.grant_all",
      requestFingerprint,
    });
    if (prior) {
      const runId = ctx.db.normalizeId("benefitGrantRuns", prior.targetId);
      const run = runId ? await ctx.db.get("benefitGrantRuns", runId) : null;
      if (!run || run.eventId !== event._id || run.benefitId !== args.benefitId) {
        throw new Error("The stored benefit grant run is invalid.");
      }
      return grantRunView(run);
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "benefit.manage",
      scopeType: "event",
    });
    const benefit = await requireBenefit(ctx, event._id, args.benefitId);
    if (benefit.status !== "active") {
      throw new ConvexError({ code: "BENEFIT_ARCHIVED", message: "That benefit is archived." });
    }
    const now = Date.now();
    const latestGrantRun = benefit.latestGrantRunId
      ? await ctx.db.get("benefitGrantRuns", benefit.latestGrantRunId)
      : null;
    if (latestGrantRun && latestGrantRun.status !== "complete") {
      throw new ConvexError({
        code: "BENEFIT_GRANT_IN_PROGRESS",
        message: "This benefit is already being handed out to everyone.",
      });
    }
    const runId = await ctx.db.insert("benefitGrantRuns", {
      eventId: event._id,
      benefitId: benefit._id,
      scope: benefit.scope,
      status: "queued",
      teamStatusIndex: 0,
      scannedCount: 0,
      grantedCount: 0,
      alreadyHadCount: 0,
      outOfCodesCount: 0,
      reason,
      authorizingGrantIds: grantIds,
      requestedByPersonId: person._id,
      clientOperationId: args.clientOperationId,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(benefit._id, { latestGrantRunId: runId });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "benefit.grant_all",
      requestFingerprint,
      targetType: "benefit_grant_run",
      targetId: runId,
      createdAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.benefits.processGrantAllBatch, { runId });
    const run = await ctx.db.get("benefitGrantRuns", runId);
    if (!run) throw new Error("The benefit grant run did not persist.");
    return grantRunView(run);
  },
});

export const processGrantAllBatch = internalMutation({
  args: { runId: v.id("benefitGrantRuns") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const run = await ctx.db.get("benefitGrantRuns", args.runId);
    if (!run || run.status === "complete") return null;
    const benefit = await ctx.db.get("benefits", run.benefitId);
    if (
      !benefit ||
      benefit.eventId !== run.eventId ||
      benefit.scope !== run.scope ||
      benefit.status !== "active" ||
      benefit.latestGrantRunId !== run._id
    ) {
      throw new Error("The benefit grant run context changed before it completed.");
    }

    const page = run.scope === "team"
      ? await ctx.db
          .query("teams")
          .withIndex("by_event_status", (index) =>
            index
              .eq("eventId", run.eventId)
              .eq("status", grantTeamStatuses[run.teamStatusIndex] ?? "active"),
          )
          .paginate({ cursor: run.cursor ?? null, numItems: grantBatchSize })
      : await ctx.db
          .query("eventMemberships")
          .withIndex("by_event_onboarding_status", (index) =>
            index.eq("eventId", run.eventId).eq("onboardingStatus", "accepted"),
          )
          .paginate({ cursor: run.cursor ?? null, numItems: grantBatchSize });

    let grantedCount = run.grantedCount;
    let alreadyHadCount = run.alreadyHadCount;
    let outOfCodesCount = run.outOfCodesCount;
    for (const targetRow of page.page) {
      let target: { teamId: Id<"teams"> } | { membershipId: Id<"eventMemberships"> };
      if (run.scope === "team") {
        const teamId = ctx.db.normalizeId("teams", targetRow._id);
        if (!teamId) throw new Error("The benefit grant run returned an invalid team ID.");
        target = { teamId };
      } else {
        const membershipId = ctx.db.normalizeId("eventMemberships", targetRow._id);
        if (!membershipId) {
          throw new Error("The benefit grant run returned an invalid membership ID.");
        }
        target = { membershipId };
      }
      const result = await grantTo(ctx, {
        benefitId: benefit._id,
        target,
        actorPersonId: run.requestedByPersonId,
        now: Date.now(),
      });
      if (!result) outOfCodesCount += 1;
      else if (result.created) grantedCount += 1;
      else alreadyHadCount += 1;
    }

    const nextTeamStatusIndex = run.teamStatusIndex + 1;
    const complete = page.isDone && (
      run.scope === "person" || nextTeamStatusIndex >= grantTeamStatuses.length
    );
    const now = Date.now();
    await ctx.db.patch(run._id, {
      status: complete ? "complete" : "running",
      teamStatusIndex:
        run.scope === "team" && page.isDone ? nextTeamStatusIndex : run.teamStatusIndex,
      cursor: page.isDone ? undefined : page.continueCursor,
      scannedCount: run.scannedCount + page.page.length,
      grantedCount,
      alreadyHadCount,
      outOfCodesCount,
      updatedAt: now,
      ...(complete ? { completedAt: now } : {}),
    });
    if (!complete) {
      await ctx.scheduler.runAfter(0, internal.benefits.processGrantAllBatch, { runId: run._id });
      return null;
    }
    await writeAuditEvent(ctx, {
      eventId: run.eventId,
      actorPersonId: run.requestedByPersonId,
      permissionKey: "benefit.manage",
      grantIds: run.authorizingGrantIds,
      scopeType: "event",
      action: "benefit.granted_to_all",
      targetType: "benefit",
      targetId: benefit._id,
      nextSummary: JSON.stringify({ granted: grantedCount, alreadyHad: alreadyHadCount, outOfCodes: outOfCodesCount }),
      reason: run.reason,
    });
    return null;
  },
});

/** The benefits this participant holds: their own, and their team's. */
export const mine = query({
  args: { eventSlug: v.string() },
  returns: v.array(
    v.object({
      id: v.id("benefitGrants"),
      name: v.string(),
      description: v.optional(v.string()),
      link: v.optional(v.string()),
      scope: benefitScope,
      code: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const membership = await requireMembership(ctx, event._id, person._id);
    const member = await ctx.db
      .query("teamMembers")
      .withIndex("by_event_membership_status", (index) =>
        index.eq("eventId", event._id).eq("membershipId", membership._id).eq("status", "active"),
      )
      .unique();
    const [own, team] = await Promise.all([
      ctx.db
        .query("benefitGrants")
        .withIndex("by_membership", (index) => index.eq("membershipId", membership._id))
        .take(maximumBenefits),
      member
        ? ctx.db
            .query("benefitGrants")
            .withIndex("by_team", (index) => index.eq("teamId", member.teamId))
            .take(maximumBenefits)
        : Promise.resolve([]),
    ]);
    const views = [];
    for (const grant of [...own, ...team]) {
      const benefit = await ctx.db.get("benefits", grant.benefitId);
      if (!benefit || benefit.status !== "active" || benefit.eventId !== event._id) continue;
      views.push({
        id: grant._id,
        name: benefit.name,
        ...(benefit.description !== undefined ? { description: benefit.description } : {}),
        ...(benefit.link !== undefined ? { link: benefit.link } : {}),
        scope: benefit.scope,
        code: grant.code,
      });
    }
    return views.sort((left, right) => left.name.localeCompare(right.name));
  },
});
