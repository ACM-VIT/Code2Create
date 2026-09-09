import { photoDay } from "./lib/photoDate";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import {
  env,
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireEventBySlug } from "./lib/events";
import {
  findCurrentPerson,
  requireCurrentPerson,
  requireEventSubject,
} from "./lib/identity";
import {
  matchingPermissionGrantIds,
  requirePermission,
} from "./lib/permissions";
import { writeAuditEvent } from "./lib/audit";
import {
  photoSourceUrl,
  photoUploadLifetime,
  photoVariantUrl,
  validatePhotoInput,
} from "./lib/galleryPhotos";

export const photoInput = {
  eventSlug: v.string(),
  clientOperationId: v.string(),
  fileName: v.string(),
  caption: v.string(),
  contentType: v.string(),
  byteCount: v.number(),
  sha256: v.string(),
};

async function uploadAccess(
  ctx: QueryCtx | MutationCtx,
  eventId: Id<"events">,
) {
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, eventId, person._id);
  const grantIds = await requirePermission(ctx, {
    eventId,
    eventAccessSubjectId: subject._id,
    permissionKey: "photos.upload",
    scopeType: "event",
  });
  return { person, grantIds };
}

export const capabilities = query({
  args: { eventSlug: v.string() },
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const person = await findCurrentPerson(ctx);
    if (!person || person.status !== "active") return { canUpload: false };
    const subject = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (q) =>
        q.eq("eventId", event._id).eq("personId", person._id),
      )
      .unique();
    if (!subject || subject.status !== "active") return { canUpload: false };
    const grants = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "photos.upload",
      scopeType: "event",
    });
    return { canUpload: grants.length > 0 };
  },
});

const dayValidator = v.union(
  v.literal("6"),
  v.literal("7"),
  v.literal("8"),
  v.literal("other"),
);
export const facets = query({
  args: { eventSlug: v.string() },
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const rows = await ctx.db
      .query("galleryPhotoFacets")
      .withIndex("by_event_uploader", (q) => q.eq("eventId", event._id))
      .take(1001);
    if (rows.length > 1000)
      throw new ConvexError("Too many photographers to display.");
    return rows
      .map((row) => ({
        uploaderId: row.uploaderId,
        uploaderName: row.uploaderName,
        counts: row.counts,
      }))
      .sort((a, b) => a.uploaderName.localeCompare(b.uploaderName));
  },
});
export const list = query({
  args: {
    eventSlug: v.string(),
    paginationOpts: paginationOptsValidator,
    day: v.optional(dayValidator),
    uploaderId: v.optional(v.id("people")),
    sort: v.optional(
      v.union(v.literal("newest"), v.literal("oldest"), v.literal("uploader")),
    ),
  },
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const base = ctx.db.query("galleryPhotos");
    const day = args.day;
    const uploader = args.uploaderId;
    const indexed = uploader
      ? day
        ? base.withIndex("by_uploader_day_capture", (q) =>
            q
              .eq("eventId", event._id)
              .eq("status", "published")
              .eq("uploaderId", uploader)
              .eq("day", day),
          )
        : base.withIndex("by_uploader_capture", (q) =>
            q
              .eq("eventId", event._id)
              .eq("status", "published")
              .eq("uploaderId", uploader),
          )
      : args.sort === "uploader"
        ? day
          ? base.withIndex("by_day_name_capture", (q) =>
              q
                .eq("eventId", event._id)
                .eq("status", "published")
                .eq("day", day),
            )
          : base.withIndex("by_name_capture", (q) =>
              q.eq("eventId", event._id).eq("status", "published"),
            )
        : day
          ? base.withIndex("by_day_capture", (q) =>
              q
                .eq("eventId", event._id)
                .eq("status", "published")
                .eq("day", day),
            )
          : base.withIndex("by_capture", (q) =>
              q.eq("eventId", event._id).eq("status", "published"),
            );
    const result = await indexed
      .order(
        args.sort === "oldest" || args.sort === "uploader" ? "asc" : "desc",
      )
      .paginate(args.paginationOpts);
    const origin = env.PHOTO_PUBLIC_ORIGIN?.replace(/\/$/, "");
    if (result.page.length && !origin)
      throw new ConvexError("Photo delivery is not configured.");
    return {
      ...result,
      page: result.page.map((photo) => {
        if (!origin || !photo.width || !photo.height)
          throw new Error("Published photo metadata is incomplete.");
        const { width: originalWidth, height: originalHeight } = photo;
        const widths = [320, 640, 960, 1600, 2400].filter(
          (width) => width < originalWidth,
        );
        widths.push(Math.min(originalWidth, 2400));
        return {
          id: photo._id,
          uploaderId: photo.uploaderId,
          uploaderName: photo.uploaderName ?? "Photographer",
          capturedAt: photo.capturedAt,
          day: photo.day ?? "other",
          fileName: photo.fileName,
          caption: photo.caption,
          width: photo.width,
          height: photo.height,
          byteCount: photo.byteCount,
          originalUrl: photoSourceUrl(origin, photo._id, photo.sha256),
          src: photoVariantUrl(origin, photo._id, photo.sha256, 960),
          srcSet: [...new Set(widths)].map((width) => ({
            src: photoVariantUrl(origin, photo._id, photo.sha256, width),
            width,
            height: Math.round((width * originalHeight) / originalWidth),
          })),
        };
      }),
    };
  },
});

export const reserve = internalMutation({
  args: photoInput,
  handler: async (ctx, args): Promise<Id<"galleryPhotos">> => {
    validatePhotoInput(args);
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await uploadAccess(ctx, event._id);
    const previous = await ctx.db
      .query("galleryPhotos")
      .withIndex("by_uploaderId_and_clientOperationId", (q) =>
        q
          .eq("uploaderId", person._id)
          .eq("clientOperationId", args.clientOperationId),
      )
      .order("desc")
      .first();
    if (previous) {
      if (
        previous.eventId !== event._id ||
        previous.sha256 !== args.sha256 ||
        previous.byteCount !== args.byteCount ||
        previous.contentType !== args.contentType ||
        previous.fileName !== args.fileName ||
        previous.caption !== args.caption.trim()
      ) {
        throw new ConvexError(
          "That upload identifier belongs to a different photo.",
        );
      }
      if (previous.status !== "expired") return previous._id;
    }
    const photoId = await ctx.db.insert("galleryPhotos", {
      eventId: event._id,
      uploaderId: person._id,
      clientOperationId: args.clientOperationId,
      fileName: args.fileName,
      caption: args.caption.trim(),
      contentType: args.contentType,
      byteCount: args.byteCount,
      sha256: args.sha256,
      status: "pending",
      expiresAt: Date.now() + photoUploadLifetime,
    });
    await ctx.scheduler.runAfter(photoUploadLifetime, internal.photos.expire, {
      photoId,
    });
    return photoId;
  },
});

export const uploadContext = internalQuery({
  args: { photoId: v.id("galleryPhotos") },
  handler: async (ctx, args) => {
    const photo = await ctx.db.get("galleryPhotos", args.photoId);
    if (!photo) throw new ConvexError("Photo not found.");
    const { person } = await uploadAccess(ctx, photo.eventId);
    if (person._id !== photo.uploaderId)
      throw new ConvexError("This photo belongs to another uploader.");
    return photo;
  },
});

export const publish = internalMutation({
  args: {
    photoId: v.id("galleryPhotos"),
    width: v.number(),
    height: v.number(),
    capturedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const photo = await ctx.db.get("galleryPhotos", args.photoId);
    if (!photo) throw new ConvexError("Photo not found.");
    const { person, grantIds } = await uploadAccess(ctx, photo.eventId);
    if (person._id !== photo.uploaderId)
      throw new ConvexError("This photo belongs to another uploader.");
    if (photo.status === "published") return photo._id;
    if (photo.status !== "pending" || photo.expiresAt <= Date.now())
      throw new ConvexError("This upload expired. Select the photo again.");
    if (
      ![args.width, args.height].every(
        (n) => Number.isSafeInteger(n) && n > 0 && n <= 30000,
      )
    )
      throw new ConvexError("Invalid photo dimensions.");
    if (
      args.capturedAt !== undefined &&
      (!Number.isSafeInteger(args.capturedAt) ||
        Math.abs(args.capturedAt) > 8.64e15)
    )
      throw new ConvexError("Invalid capture date.");
    const event = await ctx.db.get("events", photo.eventId);
    const eventMonth = event?.startsAt
      ? new Date(event.startsAt + 330 * 60_000).toISOString().slice(0, 7)
      : undefined;
    const day = photoDay(args.capturedAt, eventMonth);
    const facet = await ctx.db
      .query("galleryPhotoFacets")
      .withIndex("by_event_uploader", (q) =>
        q.eq("eventId", photo.eventId).eq("uploaderId", photo.uploaderId),
      )
      .unique();
    const counts = facet?.counts ?? { "6": 0, "7": 0, "8": 0, other: 0 };
    counts[day] += 1;
    if (facet)
      await ctx.db.patch("galleryPhotoFacets", facet._id, {
        counts,
        uploaderName: person.displayName,
      });
    else
      await ctx.db.insert("galleryPhotoFacets", {
        eventId: photo.eventId,
        uploaderId: photo.uploaderId,
        uploaderName: person.displayName,
        counts,
      });
    await ctx.db.patch("galleryPhotos", photo._id, {
      capturedAt: args.capturedAt,
      day,
      uploaderName: person.displayName,
      status: "published",
      width: args.width,
      height: args.height,
      publishedAt: Date.now(),
    });
    await writeAuditEvent(ctx, {
      eventId: photo.eventId,
      actorPersonId: person._id,
      permissionKey: "photos.upload",
      grantIds,
      scopeType: "event",
      action: "photos.publish",
      targetType: "galleryPhoto",
      targetId: photo._id,
      nextSummary: photo.fileName,
      reason: "Published a photo to the public event gallery.",
    });
    return photo._id;
  },
});

export const expire = internalMutation({
  args: { photoId: v.id("galleryPhotos") },
  handler: async (ctx, args) => {
    const photo = await ctx.db.get("galleryPhotos", args.photoId);
    if (photo?.status === "pending" && photo.expiresAt <= Date.now()) {
      await ctx.db.patch("galleryPhotos", photo._id, { status: "expired" });
      // Let any in-flight action finish before deleting its unpublished objects.
      await ctx.scheduler.runAfter(
        photoUploadLifetime,
        internal.photoActions.cleanupExpired,
        { photoId: photo._id },
      );
    }
  },
});

export const expiredContext = internalQuery({
  args: { photoId: v.id("galleryPhotos") },
  handler: async (ctx, args) => {
    const photo = await ctx.db.get("galleryPhotos", args.photoId);
    return photo?.status === "expired"
      ? { id: photo._id, sha256: photo.sha256 }
      : null;
  },
});

export const downloadContext = internalQuery({
  args: { photoId: v.id("galleryPhotos") },
  handler: async (ctx, args) => {
    const photo = await ctx.db.get("galleryPhotos", args.photoId);
    if (!photo || photo.status !== "published")
      throw new ConvexError("Photo not found.");
    return { id: photo._id, sha256: photo.sha256, fileName: photo.fileName };
  },
});
