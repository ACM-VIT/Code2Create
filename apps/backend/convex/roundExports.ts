import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { z } from "zod";

import { internal } from "./_generated/api";
import type { DataModel, Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, mutation, query,
} from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationResult,
  storedOperationVersion,
} from "./lib/operations";
import { matchingPermissionGrantIds, requirePermission,
} from "./lib/permissions";
import { activeRoundPause } from "./lib/reviewRoundPauses";
import { roundExportCsvRow } from "./lib/roundExportFormat";
import { buildRoundCloseEntries } from "./lib/roundCloseEntries";
import { normalizedText } from "./lib/strings";
import { appendRoundExportJobReadFactById } from "./lib/operationsAutonomyReadFacts/roundExportJobs";
import { reviewRoundStatus } from "./values";
import { exportWorkpool } from "./workpools";

const exportFormatVersion = 1;
const roundExportIdValidator = v.id("roundExports");
const generateKind = "generate" as const;
const skipKind = "skip" as const;
const alreadyVerifiedKind = "already_verified" as const;
const verifyKind = "verify" as const;

const activeExportState = v.union(
  v.literal("generating"),
  v.literal("uploaded"),
  v.literal("verified"),
  v.literal("failed"),
);

const exportCounts = v.object({
  team: v.number(),
  result: v.number(),
  excluded: v.number(),
  withdrawn: v.number(),
  reviewSession: v.number(),
  scorecard: v.number(),
  scorecardVersion: v.number(),
  correctionCase: v.number(),
  manualReviewRecord: v.number(),
});

const storedFile = v.object({
  objectKey: v.string(),
  objectVersionId: v.string(),
  byteCount: v.number(),
  sha256: v.string(),
});

const storedFiles = v.object({
  storageRegion: v.string(),
  storageBucket: v.string(),
  json: storedFile,
  csv: storedFile,
});

const exportWorkspace = v.object({
  round: v.object({
    id: v.id("reviewRounds"),
    name: v.string(),
    status: reviewRoundStatus,
    version: v.number(),
  }),
  activeExport: v.union(
    v.null(),
    v.object({
      id: v.id("roundExports"),
      revision: v.number(),
      state: activeExportState,
      version: v.number(),
      requestedByName: v.string(),
      requestedAt: v.number(),
      uploadedAt: v.optional(v.number()),
      verifiedByName: v.optional(v.string()),
      verifiedAt: v.optional(v.number()),
      counts: exportCounts,
      files: v.optional(
        v.object({
          json: v.object({ byteCount: v.number(), sha256: v.string() }),
          csv: v.object({ byteCount: v.number(), sha256: v.string() }),
        }),
      ),
    }),
  ),
  canStart: v.boolean(),
  canReadFiles: v.boolean(),
  canVerify: v.boolean(),
  canRetry: v.boolean(),
  canReopen: v.boolean(),
});

type ReadCtx = QueryCtx | MutationCtx;
type ActiveExportState = "generating" | "uploaded" | "verified" | "failed";
type StartResult = {
  roundExportId: Id<"roundExports">;
  closeSnapshotId: Id<"roundCloseSnapshots">;
  roundVersion: number;
  exportVersion: number;
  state: ActiveExportState;
};

const roundCloseStartOperationResult = z
  .object({
    roundExportId: z.string().min(1),
    closeSnapshotId: z.string().min(1),
    roundVersion: z.number().int().positive(),
    exportVersion: z.number().int().positive(),
    state: z.literal("generating"),
  })
  .strict();

const roundExportRetryOperationResult = z
  .object({
    exportVersion: z.number().int().positive(),
    state: z.literal("generating"),
  })
  .strict();

const roundExportVerificationOperationResult = z
  .object({
    roundId: z.string().min(1),
    closedAt: z.number().int().nonnegative(),
  })
  .strict();

function unresolvedCorrection(state: Doc<"scorecardCorrectionCases">["state"]) {
  return state === "requested" || state === "open";
}

function sameNumber(left: number, right: number) {
  return Math.abs(left - right) <= 1e-9;
}

function requireActiveExportState(state: Doc<"roundExports">["state"],
): ActiveExportState {
  switch (state) {
    case "generating":
    case "uploaded":
    case "verified":
    case "failed":
      return state;
    case "superseded":
      throw new Error("The round export is superseded.");
  }
}

function isoTime(value: number | undefined) {
  return value === undefined ? "" : new Date(value).toISOString();
}

async function requireRound(ctx: ReadCtx, eventId: Id<"events">, roundId: Id<"reviewRounds">,
) {
  const round = await ctx.db.get(roundId);
  if (!round || round.eventId !== eventId) {
    throw new ConvexError({
      code: "ROUND_NOT_FOUND",
      message: "That review round is unavailable.",
    });
  }
  return round;
}

async function activeExportForRound(ctx: ReadCtx, round: Doc<"reviewRounds">) {
  if (!round.activeRoundExportId) return null;
  const exportRecord = await ctx.db.get(round.activeRoundExportId);
  if (!exportRecord || exportRecord.roundId !== round._id) {
    throw new Error("The round's active export reference is invalid.");
  }
  return exportRecord;
}

async function permissionIds(
  ctx: ReadCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    permissionKey:
      | "round.close"
      | "round.export.read"
      | "round.export.verify"
      | "round.export.retry"
      | "round.reopen";
    roundId: Id<"reviewRounds">;
  },
) {
  return matchingPermissionGrantIds(ctx, {
    eventId: args.eventId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    permissionKey: args.permissionKey,
    scopeType: "round",
    scopeId: args.roundId,
  });
}

export const workspace = query({
  args: { eventSlug: v.string(), roundId: v.id("reviewRounds") },
  returns: exportWorkspace,
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const round = await requireRound(ctx, event._id, args.roundId);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "score.completeness.read",
      scopeType: "round",
      scopeId: round._id,
    });
    const [
      exportRecord,
      startGrants,
      readGrants,
      verifyGrants,
      retryGrants,
      reopenGrants,
    ] = await Promise.all([
      activeExportForRound(ctx, round),
      permissionIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "round.close",
        roundId: round._id,
      }),
      permissionIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "round.export.read",
        roundId: round._id,
      }),
      permissionIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "round.export.verify",
        roundId: round._id,
      }),
      permissionIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "round.export.retry",
        roundId: round._id,
      }),
      permissionIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "round.reopen",
        roundId: round._id,
      }),
    ]);
    let activeExport: {
      id: Id<"roundExports">;
      revision: number;
      state: ActiveExportState;
      version: number;
      requestedByName: string;
      requestedAt: number;
      uploadedAt?: number;
      verifiedByName?: string;
      verifiedAt?: number;
      counts: Doc<"roundExports">["counts"];
      files?: {
        json: { byteCount: number; sha256: string };
        csv: { byteCount: number; sha256: string };
      };
    } | null = null;
    if (exportRecord) {
      const [requester, verifier] = await Promise.all([
        ctx.db.get(exportRecord.requestedByPersonId),
        exportRecord.verifiedByPersonId
          ? ctx.db.get(exportRecord.verifiedByPersonId)
          : Promise.resolve(null),
      ]);
      if (!requester) throw new Error("The round export requester no longer resolves.");
      activeExport = {
        id: exportRecord._id,
        revision: exportRecord.revision,
        state: requireActiveExportState(exportRecord.state),
        version: exportRecord.version,
        requestedByName: requester.displayName,
        requestedAt: exportRecord.requestedAt,
        ...(exportRecord.uploadedAt !== undefined ? { uploadedAt: exportRecord.uploadedAt } : {}),
        ...(verifier ? { verifiedByName: verifier.displayName } : {}),
        ...(exportRecord.verifiedAt !== undefined ? { verifiedAt: exportRecord.verifiedAt } : {}),
        counts: exportRecord.counts,
        ...(readGrants.length > 0 && exportRecord.files
          ? {
              files: {
                json: {
                  byteCount: exportRecord.files.json.byteCount,
                  sha256: exportRecord.files.json.sha256,
                },
                csv: {
                  byteCount: exportRecord.files.csv.byteCount,
                  sha256: exportRecord.files.csv.sha256,
                },
              },
            }
          : {}),
      };
    }
    return {
      round: {
        id: round._id,
        name: round.name,
        status: round.status,
        version: round.version,
      },
      activeExport,
      canStart: startGrants.length > 0,
      canReadFiles: readGrants.length > 0,
      canVerify:
        verifyGrants.length > 0 &&
        readGrants.length > 0 &&
        exportRecord?.requestedByPersonId !== person._id,
      canRetry: retryGrants.length > 0,
      canReopen: reopenGrants.length > 0,
    };
  },
});

export const generationFinished = exportWorkpool.defineOnComplete<
  DataModel,
  typeof roundExportIdValidator
>({
  context: roundExportIdValidator,
  handler: async (ctx, { context: exportId, result }) => {
    if (result.kind === "success") return;
    const exportRecord = await ctx.db.get(exportId);
    if (!exportRecord || exportRecord.state !== "generating") return;
    const now = Date.now();
    await ctx.db.patch(exportRecord._id, {
      state: "failed",
      failureCode: result.kind === "canceled" ? "generation_canceled" : "generation_failed",
      failedAt: now,
      version: exportRecord.version + 1,
      updatedAt: now,
    });
    await appendRoundExportJobReadFactById(ctx, exportRecord._id, now);
  },
});

export const start = mutation({
  args: {
    eventSlug: v.string(),
    roundId: v.id("reviewRounds"),
    expectedRoundVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    roundExportId: v.id("roundExports"),
    closeSnapshotId: v.id("roundCloseSnapshots"),
    roundVersion: v.number(),
    exportVersion: v.number(),
    state: activeExportState,
  }),
  handler: async (ctx, args): Promise<StartResult> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Close reason", 5, 500);
    const requestFingerprint = operationFingerprint([
      args.roundId,
      args.expectedRoundVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.round_close.start",
      requestFingerprint,
    });
    if (prior) {
      const result = storedOperationResult(
        prior.resultJson,
        "round-close start",
        roundCloseStartOperationResult,
      );
      const roundExportId = ctx.db.normalizeId("roundExports", result.roundExportId,
      );
      const closeSnapshotId = ctx.db.normalizeId("roundCloseSnapshots", result.closeSnapshotId,
      );
      if (!roundExportId || !closeSnapshotId || roundExportId !== prior.targetId) {
        throw new Error("The stored round-close start is invalid.");
      }
      return {
        roundExportId,
        closeSnapshotId,
        roundVersion: result.roundVersion,
        exportVersion: result.exportVersion,
        state: result.state,
      };
    }
    const round = await requireRound(ctx, event._id, args.roundId);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "round.close",
      scopeType: "round",
      scopeId: round._id,
    });
    if (await activeRoundPause(ctx, round._id)) {
      throw new ConvexError({
        code: "ROUND_PAUSED",
        message: "Resume new review starts before beginning round close.",
      });
    }
    if (
      round.status !== "open" ||
      round.version !== args.expectedRoundVersion ||
      round.activeCloseSnapshotId !== undefined ||
      round.activeRoundExportId !== undefined
    ) {
      throw new ConvexError({
        code: "ROUND_CHANGED",
        message: "Only the current open round can begin closing.",
      });
    }
    const [
      sessions,
      states,
      cases,
      manualRecords,
      evaluations,
      scorecards,
      scorecardVersions,
      latestExport,
    ] = await Promise.all([
      ctx.db
        .query("reviewSessions")
        .withIndex("by_round_team_status", (index) => index.eq("roundId", round._id),
        )
        .collect(),
      ctx.db
        .query("teamRoundStates")
        .withIndex("by_round_state_priority_queued", (index) => index.eq("roundId", round._id),
        )
        .collect(),
      ctx.db
        .query("scorecardCorrectionCases")
        .withIndex("by_round_state", (index) => index.eq("roundId", round._id))
        .collect(),
      ctx.db
        .query("manualReviewRecords")
        .withIndex("by_round_status_created", (index) => index.eq("roundId", round._id),
        )
        .collect(),
      ctx.db
        .query("reviewEvaluations")
        .withIndex("by_round_state", (index) => index.eq("roundId", round._id))
        .collect(),
      ctx.db
        .query("scorecards")
        .withIndex("by_round_session", (index) => index.eq("roundId", round._id),
        )
        .collect(),
      ctx.db
        .query("scorecardVersions")
        .withIndex("by_round_session", (index) => index.eq("roundId", round._id),
        )
        .collect(),
      ctx.db
        .query("roundExports")
        .withIndex("by_round_revision", (index) => index.eq("roundId", round._id),
        )
        .order("desc")
        .first(),
    ]);
    if (cases.some((correctionCase) => unresolvedCorrection(correctionCase.state))) {
      throw new ConvexError({
        code: "CORRECTIONS_UNRESOLVED",
        message: "Resolve every correction request before closing this round.",
      });
    }
    if (
      manualRecords.some((record) => record.status === "draft" || record.status === "submitted",
      )
    ) {
      throw new ConvexError({
        code: "PAPER_REVIEWS_UNRESOLVED",
        message: "Cancel, reject, or import every pending paper review before closing this round.",
      });
    }
    const unresolvedStates = states.filter(
      (state) => !["completed", "withdrawn"].includes(state.state),
    );
    if (unresolvedStates.length > 0) {
      throw new ConvexError({
        code: "ROUND_TEAMS_UNRESOLVED",
        message: `${unresolvedStates.length} team states still need an explicit outcome.`,
      });
    }
    if (
      sessions.some((session) =>
        ["awaiting_presence", "active", "scoring"].includes(session.status),
      )
    ) {
      throw new ConvexError({
        code: "REVIEWS_STILL_LIVE",
        message: "Finish or resolve every live review before closing the round.",
      });
    }
    if (states.length === 0) {
      throw new ConvexError({
        code: "ROUND_EMPTY",
        message: "This round has no team outcomes to export.",
      });
    }
    const entries = buildRoundCloseEntries({ states, sessions, evaluations, cases });
    const revision = (latestExport?.revision ?? 0) + 1;
    const now = Date.now();
    const snapshotChecksum = operationFingerprint([
      round._id,
      revision,
      round.configurationChecksum,
      JSON.stringify(entries),
    ]);
    const resultCount = entries.filter((entry) => entry.payload.kind === "result",
    ).length;
    const exclusionCount = entries.filter((entry) => entry.payload.kind === "excluded",
    ).length;
    const withdrawnCount = entries.filter((entry) => entry.payload.kind === "withdrawn",
    ).length;
    const closeSnapshotId = await ctx.db.insert("roundCloseSnapshots", {
      eventId: event._id,
      roundId: round._id,
      rubricVersionId: round.rubricVersionId,
      revision,
      roundConfigurationChecksum: round.configurationChecksum,
      resultCount,
      exclusionCount,
      withdrawnCount,
      checksum: snapshotChecksum,
      createdByPersonId: person._id,
      createdAt: now,
    });
    await Promise.all(
      entries.map((entry) =>
        ctx.db.insert("roundCloseEntries", {
          eventId: event._id,
          roundId: round._id,
          closeSnapshotId,
          teamId: entry.teamId,
          payload: entry.payload,
          createdAt: now,
        }),
      ),
    );
    const closingRoundVersion = round.version + 1;
    const exportedReviewIds = new Set(
      entries.flatMap((entry) =>
        entry.payload.kind === "withdrawn" ? [] : [entry.payload.reviewSessionId],
      ),
    );
    const counts = {
      team: entries.length,
      result: resultCount,
      excluded: exclusionCount,
      withdrawn: withdrawnCount,
      reviewSession: exportedReviewIds.size,
      scorecard: scorecards.filter((scorecard) => exportedReviewIds.has(scorecard.reviewSessionId),
      )
        .length,
      scorecardVersion: scorecardVersions.filter((scorecardVersion) =>
        exportedReviewIds.has(scorecardVersion.reviewSessionId),
      ).length,
      correctionCase: cases.filter((correctionCase) =>
        exportedReviewIds.has(correctionCase.reviewSessionId),
      ).length,
      manualReviewRecord: manualRecords.filter((manualRecord) =>
        exportedReviewIds.has(manualRecord.reviewSessionId),
      ).length,
    };
    const roundExportId = await ctx.db.insert("roundExports", {
      eventId: event._id,
      roundId: round._id,
      closeSnapshotId,
      revision,
      exportFormatVersion,
      state: "generating",
      closingRoundVersion,
      counts,
      checksum: operationFingerprint([
        snapshotChecksum,
        exportFormatVersion,
        JSON.stringify(counts),
      ]),
      requestedByPersonId: person._id,
      requestedAt: now,
      version: 1,
      updatedAt: now,
    });
    await appendRoundExportJobReadFactById(ctx, roundExportId, now);
    const workId = await exportWorkpool.enqueueAction(
      ctx,
      internal.roundExportActions.generate,
      { roundExportId },
      {
        retry: true,
        onComplete: internal.roundExports.generationFinished,
        context: roundExportId,
      },
    );
    await Promise.all([
      ctx.db.patch(roundExportId, { workId }),
      ctx.db.patch(round._id, {
        status: "closing",
        closingAt: now,
        closingByPersonId: person._id,
        activeCloseSnapshotId: closeSnapshotId,
        activeRoundExportId: roundExportId,
        closedAt: undefined,
        closedByPersonId: undefined,
        version: closingRoundVersion,
      }),
    ]);
    const result: StartResult = {
      roundExportId,
      closeSnapshotId,
      roundVersion: closingRoundVersion,
      exportVersion: 1,
      state: "generating",
    };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.round_close.start",
      requestFingerprint,
      targetType: "round_export",
      targetId: roundExportId,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "round.close",
      grantIds,
      scopeType: "round",
      scopeId: round._id,
      action: "review.round_closing_started",
      targetType: "round_export",
      targetId: roundExportId,
      previousSummary: JSON.stringify({ status: round.status, version: round.version,
      }),
      nextSummary: JSON.stringify({
        status: "closing",
        version: closingRoundVersion,
        revision,
        counts,
        snapshotChecksum,
      }),
      reason,
    });
    return result;
  },
});

export const generationContext = internalQuery({
  args: { roundExportId: v.id("roundExports") },
  returns: v.union(
    v.object({ kind: v.literal("skip") }),
    v.object({
      kind: v.literal("generate"),
      eventId: v.id("events"),
      roundId: v.id("reviewRounds"),
      roundExportId: v.id("roundExports"),
      closeSnapshotId: v.id("roundCloseSnapshots"),
      requestedAt: v.number(),
      metadataJson: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const exportRecord = await ctx.db.get(args.roundExportId);
    if (!exportRecord) {
      throw new ConvexError({
        code: "ROUND_EXPORT_NOT_FOUND",
        message: "That round export is unavailable.",
      });
    }
    if (exportRecord.state !== "generating") return { kind: skipKind };
    const [event, round, snapshot] = await Promise.all([
      ctx.db.get(exportRecord.eventId),
      ctx.db.get(exportRecord.roundId),
      ctx.db.get(exportRecord.closeSnapshotId),
    ]);
    if (
      !event ||
      !round ||
      !snapshot ||
      round.status !== "closing" ||
      round.version !== exportRecord.closingRoundVersion ||
      round.activeRoundExportId !== exportRecord._id ||
      round.activeCloseSnapshotId !== snapshot._id
    ) {
      throw new ConvexError({
        code: "ROUND_EXPORT_CONTEXT_CHANGED",
        message: "The closing round no longer matches this export.",
      });
    }
    const [rubric, criteria, panels] = await Promise.all([
      ctx.db.get(round.rubricVersionId),
      ctx.db
        .query("reviewRubricCriteria")
        .withIndex("by_rubric_order", (index) => index.eq("rubricVersionId", round.rubricVersionId),
        )
        .collect(),
      ctx.db
        .query("reviewPanels")
        .withIndex("by_round_status", (index) => index.eq("roundId", round._id))
        .collect(),
    ]);
    if (!rubric) throw new Error("The closing round rubric no longer resolves.");
    const panelSnapshots = [];
    for (const panel of panels.sort((left, right) =>
      left.stableKey.localeCompare(right.stableKey),
    )) {
      const members = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (index) => index.eq("panelId", panel._id))
        .collect();
      const namedMembers = await Promise.all(
        members.map(async (member) => {
          const reviewer = await ctx.db.get(member.personId);
          if (!reviewer) throw new Error("A panel member no longer resolves.");
          return {
            id: member._id,
            reviewerPersonId: member.personId,
            reviewerName: reviewer.displayName,
            assignedCriterionIds: member.assignedCriterionIds,
            isCoordinator: member.isCoordinator,
            status: member.status,
            assignedAt: member.assignedAt,
            endedAt: member.endedAt,
          };
        }),
      );
      panelSnapshots.push({
        id: panel._id,
        stableKey: panel.stableKey,
        name: panel.name,
        coordinatorPersonId: panel.coordinatorPersonId,
        status: panel.status,
        version: panel.version,
        members: namedMembers,
      });
    }
    const metadataJson = JSON.stringify({
      event: {
        id: event._id,
        slug: event.slug,
        name: event.name,
        timezone: event.timezone,
        version: event.version,
      },
      round: {
        id: round._id,
        stableKey: round.stableKey,
        name: round.name,
        sequence: round.sequence,
        status: round.status,
        startsAt: round.startsAt,
        endsAt: round.endsAt,
        reviewDurationSeconds: round.reviewDurationSeconds,
        ordinaryExtensionSeconds: round.ordinaryExtensionSeconds,
        maximumOrdinaryExtensions: round.maximumOrdinaryExtensions,
        requiredPanelSize: round.requiredPanelSize,
        minimumScorersPerCriterion: round.minimumScorersPerCriterion,
        requiresSharedCommitments: round.requiresSharedCommitments,
        requiresFinalComment: round.requiresFinalComment,
        configurationChecksum: round.configurationChecksum,
        version: round.version,
      },
      rubric: {
        id: rubric._id,
        version: rubric.version,
        name: rubric.name,
        scoreMinimum: rubric.scoreMinimum,
        scoreMaximum: rubric.scoreMaximum,
        aggregationFormula: rubric.aggregationFormula,
        spreadThreshold: rubric.spreadThreshold,
        checksum: rubric.checksum,
        criteria: criteria.map((criterion) => ({
          id: criterion._id,
          stableKey: criterion.stableKey,
          label: criterion.label,
          question: criterion.question,
          guidance: criterion.guidance,
          weight: criterion.weight,
          displayOrder: criterion.displayOrder,
          anchors: criterion.anchors,
        })),
      },
      panels: panelSnapshots,
      closeSnapshot: {
        id: snapshot._id,
        revision: snapshot.revision,
        resultCount: snapshot.resultCount,
        exclusionCount: snapshot.exclusionCount,
        withdrawnCount: snapshot.withdrawnCount,
        checksum: snapshot.checksum,
        createdAt: snapshot.createdAt,
      },
      roundExport: {
        id: exportRecord._id,
        revision: exportRecord.revision,
        formatVersion: exportRecord.exportFormatVersion,
        requestedAt: exportRecord.requestedAt,
      },
    });
    return {
      kind: generateKind,
      eventId: event._id,
      roundId: round._id,
      roundExportId: exportRecord._id,
      closeSnapshotId: snapshot._id,
      requestedAt: exportRecord.requestedAt,
      metadataJson,
    };
  },
});

type CsvRow = string[];

async function teamExportContext(
  ctx: QueryCtx,
  entry: Doc<"roundCloseEntries">,
  round: Doc<"reviewRounds">,
  rubric: Doc<"reviewRubricVersions">,
  criteria: Doc<"reviewRubricCriteria">[],
) {
  const team = await ctx.db.get(entry.teamId);
  if (!team || team.eventId !== entry.eventId) {
    throw new Error("A close entry references an invalid team.");
  }
  const [application, session] = await Promise.all([
    ctx.db
      .query("applications")
      .withIndex("by_team", (index) => index.eq("teamId", team._id))
      .unique(),
    entry.payload.kind === "withdrawn" ? null : ctx.db.get(entry.payload.reviewSessionId),
  ]);
  const projectVersionId =
    entry.payload.kind === "withdrawn"
      ? team.lockedProjectVersionId
      : session?.projectVersionId;
  const projectVersion = projectVersionId ? await ctx.db.get(projectVersionId) : null;
  if (
    projectVersion &&
    (projectVersion.eventId !== entry.eventId || projectVersion.teamId !== team._id)
  ) {
    throw new Error("A close entry references an invalid submitted project version.",
    );
  }
  const teamSnapshot = {
    id: team._id,
    name: team.name,
    status: team.status,
    version: team.version,
    lockedProjectVersionId: team.lockedProjectVersionId,
    application: application
      ? {
          id: application._id,
          state: application.state,
          experienceBand: application.experienceBand,
          humanDecision: application.humanDecision,
          admissionPolicyVersionId: application.admissionPolicyVersionId,
          contentVersion: application.contentVersion,
          version: application.version,
        }
      : null,
    projectVersion,
  };
  if (entry.payload.kind === "withdrawn") {
    return {
      json: JSON.stringify({
        disposition: "withdrawn",
        team: teamSnapshot,
      }),
      csvRows: [
        roundExportCsvRow({
          roundReference: String(round._id),
          roundName: round.name,
          teamReference: String(team._id),
          teamName: team.name,
          teamState: "withdrawn",
          applicationState: application?.state ?? "",
          reviewReference: "",
          reviewState: "",
          panelReference: "",
          panelName: "",
          reviewerReference: "",
          reviewerName: "",
          scorecardReference: "",
          scorecardVersionReference: "",
          scorecardVersion: "",
          submissionSource: "",
          submittedAt: "",
          criterionKey: "",
          criterionLabel: "",
          criterionWeight: "",
          rating: "",
          evidenceNote: "",
          privateNote: "",
          finalComment: "",
          evaluationScoreCount: "",
          evaluationMean: "",
          evaluationWeightedPoints: "",
          spreadFlag: "",
          totalPoints: "",
          sharedFindings: "",
          sharedCommitments: "",
          disposition: "withdrawn",
        }),
      ],
      counts: {
        team: 1,
        result: 0,
        excluded: 0,
        withdrawn: 1,
        reviewSession: 0,
        scorecard: 0,
        scorecardVersion: 0,
        correctionCase: 0,
        manualReviewRecord: 0,
      },
    };
  }
  if (!session || session.roundId !== round._id || session.teamId !== team._id) {
    throw new Error("A close entry references an invalid review session.");
  }
  const [panel, evidence, assignments, scorecards, versions, cases, manualRecords, evaluation,
  ] =
    await Promise.all([
      ctx.db.get(session.panelId),
      ctx.db.get(session.evidenceCheckpointSetId),
      ctx.db
        .query("reviewAssignments")
        .withIndex("by_session_person", (index) => index.eq("reviewSessionId", session._id),
      )
        .collect(),
      ctx.db
        .query("scorecards")
        .withIndex("by_session_status", (index) => index.eq("reviewSessionId", session._id),
      )
        .collect(),
      ctx.db
        .query("scorecardVersions")
        .withIndex("by_session_reviewer", (index) => index.eq("reviewSessionId", session._id),
      )
        .collect(),
      ctx.db
        .query("scorecardCorrectionCases")
        .withIndex("by_session_kind", (index) => index.eq("reviewSessionId", session._id),
      )
        .collect(),
      ctx.db
        .query("manualReviewRecords")
        .withIndex("by_review_status_created", (index) => index.eq("reviewSessionId", session._id),
      )
        .collect(),
      ctx.db
        .query("reviewEvaluations")
        .withIndex("by_session", (index) => index.eq("reviewSessionId", session._id),
      )
        .unique(),
    ]);
  if (
    !panel ||
    !evidence ||
    !evaluation ||
    session.rubricVersionId !== rubric._id ||
    session.projectVersionId !== projectVersion?._id ||
    panel.roundId !== round._id ||
    evidence.roundId !== round._id ||
    evidence.teamId !== team._id ||
    evidence.projectVersionId !== session.projectVersionId ||
    evaluation.roundId !== round._id ||
    evaluation.reviewSessionId !== session._id ||
    evaluation.teamId !== team._id ||
    evaluation.rubricVersionId !== rubric._id
  ) {
    throw new Error("A close entry's review context no longer resolves.");
  }
  const teamCheckpointSubmission = evidence.teamCheckpointSubmissionId
    ? await ctx.db.get(evidence.teamCheckpointSubmissionId)
    : null;
  if (
    teamCheckpointSubmission &&
    (teamCheckpointSubmission.eventId !== round.eventId ||
      teamCheckpointSubmission.teamId !== team._id)
  ) {
    throw new Error("A close entry's team checkpoint does not match its review evidence.",
    );
  }
  const reviewerIds = Array.from(
    new Set(assignments.map((assignment) => assignment.reviewerPersonId)),
  );
  const reviewers = await Promise.all(
    reviewerIds.map(async (reviewerPersonId) => {
      const reviewer = await ctx.db.get(reviewerPersonId);
      if (!reviewer) throw new Error("A review assignment references a missing reviewer.");
      return { id: reviewer._id, name: reviewer.displayName };
    }),
  );
  const activeVersions = scorecards.flatMap((scorecard) => {
    if (scorecard.status !== "submitted" || !scorecard.submittedVersionId) return [];
    const version = versions.find((candidate) => candidate._id === scorecard.submittedVersionId,
    );
    if (!version || version.scorecardId !== scorecard._id) {
      throw new Error("A submitted scorecard's immutable version is missing.");
    }
    return [{ scorecard, version }];
  });
  const assigned = assignments.filter((assignment) => assignment.status === "assigned",
  );
  const assignedIds = new Set(assigned.map((assignment) => assignment._id));
  const assignedReviewerIds = new Set(assigned.map((assignment) => assignment.reviewerPersonId),
  );
  const activeReviewerIds = new Set(activeVersions.map(({ version }) => version.reviewerPersonId),
  );
  const csvRows: CsvRow[] = [];
  if (entry.payload.kind === "result") {
    if (
      assigned.length !== round.requiredPanelSize ||
      scorecards.length !== assigned.length ||
      activeVersions.length !== assigned.length ||
      assignedReviewerIds.size !== assigned.length ||
      activeReviewerIds.size !== assigned.length ||
      activeVersions.some(
        ({ scorecard, version }) =>
          !assignedIds.has(scorecard.assignmentId) ||
          !assignedReviewerIds.has(version.reviewerPersonId) ||
          scorecard.reviewerPersonId !== version.reviewerPersonId ||
          version.reviewSessionId !== session._id ||
          version.rubricVersionId !== rubric._id,
      )
    ) {
      throw new ConvexError({
        code: "ROUND_EXPORT_SCORECARD_MISMATCH",
        message: "The exported review no longer has one submitted scorecard per assigned reviewer.",
      });
    }
    if (
      evaluation._id !== entry.payload.evaluationId ||
      evaluation.state !== "complete" ||
      evaluation.inputChecksum !== entry.payload.evaluationInputChecksum
    ) {
      throw new Error("The result evaluation no longer matches the close snapshot.",
      );
    }
    const recomputedInputChecksum = operationFingerprint([
      session._id,
      round.configurationChecksum,
      rubric.checksum,
      JSON.stringify(
        activeVersions.map(({ version }) => ({
          id: version._id,
          checksum: version.checksum,
        })),
      ),
    ]);
    if (recomputedInputChecksum !== evaluation.inputChecksum) {
      throw new ConvexError({
        code: "ROUND_EXPORT_INPUT_MISMATCH",
        message: "The exported result no longer matches its immutable scorecard inputs.",
      });
    }
    for (const { version } of activeVersions) {
      const seenCriteria = new Set<Id<"reviewRubricCriteria">>();
      for (const rating of version.ratings) {
        if (
          seenCriteria.has(rating.criterionId) ||
          !criteria.some((criterion) => criterion._id === rating.criterionId) ||
          !Number.isInteger(rating.score) ||
          rating.score < rubric.scoreMinimum ||
          rating.score > rubric.scoreMaximum
        ) {
          throw new ConvexError({
            code: "ROUND_EXPORT_RATING_INVALID",
            message: "An exported scorecard contains an invalid or duplicate rating.",
          });
        }
        seenCriteria.add(rating.criterionId);
      }
    }
    const recomputed = criteria.map((criterion) => {
      const ratings = activeVersions.flatMap(({ version }) =>
        version.ratings
          .filter((rating) => rating.criterionId === criterion._id)
          .map((rating) => ({
            scorecardVersionId: version._id,
            score: rating.score,
          })),
      );
      if (ratings.length < round.minimumScorersPerCriterion) {
        throw new ConvexError({
          code: "ROUND_EXPORT_COVERAGE_MISMATCH",
          message: `${criterion.label} no longer has its required score coverage.`,
        });
      }
      const scoreSum = ratings.reduce((total, rating) => total + rating.score, 0,
      );
      const meanScore = scoreSum / ratings.length;
      const scores = ratings.map((rating) => rating.score);
      return {
        criterionId: criterion._id,
        inputScorecardVersionIds: ratings.map((rating) => rating.scorecardVersionId,
        ),
        scoreCount: ratings.length,
        scoreSum,
        meanScore,
        weightedPoints: (meanScore / rubric.scoreMaximum) * criterion.weight,
        spreadFlag: Math.max(...scores) - Math.min(...scores) >= rubric.spreadThreshold,
      };
    });
    const totalPoints = recomputed.reduce(
      (total, criterion) => total + criterion.weightedPoints,
      0,
    );
    for (const expected of entry.payload.criterionResults) {
      const actual = recomputed.find((candidate) => candidate.criterionId === expected.criterionId,
      );
      const saved = evaluation.criterionResults.find(
        (candidate) => candidate.criterionId === expected.criterionId,
      );
      if (
        !actual ||
        !saved ||
        JSON.stringify(actual.inputScorecardVersionIds) !==
          JSON.stringify(saved.inputScorecardVersionIds) ||
        actual.scoreCount !== expected.scoreCount ||
        actual.scoreCount !== saved.scoreCount ||
        actual.scoreSum !== expected.scoreSum ||
        actual.scoreSum !== saved.scoreSum ||
        !sameNumber(actual.meanScore, expected.meanScore) ||
        !sameNumber(actual.meanScore, saved.meanScore) ||
        !sameNumber(actual.weightedPoints, expected.weightedPoints) ||
        !sameNumber(actual.weightedPoints, saved.weightedPoints) ||
        actual.spreadFlag !== expected.spreadFlag ||
        actual.spreadFlag !== saved.spreadFlag
      ) {
        throw new ConvexError({
          code: "ROUND_EXPORT_RESULT_MISMATCH",
          message: "A saved round result no longer reproduces from its raw scorecards.",
        });
      }
    }
    if (
      recomputed.length !== entry.payload.criterionResults.length ||
      !sameNumber(totalPoints, entry.payload.totalPoints) ||
      !sameNumber(totalPoints, evaluation.totalPoints)
    ) {
      throw new ConvexError({
        code: "ROUND_EXPORT_TOTAL_MISMATCH",
        message: "A saved round total no longer reproduces from its raw scorecards.",
      });
    }
    for (const { scorecard, version } of activeVersions) {
      const reviewer = reviewers.find((candidate) => candidate.id === version.reviewerPersonId,
      );
      if (!reviewer) throw new Error("A submitted scorecard reviewer no longer resolves.");
      for (const rating of version.ratings) {
        const criterion = criteria.find((candidate) => candidate._id === rating.criterionId,
        );
        const criterionResult = entry.payload.criterionResults.find(
          (candidate) => candidate.criterionId === rating.criterionId,
        );
        if (!criterion || !criterionResult) {
          throw new Error("A scorecard rating references an invalid rubric criterion.",
          );
        }
        csvRows.push(
          roundExportCsvRow({
            roundReference: String(round._id),
            roundName: round.name,
            teamReference: String(team._id),
            teamName: team.name,
            teamState: "completed",
            applicationState: application?.state ?? "",
            reviewReference: String(session._id),
            reviewState: session.status,
            panelReference: String(panel._id),
            panelName: panel.name,
            reviewerReference: String(reviewer.id),
            reviewerName: reviewer.name,
            scorecardReference: String(scorecard._id),
            scorecardVersionReference: String(version._id),
            scorecardVersion: String(version.version),
            submissionSource: version.manualReviewRecordId ? "paper_import" : "digital",
            submittedAt: isoTime(version.submittedAt),
            criterionKey: criterion.stableKey,
            criterionLabel: criterion.label,
            criterionWeight: String(criterion.weight),
            rating: String(rating.score),
            evidenceNote: rating.evidenceNote ?? "",
            privateNote: version.privateNote ?? "",
            finalComment: version.finalComment ?? "",
            evaluationScoreCount: String(criterionResult.scoreCount),
            evaluationMean: String(criterionResult.meanScore),
            evaluationWeightedPoints: String(criterionResult.weightedPoints),
            spreadFlag: criterionResult.spreadFlag ? "yes" : "no",
            totalPoints: String(entry.payload.totalPoints),
            sharedFindings: session.sharedFindings ?? "",
            sharedCommitments: session.sharedCommitments ?? "",
            disposition: "result",
          }),
        );
      }
    }
  } else {
    const correctionCaseId = entry.payload.correctionCaseId;
    const exclusionCase = cases.find((candidate) => candidate._id === correctionCaseId,
    );
    if (
      evaluation.state !== "void" ||
      !exclusionCase ||
      exclusionCase.kind !== "void" ||
      exclusionCase.state !== "closed" ||
      exclusionCase.voidDisposition !== "exclude" ||
      exclusionCase.category !== entry.payload.category
    ) {
      throw new Error("The excluded review no longer matches its approved void record.",
      );
    }
    csvRows.push(
      roundExportCsvRow({
        roundReference: String(round._id),
        roundName: round.name,
        teamReference: String(team._id),
        teamName: team.name,
        teamState: "completed",
        applicationState: application?.state ?? "",
        reviewReference: String(session._id),
        reviewState: session.status,
        panelReference: String(panel._id),
        panelName: panel.name,
        reviewerReference: "",
        reviewerName: "",
        scorecardReference: "",
        scorecardVersionReference: "",
        scorecardVersion: "",
        submissionSource: "",
        submittedAt: "",
        criterionKey: "",
        criterionLabel: "",
        criterionWeight: "",
        rating: "",
        evidenceNote: "",
        privateNote: "",
        finalComment: "",
        evaluationScoreCount: "",
        evaluationMean: "",
        evaluationWeightedPoints: "",
        spreadFlag: "",
        totalPoints: "",
        sharedFindings: session.sharedFindings ?? "",
        sharedCommitments: session.sharedCommitments ?? "",
        disposition: `excluded:${entry.payload.category}`,
      }),
    );
  }
  return {
    json: JSON.stringify({
      disposition:
        entry.payload.kind === "result" ? "result" : `excluded:${entry.payload.category}`,
      team: teamSnapshot,
      review: {
        session,
        panel: {
          id: panel._id,
          stableKey: panel.stableKey,
          name: panel.name,
          version: panel.version,
        },
        evidenceCheckpointSet: evidence,
        teamCheckpointSubmission,
        reviewers,
        assignments,
        scorecards,
        scorecardVersions: versions,
        evaluation,
        correctionCases: cases,
        manualReviewRecords: manualRecords,
      },
      closeEntry: entry.payload,
    }),
    csvRows,
    counts: {
      team: 1,
      result: entry.payload.kind === "result" ? 1 : 0,
      excluded: entry.payload.kind === "excluded" ? 1 : 0,
      withdrawn: 0,
      reviewSession: 1,
      scorecard: scorecards.length,
      scorecardVersion: versions.length,
      correctionCase: cases.length,
      manualReviewRecord: manualRecords.length,
    },
  };
}

export const exportPage = internalQuery({
  args: {
    roundExportId: v.id("roundExports"),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    continueCursor: v.string(),
    isDone: v.boolean(),
    jsonEntries: v.array(v.string()),
    csvRows: v.array(v.array(v.string())),
    counts: exportCounts,
  }),
  handler: async (ctx, args) => {
    const exportRecord = await ctx.db.get(args.roundExportId);
    if (!exportRecord || exportRecord.state !== "generating") {
      throw new ConvexError({
        code: "ROUND_EXPORT_NOT_GENERATING",
        message: "This round export is no longer generating.",
      });
    }
    const snapshot = await ctx.db.get(exportRecord.closeSnapshotId);
    if (!snapshot) throw new Error("The round close snapshot no longer resolves.");
    const [round, rubric] = await Promise.all([
      ctx.db.get(exportRecord.roundId),
      ctx.db.get(snapshot.rubricVersionId),
    ]);
    if (!round || !rubric || rubric._id !== round.rubricVersionId) {
      throw new Error("The round export rubric no longer resolves.");
    }
    const criteria = await ctx.db
      .query("reviewRubricCriteria")
      .withIndex("by_rubric_order", (index) => index.eq("rubricVersionId", rubric._id),
      )
      .collect();
    const page = await ctx.db
      .query("roundCloseEntries")
      .withIndex("by_snapshot_team", (index) =>
        index.eq("closeSnapshotId", exportRecord.closeSnapshotId),
      )
      .paginate(args.paginationOpts);
    const rows = [];
    for (const entry of page.page) {
      rows.push(await teamExportContext(ctx, entry, round, rubric, criteria));
    }
    const counts = rows.reduce(
      (total, row) => ({
        team: total.team + row.counts.team,
        result: total.result + row.counts.result,
        excluded: total.excluded + row.counts.excluded,
        withdrawn: total.withdrawn + row.counts.withdrawn,
        reviewSession: total.reviewSession + row.counts.reviewSession,
        scorecard: total.scorecard + row.counts.scorecard,
        scorecardVersion: total.scorecardVersion + row.counts.scorecardVersion,
        correctionCase: total.correctionCase + row.counts.correctionCase,
        manualReviewRecord: total.manualReviewRecord + row.counts.manualReviewRecord,
      }),
      {
        team: 0,
        result: 0,
        excluded: 0,
        withdrawn: 0,
        reviewSession: 0,
        scorecard: 0,
        scorecardVersion: 0,
        correctionCase: 0,
        manualReviewRecord: 0,
      },
    );
    return {
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      jsonEntries: rows.map((row) => row.json),
      csvRows: rows.flatMap((row) => row.csvRows),
      counts,
    };
  },
});

export const completeGeneration = internalMutation({
  args: {
    roundExportId: v.id("roundExports"),
    files: storedFiles,
    counts: exportCounts,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const exportRecord = await ctx.db.get(args.roundExportId);
    if (!exportRecord) throw new Error("Round export no longer resolves.");
    if (exportRecord.state === "uploaded") {
      if (
        !exportRecord.files ||
        exportRecord.files.json.objectVersionId !== args.files.json.objectVersionId ||
        exportRecord.files.csv.objectVersionId !== args.files.csv.objectVersionId ||
        exportRecord.files.json.sha256 !== args.files.json.sha256 ||
        exportRecord.files.csv.sha256 !== args.files.csv.sha256
      ) {
        throw new Error("Repeated round export completion does not match the stored files.",
        );
      }
      return null;
    }
    if (exportRecord.state !== "generating") return null;
    const round = await ctx.db.get(exportRecord.roundId);
    if (
      !round ||
      round.status !== "closing" ||
      round.version !== exportRecord.closingRoundVersion ||
      round.activeRoundExportId !== exportRecord._id
    ) {
      throw new ConvexError({
        code: "ROUND_EXPORT_CONTEXT_CHANGED",
        message: "The closing round changed before export upload completed.",
      });
    }
    if (JSON.stringify(args.counts) !== JSON.stringify(exportRecord.counts)) {
      throw new ConvexError({
        code: "ROUND_EXPORT_COUNT_MISMATCH",
        message: "The generated export counts do not match the frozen closing snapshot.",
      });
    }
    const now = Date.now();
    await ctx.db.patch(exportRecord._id, {
      state: "uploaded",
      files: args.files,
      checksum: operationFingerprint([
        exportRecord.checksum,
        args.files.json.sha256,
        args.files.csv.sha256,
        JSON.stringify(args.counts),
      ]),
      uploadedAt: now,
      failedAt: undefined,
      failureCode: undefined,
      version: exportRecord.version + 1,
      updatedAt: now,
    });
    await appendRoundExportJobReadFactById(ctx, exportRecord._id, now);
    return null;
  },
});

export const retry = mutation({
  args: {
    eventSlug: v.string(),
    roundExportId: v.id("roundExports"),
    expectedExportVersion: v.number(),
    expectedRoundVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ exportVersion: v.number(), state: activeExportState }),
  handler: async (ctx, args,
  ): Promise<{ exportVersion: number; state: ActiveExportState }> => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Retry reason", 5, 500);
    const requestFingerprint = operationFingerprint([
      args.roundExportId,
      args.expectedExportVersion,
      args.expectedRoundVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.round_export.retry",
      requestFingerprint,
    });
    if (prior) {
      const roundExportId = ctx.db.normalizeId("roundExports", prior.targetId);
      if (!roundExportId) throw new Error("The stored round-export retry is invalid.");
      return storedOperationResult(
        prior.resultJson,
        "round-export retry",
        roundExportRetryOperationResult,
      );
    }
    const exportRecord = await ctx.db.get(args.roundExportId);
    if (!exportRecord || exportRecord.eventId !== event._id) {
      throw new ConvexError({
        code: "ROUND_EXPORT_NOT_FOUND",
        message: "That round export is unavailable.",
      });
    }
    const round = await requireRound(ctx, event._id, exportRecord.roundId);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "round.export.retry",
      scopeType: "round",
      scopeId: round._id,
    });
    if (
      exportRecord.state !== "failed" ||
      exportRecord.version !== args.expectedExportVersion ||
      round.status !== "closing" ||
      round.version !== args.expectedRoundVersion ||
      round.activeRoundExportId !== exportRecord._id
    ) {
      throw new ConvexError({
        code: "ROUND_EXPORT_CHANGED",
        message: "The failed export or closing round changed. Review it before retrying.",
      });
    }
    const now = Date.now();
    const nextVersion = exportRecord.version + 1;
    await ctx.db.patch(exportRecord._id, {
      state: "generating",
      failedAt: undefined,
      failureCode: undefined,
      version: nextVersion,
      updatedAt: now,
    });
    await appendRoundExportJobReadFactById(ctx, exportRecord._id, now);
    const workId = await exportWorkpool.enqueueAction(
      ctx,
      internal.roundExportActions.generate,
      { roundExportId: exportRecord._id },
      {
        retry: true,
        onComplete: internal.roundExports.generationFinished,
        context: exportRecord._id,
      },
    );
    await ctx.db.patch(exportRecord._id, { workId });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.round_export.retry",
      requestFingerprint,
      targetType: "round_export",
      targetId: exportRecord._id,
      resultJson: JSON.stringify({ exportVersion: nextVersion, state: "generating",
      }),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "round.export.retry",
      grantIds,
      scopeType: "round",
      scopeId: round._id,
      action: "review.round_export_retried",
      targetType: "round_export",
      targetId: exportRecord._id,
      previousSummary: JSON.stringify({
        state: exportRecord.state,
        failureCode: exportRecord.failureCode,
        version: exportRecord.version,
      }),
      nextSummary: JSON.stringify({ state: "generating", version: nextVersion,
      }),
      reason,
    });
    return { exportVersion: nextVersion, state: "generating" };
  },
});

export const downloadContext = internalQuery({
  args: {
    eventSlug: v.string(),
    roundExportId: v.id("roundExports"),
    kind: v.union(v.literal("json"), v.literal("csv")),
  },
  returns: v.object({
    files: storedFiles,
    kind: v.union(v.literal("json"), v.literal("csv")),
    version: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const exportRecord = await ctx.db.get(args.roundExportId);
    if (!exportRecord || exportRecord.eventId !== event._id) {
      throw new ConvexError({
        code: "ROUND_EXPORT_NOT_FOUND",
        message: "That round export is unavailable.",
      });
    }
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "round.export.read",
      scopeType: "round",
      scopeId: exportRecord.roundId,
    });
    if (!exportRecord.files || !["uploaded", "verified"].includes(exportRecord.state)) {
      throw new ConvexError({
        code: "ROUND_EXPORT_NOT_AVAILABLE",
        message: "This round export is not ready to download.",
      });
    }
    return { files: exportRecord.files, kind: args.kind, version: exportRecord.version,
    };
  },
});

export const recordDownload = internalMutation({
  args: {
    eventSlug: v.string(),
    roundExportId: v.id("roundExports"),
    kind: v.union(v.literal("json"), v.literal("csv")),
    expectedVersion: v.number(),
    expectedStorageRegion: v.string(),
    expectedStorageBucket: v.string(),
    expectedFile: storedFile,
    signedUrlExpiresAt: v.number(),
  },
  returns: v.object({ serverNow: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const exportRecord = await ctx.db.get(args.roundExportId);
    if (!exportRecord || exportRecord.eventId !== event._id || !exportRecord.files) {
      throw new ConvexError({
        code: "ROUND_EXPORT_NOT_FOUND",
        message: "That round export is unavailable.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "round.export.read",
      scopeType: "round",
      scopeId: exportRecord.roundId,
    });
    if (!["uploaded", "verified"].includes(exportRecord.state)) {
      throw new ConvexError({
        code: "ROUND_EXPORT_NOT_AVAILABLE",
        message: "This round export is not ready to download.",
      });
    }
    const file = exportRecord.files[args.kind];
    if (
      exportRecord.version !== args.expectedVersion ||
      exportRecord.files.storageRegion !== args.expectedStorageRegion ||
      exportRecord.files.storageBucket !== args.expectedStorageBucket ||
      file.objectKey !== args.expectedFile.objectKey ||
      file.objectVersionId !== args.expectedFile.objectVersionId ||
      file.byteCount !== args.expectedFile.byteCount ||
      file.sha256 !== args.expectedFile.sha256
    ) {
      throw new ConvexError({
        code: "ROUND_EXPORT_CHANGED",
        message: "This round export changed while the download was prepared. Try again.",
      });
    }
    const serverNow = Date.now();
    if (
      !Number.isSafeInteger(args.signedUrlExpiresAt) ||
      args.signedUrlExpiresAt <= serverNow ||
      args.signedUrlExpiresAt > serverNow + 60_000
    ) {
      throw new ConvexError({
        code: "ROUND_EXPORT_LINK_EXPIRED",
        message: "The round export link expired while it was prepared. Try again.",
      });
    }
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "round.export.read",
      grantIds,
      scopeType: "round",
      scopeId: exportRecord.roundId,
      action: "review.round_export_downloaded",
      targetType: "round_export",
      targetId: exportRecord._id,
      nextSummary: JSON.stringify({
        kind: args.kind,
        sha256: file.sha256,
        signedUrlExpiresAt: args.signedUrlExpiresAt,
      }),
      reason: "Protected round export download",
    });
    return { serverNow };
  },
});

function verificationFingerprint(args: {
  roundExportId: Id<"roundExports">;
  expectedExportVersion: number;
  expectedRoundVersion: number;
  filesOpened: boolean;
  countsMatch: boolean;
  reason: string;
}) {
  return operationFingerprint([
    args.roundExportId,
    args.expectedExportVersion,
    args.expectedRoundVersion,
    args.filesOpened,
    args.countsMatch,
    args.reason,
  ]);
}

export const verificationContext = internalQuery({
  args: {
    eventSlug: v.string(),
    roundExportId: v.id("roundExports"),
    expectedExportVersion: v.number(),
    expectedRoundVersion: v.number(),
    filesOpened: v.boolean(),
    countsMatch: v.boolean(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.union(
    v.object({
      kind: v.literal("already_verified"),
      roundId: v.id("reviewRounds"),
      closedAt: v.number(),
    }),
    v.object({ kind: v.literal("verify"), files: storedFiles }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Verification reason", 5, 500);
    const requestFingerprint = verificationFingerprint({ ...args, reason });
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.round_export.verify",
      requestFingerprint,
    });
    if (prior) {
      const result = storedOperationResult(
        prior.resultJson,
        "round-export verification",
        roundExportVerificationOperationResult,
      );
      const roundId = ctx.db.normalizeId("reviewRounds", result.roundId);
      if (!roundId) throw new Error("The stored round-export verification is invalid.");
      return { kind: alreadyVerifiedKind, roundId, closedAt: result.closedAt };
    }
    const exportRecord = await ctx.db.get(args.roundExportId);
    if (!exportRecord || exportRecord.eventId !== event._id) {
      throw new ConvexError({
        code: "ROUND_EXPORT_NOT_FOUND",
        message: "That round export is unavailable.",
      });
    }
    await Promise.all([
      requirePermission(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "round.export.verify",
        scopeType: "round",
        scopeId: exportRecord.roundId,
      }),
      requirePermission(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "round.export.read",
        scopeType: "round",
        scopeId: exportRecord.roundId,
      }),
    ]);
    const round = await requireRound(ctx, event._id, exportRecord.roundId);
    if (!args.filesOpened || !args.countsMatch) {
      throw new ConvexError({
        code: "ROUND_EXPORT_ATTESTATION_REQUIRED",
        message: "Open both files and confirm every displayed count before verification.",
      });
    }
    if (exportRecord.requestedByPersonId === person._id) {
      throw new ConvexError({
        code: "SECOND_VERIFIER_REQUIRED",
        message: "A different person must verify the round export.",
      });
    }
    if (
      exportRecord.state !== "uploaded" ||
      !exportRecord.files ||
      exportRecord.version !== args.expectedExportVersion ||
      round.status !== "closing" ||
      round.version !== args.expectedRoundVersion ||
      round.activeRoundExportId !== exportRecord._id
    ) {
      throw new ConvexError({
        code: "ROUND_EXPORT_CHANGED",
        message: "The export or closing round changed. Open the current files before verifying.",
      });
    }
    return { kind: verifyKind, files: exportRecord.files };
  },
});

export const completeVerification = internalMutation({
  args: {
    eventSlug: v.string(),
    roundExportId: v.id("roundExports"),
    expectedExportVersion: v.number(),
    expectedRoundVersion: v.number(),
    filesOpened: v.boolean(),
    countsMatch: v.boolean(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ roundId: v.id("reviewRounds"), closedAt: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Verification reason", 5, 500);
    const requestFingerprint = verificationFingerprint({ ...args, reason });
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.round_export.verify",
      requestFingerprint,
    });
    if (prior) {
      const result = storedOperationResult(
        prior.resultJson,
        "round-export verification",
        roundExportVerificationOperationResult,
      );
      const roundId = ctx.db.normalizeId("reviewRounds", result.roundId);
      if (!roundId) throw new Error("The stored round-export verification is invalid.");
      return { roundId, closedAt: result.closedAt };
    }
    const exportRecord = await ctx.db.get(args.roundExportId);
    if (!exportRecord || exportRecord.eventId !== event._id) {
      throw new ConvexError({
        code: "ROUND_EXPORT_NOT_FOUND",
        message: "That round export is unavailable.",
      });
    }
    const [verifyGrantIds, readGrantIds] = await Promise.all([
      requirePermission(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "round.export.verify",
        scopeType: "round",
        scopeId: exportRecord.roundId,
      }),
      requirePermission(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "round.export.read",
        scopeType: "round",
        scopeId: exportRecord.roundId,
      }),
    ]);
    const round = await requireRound(ctx, event._id, exportRecord.roundId);
    if (
      !args.filesOpened ||
      !args.countsMatch ||
      exportRecord.requestedByPersonId === person._id ||
      exportRecord.state !== "uploaded" ||
      !exportRecord.files ||
      exportRecord.version !== args.expectedExportVersion ||
      round.status !== "closing" ||
      round.version !== args.expectedRoundVersion ||
      round.activeRoundExportId !== exportRecord._id ||
      round.activeCloseSnapshotId !== exportRecord.closeSnapshotId
    ) {
      throw new ConvexError({
        code: "ROUND_EXPORT_CHANGED",
        message: "The export or closing round changed before verification completed.",
      });
    }
    const now = Date.now();
    await Promise.all([
      ctx.db.patch(exportRecord._id, {
        state: "verified",
        verifiedByPersonId: person._id,
        verifiedAt: now,
        verificationReason: reason,
        version: exportRecord.version + 1,
        updatedAt: now,
      }),
      ctx.db.patch(round._id, {
        status: "closed",
        closedAt: now,
        closedByPersonId: person._id,
        version: round.version + 1,
      }),
    ]);
    await appendRoundExportJobReadFactById(ctx, exportRecord._id, now);
    const result = { roundId: round._id, closedAt: now };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.round_export.verify",
      requestFingerprint,
      targetType: "round_export",
      targetId: exportRecord._id,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "round.export.verify",
      grantIds: [...verifyGrantIds, ...readGrantIds],
      scopeType: "round",
      scopeId: round._id,
      action: "review.round_export_verified",
      targetType: "round_export",
      targetId: exportRecord._id,
      previousSummary: JSON.stringify({
        roundStatus: round.status,
        roundVersion: round.version,
        exportState: exportRecord.state,
        exportVersion: exportRecord.version,
      }),
      nextSummary: JSON.stringify({
        roundStatus: "closed",
        roundVersion: round.version + 1,
        exportState: "verified",
        exportVersion: exportRecord.version + 1,
        counts: exportRecord.counts,
        checksum: exportRecord.checksum,
      }),
      reason,
    });
    return result;
  },
});

export const reopen = mutation({
  args: {
    eventSlug: v.string(),
    roundId: v.id("reviewRounds"),
    roundExportId: v.id("roundExports"),
    expectedRoundVersion: v.number(),
    expectedExportVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ roundId: v.id("reviewRounds"), roundVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Reopen reason", 5, 500);
    const requestFingerprint = operationFingerprint([
      args.roundId,
      args.roundExportId,
      args.expectedRoundVersion,
      args.expectedExportVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.round.reopen",
      requestFingerprint,
    });
    if (prior) {
      const roundId = ctx.db.normalizeId("reviewRounds", prior.targetId);
      if (!roundId) throw new Error("The stored round reopen is invalid.");
      return {
        roundId,
        roundVersion: storedOperationVersion(prior.resultJson, "round reopen"),
      };
    }
    const round = await requireRound(ctx, event._id, args.roundId);
    const exportRecord = await ctx.db.get(args.roundExportId);
    if (!exportRecord || exportRecord.roundId !== round._id) {
      throw new ConvexError({
        code: "ROUND_EXPORT_NOT_FOUND",
        message: "That round export is unavailable.",
      });
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "round.reopen",
      scopeType: "round",
      scopeId: round._id,
    });
    const laterRounds = await ctx.db
      .query("reviewRounds")
      .withIndex("by_event_status_start", (index) => index.eq("eventId", event._id))
      .collect();
    if (
      laterRounds.some(
        (candidate) => candidate.sequence > round.sequence && candidate.status !== "draft",
      )
    ) {
      throw new ConvexError({
        code: "LATER_ROUND_STARTED",
        message: "A later round has already moved beyond draft. Resolve that dependency first.",
      });
    }
    if (
      round.status !== "closed" ||
      round.version !== args.expectedRoundVersion ||
      round.activeRoundExportId !== exportRecord._id ||
      round.activeCloseSnapshotId !== exportRecord.closeSnapshotId ||
      exportRecord.state !== "verified" ||
      exportRecord.version !== args.expectedExportVersion
    ) {
      throw new ConvexError({
        code: "ROUND_CHANGED",
        message: "The closed round or verified export changed. Review it before reopening.",
      });
    }
    const now = Date.now();
    const nextRoundVersion = round.version + 1;
    await Promise.all([
      ctx.db.patch(exportRecord._id, {
        state: "superseded",
        supersededByPersonId: person._id,
        supersededAt: now,
        supersedeReason: reason,
        version: exportRecord.version + 1,
        updatedAt: now,
      }),
      ctx.db.patch(round._id, {
        status: "open",
        closingAt: undefined,
        closingByPersonId: undefined,
        activeCloseSnapshotId: undefined,
        activeRoundExportId: undefined,
        closedAt: undefined,
        closedByPersonId: undefined,
        version: nextRoundVersion,
      }),
    ]);
    await appendRoundExportJobReadFactById(ctx, exportRecord._id, now);
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.round.reopen",
      requestFingerprint,
      targetType: "review_round",
      targetId: round._id,
      resultJson: String(nextRoundVersion),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "round.reopen",
      grantIds,
      scopeType: "round",
      scopeId: round._id,
      action: "review.round_reopened",
      targetType: "review_round",
      targetId: round._id,
      previousSummary: JSON.stringify({
        status: round.status,
        version: round.version,
        roundExportId: exportRecord._id,
        exportVersion: exportRecord.version,
      }),
      nextSummary: JSON.stringify({
        status: "open",
        version: nextRoundVersion,
        supersededExportVersion: exportRecord.version + 1,
      }),
      reason,
    });
    return { roundId: round._id, roundVersion: nextRoundVersion };
  },
});
