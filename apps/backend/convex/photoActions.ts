"use node";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ConvexError, v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { photoCaptureDate } from "./lib/photoDate";
import { photoInput } from "./photos";
import { photoObjectKey } from "./lib/galleryPhotos";
import {
  inspectPhoto,
  photoDownloadDisposition,
  photoStorage,
} from "./lib/photoStorage";

export const beginUpload = action({
  args: photoInput,
  handler: async (
    ctx,
    args,
  ): Promise<{ photoId: Id<"galleryPhotos">; uploadUrl: string | null }> => {
    const { client, bucket } = photoStorage();
    const photoId = await ctx.runMutation(internal.photos.reserve, args);
    const photo: Doc<"galleryPhotos"> = await ctx.runQuery(
      internal.photos.uploadContext,
      { photoId },
    );
    if (photo.status === "published") return { photoId, uploadUrl: null };
    if (photo.status !== "pending" || photo.expiresAt <= Date.now())
      throw new ConvexError("This upload expired. Select the photo again.");
    const uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: bucket,
        Key: `uploads/${photoId}`,
        ContentType: photo.contentType,
        ContentLength: photo.byteCount,
      }),
      {
        expiresIn: Math.min(
          900,
          Math.max(1, Math.floor((photo.expiresAt - Date.now()) / 1000)),
        ),
      },
    );
    return { photoId, uploadUrl };
  },
});

export const finishUpload = action({
  args: { photoId: v.id("galleryPhotos") },
  handler: async (ctx, args): Promise<Id<"galleryPhotos">> => {
    const photo: Doc<"galleryPhotos"> = await ctx.runQuery(
      internal.photos.uploadContext,
      args,
    );
    if (photo.status === "published") return photo._id;
    if (photo.status !== "pending" || photo.expiresAt <= Date.now())
      throw new ConvexError("This upload expired. Select the photo again.");
    const { client, bucket } = photoStorage();
    const input = { Bucket: bucket, Key: `uploads/${photo._id}` };
    const head = await client.send(new HeadObjectCommand(input));
    if (
      head.ContentLength !== photo.byteCount ||
      head.ContentType !== photo.contentType
    )
      throw new ConvexError(
        "The uploaded file is incomplete or has a different format.",
      );
    // Bind the read to the inspected object; a reused PUT URL cannot change the verified snapshot.
    const uploaded = await client.send(
      new GetObjectCommand({ ...input, IfMatch: head.ETag }),
    );
    if (!uploaded.Body)
      throw new ConvexError("The upload could not be read. Please retry.");
    const bytes = await uploaded.Body.transformToByteArray();
    const dimensions = inspectPhoto(bytes, photo);
    // Store the exact bytes, including EXIF and colour profiles. Only CDN previews are transformed.
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: photoObjectKey(photo._id, photo.sha256),
        Body: bytes,
        ContentType: photo.contentType,
        CacheControl: "public, max-age=31536000, immutable",
        Metadata: { sha256: photo.sha256 },
      }),
    );
    // This transaction checks current identity, ownership and grants again, including revocations.
    const capturedAt = await photoCaptureDate(bytes);
    return await ctx.runMutation(internal.photos.publish, {
      photoId: photo._id,
      ...dimensions,
      ...(capturedAt === undefined ? {} : { capturedAt }),
    });
  },
});

export const download = action({
  args: { photoId: v.id("galleryPhotos") },
  handler: async (ctx, args): Promise<string> => {
    // Deliberately public, but pending uploads never receive a download URL.
    const photo = await ctx.runQuery(internal.photos.downloadContext, args);
    const { client, bucket } = photoStorage();
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: photoObjectKey(photo.id, photo.sha256),
        ResponseContentDisposition: photoDownloadDisposition(photo.fileName),
      }),
      { expiresIn: 300 },
    );
  },
});

export const cleanupExpired = internalAction({
  args: { photoId: v.id("galleryPhotos") },
  handler: async (ctx, args) => {
    const photo = await ctx.runQuery(internal.photos.expiredContext, args);
    if (!photo) return;
    const { client, bucket } = photoStorage();
    const result = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: [
            { Key: `uploads/${photo.id}` },
            { Key: photoObjectKey(photo.id, photo.sha256) },
          ],
        },
      }),
    );
    if (result.Errors?.length)
      throw new Error("Expired photo objects could not be removed from R2.");
  },
});
