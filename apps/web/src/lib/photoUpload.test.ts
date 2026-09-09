import assert from "node:assert/strict";
import test from "node:test";
import { photoChecksum, validatePhotoFile } from "./photoUpload.ts";

test("photo selection accepts original formats and rejects oversized or executable files", () => {
  assert.equal(
    validatePhotoFile({
      name: "event.jpg",
      type: "image/jpeg",
      size: 20 * 1024 * 1024,
    }),
    null,
  );
  assert.ok(
    validatePhotoFile({
      name: "event.jpg",
      type: "image/jpeg",
      size: 51 * 1024 * 1024,
    }),
  );
  assert.ok(
    validatePhotoFile({ name: "event.svg", type: "image/svg+xml", size: 100 }),
  );
  assert.ok(
    validatePhotoFile({ name: "empty.jpg", type: "image/jpeg", size: 0 }),
  );
});

test("the checksum covers the exact original bytes", async () => {
  const file = new File(["abc"], "photo.jpg", { type: "image/jpeg" });
  assert.equal(
    await photoChecksum(file),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
