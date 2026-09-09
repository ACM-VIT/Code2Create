/// <reference types="vite/client" />
import { createHash } from "node:crypto";
import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api";
import schema from "./schema";
import { inspectPhoto, photoDownloadDisposition } from "./lib/photoStorage";
import { photoObjectKey, validatePhotoInput } from "./lib/galleryPhotos";
import { parsePhotoDate, photoCaptureDate, photoDay } from "./lib/photoDate";

const storage = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const original = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...original,
    S3Client: class {
      send = storage.send;
    },
  };
});
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async (
    _client: unknown,
    command: { input: { Key?: string; ResponseContentDisposition?: string } },
  ) =>
    `https://r2.example.test/${command.input.Key}?disposition=${encodeURIComponent(command.input.ResponseContentDisposition ?? "")}`,
}));

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const authModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
const bytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
const input = {
  eventSlug: "photos-test",
  clientOperationId: "d065d617-273e-43e2-976b-6b8690857071",
  fileName: "a photo.png",
  caption: "Opening night",
  contentType: "image/png",
  byteCount: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};

test("capture dates use EXIF offsets or India time, never the upload date", async () => {
  expect(parsePhotoDate("2026:09:06 00:30:00", undefined)).toBe(
    Date.parse("2026-09-05T19:00:00Z"),
  );
  expect(
    photoDay(parsePhotoDate("2026:09:05 23:30:00", "+00:00"), "2026-09"),
  ).toBe("6");
  expect(
    photoDay(parsePhotoDate("2026:09:08 23:30:00", "+05:30"), "2026-09"),
  ).toBe("8");
  expect(
    photoDay(parsePhotoDate("2025:09:06 12:00:00", undefined), "2026-09"),
  ).toBe("other");
  expect(parsePhotoDate("2026:02:30 12:00:00", undefined)).toBeUndefined();
  expect(parsePhotoDate("invalid", undefined)).toBeUndefined();
  expect(photoDay(undefined, "2026-09")).toBe("other");
  expect(await photoCaptureDate(bytes)).toBeUndefined();
});

test("day and photographer filters paginate globally, sort capture time, and count publications once", async () => {
  const { t, uploader, eventId, personId } = await fixture();
  await t.run((ctx) =>
    ctx.db.patch("events", eventId, {
      startsAt: Date.parse("2026-09-06T00:00:00+05:30"),
    }),
  );
  const dates = [
    "2026-09-06T10:00:00+05:30",
    "2026-09-07T09:00:00+05:30",
    "2026-09-06T12:00:00+05:30",
    "2026-08-06T10:00:00+05:30",
  ];
  for (const date of dates) {
    const photoId = await uploader.mutation(internal.photos.reserve, {
      ...input,
      clientOperationId: crypto.randomUUID(),
    });
    const args = { photoId, width: 1, height: 1, capturedAt: Date.parse(date) };
    await uploader.mutation(internal.photos.publish, args);
    await uploader.mutation(internal.photos.publish, args);
  }
  const first = await t.query(api.photos.list, {
    eventSlug: input.eventSlug,
    day: "6",
    uploaderId: personId,
    sort: "oldest",
    paginationOpts: { cursor: null, numItems: 1 },
  });
  expect(first.page).toHaveLength(1);
  expect(first.page[0]?.capturedAt).toBe(Date.parse(dates[0]!));
  const second = await t.query(api.photos.list, {
    eventSlug: input.eventSlug,
    day: "6",
    uploaderId: personId,
    sort: "oldest",
    paginationOpts: { cursor: first.continueCursor, numItems: 1 },
  });
  expect(second.page[0]?.capturedAt).toBe(Date.parse(dates[2]!));
  const newest = await t.query(api.photos.list, {
    eventSlug: input.eventSlug,
    sort: "newest",
    paginationOpts: { cursor: null, numItems: 10 },
  });
  expect(newest.page[0]?.day).toBe("7");
  const other = await t.query(api.photos.list, {
    eventSlug: input.eventSlug,
    day: "other",
    paginationOpts: { cursor: null, numItems: 10 },
  });
  expect(other.page).toHaveLength(1);
  const facets = await t.query(api.photos.facets, {
    eventSlug: input.eventSlug,
  });
  expect(facets).toHaveLength(1);
  expect(facets[0]?.counts).toEqual({ "6": 2, "7": 1, "8": 0, other: 1 });
  expect(facets[0]).not.toHaveProperty("verifiedEmail");
});

beforeEach(() =>
  vi.stubEnv("PHOTO_PUBLIC_ORIGIN", "https://media.example.test"),
);
afterEach(() => vi.unstubAllEnvs());

async function fixture(grant = true) {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, authModules);
  const now = Date.now();
  const user: unknown = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Photographer",
        email: "photographer@example.test",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const userId = getId(user);
  const session: unknown = await t.mutation(
    components.betterAuth.adapter.create,
    {
      input: {
        model: "session",
        data: {
          userId,
          expiresAt: now + 3600000,
          token: crypto.randomUUID(),
          createdAt: now,
          updatedAt: now,
        },
      },
    },
  );
  const seeded = await t.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: input.eventSlug,
      name: "Photos test",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      applicationsCloseAt: now + 3600000,
      startsAt: now,
      endsAt: now + 3600000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const personId = await ctx.db.insert("people", {
      authUserId: userId,
      googleSubject: userId,
      verifiedEmail: "photographer@example.test",
      displayName: "Photographer",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: "photographer@example.test",
      displayName: "Photographer",
      status: "active",
      linkedBy: "participant_provisioning",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    const grantId = grant
      ? await ctx.db.insert("permissionGrants", {
          eventId,
          personId,
          eventAccessSubjectId: subjectId,
          permissionKey: "photos.upload",
          scopeType: "event",
          validFrom: now - 1000,
          status: "active",
          sourceType: "manual",
          sourceId: "photo-test",
          reason: "Photo test",
          createdAt: now,
          activatedAt: now,
        })
      : null;
    return { eventId, personId, subjectId, grantId };
  });
  return {
    t,
    uploader: t.withIdentity({ subject: userId, sessionId: getId(session) }),
    ...seeded,
  };
}

function getId(value: unknown) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("_id" in value) ||
    typeof value._id !== "string"
  )
    throw new Error("Missing fixture ID");
  return value._id;
}

test("signed-out visitors can read photos but cannot reserve an upload", async () => {
  const { t } = await fixture();
  await expect(
    t.query(api.photos.list, {
      eventSlug: input.eventSlug,
      paginationOpts: { numItems: 2, cursor: null },
    }),
  ).resolves.toMatchObject({ page: [], isDone: true });
  await expect(
    t.query(api.photos.capabilities, { eventSlug: input.eventSlug }),
  ).resolves.toEqual({ canUpload: false });
  await expect(t.mutation(internal.photos.reserve, input)).rejects.toThrow();
});

test("sign-in alone never grants upload permission", async () => {
  const { uploader } = await fixture(false);
  await expect(
    uploader.query(api.photos.capabilities, { eventSlug: input.eventSlug }),
  ).resolves.toEqual({ canUpload: false });
  await expect(
    uploader.mutation(internal.photos.reserve, input),
  ).rejects.toThrow();
});

test("pending uploads are private to the feed; publish and retries are idempotent", async () => {
  const { t, uploader } = await fixture();
  const photoId = await uploader.mutation(internal.photos.reserve, input);
  expect(await uploader.mutation(internal.photos.reserve, input)).toBe(photoId);
  await expect(
    t.query(internal.photos.downloadContext, { photoId }),
  ).rejects.toThrow();
  expect(
    (
      await t.query(api.photos.list, {
        eventSlug: input.eventSlug,
        paginationOpts: { numItems: 2, cursor: null },
      })
    ).page,
  ).toHaveLength(0);
  await uploader.mutation(internal.photos.publish, {
    photoId,
    width: 1000,
    height: 1500,
  });
  await uploader.mutation(internal.photos.publish, {
    photoId,
    width: 1000,
    height: 1500,
  });
  const result = await t.query(api.photos.list, {
    eventSlug: input.eventSlug,
    paginationOpts: { numItems: 2, cursor: null },
  });
  expect(result.page).toHaveLength(1);
  expect(result.page[0]).toMatchObject({
    id: photoId,
    width: 1000,
    height: 1500,
    fileName: input.fileName,
    caption: input.caption,
  });
  expect(result.page[0]).toHaveProperty("uploaderName", "Photographer");
  expect(result.page[0]).not.toHaveProperty("verifiedEmail");
  expect(result.page[0]).not.toHaveProperty("sha256");
  expect(result.page[0]?.originalUrl).toBe(
    `https://media.example.test/${photoObjectKey(photoId, input.sha256)}`,
  );
  expect(result.page[0]?.srcSet.at(-1)?.width).toBe(1000);
  expect(
    (await t.query(internal.photos.downloadContext, { photoId })).fileName,
  ).toBe(input.fileName);
  const audits = await t.run((ctx) => ctx.db.query("auditEvents").take(10));
  expect(audits).toHaveLength(1);
});

test("publication rechecks a grant revoked after upload reservation", async () => {
  const { t, uploader, grantId } = await fixture();
  const photoId = await uploader.mutation(internal.photos.reserve, input);
  if (!grantId) throw new Error("Missing grant");
  await t.run((ctx) =>
    ctx.db.patch("permissionGrants", grantId, { status: "revoked" }),
  );
  await expect(
    uploader.mutation(internal.photos.publish, {
      photoId,
      width: 1,
      height: 1,
    }),
  ).rejects.toThrow();
  expect(
    (
      await t.query(api.photos.list, {
        eventSlug: input.eventSlug,
        paginationOpts: { numItems: 2, cursor: null },
      })
    ).page,
  ).toHaveLength(0);
});

test("expiration prevents publication; retry gets a fresh key immune to old cleanup", async () => {
  const { t, uploader } = await fixture();
  const photoId = await uploader.mutation(internal.photos.reserve, input);
  await t.run((ctx) =>
    ctx.db.patch("galleryPhotos", photoId, { expiresAt: Date.now() - 1 }),
  );
  await t.mutation(internal.photos.expire, { photoId });
  await expect(
    uploader.mutation(internal.photos.publish, {
      photoId,
      width: 1,
      height: 1,
    }),
  ).rejects.toThrow();
  const retryId = await uploader.mutation(internal.photos.reserve, input);
  expect(retryId).not.toBe(photoId);
  expect(await uploader.mutation(internal.photos.reserve, input)).toBe(retryId);
  await t.mutation(internal.photos.expire, { photoId });
  await uploader.mutation(internal.photos.publish, {
    photoId: retryId,
    width: 1,
    height: 1,
  });
  await expect(
    uploader.mutation(internal.photos.reserve, {
      ...input,
      sha256: "a".repeat(64),
    }),
  ).rejects.toThrow();
});

test("original verification detects corruption and disguised non-photo uploads", () => {
  expect(inspectPhoto(bytes, input)).toEqual({ width: 1, height: 1 });
  expect(() =>
    inspectPhoto(bytes, { ...input, sha256: "a".repeat(64) }),
  ).toThrow();
  expect(() =>
    inspectPhoto(bytes, { ...input, contentType: "image/jpeg" }),
  ).toThrow();
  expect(() => inspectPhoto(bytes, { ...input, byteCount: 1 })).toThrow();
  const html = Buffer.from("<html><script>alert(1)</script></html>");
  expect(() =>
    inspectPhoto(html, {
      ...input,
      byteCount: html.length,
      sha256: createHash("sha256").update(html).digest("hex"),
    }),
  ).toThrow();
  expect(() =>
    validatePhotoInput({ ...input, contentType: "image/svg+xml" }),
  ).toThrow();
  expect(() =>
    validatePhotoInput({ ...input, byteCount: 51 * 1024 * 1024 }),
  ).toThrow();
  expect(() =>
    validatePhotoInput({ ...input, fileName: "bad\r\nname.png" }),
  ).toThrow();
  expect(photoDownloadDisposition('தமிழ் "photo".jpg')).toMatch(
    /^attachment; filename="/,
  );
  expect(photoDownloadDisposition("தமிழ்.jpg")).toContain("filename*=UTF-8''");
});

test("public listing paginates without leaking another event", async () => {
  const { t, uploader } = await fixture();
  for (let index = 0; index < 3; index++) {
    const photoId = await uploader.mutation(internal.photos.reserve, {
      ...input,
      clientOperationId: crypto.randomUUID(),
    });
    await uploader.mutation(internal.photos.publish, {
      photoId,
      width: 4000,
      height: 3000,
    });
  }
  const first = await t.query(api.photos.list, {
    eventSlug: input.eventSlug,
    paginationOpts: { numItems: 2, cursor: null },
  });
  expect(first.page).toHaveLength(2);
  expect(first.isDone).toBe(false);
  const last = await t.query(api.photos.list, {
    eventSlug: input.eventSlug,
    paginationOpts: { numItems: 2, cursor: first.continueCursor },
  });
  expect(last.page).toHaveLength(1);
  expect(last.isDone).toBe(true);
  expect(
    new Set([...first.page, ...last.page].map((photo) => photo.id)).size,
  ).toBe(3);
  expect(first.page[0]?.srcSet.at(-1)?.width).toBe(2400);
  const otherEventId = await t.run(async (ctx) => {
    const event = await ctx.db.query("events").first();
    if (!event) throw new Error("Missing event");
    const { _id, _creationTime, ...fields } = event;
    void _id;
    void _creationTime;
    return ctx.db.insert("events", { ...fields, slug: "other-event" });
  });
  expect(otherEventId).toBeTruthy();
  expect(
    (
      await t.query(api.photos.list, {
        eventSlug: "other-event",
        paginationOpts: { numItems: 10, cursor: null },
      })
    ).page,
  ).toHaveLength(0);
});

test("the upload actions preserve exact bytes and allow signed-out original downloads", async () => {
  vi.stubEnv("PHOTO_R2_ACCOUNT_ID", "a".repeat(32));
  vi.stubEnv("PHOTO_R2_ACCESS_KEY_ID", "test-key");
  vi.stubEnv("PHOTO_R2_SECRET_ACCESS_KEY", "test-secret");
  vi.stubEnv("PHOTO_R2_BUCKET", "gallery-test");
  const { t, uploader } = await fixture();
  let written: Uint8Array | undefined;
  let writtenKey: string | undefined;
  storage.send.mockImplementation(
    async (command: {
      constructor: { name: string };
      input: { Body?: Uint8Array; Key?: string; IfMatch?: string };
    }) => {
      if (command.constructor.name === "HeadObjectCommand")
        return {
          ContentLength: bytes.length,
          ContentType: "image/png",
          ETag: "test-etag",
        };
      if (command.constructor.name === "GetObjectCommand") {
        expect(command.input.IfMatch).toBe("test-etag");
        return {
          Body: { transformToByteArray: async () => new Uint8Array(bytes) },
        };
      }
      if (command.constructor.name === "PutObjectCommand") {
        written = command.input.Body;
        writtenKey = command.input.Key;
        return {};
      }
      throw new Error("Unexpected storage command");
    },
  );
  const ticket = await uploader.action(api.photoActions.beginUpload, input);
  expect(ticket.uploadUrl).toContain(`uploads/${ticket.photoId}`);
  await uploader.action(api.photoActions.finishUpload, {
    photoId: ticket.photoId,
  });
  expect(written).toEqual(new Uint8Array(bytes));
  expect(writtenKey).toBe(photoObjectKey(ticket.photoId, input.sha256));
  const url = await t.action(api.photoActions.download, {
    photoId: ticket.photoId,
  });
  expect(decodeURIComponent(url)).toContain(
    'attachment; filename="a photo.png"',
  );
  expect(url).toContain(photoObjectKey(ticket.photoId, input.sha256));
  const retry = await uploader.action(api.photoActions.beginUpload, input);
  expect(retry).toEqual({ photoId: ticket.photoId, uploadUrl: null });
});

test("reads the original capture timestamp from a JPEG EXIF block", async () => {
  const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/4QBcRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAApADAAIAAAAUAAAAOJARAAIAAAAHAAAATAAAAAAyMDI2OjA5OjA2IDAwOjMwOjAwACswNTozMAAA/9sAQwAIBgYHBgUIBwcHCQkICgwUDQwLCwwZEhMPFB0aHx4dGhwcICQuJyAiLCMcHCg3KSwwMTQ0NB8nOT04MjwuMzQy/9sAQwEJCQkMCwwYDQ0YMiEcITIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/aAAwDAQACEQMRAD8A89ooorzD2D//2Q==", "base64");
  expect(await photoCaptureDate(jpeg)).toBe(Date.parse("2026-09-05T19:00:00Z"));
});
