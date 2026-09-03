import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { participantEmailTemplateZipMaximumBytes } from "@code2create/domain";
import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action } from "./_generated/server";
import {
  EmailTemplateBundleError,
  readEmailTemplateBundle,
  type ImportedEmailTemplateBundle,
} from "./lib/emailTemplateBundle";
import { participantEmailTemplateKey } from "./values";

type BundleResult = {
  bundleId: Id<"communicationsEmailAssetBundles">;
  html: string;
  sourceFileName: string;
  assetCount: number;
};

type BundlePreview = {
  sourceFileName: string;
  assets: Array<{
    fileName: string;
    disposition: "inline" | "attachment";
    url: string;
  }>;
};

type StoredBundleContext = {
  sourceFileName: string;
  assets: Array<{
    storageId: Id<"_storage">;
    fileName: string;
    contentType: string;
    contentId: string;
    disposition: "inline" | "attachment";
    byteCount: number;
    sha256: string;
  }>;
};

function invalidBundle(message: string): never {
  throw new ConvexError({ code: "EMAIL_TEMPLATE_ZIP_INVALID", message });
}

async function readStoredBundle(
  ctx: ActionCtx,
  eventSlug: string,
  bundleId: Id<"communicationsEmailAssetBundles">,
): Promise<BundlePreview> {
  const context: StoredBundleContext = await ctx.runQuery(
    internal.communicationsEmailAssets.readContext,
    {
      eventSlug,
      bundleId,
    },
  );
  const assets: BundlePreview["assets"] = [];
  for (const asset of context.assets) {
    const blob = await ctx.storage.get(asset.storageId);
    if (!blob || blob.size !== asset.byteCount || blob.type !== asset.contentType) {
      throw new Error("An email asset no longer matches its stored manifest.");
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytesToHex(sha256(bytes)) !== asset.sha256) {
      throw new Error("An email asset no longer matches its stored manifest.");
    }
    const url = await ctx.storage.getUrl(asset.storageId);
    if (!url) throw new Error("An email asset is no longer available.");
    assets.push({
      fileName: asset.fileName,
      disposition: asset.disposition,
      url,
    });
  }
  return { sourceFileName: context.sourceFileName, assets };
}

export const importBundle = action({
  args: {
    eventSlug: v.string(),
    templateKey: participantEmailTemplateKey,
    sourceStorageId: v.id("_storage"),
    fileName: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    bundleId: v.id("communicationsEmailAssetBundles"),
    html: v.string(),
    sourceFileName: v.string(),
    assetCount: v.number(),
  }),
  handler: async (ctx, args): Promise<BundleResult> => {
    await ctx.runQuery(internal.communicationsEmailAssets.authorizeBundleUpload, {
      eventSlug: args.eventSlug,
    });
    const source = await ctx.storage.get(args.sourceStorageId);
    try {
      if (!args.fileName.toLocaleLowerCase("en").endsWith(".zip")) {
        invalidBundle("Choose a .zip template package.");
      }
      if (!source || source.size < 22 || source.size > participantEmailTemplateZipMaximumBytes) {
        invalidBundle("Choose a valid ZIP file no larger than 3.5 MB.");
      }
      const zipBytes = new Uint8Array(await source.arrayBuffer());
      const sourceSha256 = bytesToHex(sha256(zipBytes));
      let content: ImportedEmailTemplateBundle;
      try {
        content = await readEmailTemplateBundle(zipBytes);
      } catch (error) {
        if (error instanceof EmailTemplateBundleError) invalidBundle(error.message);
        throw error;
      }
      const context = await ctx.runQuery(internal.communicationsEmailAssets.uploadContext, {
        eventSlug: args.eventSlug,
        templateKey: args.templateKey,
        sourceFileName: args.fileName,
        sourceByteCount: source.size,
        sourceSha256,
        clientOperationId: args.clientOperationId,
      });
      if (context.kind === "complete") {
        return {
          bundleId: context.bundleId,
          html: content.html,
          sourceFileName: args.fileName,
          assetCount: content.assets.length,
        };
      }
      const storedIds: Id<"_storage">[] = [];
      const storedAssets = [];
      try {
        for (const asset of content.assets) {
          const bytes = Uint8Array.from(asset.bytes);
          const storageId = await ctx.storage.store(
            new Blob([bytes], { type: asset.contentType }),
          );
          storedIds.push(storageId);
          storedAssets.push({
            storageId,
            fileName: asset.fileName,
            contentType: asset.contentType,
            contentId: asset.contentId,
            disposition: asset.disposition,
            byteCount: asset.bytes.byteLength,
            sha256: bytesToHex(sha256(asset.bytes)),
          });
        }
        const recorded = await ctx.runMutation(internal.communicationsEmailAssets.recordBundle, {
          eventSlug: args.eventSlug,
          templateKey: args.templateKey,
          sourceFileName: args.fileName,
          sourceByteCount: source.size,
          sourceSha256,
          assets: storedAssets,
          clientOperationId: args.clientOperationId,
        });
        if (!recorded.attached) {
          for (const storageId of storedIds) await ctx.storage.delete(storageId);
        }
        return {
          bundleId: recorded.bundleId,
          html: content.html,
          sourceFileName: args.fileName,
          assetCount: content.assets.length,
        };
      } catch (error) {
        for (const storageId of storedIds) await ctx.storage.delete(storageId);
        throw error;
      }
    } finally {
      await ctx.storage.delete(args.sourceStorageId);
    }
  },
});

export const readBundle = action({
  args: {
    eventSlug: v.string(),
    bundleId: v.id("communicationsEmailAssetBundles"),
  },
  returns: v.object({
    sourceFileName: v.string(),
    assets: v.array(
      v.object({
        fileName: v.string(),
        disposition: v.union(v.literal("inline"), v.literal("attachment")),
        url: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args): Promise<BundlePreview> => {
    return await readStoredBundle(ctx, args.eventSlug, args.bundleId);
  },
});
