import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { z } from "zod";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { findCurrentPerson, requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationResult,
} from "./lib/operations";
import { loadPublishedParticipantPolicy } from "./lib/participantPolicy";
import type { PermissionKey } from "./lib/permissionCatalog";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { normalizeEmail, normalizedText } from "./lib/strings";
import {
  activeTeamsWithName,
  pendingEntryForIdentity,
  resolveTeamRosterPerson,
} from "./lib/teamBackfill";
import { teamRosterCounts } from "./lib/teamRoster";
import { parseVitRegistrationNumber, vitIdentityReferenceYear } from "./lib/vitStudentIdentity";
import { memberRole, teamRosterEntryStatus } from "./values";

type ReadCtx = QueryCtx | MutationCtx;

const maximumRowsPerImport = 200;

const teamRosterImportOperationResult = z
  .object({
    teamRosterImportId: z.string(),
    rowCount: z.number(),
  })
  .strict();

const importRow = v.object({
  rowNumber: v.number(),
  identity: v.string(),
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
  identityConflicts: v.number(),
  superseded: v.number(),
  alreadyAssigned: v.number(),
  choiceRequired: v.number(),
  waitingForLead: v.number(),
});

const entryCounts = v.object({
  waiting: v.number(),
  awaitingChoice: v.number(),
  identityConflicts: v.number(),
  claimed: v.number(),
  total: v.number(),
});

const previewRowOutcome = v.union(
  v.literal("pending"),
  v.literal("identity_conflict"),
  v.literal("already_assigned"),
  v.literal("choice_required"),
  v.literal("waiting_for_lead"),
);

const entryView = v.object({
  id: v.id("teamRosterEntries"),
  teamRosterImportId: v.id("teamRosterImports"),
  sourceRowNumber: v.number(),
  identity: v.string(),
  identityKind: v.union(v.literal("email"), v.literal("vit_registration")),
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
  identity: string;
  displayName: string;
  teamName: string;
  role: Doc<"teamRosterEntries">["role"];
};

type NormalizedImportRow = ImportRowInput & {
  identityKind: "email" | "vit_registration";
  identityNormalized: string;
  emailNormalized?: string;
  vitRegistrationNumber?: string;
};

type PreviewRow = NormalizedImportRow & {
  outcome:
    | "pending"
    | "identity_conflict"
    | "already_assigned"
    | "choice_required"
    | "waiting_for_lead";
};

type TeamRosterPreview = {
  previewChecksum: string;
  sourceName: string;
  sourceFileName?: string;
  rows: PreviewRow[];
  counts: {
    pending: number;
    identityConflicts: number;
    superseded: number;
    alreadyAssigned: number;
    choiceRequired: number;
    waitingForLead: number;
  };
  reason: string;
  normalizedRows: NormalizedImportRow[];
  priorEntries: Doc<"teamRosterEntries">[];
  eventId: Id<"events">;
};

function exactTeamRosterIdentity(value: string, eventYear: number) {
  const trimmed = value.trim();
  if (trimmed.includes("@")) {
    const email = normalizeEmail(trimmed);
    if (!emailPattern.test(email) || email.length > 254) {
      throw new ConvexError({
        code: "INVALID_TEAM_ROSTER_IDENTITY",
        message: "Every team roster row needs an email address or a VIT registration number.",
      });
    }
    return {
      identityKind: "email" as const,
      identityNormalized: email,
      identity: email,
      emailNormalized: email,
    };
  }
  const parsed = parseVitRegistrationNumber(trimmed, eventYear);
  if (!parsed) {
    throw new ConvexError({
      code: "INVALID_TEAM_ROSTER_IDENTITY",
      message: "Every team roster row needs an email address or a VIT registration number.",
    });
  }
  return {
    identityKind: "vit_registration" as const,
    identityNormalized: parsed.registrationNumber,
    identity: parsed.registrationNumber,
    vitRegistrationNumber: parsed.registrationNumber,
  };
}

function normalizeTeamRosterRequest(args: {
  sourceName: string;
  sourceFileName?: string;
  rows: ImportRowInput[];
  reason: string;
  eventYear: number;
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
  const seenIdentities = new Set<string>();
  const rows = args.rows.map((row) => {
    if (!Number.isSafeInteger(row.rowNumber) || row.rowNumber < 2 || seenRows.has(row.rowNumber)) {
      throw new ConvexError({
        code: "INVALID_TEAM_ROSTER_ROW",
        message: "Team roster row numbers must be unique positive spreadsheet rows.",
      });
    }
    seenRows.add(row.rowNumber);
    const identity = exactTeamRosterIdentity(row.identity, args.eventYear);
    if (seenIdentities.has(identity.identityNormalized)) {
      throw new ConvexError({
        code: "DUPLICATE_TEAM_ROSTER_IDENTITY",
        message: `${identity.identityNormalized} appears more than once in this import.`,
      });
    }
    seenIdentities.add(identity.identityNormalized);
    return {
      rowNumber: row.rowNumber,
      identity: identity.identity,
      identityKind: identity.identityKind,
      identityNormalized: identity.identityNormalized,
      ...(identity.identityKind === "email"
        ? { emailNormalized: identity.emailNormalized }
        : { vitRegistrationNumber: identity.vitRegistrationNumber }),
      displayName: normalizedText(row.displayName, "Roster name", 2, 100),
      teamName: normalizedText(row.teamName, "Team name", 2, 60),
      role: row.role,
    };
  });
  rows.sort((left, right) => left.rowNumber - right.rowNumber);

  const leadCountByTeam: Record<string, number> = {};
  const rowCountByTeam: Record<string, number> = {};
  for (const row of rows) {
    leadCountByTeam[row.teamName] =
      (leadCountByTeam[row.teamName] ?? 0) + (row.role === "lead" ? 1 : 0);
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
  identity: Pick<NormalizedImportRow, "emailNormalized" | "vitRegistrationNumber">,
) {
  const resolved = await resolveTeamRosterPerson(ctx, { eventId, entry: identity });
  if (resolved.kind === "identity_conflict") {
    return {
      activeMember: null as Doc<"teamMembers"> | null,
      hasMembership: false,
      identityConflict: true,
      membershipId: null as Id<"eventMemberships"> | null,
    };
  }
  if (resolved.kind === "not_found") {
    return {
      activeMember: null as Doc<"teamMembers"> | null,
      hasMembership: false,
      identityConflict: false,
      membershipId: null as Id<"eventMemberships"> | null,
    };
  }
  const activeMember = await ctx.db
    .query("teamMembers")
    .withIndex("by_event_membership_status", (index) =>
      index
        .eq("eventId", eventId)
        .eq("membershipId", resolved.membership._id)
        .eq("status", "active"),
    )
    .unique();
  return {
    activeMember,
    hasMembership: true,
    identityConflict: false,
    membershipId: resolved.membership._id,
  };
}

async function liveTeamNamed(ctx: ReadCtx, eventId: Id<"events">, teamName: string) {
  const activeMatches = await activeTeamsWithName(ctx, { eventId, name: teamName });
  if (activeMatches.length > 1) {
    throw new ConvexError({
      code: "TEAM_NAME_AMBIGUOUS",
      message: "More than one active team uses that name. Rename in the CSV or in the event.",
    });
  }
  return activeMatches[0] ?? null;
}

async function countTeamRosterEntries(
  ctx: ReadCtx,
  eventId: Id<"events">,
  status: Doc<"teamRosterEntries">["status"],
) {
  let count = 0;
  for await (const _entry of ctx.db
    .query("teamRosterEntries")
    .withIndex("by_event_status", (index) => index.eq("eventId", eventId).eq("status", status))) {
    count += 1;
  }
  return count;
}

const emptyEntryCounts = {
  waiting: 0,
  awaitingChoice: 0,
  identityConflicts: 0,
  claimed: 0,
  total: 0,
};

async function eventEntryCounts(ctx: ReadCtx, eventId: Id<"events">) {
  const [pending, waitingForLead, awaitingChoice, identityConflicts, claimed] = await Promise.all([
    countTeamRosterEntries(ctx, eventId, "pending"),
    countTeamRosterEntries(ctx, eventId, "waiting_for_lead"),
    countTeamRosterEntries(ctx, eventId, "choice_required"),
    countTeamRosterEntries(ctx, eventId, "identity_conflict"),
    countTeamRosterEntries(ctx, eventId, "claimed"),
  ]);
  return {
    waiting: pending + waitingForLead,
    awaitingChoice,
    identityConflicts,
    claimed,
    total: pending + waitingForLead + awaitingChoice + identityConflicts + claimed,
  };
}

function entryStatusForPreviewOutcome(
  outcome: PreviewRow["outcome"],
): Doc<"teamRosterEntries">["status"] {
  if (outcome === "already_assigned") return "claimed";
  if (outcome === "choice_required") return "choice_required";
  if (outcome === "identity_conflict") return "identity_conflict";
  return "pending";
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
  const normalized = normalizeTeamRosterRequest({
    ...args,
    eventYear: vitIdentityReferenceYear(event),
  });
  const participantPolicy = await loadPublishedParticipantPolicy(ctx, event);
  const teamByName = new Map<string, Doc<"teams"> | null>();
  for (const row of normalized.rows) {
    if (teamByName.has(row.teamName)) continue;
    teamByName.set(row.teamName, await liveTeamNamed(ctx, event._id, row.teamName));
  }

  const rows: PreviewRow[] = [];
  const identityStateChecksums: string[] = [];
  const priorEntries: Doc<"teamRosterEntries">[] = [];
  for (const row of normalized.rows) {
    const priorEntry = await pendingEntryForIdentity(ctx, {
      eventId: event._id,
      identityNormalized: row.identityNormalized,
    });
    if (priorEntry) priorEntries.push(priorEntry);
    const state = await personStateForPreview(ctx, event._id, row);
    identityStateChecksums.push(
      operationFingerprint([
        row.identityNormalized,
        state.membershipId,
        state.activeMember?._id ?? null,
        state.activeMember?.teamId ?? null,
        state.hasMembership,
        state.identityConflict,
      ]),
    );
    const liveTeam = teamByName.get(row.teamName) ?? null;
    if (state.identityConflict) {
      rows.push({ ...row, outcome: "identity_conflict" });
    } else if (state.activeMember && state.activeMember.teamId === liveTeam?._id) {
      rows.push({ ...row, outcome: "already_assigned" });
    } else if (state.activeMember) {
      rows.push({ ...row, outcome: "choice_required" });
    } else if (row.role === "member" && state.hasMembership && liveTeam === null) {
      rows.push({ ...row, outcome: "waiting_for_lead" });
    } else {
      rows.push({ ...row, outcome: "pending" });
    }
  }

  const teamMaximumSize = participantPolicy.normalized.teamMaximumSize;
  for (const [teamName, liveTeam] of teamByName) {
    const incoming = rows.filter(
      (row) =>
        row.teamName === teamName &&
        row.outcome !== "already_assigned" &&
        row.outcome !== "identity_conflict",
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
      rows.flatMap((row) => [
        row.rowNumber,
        row.identityNormalized,
        row.displayName,
        row.teamName,
        row.role,
        row.outcome,
      ]),
    ),
    operationFingerprint(identityStateChecksums),
    operationFingerprint(priorEntries.flatMap((entry) => [entry._id, entry.version, entry.status])),
    operationFingerprint(
      [...teamByName.entries()].flatMap(([teamName, team]) => [
        teamName,
        team?._id ?? null,
        team?.version ?? null,
        team?.activeMemberCount ?? null,
      ]),
    ),
    participantPolicy.policy._id,
    participantPolicy.policy.checksum,
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
      identityConflicts: rows.filter((row) => row.outcome === "identity_conflict").length,
      superseded: priorEntries.length,
      alreadyAssigned: rows.filter((row) => row.outcome === "already_assigned").length,
      choiceRequired: rows.filter((row) => row.outcome === "choice_required").length,
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
    entryCounts,
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const person = await findCurrentPerson(ctx);
    if (!person) {
      return {
        canRead: false,
        canImport: false,
        canRevoke: false,
        serverNow: Date.now(),
        entryCounts: emptyEntryCounts,
      };
    }
    const subject = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", person._id),
      )
      .unique();
    if (!subject || subject.status !== "active") {
      return {
        canRead: false,
        canImport: false,
        canRevoke: false,
        serverNow: Date.now(),
        entryCounts: emptyEntryCounts,
      };
    }
    const [readGrantIds, importGrantIds, revokeGrantIds] = await Promise.all([
      eventWideGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "team.roster.read",
      }),
      eventWideGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "team.roster.import",
      }),
      eventWideGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "team.roster.revoke",
      }),
    ]);
    if (readGrantIds.length === 0 && importGrantIds.length === 0 && revokeGrantIds.length === 0) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "This account has no participant team import permission.",
      });
    }
    const canRead = readGrantIds.length > 0;
    return {
      canRead,
      canImport: importGrantIds.length > 0,
      canRevoke: revokeGrantIds.length > 0,
      serverNow: Date.now(),
      entryCounts: canRead ? await eventEntryCounts(ctx, event._id) : emptyEntryCounts,
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
        identity: entry.emailNormalized ?? entry.vitRegistrationNumber ?? "",
        identityKind:
          entry.emailNormalized === undefined ? ("vit_registration" as const) : ("email" as const),
        displayName: entry.displayName,
        teamName: entry.teamName,
        role: entry.role,
        status: entry.status,
        version: entry.version,
        canRevoke:
          entry.status === "pending" ||
          entry.status === "waiting_for_lead" ||
          entry.status === "choice_required" ||
          entry.status === "identity_conflict",
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
        identity: v.string(),
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
    const importGrantIds = await eventWideGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "team.roster.import",
    });
    if (importGrantIds.length === 0) {
      throw new ConvexError({
        code: "ACCESS_DENIED",
        message: "This account cannot import participant teams.",
      });
    }
    const prepared = await prepareTeamRosterPreview(ctx, event, args);
    return {
      previewChecksum: prepared.previewChecksum,
      rows: prepared.rows.map((row) => ({
        rowNumber: row.rowNumber,
        identity: row.identity,
        displayName: row.displayName,
        teamName: row.teamName,
        role: row.role,
        outcome: row.outcome,
      })),
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
          row.identity,
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
      const teamRosterImportId = ctx.db.normalizeId("teamRosterImports", result.teamRosterImportId);
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
      ...(prepared.sourceFileName !== undefined ? { sourceFileName: prepared.sourceFileName } : {}),
      previewChecksum: prepared.previewChecksum,
      rowCount: prepared.rows.length,
      createdCount: prepared.rows.length,
      replacedCount: prepared.counts.superseded,
      alreadyAssignedCount: prepared.counts.alreadyAssigned,
      choiceRequiredCount: prepared.counts.choiceRequired,
      waitingForLeadCount: prepared.counts.waitingForLead,
      identityConflictCount: prepared.counts.identityConflicts,
      appliedNowCount: 0,
      reason: prepared.reason,
      authorizingGrantIds,
      createdByPersonId: person._id,
      clientOperationId: operationId,
      createdAt: now,
    });
    const insertedEntryIds = new Map<number, Id<"teamRosterEntries">>();
    for (const row of prepared.rows) {
      const teamRosterEntryId = await ctx.db.insert("teamRosterEntries", {
        eventId: event._id,
        teamRosterImportId,
        sourceRowNumber: row.rowNumber,
        ...(row.identityKind === "email"
          ? { emailNormalized: row.identityNormalized }
          : { vitRegistrationNumber: row.identityNormalized }),
        displayName: row.displayName,
        teamName: row.teamName,
        role: row.role,
        status: entryStatusForPreviewOutcome(row.outcome),
        version: 1,
        createdByPersonId: person._id,
        createdAt: now,
      });
      insertedEntryIds.set(row.rowNumber, teamRosterEntryId);
    }
    for (const priorEntry of prepared.priorEntries) {
      const supersedingRow = prepared.normalizedRows.find(
        (row) =>
          row.identityNormalized ===
          (priorEntry.emailNormalized ?? priorEntry.vitRegistrationNumber),
      );
      await ctx.db.patch(priorEntry._id, {
        status: "superseded",
        version: priorEntry.version + 1,
        ...(supersedingRow
          ? { supersededByEntryId: insertedEntryIds.get(supersedingRow.rowNumber) }
          : {}),
      });
    }
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
        alreadyAssignedCount: prepared.counts.alreadyAssigned,
        choiceRequiredCount: prepared.counts.choiceRequired,
        waitingForLeadCount: prepared.counts.waitingForLead,
        identityConflictCount: prepared.counts.identityConflicts,
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
    if (
      entry.status !== "pending" &&
      entry.status !== "waiting_for_lead" &&
      entry.status !== "choice_required" &&
      entry.status !== "identity_conflict"
    ) {
      throw new ConvexError({
        code: "TEAM_ROSTER_ENTRY_NOT_REVOKABLE",
        message:
          "Only entries still waiting, awaiting a participant choice, or blocked by an identity conflict can be revoked. Use the team tools to remove a member.",
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
