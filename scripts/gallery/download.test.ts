import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadPhotos } from "../../apps/landing/src/photos/download.ts";

const photos = ["originals/one", "originals/two"].map((key) => ({
  key,
  name: "தமிழ்.jpg",
  preview: "previews/a",
  thumbnail: "previews/b",
  width: 1,
  height: 1,
}));

test("ZIP preserves original bytes and gives duplicate filenames unique names", async (t) => {
  const chunks: Uint8Array[] = [];
  const originals = [
    new Uint8Array([0, 255, 12, 42]),
    new Uint8Array([99, 0, 88]),
  ];
  let fetched = 0;
  let closed = false;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      showSaveFilePicker: async () => ({
        createWritable: async () =>
          new WritableStream({
            write: (chunk: Uint8Array) => {
              chunks.push(chunk);
            },
            close: () => {
              closed = true;
            },
          }),
      }),
    },
  });
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(originals[fetched++]),
  );
  const progress: number[] = [];
  await downloadPhotos(photos, new AbortController().signal, (count) =>
    progress.push(count),
  );
  assert.equal(closed, true);
  assert.deepEqual(progress, [1, 2]);
  const zip = Buffer.concat(chunks);
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt16LE(end + 10), 2);
  let central = zip.readUInt32LE(end + 16);
  for (let i = 0; i < 2; i++) {
    assert.equal(zip.readUInt32LE(central), 0x02014b50);
    assert.equal(zip.readUInt16LE(central + 10), 0); // Stored, unchanged originals.
    const length = zip.readUInt32LE(central + 24);
    const nameLength = zip.readUInt16LE(central + 28);
    assert.equal(
      zip.subarray(central + 46, central + 46 + nameLength).toString(),
      `00${i + 1}-தமிழ்.jpg`,
    );
    const local = zip.readUInt32LE(central + 42);
    const start =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    assert.deepEqual(
      zip.subarray(start, start + length),
      Buffer.from(originals[i]),
    );
    central +=
      46 +
      nameLength +
      zip.readUInt16LE(central + 30) +
      zip.readUInt16LE(central + 32);
  }
});

test("a failed photo aborts the ZIP destination instead of saving a partial archive", async (t) => {
  let aborted = false;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      showSaveFilePicker: async () => ({
        createWritable: async () =>
          new WritableStream({
            abort: () => {
              aborted = true;
            },
          }),
      }),
    },
  });
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 503 }),
  );
  await assert.rejects(
    downloadPhotos(photos, new AbortController().signal, () => {}),
    /couldn’t download/,
  );
  assert.equal(aborted, true);
});

test("cancelling before transfer does not fetch original photos", async (t) => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
  });
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected fetch");
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    downloadPhotos(photos, controller.signal, () => {}),
    { name: "AbortError" },
  );
  assert.equal(fetch.mock.callCount(), 0);
});

test("browsers without a file writer download the completed ZIP as one file", async (t) => {
  let clicked = false;
  let archived: Blob | undefined;
  const link = {
    href: "",
    download: "",
    click: () => {
      clicked = true;
    },
    remove: () => {},
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setTimeout: () => 0 },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => link,
      body: { append: () => {} },
    },
  });
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(new Uint8Array([1, 2, 3])),
  );
  t.mock.method(URL, "createObjectURL", (blob: Blob) => {
    archived = blob;
    return "blob:test";
  });
  await downloadPhotos(photos, new AbortController().signal, () => {});
  assert.equal(clicked, true);
  assert.equal(link.download, "code2create-photos.zip");
  assert.equal(link.href, "blob:test");
  assert.ok(archived && archived.size > 6);
});
