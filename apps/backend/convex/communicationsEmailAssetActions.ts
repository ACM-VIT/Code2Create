import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  participantEmailTemplateKeys,
  participantEmailTemplateZipMaximumBytes,
  type ParticipantEmailTemplateKey,
} from "@code2create/domain";
import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action, httpAction } from "./_generated/server";
import {
  EmailTemplateBundleError,
  readEmailTemplateBundle,
} from "./lib/emailTemplateBundle";

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

const bundleUploadHeaders = {
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json; charset=utf-8",
} as const;

function bundleResponse(payload: BundleResult | { error: string }, status: number) {
  return new Response(JSON.stringify(payload), { status, headers: bundleUploadHeaders });
}

function templateKeyFrom(value: string | null): ParticipantEmailTemplateKey | null {
  return participantEmailTemplateKeys.find((key) => key === value) ?? null;
}

function validClientOperationId(value: string | null): value is string {
  return value !== null && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(value);
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

async function importBundle(
  ctx: ActionCtx,
  args: {
    eventSlug: string;
    templateKey: ParticipantEmailTemplateKey;
    fileName: string;
    clientOperationId: string;
    zipBytes: Uint8Array;
  },
): Promise<BundleResult> {
  const sourceSha256 = bytesToHex(sha256(args.zipBytes));
  const content = await readEmailTemplateBundle(args.zipBytes, args.templateKey);
  const context = await ctx.runQuery(internal.communicationsEmailAssets.uploadContext, {
    eventSlug: args.eventSlug,
    templateKey: args.templateKey,
    sourceFileName: args.fileName,
    sourceByteCount: args.zipBytes.byteLength,
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
      const storageId = await ctx.storage.store(new Blob([bytes], { type: asset.contentType }));
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
      sourceByteCount: args.zipBytes.byteLength,
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
}

export const importBundleEndpoint = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const eventSlug = url.searchParams.get("eventSlug")?.trim() ?? "";
  const templateKey = templateKeyFrom(url.searchParams.get("templateKey"));
  const fileName = url.searchParams.get("fileName")?.trim() ?? "";
  const clientOperationId = url.searchParams.get("clientOperationId");
  if (
    eventSlug.length < 1 ||
    eventSlug.length > 80 ||
    templateKey === null ||
    fileName.length < 1 ||
    fileName.length > 160 ||
    !fileName.toLocaleLowerCase("en").endsWith(".zip") ||
    !validClientOperationId(clientOperationId)
  ) {
    return bundleResponse({ error: "The template ZIP request is invalid." }, 400);
  }

  try {
    await ctx.runQuery(internal.communicationsEmailAssets.authorizeBundleUpload, { eventSlug });
    const declaredLength = Number(request.headers.get("Content-Length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > participantEmailTemplateZipMaximumBytes
    ) {
      return bundleResponse({ error: "Choose a valid ZIP file no larger than 3.5 MB." }, 413);
    }
    const zipBytes = new Uint8Array(await request.arrayBuffer());
    if (
      zipBytes.byteLength < 22 ||
      zipBytes.byteLength > participantEmailTemplateZipMaximumBytes
    ) {
      return bundleResponse({ error: "Choose a valid ZIP file no larger than 3.5 MB." }, 400);
    }
    const result = await importBundle(ctx, {
      eventSlug,
      templateKey,
      fileName,
      clientOperationId,
      zipBytes,
    });
    return bundleResponse(result, 200);
  } catch (error) {
    if (error instanceof EmailTemplateBundleError) {
      return bundleResponse({ error: error.message }, 400);
    }
    if (error instanceof ConvexError) {
      return bundleResponse({ error: error.message }, 403);
    }
    console.error("Email template ZIP import failed", error);
    return bundleResponse({ error: "The template ZIP could not be imported." }, 500);
  }
});

export const importBundleOptions = httpAction(async () => {
  return new Response(null, { status: 204, headers: bundleUploadHeaders });
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
