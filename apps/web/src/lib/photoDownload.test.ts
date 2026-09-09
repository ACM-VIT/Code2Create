import { test } from "node:test";
import assert from "node:assert/strict";
import { selectionMaximumBytes } from "./photoSelection.ts";
import { unzipSync } from "fflate";
import { downloadPhotoArchive } from "./photoDownload.ts";

test("selection ZIP preserves original bytes and duplicate filenames", async () => {
  const bytes = new Uint8Array([0, 255, 12, 43, 99]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(bytes);
  try {
    const progress: number[] = [];
    const blob = await downloadPhotoArchive(
      [
        { fileName: "same.jpg", byteCount: 5 },
        { fileName: "same.jpg", byteCount: 5 },
      ],
      async () => "https://example.test/photo",
      new AbortController().signal,
      (count) => progress.push(count),
    );
    const zip = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    assert.deepEqual(zip["001-same.jpg"], bytes);
    assert.deepEqual(zip["002-same.jpg"], bytes);
    assert.deepEqual(progress, [1, 2]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("selection downloads reject oversized batches, incomplete files, and cancellation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([1]));
  const file = { fileName: "test.jpg", byteCount: 2 };
  const getUrl = async () => "https://example.test/photo";
  try {
    await assert.rejects(
      downloadPhotoArchive(
        [{ ...file, byteCount: selectionMaximumBytes + 1 }],
        getUrl,
        new AbortController().signal,
        () => {},
      ),
      /200 MB/,
    );
    await assert.rejects(
      downloadPhotoArchive(
        [file],
        getUrl,
        new AbortController().signal,
        () => {},
      ),
      /Incomplete download/,
    );
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      downloadPhotoArchive([file], getUrl, cancelled.signal, () => {}),
      { name: "AbortError" },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
