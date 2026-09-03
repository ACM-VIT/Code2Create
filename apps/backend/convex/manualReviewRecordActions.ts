import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action } from "./_generated/server";

const maximumSourceBytes = 900_000;
const sourceContentType = "image/jpeg";

type UploadResult = {
  recordId: Id<"manualReviewRecords">;
  version: number;
};

type SourceResult = {
  bytes: ArrayBuffer;
  contentType: string;
  fileName: string;
  sha256: string;
};

export const uploadSource = action({
  args: {
    eventSlug: v.string(),
    recordId: v.id("manualReviewRecords"),
    expectedRecordVersion: v.number(),
    bytes: v.bytes(),
    fileName: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    recordId: v.id("manualReviewRecords"),
    version: v.number(),
  }),
  handler: async (ctx, args): Promise<UploadResult> => {
    if (args.bytes.byteLength < 4 || args.bytes.byteLength > maximumSourceBytes) {
      throw new ConvexError({
        code: "SOURCE_SIZE_INVALID",
        message: "The compressed source image must be smaller than 900 KB.",
      });
    }
    const bytes = new Uint8Array(args.bytes);
    if (
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes[bytes.length - 2] !== 0xff ||
      bytes[bytes.length - 1] !== 0xd9
    ) {
      throw new ConvexError({
        code: "SOURCE_TYPE_INVALID",
        message: "The paper source must be a valid JPEG image.",
      });
    }
    const sourceSha256 = bytesToHex(sha256(bytes));
    const context = await ctx.runQuery(internal.manualReviewRecords.sourceUploadContext, {
      eventSlug: args.eventSlug,
      recordId: args.recordId,
      expectedRecordVersion: args.expectedRecordVersion,
      fileName: args.fileName,
      sourceSha256,
      sourceByteCount: args.bytes.byteLength,
      clientOperationId: args.clientOperationId,
    });
    if (context.kind === "complete") {
      return { recordId: args.recordId, version: context.version };
    }
    const storageId = await ctx.storage.store(new Blob([args.bytes], { type: sourceContentType }));
    try {
      const attached = await ctx.runMutation(internal.manualReviewRecords.attachSource, {
        eventSlug: args.eventSlug,
        recordId: args.recordId,
        expectedRecordVersion: args.expectedRecordVersion,
        storageId,
        fileName: args.fileName,
        contentType: sourceContentType,
        sourceSha256,
        sourceByteCount: args.bytes.byteLength,
        clientOperationId: args.clientOperationId,
      });
      if (attached.storageId !== storageId) await ctx.storage.delete(storageId);
      return { recordId: attached.id, version: attached.version };
    } catch (caught) {
      await ctx.storage.delete(storageId);
      throw caught;
    }
  },
});

export const readSource = action({
  args: { eventSlug: v.string(), recordId: v.id("manualReviewRecords") },
  returns: v.object({
    bytes: v.bytes(),
    contentType: v.string(),
    fileName: v.string(),
    sha256: v.string(),
  }),
  handler: async (ctx, args): Promise<SourceResult> => {
    const context = await ctx.runQuery(internal.manualReviewRecords.sourceContext, args);
    const blob = await ctx.storage.get(context.storageId);
    if (
      !blob ||
      blob.size !== context.byteCount ||
      blob.size > maximumSourceBytes ||
      blob.type !== context.contentType
    ) {
      throw new ConvexError({
        code: "SOURCE_CHANGED",
        message: "The protected source image no longer matches its manifest.",
      });
    }
    return {
      bytes: await blob.arrayBuffer(),
      contentType: context.contentType,
      fileName: context.fileName,
      sha256: context.sha256,
    };
  },
});
