"use node";

import { createHash } from "node:crypto";

import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action, internalAction } from "./_generated/server";
import { signEmergencyPackDownload, storeEmergencyPack } from "./lib/artifactStorage";
import { buildEmergencyPackHtml, type EmergencyPackSnapshot } from "./lib/emergencyPack";

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

type EmergencyPackGenerationContext =
  | { kind: "skip" }
  | {
      kind: "generate";
      eventId: Id<"events">;
      packId: Id<"emergencyPacks">;
      purpose: string;
      expiresAt: number;
      spareAttendanceSheetCount: number;
      spareReviewSheetCount: number;
      serialPrefix: string;
      snapshot: EmergencyPackSnapshot;
    };

export const generate = internalAction({
  args: { packId: v.id("emergencyPacks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const context: EmergencyPackGenerationContext = await ctx.runQuery(
      internal.emergencyPacks.generationContext,
      args,
    );
    if (context.kind === "skip") return null;
    const snapshotChecksum = digest(JSON.stringify(context.snapshot));
    const built = buildEmergencyPackHtml({
      snapshot: context.snapshot,
      purpose: context.purpose,
      expiresAt: context.expiresAt,
      snapshotChecksum,
      serialPrefix: context.serialPrefix,
      spareAttendanceSheetCount: context.spareAttendanceSheetCount,
      spareReviewSheetCount: context.spareReviewSheetCount,
    });
    const stored = await storeEmergencyPack({
      eventId: context.eventId,
      packId: context.packId,
      html: built.html,
    });
    const teamCodes = new Set(
      context.snapshot.roster.flatMap((row) => (row.teamCode === undefined ? [] : [row.teamCode])),
    );
    const panelCount = context.snapshot.rounds.reduce(
      (count, round) => count + round.panels.length,
      0,
    );
    await ctx.runMutation(internal.emergencyPacks.complete, {
      packId: context.packId,
      snapshotAt: context.snapshot.snapshotAt,
      snapshotChecksum,
      counts: {
        participants: context.snapshot.roster.length,
        teams: teamCodes.size,
        stations: context.snapshot.stations.length,
        sessions: context.snapshot.sessions.length,
        rounds: context.snapshot.rounds.length,
        panels: panelCount,
        attendanceSheets: built.attendanceSheetCount,
        reviewSheets: built.reviewSheetCount,
      },
      objectKey: stored.objectKey,
      objectVersionId: stored.objectVersionId,
      storageRegion: stored.storageRegion,
      storageBucket: stored.storageBucket,
      byteCount: stored.byteCount,
      sha256: stored.sha256,
    });
    return null;
  },
});

export const print = action({
  args: {
    eventSlug: v.string(),
    packId: v.id("emergencyPacks"),
  },
  returns: v.object({
    url: v.string(),
    expiresAt: v.number(),
    sha256: v.string(),
    snapshotChecksum: v.string(),
  }),
  handler: async (
    ctx: ActionCtx,
    args: { eventSlug: string; packId: Id<"emergencyPacks"> },
  ): Promise<{
    url: string;
    expiresAt: number;
    sha256: string;
    snapshotChecksum: string;
  }> => {
    const context = await ctx.runQuery(internal.emergencyPacks.printContext, args);
    const now = Date.now();
    const remainingWholeSeconds = Math.floor((context.packExpiresAt - now) / 1_000) - 1;
    if (remainingWholeSeconds < 1) {
      throw new ConvexError({
        code: "EMERGENCY_PACK_NOT_AVAILABLE",
        message: "This emergency pack is too close to expiry. Prepare a current pack.",
      });
    }
    const expiresInSeconds = Math.min(60, remainingWholeSeconds);
    const expiresAt = now + expiresInSeconds * 1_000;
    const url = await signEmergencyPackDownload({ ...context, expiresInSeconds });
    await ctx.runMutation(internal.emergencyPacks.recordPrint, {
      ...args,
      expectedVersion: context.version,
      expectedSha256: context.sha256,
      expectedSnapshotChecksum: context.snapshotChecksum,
      signedUrlExpiresAt: expiresAt,
    });
    return {
      url,
      expiresAt,
      sha256: context.sha256,
      snapshotChecksum: context.snapshotChecksum,
    };
  },
});
