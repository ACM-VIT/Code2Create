import { ConvexError, v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
} from "./lib/operations";
import { requirePermission } from "./lib/permissions";
import { normalizedText } from "./lib/strings";
import { participantEmailTemplateKey } from "./values";

const assetInput = v.object({
  storageId: v.id("_storage"),
  fileName: v.string(),
  contentType: v.string(),
  contentId: v.string(),
  disposition: v.union(v.literal("inline"), v.literal("attachment")),
  byteCount: v.number(),
  sha256: v.string(),
});

export const uploadContext = internalQuery({
  args: {
    eventSlug: v.string(),
    templateKey: participantEmailTemplateKey,
    sourceFileName: v.string(),
    sourceByteCount: v.number(),
    sourceSha256: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.union(
    v.object({ kind: v.literal("ready") }),
    v.object({
      kind: v.literal("complete"),
      bundleId: v.id("communicationsEmailAssetBundles"),
    }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.communications.draft.create",
      scopeType: "event",
    });
    const requestFingerprint = operationFingerprint([
      args.templateKey,
      args.sourceFileName,
      args.sourceByteCount,
      args.sourceSha256,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.communications_email_assets.upload",
      requestFingerprint,
    });
    if (!prior) return { kind: "ready" as const };
    const bundleId = ctx.db.normalizeId("communicationsEmailAssetBundles", prior.targetId);
    if (!bundleId) throw new Error("The prior email bundle upload result is invalid.");
    return { kind: "complete" as const, bundleId };
  },
});

export const recordBundle = internalMutation({
  args: {
    eventSlug: v.string(),
    templateKey: participantEmailTemplateKey,
    sourceFileName: v.string(),
    sourceByteCount: v.number(),
    sourceSha256: v.string(),
    assets: v.array(assetInput),
    clientOperationId: v.string(),
  },
  returns: v.object({
    bundleId: v.id("communicationsEmailAssetBundles"),
    attached: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.communications.draft.create",
      scopeType: "event",
    });
    const sourceFileName = normalizedText(args.sourceFileName, "ZIP file name", 1, 160);
    const requestFingerprint = operationFingerprint([
      args.templateKey,
      sourceFileName,
      args.sourceByteCount,
      args.sourceSha256,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.communications_email_assets.upload",
      requestFingerprint,
    });
    if (prior) {
      const priorBundleId = ctx.db.normalizeId(
        "communicationsEmailAssetBundles",
        prior.targetId,
      );
      if (!priorBundleId) throw new Error("The prior email bundle upload result is invalid.");
      return { bundleId: priorBundleId, attached: false };
    }
    const now = Date.now();
    const bundleId = await ctx.db.insert("communicationsEmailAssetBundles", {
      eventId: event._id,
      templateKey: args.templateKey,
      sourceFileName,
      sourceByteCount: args.sourceByteCount,
      sourceSha256: args.sourceSha256,
      assets: args.assets,
      createdByPersonId: person._id,
      createdAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.communications_email_assets.upload",
      requestFingerprint,
      targetType: "communications_email_asset_bundle",
      targetId: bundleId,
      resultJson: "uploaded",
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "configuration.communications.draft.create",
      grantIds,
      scopeType: "event",
      action: "configuration.communications_email_assets_uploaded",
      targetType: "communications_email_asset_bundle",
      targetId: bundleId,
      nextSummary: JSON.stringify({
        templateKey: args.templateKey,
        sourceFileName,
        assetCount: args.assets.length,
        sourceByteCount: args.sourceByteCount,
      }),
      reason: `Imported ${sourceFileName} for the ${args.templateKey} participant email`,
    });
    return { bundleId, attached: true };
  },
});

export const readContext = internalQuery({
  args: {
    eventSlug: v.string(),
    bundleId: v.id("communicationsEmailAssetBundles"),
  },
  returns: v.object({
    sourceFileName: v.string(),
    assets: v.array(assetInput),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.communications.read",
      scopeType: "event",
    });
    const bundle = await ctx.db.get(args.bundleId);
    if (!bundle || bundle.eventId !== event._id) {
      throw new ConvexError({
        code: "EMAIL_ASSET_BUNDLE_NOT_FOUND",
        message: "That email asset bundle is not available for this event.",
      });
    }
    return { sourceFileName: bundle.sourceFileName, assets: bundle.assets };
  },
});
