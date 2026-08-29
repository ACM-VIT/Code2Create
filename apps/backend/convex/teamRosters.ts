import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { z } from "zod";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import {
  findCurrentPerson,
  requireCurrentPerson,
  requireEventSubject,
  requireFreshAuthSession,
  sensitiveCommandSessionMaxAgeMs,
} from "./lib/identity";
import { findOperation, operationFingerprint, recordOperation, storedOperationResult } from "./lib/operations";
import { loadPublishedParticipantPolicy } from "./lib/participantPolicy";
import type { PermissionKey } from "./lib/permissionCatalog";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { normalizeEmail, normalizedText } from "./lib/strings";
import { activeTeamsWithName, applyTeamRosterEntry } from "./lib/teamBackfill";
import { teamRosterCounts } from "./lib/teamRoster";
import { memberRole, teamRosterEntryStatus } from "./values";

type ReadCtx = QueryCtx | MutationCtx;

const maximumRowsPerImport = 200;
const maximumJoinsPerApplyRun = 5;

const teamRosterImportOperationResult = z
  .object({
    teamRosterImportId: z.string(),
    rowCount: z.number(),
  })
  .strict();

const importRow = v.object({
  rowNumber: v.number(),
  email: v.string(),
  displayName: v.string(),
  teamName: v.string(),
  role: memberRole,
});

const importRequestArgs = {
  eventSlug: v.string(),
  sourceName: v.string(),
  sourceFileName: v.optional(v.string()),
  rows: v.array(importRow),
  reason: v.string(),
};

const previewCounts = v.object({
  pending: v.number(),
  superseded: v.number(),
  alreadyOnTeam: v.number(),
  waitingForLead: v.number(),
});

const previewRowOutcome = v.union(
  v.literal("pending"),
  v.literal("already_on_team"),
  v.literal("waiting_for_lead"),
);

const entryView = v.object({
  id: v.id("teamRosterEntries"),
  teamRosterImportId: v.id("teamRosterImports"),
  sourceRowNumber: v.number(),
  email: v.string(),
  displayName: v.string(),
  teamName: v.string(),
  role: memberRole,
  status: teamRosterEntryStatus,
  version: v.number(),
  canRevoke: v.boolean(),
  createdAt: v.number(),
});

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ImportRowInput = {
  rowNumber: number;
  email: string;
  displayName: string;
  teamName: string;
  role: Doc<"teamRosterEntries">["role"];
};

type PreviewRow = ImportRowInput & {
  outcome: "pending" | "already_on_team" | "waiting_for_lead";
};

type TeamRosterPreview = {
  previewChecksum: string;
  sourceName: string;
  sourceFileName?: string;
  rows: PreviewRow[];
  counts: { pending: number; superseded: number; alreadyOnTeam: number; waitingForLead: number };
  reason: string;
  normalizedRows: ImportRowInput[];
  priorEntries: Doc<"teamRosterEntries">[];
  eventId: Id<"events">;
};

function exactTeamRosterEmail(value: string) {
  const email = normalizeEmail(value);
  if (!emailPattern.test(email) || email.length > 254) {
    throw new ConvexError({
      code: "INVALID_TEAM_ROSTER_EMAIL",
      message: "Every team roster row needs one complete Google account email address.",
    });
  }
  return email;
}

function normalizeTeamRosterRequest(args: {
  sourceName: string;
  sourceFileName?: string;
  rows: ImportRowInput[];
  reason: string;
}) {
  if (args.rows.length < 1 || args.rows.length > maximumRowsPerImport) {
    throw new ConvexError({
      code: "INVALID_TEAM_ROSTER_SIZE",
      message: `Import between 1 and ${maximumRowsPerImport} team roster rows at a time.`,
    });
  }
  const sourceName = normalizedText(args.sourceName, "Roster source", 3, 100);
  const sourceFileName = args.sourceFileName
    ? normalizedText(args.sourceFileName, "Source file name", 1, 160)
    : undefined;
  const reason = normalizedText(args.reason, "Reason", 5, 300);

  const seenRows = new Set<number>();
  const seenEmails = new Set<string>();
  const rows = args.rows.map((row) => {
    if (!Number.isSafeInteger(row.rowNumber) || row.rowNumber < 2 || seenRows.has(row.rowNumber)) {
      throw new ConvexError({
        code: "INVALID_TEAM_ROSTER_ROW",
        message: "Team roster row numbers must be unique positive spreadsheet rows.",
      });
    }
    seenRows.add(row.rowNumber);
    const email = exactTeamRosterEmail(row.email);
    if (seenEmails.has(email)) {
      throw new ConvexError({
        code: "DUPLICATE_TEAM_ROSTER_EMAIL",
        message: `${email} appears more than once in this import.`,
      });
    }
    seenEmails.add(email);
    return {
      rowNumber: row.rowNumber,
      email,
      displayName: normalizedText(row.displayName, "Roster name", 2, 100),
      teamName: normalizedText(row.teamName, "Team name", 2, 60),
      role: row.role,
    };
  });
  rows.sort((left, right) => left.rowNumber - right.rowNumber);

  const leadCountByTeam: Record<string, number> = {};
  const rowCountByTeam: Record<string, number> = {};
  for (const row of rows) {
    leadCountByTeam[row.teamName] = (leadCountByTeam[row.teamName] ?? 0) + (row.role === "lead" ? 1 : 0);
    rowCountByTeam[row.teamName] = (rowCountByTeam[row.teamName] ?? 0) + 1;
  }
  for (const [teamName, leadCount] of Object.entries(leadCountByTeam)) {
    if (leadCount !== 1) {
      throw new ConvexError({
        code: "INVALID_TEAM_ROSTER_LEADS",
        message: `Team ${teamName} needs exactly one lead row in this import.`,
      });
    }
  }
  for (const [teamName, rowCount] of Object.entries(rowCountByTeam)) {
    if (rowCount > maximumRowsPerImport) {
      throw new ConvexError({
        code: "INVALID_TEAM_ROSTER_TEAM_SIZE",
        message: `Team ${teamName} lists more rows than an import can carry.`,
      });
    }
  }
  return { sourceName, ...(sourceFileName !== undefined ? { sourceFileName } : {}), rows, reason };
}

async function personStateForPreview(
  ctx: ReadCtx,
  eventId: Id<"events">,
  email: string,
) {
  const person = await ctx.db
    .query("people")
    .withIndex("by_verified_email", (index) => index.eq("verifiedEmail", email))
    .unique();
  if (!person) return { activeMember: null as Doc<"teamMembers"> | null, hasMembership: false };
  const membership = await ctx.db
    .query("eventMemberships")
    .withIndex("by_event_person", (index) =>
      index.eq("eventId", eventId).eq("personId", person._id),
    )
    .unique();
  if (!membership) return { activeMember: null as Doc<"teamMembers"> | null, hasMembership: false };
  const activeMember = await ctx.db
    .query("teamMembers")
    .withIndex("by_event_membership_status", (index) =>
      index
        .eq("eventId", eventId)
        .eq("membershipId", membership._id)
        .eq("status", "active"),
    )
    .unique();
  return { activeMember, hasMembership: true };
}

async function pendingEntryForEmail(
  ctx: ReadCtx,
  eventId: Id<"events">,
  email: string,
) {
  const pending = await ctx.db
    .query("teamRosterEntries")
    .withIndex("by_event_email_status", (index) =>
      index.eq("eventId", eventId).eq("emailNormalized", email).eq("status", "pending"),
    )
    .unique();
  if (pending) return pending;
  return ctx.db
    .query("teamRosterEntries")
    .withIndex("by_event_email_status", (index) =>
      index
        .eq("eventId", eventId)
        .eq("emailNormalized", email)
        .eq("status", "waiting_for_lead"),
    )
    .unique();
}
async function liveTeamNamed(
  ctx: ReadCtx,
  eventId: Id<"events">,
  teamName: string,
) {
  const activeMatches = await activeTeamsWithName(ctx, { eventId, name: teamName });
  if (activeMatches.length > 1) {
    throw new ConvexError({
      code: "TEAM_NAME_AMBIGUOUS",
      message: "More than one active team uses that name. Rename in the CSV or in the event.",
    });
  }
  return activeMatches[0] ?? null;
}

async function prepareTeamRosterPreview(
  ctx: ReadCtx,
  event: Doc<"events">,
  args: {
    sourceName: string;
    sourceFileName?: string;
    rows: ImportRowInput[];
    reason: string;
  },
): Promise<TeamRosterPreview> {
  const normalized = normalizeTeamRosterRequest(args);
  const participantPolicy = await loadPublishedParticipantPolicy(ctx, event);
  const teamByName = new Map<string, Doc<"teams"> | null>();
  for (const row of normalized.rows) {
    if (teamByName.has(row.teamName)) continue;
    teamByName.set(row.teamName, await liveTeamNamed(ctx, event._id, row.teamName));
  }

  const rows: PreviewRow[] = [];
  const priorEntries: Doc<"teamRosterEntries">[] = [];
  for (const row of normalized.rows) {
    const priorEntry = await pendingEntryForEmail(ctx, event._id, row.email);
    if (priorEntry) priorEntries.push(priorEntry);
    const state = await personStateForPreview(ctx, event._id, row.email);
    const liveTeam = teamByName.get(row.teamName) ?? null;
    if (state.activeMember) {
      rows.push({ ...row, outcome: "already_on_team" });
    } else if (row.role === "member" && state.hasMembership && liveTeam === null) {
      rows.push({ ...row, outcome: "waiting_for_lead" });
    } else {
      rows.push({ ...row, outcome: "pending" });
    }
  }

  const teamMaximumSize = participantPolicy.normalized.teamMaximumSize;
  for (const [teamName, liveTeam] of teamByName) {
    const incoming = rows.filter(
      (row) => row.teamName === teamName && row.outcome !== "already_on_team",
    ).length;
    const liveCount = liveTeam ? teamRosterCounts(liveTeam).activeMemberCount : 0;
    if (liveCount + incoming > teamMaximumSize) {
      throw new ConvexError({
        code: "INVALID_TEAM_ROSTER_TEAM_SIZE",
        message: `Team ${teamName} would have ${liveCount + incoming} people, above this event's maximum of ${teamMaximumSize}.`,
      });
    }
  }

  const previewChecksum = operationFingerprint([
    operationFingerprint(
      normalized.rows.flatMap((row) => [
        row.rowNumber,
        row.email,
        row.displayName,
        row.teamName,
        row.role,
      ]),
    ),
    normalized.sourceName,
    normalized.sourceFileName ?? null,
    normalized.reason,
  ]);
  return {
    previewChecksum,
    sourceName: normalized.sourceName,
    ...(normalized.sourceFileName !== undefined
      ? { sourceFileName: normalized.sourceFileName }
      : {}),
    rows,
    counts: {
      pending: rows.filter((row) => row.outcome === "pending").length,
      superseded: priorEntries.length,
      alreadyOnTeam: rows.filter((row) => row.outcome === "already_on_team").length,
      waitingForLead: rows.filter((row) => row.outcome === "waiting_for_lead").length,
    },
    reason: normalized.reason,
    normalizedRows: normalized.rows,
    priorEntries,
    eventId: event._id,
  };
}

async function eventWideGrantIds(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    permissionKey: PermissionKey;
  },
) {
  return matchingPermissionGrantIds(ctx, { ...args, scopeType: "event" });
}

export const workspace = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    canRead: v.boolean(),
    canImport: v.boolean(),
    canRevoke: v.boolean(),
    serverNow: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const person = await findCurrentPerson(ctx);
    if (!person) {
      return { canRead: false, canImport: false, canRevoke: false, serverNow: Date.now() };
    }
    const subject = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", person._id),
      )
      .unique();
    if (!subject || subject.status !== "active") {
      return { canRead: false, canImport: false, canRevoke: false, serverNow: Date.now() };
    }
    const [readGrantIds, importGrantIds, revokeGrantIds] = await Promise.all([
      eventWideGrantIds(ctx, { eventId: event._id, eventAccessSubjectId: subject._id, permissionKey: "team.roster.read" }),
      eventWideGrantIds(ctx, { eventId: event._id, eventAccessSubjectId: subject._id, permissionKey: "team.roster.import" }),
      eventWideGrantIds(ctx, { eventId: event._id, eventAccessSubjectId: subject._id, permissionKey: "team.roster.revoke" }),
    ]);
    if (readGrantIds.length === 0 && importGrantIds.length === 0 && revokeGrantIds.length === 0) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "This account has no participant team import permission.",
      });
    }
    return {
      canRead: readGrantIds.length > 0,
      canImport: importGrantIds.length > 0,
      canRevoke: revokeGrantIds.length > 0,
      serverNow: Date.now(),
    };
  },
});

export const list = query({
  args: {
    eventSlug: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(entryView),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const readGrantIds = await eventWideGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.roster.read",
    });
    if (readGrantIds.length === 0) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "This account cannot view the participant team import.",
      });
    }
    const page = await ctx.db
      .query("teamRosterEntries")
      .withIndex("by_event_created", (index) => index.eq("eventId", event._id))
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      ...page,
      page: page.page.map((entry) => ({
        id: entry._id,
        teamRosterImportId: entry.teamRosterImportId,
        sourceRowNumber: entry.sourceRowNumber,
        email: entry.emailNormalized,
        displayName: entry.displayName,
        teamName: entry.teamName,
        role: entry.role,
        status: entry.status,
        version: entry.version,
        canRevoke: entry.status === "pending" || entry.status === "waiting_for_lead",
        createdAt: entry.createdAt,
      })),
    };
  },
});

export const previewImport = query({
  args: importRequestArgs,
  returns: v.object({
    previewChecksum: v.string(),
    rows: v.array(
      v.object({
        rowNumber: v.number(),
        email: v.string(),
        displayName: v.string(),
        teamName: v.string(),
        role: memberRole,
        outcome: previewRowOutcome,
      }),
    ),
    counts: previewCounts,
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const readGrantIds = await eventWideGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.roster.read",
    });
    if (readGrantIds.length === 0) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "This account cannot preview a participant team import.",
      });
    }
    const prepared = await prepareTeamRosterPreview(ctx, event, args);
    return {
      previewChecksum: prepared.previewChecksum,
      rows: prepared.rows,
      counts: prepared.counts,
    };
  },
});

export const confirmImport = mutation({
  args: {
    ...importRequestArgs,
    previewChecksum: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    teamRosterImportId: v.id("teamRosterImports"),
    rowCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const operationId = normalizedText(args.clientOperationId, "Client operation ID", 10, 100);
    const requestFingerprint = operationFingerprint([
      args.previewChecksum,
      operationFingerprint(
        args.rows.flatMap((row) => [
          row.rowNumber,
          row.email,
          row.displayName,
          row.teamName,
          row.role,
        ]),
      ),
      args.sourceName,
      args.sourceFileName ?? null,
      args.reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "teamRosters.confirmImport",
      requestFingerprint,
    });
    if (prior) {
      const result = storedOperationResult(
        prior.resultJson,
        "team roster import",
        teamRosterImportOperationResult,
      );
      const teamRosterImportId = ctx.db.normalizeId(
        "teamRosterImports",
        result.teamRosterImportId,
      );
      if (!teamRosterImportId || teamRosterImportId !== prior.targetId) {
        throw new Error("The stored team roster import is invalid.");
      }
      return { teamRosterImportId, rowCount: result.rowCount };
    }
    const authorizingGrantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.roster.import",
      scopeType: "event",
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    const prepared = await prepareTeamRosterPreview(ctx, event, args);
    if (prepared.previewChecksum !== args.previewChecksum) {
      throw new ConvexError({
        code: "TEAM_ROSTER_PREVIEW_STALE",
        message: "The team roster import changed. Review the import again.",
      });
    }
    const now = Date.now();
    const teamRosterImportId = await ctx.db.insert("teamRosterImports", {
      eventId: event._id,
      sourceName: prepared.sourceName,
      ...(prepared.sourceFileName !== undefined
        ? { sourceFileName: prepared.sourceFileName }
        : {}),
      previewChecksum: prepared.previewChecksum,
      rowCount: prepared.rows.length,
      createdCount: prepared.rows.length,
      replacedCount: prepared.counts.superseded,
      unchangedCount: prepared.counts.alreadyOnTeam,
      alreadyOnTeamCount: prepared.counts.alreadyOnTeam,
      waitingForLeadCount: prepared.counts.waitingForLead,
      appliedNowCount: 0,
      reason: prepared.reason,
      authorizingGrantIds,
      createdByPersonId: person._id,
      clientOperationId: operationId,
      createdAt: now,
    });
    const insertedEntryIds = new Map<number, Id<"teamRosterEntries">>();
    for (const row of prepared.normalizedRows) {
      const teamRosterEntryId = await ctx.db.insert("teamRosterEntries", {
        eventId: event._id,
        teamRosterImportId,
        sourceRowNumber: row.rowNumber,
        emailNormalized: row.email,
        displayName: row.displayName,
        teamName: row.teamName,
        role: row.role,
        status: "pending",
        version: 1,
        createdByPersonId: person._id,
        createdAt: now,
      });
      insertedEntryIds.set(row.rowNumber, teamRosterEntryId);
    }
    for (const priorEntry of prepared.priorEntries) {
      const supersedingRow = prepared.normalizedRows.find(
        (row) => row.email === priorEntry.emailNormalized,
      );
      await ctx.db.patch(priorEntry._id, {
        status: "superseded",
        version: priorEntry.version + 1,
        ...(supersedingRow
          ? { supersededByEntryId: insertedEntryIds.get(supersedingRow.rowNumber) }
          : {}),
      });
    }
    await ctx.scheduler.runAfter(0, internal.teamRosters.applyImport, {
      teamRosterImportId,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "team.roster.import",
      grantIds: authorizingGrantIds,
      scopeType: "event",
      action: "team.roster_imported",
      targetType: "team_roster_import",
      targetId: teamRosterImportId,
      nextSummary: JSON.stringify({
        sourceName: prepared.sourceName,
        rowCount: prepared.rows.length,
        alreadyOnTeamCount: prepared.counts.alreadyOnTeam,
        waitingForLeadCount: prepared.counts.waitingForLead,
      }),
      reason: prepared.reason,
    });
    const result = { teamRosterImportId, rowCount: prepared.rows.length };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "teamRosters.confirmImport",
      requestFingerprint,
      targetType: "team_roster_import",
      targetId: teamRosterImportId,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    return result;
  },
});

export const applyImport = internalMutation({
  args: { teamRosterImportId: v.id("teamRosterImports") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamRosterImport = await ctx.db.get("teamRosterImports", args.teamRosterImportId);
    if (!teamRosterImport) return null;
    const event = await ctx.db.get(teamRosterImport.eventId);
    if (!event) throw new Error("The team roster import references a missing event.");
    const entries = await ctx.db
      .query("teamRosterEntries")
      .withIndex("by_import_row", (index) =>
        index.eq("teamRosterImportId", teamRosterImport._id),
      )
      .take(maximumRowsPerImport + 1);
    if (entries.length > maximumRowsPerImport) {
      throw new Error("Team roster import contains more rows than its supported bound.");
    }
    const leads = entries
      .filter((entry) => entry.role === "lead" && entry.status === "pending")
      .sort((left, right) => left.sourceRowNumber - right.sourceRowNumber);
    const members = entries
      .filter((entry) => entry.role === "member" && entry.status === "pending")
      .sort((left, right) => left.sourceRowNumber - right.sourceRowNumber);
    let joinsPerformed = 0;
    let deferredByCap = false;
    for (const entry of [...leads, ...members]) {
      if (entry.status !== "pending" && entry.status !== "waiting_for_lead") continue;
      if (joinsPerformed >= maximumJoinsPerApplyRun) {
        deferredByCap = true;
        continue;
      }
      const outcome = await applyTeamRosterEntry(ctx, {
        event,
        entry,
        actorPersonId: teamRosterImport.createdByPersonId,
      });
      if (outcome === "claimed") {
        joinsPerformed += 1;
      }
    }
    if (deferredByCap) {
      await ctx.scheduler.runAfter(0, internal.teamRosters.applyImport, {
        teamRosterImportId: teamRosterImport._id,
      });
    }
    return null;
  },
});

export const revoke = mutation({
  args: {
    eventSlug: v.string(),
    teamRosterEntryId: v.id("teamRosterEntries"),
    expectedVersion: v.number(),
    reason: v.string(),
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
    const reason = normalizedText(args.reason, "Reason", 5, 300);
    const operationId = normalizedText(args.clientOperationId, "Client operation ID", 10, 100);
    const requestFingerprint = operationFingerprint([
      args.teamRosterEntryId,
      args.expectedVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "teamRosters.revoke",
      requestFingerprint,
    });
    if (prior) {
      const teamRosterEntryId = ctx.db.normalizeId("teamRosterEntries", prior.targetId);
      if (!teamRosterEntryId) throw new Error("The stored team roster revocation is invalid.");
      return { teamRosterEntryId, status: "revoked" as const };
    }
    const authorizingGrantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.roster.revoke",
      scopeType: "event",
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    const entry = await ctx.db.get("teamRosterEntries", args.teamRosterEntryId);
    if (!entry || entry.eventId !== event._id) {
      throw new ConvexError({
        code: "TEAM_ROSTER_ENTRY_NOT_FOUND",
        message: "That team roster entry is outside this event.",
      });
    }
    if (entry.version !== args.expectedVersion) {
      throw new ConvexError({
        code: "TEAM_ROSTER_ENTRY_CHANGED",
        message: "Only the current pending team roster entry can be revoked.",
      });
    }
    if (entry.status !== "pending" && entry.status !== "waiting_for_lead") {
      throw new ConvexError({
        code: "TEAM_ROSTER_ENTRY_NOT_REVOKABLE",
        message:
          "Only entries still waiting for sign-in can be revoked. Use the team tools to remove a member.",
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
      permissionKey: "team.roster.revoke",
      grantIds: authorizingGrantIds,
      scopeType: "event",
      action: "team.roster_entry_revoked",
      targetType: "team_roster_entry",
      targetId: entry._id,
      previousSummary: JSON.stringify({ status: entry.status, version: entry.version }),
      nextSummary: JSON.stringify({ status: "revoked", version: entry.version + 1 }),
      reason,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: operationId,
      commandName: "teamRosters.revoke",
      requestFingerprint,
      targetType: "team_roster_entry",
      targetId: entry._id,
      createdAt: now,
    });
    return { teamRosterEntryId: entry._id, status: "revoked" as const };
  },
});
