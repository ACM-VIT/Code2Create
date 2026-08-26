"use node";

import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action, internalAction } from "./_generated/server";
import {
  signRoundExportDownload,
  storeRoundExport,
  type StoredRoundExportFiles,
  verifyRoundExport,
} from "./lib/artifactStorage";
import { csvDocument } from "./lib/csv";
import { roundExportCsvHeader } from "./lib/roundExportFormat";
import {
  roundExportPageOptions,
  type RoundExportPageResult,
} from "./lib/roundExportFormat";

type GenerationContext =
  | { kind: "skip" }
  | {
      kind: "generate";
      eventId: Id<"events">;
      roundId: Id<"reviewRounds">;
      roundExportId: Id<"roundExports">;
      closeSnapshotId: Id<"roundCloseSnapshots">;
      requestedAt: number;
      metadataJson: string;
    };

type VerificationContext =
  | { kind: "already_verified"; roundId: Id<"reviewRounds">; closedAt: number }
  | { kind: "verify"; files: StoredRoundExportFiles };

const emptyCounts = () => ({
  team: 0,
  result: 0,
  excluded: 0,
  withdrawn: 0,
  reviewSession: 0,
  scorecard: 0,
  scorecardVersion: 0,
  correctionCase: 0,
  manualReviewRecord: 0,
});

function addCounts(
  left: ReturnType<typeof emptyCounts>,
  right: ReturnType<typeof emptyCounts>,
) {
  return {
    team: left.team + right.team,
    result: left.result + right.result,
    excluded: left.excluded + right.excluded,
    withdrawn: left.withdrawn + right.withdrawn,
    reviewSession: left.reviewSession + right.reviewSession,
    scorecard: left.scorecard + right.scorecard,
    scorecardVersion: left.scorecardVersion + right.scorecardVersion,
    correctionCase: left.correctionCase + right.correctionCase,
    manualReviewRecord: left.manualReviewRecord + right.manualReviewRecord,
  };
}

export const generate = internalAction({
  args: { roundExportId: v.id("roundExports") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const context: GenerationContext = await ctx.runQuery(
      internal.roundExports.generationContext,
      args,
    );
    if (context.kind === "skip") return null;
    const jsonEntries: string[] = [];
    const csvRows: string[][] = [];
    let counts = emptyCounts();
    let cursor: string | null = null;
    while (true) {
      const page: RoundExportPageResult = await ctx.runQuery(
        internal.roundExports.exportPage,
        {
          roundExportId: context.roundExportId,
          paginationOpts: roundExportPageOptions(cursor),
        },
      );
      jsonEntries.push(...page.jsonEntries);
      csvRows.push(...page.csvRows);
      counts = addCounts(counts, page.counts);
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    const json = [
      `{"formatVersion":1,"generatedAt":${JSON.stringify(new Date(context.requestedAt).toISOString())},`,
      `"metadata":${context.metadataJson},"entries":[`,
      jsonEntries.join(","),
      "]}\n",
    ].join("");
    const csv = csvDocument([
      [...roundExportCsvHeader],
      ...csvRows,
    ]);
    const files = await storeRoundExport({
      eventId: context.eventId,
      roundId: context.roundId,
      exportId: context.roundExportId,
      json,
      csv,
    });
    await ctx.runMutation(internal.roundExports.completeGeneration, {
      roundExportId: context.roundExportId,
      files,
      counts,
    });
    return null;
  },
});

export const download = action({
  args: {
    eventSlug: v.string(),
    roundExportId: v.id("roundExports"),
    kind: v.union(v.literal("json"), v.literal("csv")),
  },
  returns: v.object({
    url: v.string(),
    expiresAt: v.number(),
    serverNow: v.number(),
    sha256: v.string(),
  }),
  handler: async (
    ctx: ActionCtx,
    args: {
      eventSlug: string;
      roundExportId: Id<"roundExports">;
      kind: "json" | "csv";
    },
  ): Promise<{ url: string; expiresAt: number; serverNow: number; sha256: string }> => {
    const context: {
      files: StoredRoundExportFiles;
      kind: "json" | "csv";
      version: number;
    } = await ctx.runQuery(internal.roundExports.downloadContext, args);
    const expiresAt = Date.now() + 60_000;
    const url = await signRoundExportDownload(context);
    const access = await ctx.runMutation(internal.roundExports.recordDownload, {
      ...args,
      expectedVersion: context.version,
      expectedStorageRegion: context.files.storageRegion,
      expectedStorageBucket: context.files.storageBucket,
      expectedFile: context.files[context.kind],
      signedUrlExpiresAt: expiresAt,
    });
    return {
      url,
      expiresAt,
      serverNow: access.serverNow,
      sha256: context.files[context.kind].sha256,
    };
  },
});

export const verify = action({
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
  handler: async (
    ctx: ActionCtx,
    args: {
      eventSlug: string;
      roundExportId: Id<"roundExports">;
      expectedExportVersion: number;
      expectedRoundVersion: number;
      filesOpened: boolean;
      countsMatch: boolean;
      reason: string;
      clientOperationId: string;
    },
  ): Promise<{ roundId: Id<"reviewRounds">; closedAt: number }> => {
    const context: VerificationContext = await ctx.runQuery(
      internal.roundExports.verificationContext,
      args,
    );
    if (context.kind === "already_verified") {
      return { roundId: context.roundId, closedAt: context.closedAt };
    }
    try {
      await verifyRoundExport(context.files);
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      throw new ConvexError({
        code: "ROUND_EXPORT_VERIFICATION_FAILED",
        message: "The private round export could not be checksum-verified.",
      });
    }
    return await ctx.runMutation(internal.roundExports.completeVerification, args);
  },
});
