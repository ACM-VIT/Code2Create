import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ConvexError, v } from "convex/values";
import { unzipSync } from "fflate";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action } from "./_generated/server";
import { participantEmailTemplateKey } from "./values";

const maximumZipBytes = 3_500_000;
const maximumAssetBytes = 3_200_000;
const maximumFiles = 24;

const contentTypes: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  pdf: "application/pdf",
  png: "image/png",
  webp: "image/webp",
};

type ImportedAsset = {
  fileName: string;
  contentType: string;
  contentId: string;
  disposition: "inline" | "attachment";
  bytes: ArrayBuffer;
};

type BundleResult = {
  bundleId: Id<"communicationsEmailAssetBundles">;
  html: string;
  sourceFileName: string;
  assets: ImportedAsset[];
};

function invalidBundle(message: string): never {
  throw new ConvexError({ code: "EMAIL_TEMPLATE_ZIP_INVALID", message });
}

function normalizedEntryPath(value: string) {
  const path = value.replaceAll("\\", "/");
  if (
    path.length > 180 ||
    !/^[\p{L}\p{N}][\p{L}\p{N}._ /-]*$/u.test(path) ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "." || part === ".." || part === "")
  ) {
    invalidBundle("The ZIP contains an unsafe file path.");
  }
  return path;
}

function decodeHtml(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalidBundle("index.html must use UTF-8 text.");
  }
}

function rootPrefix(paths: string[]) {
  if (paths.includes("index.html")) return "";
  const candidates = paths.filter((path) => path.endsWith("/index.html"));
  if (candidates.length !== 1) {
    invalidBundle("The ZIP must contain exactly one index.html at its root or inside one folder.");
  }
  const indexPath = candidates[0];
  if (!indexPath) invalidBundle("The ZIP does not contain index.html.");
  return indexPath.slice(0, -"index.html".length);
}

function bundleContent(
  files: Record<string, Uint8Array>,
): { html: string; assets: Array<Omit<ImportedAsset, "bytes"> & { bytes: Uint8Array }> } {
  const paths = Object.keys(files)
    .filter((path) => !path.endsWith("/") && !path.startsWith("__MACOSX/"))
    .map(normalizedEntryPath);
  if (paths.length < 1 || paths.length > maximumFiles + 1) {
    invalidBundle(`The ZIP must contain index.html and no more than ${maximumFiles} assets.`);
  }
  const prefix = rootPrefix(paths);
  if (prefix && paths.some((path) => !path.startsWith(prefix))) {
    invalidBundle("All files must be inside the same folder as index.html.");
  }
  const indexPath = `${prefix}index.html`;
  const htmlBytes = files[indexPath];
  if (!htmlBytes || htmlBytes.byteLength > 250_000) {
    invalidBundle("index.html must be present and no larger than 250 KB.");
  }
  let totalAssetBytes = 0;
  const assets = paths
    .filter((path) => path !== indexPath)
    .map((path) => {
      const bytes = files[path];
      if (!bytes) invalidBundle(`The ZIP entry ${path} could not be read.`);
      totalAssetBytes += bytes.byteLength;
      const relativePath = path.slice(prefix.length);
      const extension = relativePath.split(".").pop()?.toLocaleLowerCase("en") ?? "";
      const contentType = contentTypes[extension];
      if (!contentType) {
        invalidBundle(`Unsupported asset ${relativePath}. Use PNG, JPEG, GIF, WebP, or PDF files.`);
      }
      const digest = bytesToHex(sha256(bytes));
      return {
        fileName: relativePath,
        contentType,
        contentId: `${digest.slice(0, 24)}@code2create`,
        disposition: contentType.startsWith("image/") ? "inline" as const : "attachment" as const,
        bytes,
      };
    });
  if (totalAssetBytes > maximumAssetBytes) {
    invalidBundle("The uncompressed email assets must total no more than 3.2 MB.");
  }
  const html = decodeHtml(htmlBytes);
  if (
    /<(?:script|iframe|object|embed|form|base|meta)\b/iu.test(html) ||
    /\son[a-z]+\s*=/iu.test(html) ||
    /(?:href|src)\s*=\s*["']?\s*(?:javascript|data\s*:\s*text\/html)/iu.test(html)
  ) {
    invalidBundle("index.html contains executable or unsafe HTML.");
  }
  return { html, assets };
}

async function readStoredBundle(
  ctx: ActionCtx,
  eventSlug: string,
  bundleId: Id<"communicationsEmailAssetBundles">,
  html: string,
): Promise<BundleResult> {
  const context = await ctx.runQuery(internal.communicationsEmailAssets.readContext, {
    eventSlug,
    bundleId,
  });
  const assets: ImportedAsset[] = [];
  for (const asset of context.assets) {
    const blob = await ctx.storage.get(asset.storageId);
    if (!blob || blob.size !== asset.byteCount || blob.type !== asset.contentType) {
      throw new Error("An email asset no longer matches its stored manifest.");
    }
    assets.push({
      fileName: asset.fileName,
      contentType: asset.contentType,
      contentId: asset.contentId,
      disposition: asset.disposition,
      bytes: await blob.arrayBuffer(),
    });
  }
  return { bundleId, html, sourceFileName: context.sourceFileName, assets };
}

export const uploadBundle = action({
  args: {
    eventSlug: v.string(),
    templateKey: participantEmailTemplateKey,
    bytes: v.bytes(),
    fileName: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    bundleId: v.id("communicationsEmailAssetBundles"),
    html: v.string(),
    sourceFileName: v.string(),
    assets: v.array(v.object({
      fileName: v.string(),
      contentType: v.string(),
      contentId: v.string(),
      disposition: v.union(v.literal("inline"), v.literal("attachment")),
      bytes: v.bytes(),
    })),
  }),
  handler: async (ctx, args): Promise<BundleResult> => {
    if (args.bytes.byteLength < 22 || args.bytes.byteLength > maximumZipBytes) {
      invalidBundle("Choose a valid ZIP file no larger than 3.5 MB.");
    }
    const zipBytes = new Uint8Array(args.bytes);
    const sourceSha256 = bytesToHex(sha256(zipBytes));
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(zipBytes);
    } catch {
      invalidBundle("The selected file is not a readable ZIP archive.");
    }
    const content = bundleContent(files);
    const context = await ctx.runQuery(internal.communicationsEmailAssets.uploadContext, {
      eventSlug: args.eventSlug,
      templateKey: args.templateKey,
      sourceFileName: args.fileName,
      sourceByteCount: args.bytes.byteLength,
      sourceSha256,
      clientOperationId: args.clientOperationId,
    });
    if (context.kind === "complete") {
      return await readStoredBundle(ctx, args.eventSlug, context.bundleId, content.html);
    }
    const storedIds: Id<"_storage">[] = [];
    try {
      const storedAssets = [];
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
        sourceByteCount: args.bytes.byteLength,
        sourceSha256,
        assets: storedAssets,
        clientOperationId: args.clientOperationId,
      });
      if (!recorded.attached) {
        for (const storageId of storedIds) await ctx.storage.delete(storageId);
        storedIds.length = 0;
        return await readStoredBundle(
          ctx,
          args.eventSlug,
          recorded.bundleId,
          content.html,
        );
      }
      return {
        bundleId: recorded.bundleId,
        html: content.html,
        sourceFileName: args.fileName,
        assets: content.assets.map((asset) => ({
          fileName: asset.fileName,
          contentType: asset.contentType,
          contentId: asset.contentId,
          disposition: asset.disposition,
          bytes: Uint8Array.from(asset.bytes).buffer,
        })),
      };
    } catch (caught) {
      for (const storageId of storedIds) await ctx.storage.delete(storageId);
      throw caught;
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
    assets: v.array(v.object({
      fileName: v.string(),
      contentType: v.string(),
      contentId: v.string(),
      disposition: v.union(v.literal("inline"), v.literal("attachment")),
      bytes: v.bytes(),
    })),
  }),
  handler: async (ctx, args) => {
    const result = await readStoredBundle(ctx, args.eventSlug, args.bundleId, "");
    return { sourceFileName: result.sourceFileName, assets: result.assets };
  },
});
