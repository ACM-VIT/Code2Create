import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseCatalog,
  photoUrl,
  PHOTO_BUCKET,
} from "../../apps/landing/src/photos/catalog.ts";

test("original filenames retain spaces, unicode and URL punctuation", () => {
  const key = "originals/drive/folder/தமிழ் photo #1?.jpg";
  const url = new URL(photoUrl(key));
  assert.equal(url.origin, PHOTO_BUCKET);
  assert.equal(decodeURIComponent(url.pathname), `/${key}`);
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
});

test("invalid remote catalogs cannot produce broken gallery geometry or external image URLs", () => {
  const photo = {
    key: "originals/a.jpg",
    preview: "previews/a.webp",
    thumbnail: "previews/a-800.webp",
    name: "a.jpg",
    width: 1600,
    height: 900,
  };
  assert.equal(parseCatalog({ photos: [photo] }).photos.length, 1);
  for (const invalid of [
    null,
    {},
    { photos: [null] },
    { photos: [{ ...photo, width: 0 }] },
    { photos: [{ ...photo, height: Infinity }] },
    { photos: [{ ...photo, preview: "https://example.com/photo.jpg" }] },
  ]) {
    assert.throws(() => parseCatalog(invalid));
  }
});
