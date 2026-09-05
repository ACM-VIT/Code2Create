import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readStoredFigmaPreview } from "./artifactStorage";

const storage = vi.hoisted(() => ({
  send: vi.fn<
    () => Promise<{
      ContentLength: number;
      Body: { transformToByteArray: () => Promise<Uint8Array> };
    }>
  >(),
}));
vi.mock("@aws-sdk/client-s3", async (original) => {
  const actual = await original<typeof import("@aws-sdk/client-s3")>();
  return {
    ...actual,
    S3Client: class {
      send = storage.send;
    },
  };
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
  "base64",
);
const manifest = {
  objectKey: "captured/frame.png",
  storageRegion: "ap-south-1",
  storageBucket: "test-evidence",
  byteCount: png.length,
  sha256: createHash("sha256").update(png).digest("hex"),
};
beforeEach(() => {
  vi.stubEnv("ARTIFACT_S3_REGION", manifest.storageRegion);
  vi.stubEnv("ARTIFACT_S3_BUCKET", manifest.storageBucket);
  vi.stubEnv("ARTIFACT_S3_ACCESS_KEY_ID", "test-access");
  vi.stubEnv("ARTIFACT_S3_SECRET_ACCESS_KEY", "test-secret");
  vi.stubEnv("ARTIFACT_S3_KMS_KEY_ID", "test-kms");
  storage.send.mockReset().mockResolvedValue({
    ContentLength: png.length,
    Body: { transformToByteArray: async () => png },
  });
});
afterEach(() => vi.unstubAllEnvs());

test("reads only the captured object and verifies the PNG checksum before analysis", async () => {
  expect(await readStoredFigmaPreview(manifest)).toBe(png.toString("base64"));
  expect(storage.send).toHaveBeenCalledWith(
    expect.objectContaining({
      input: { Bucket: manifest.storageBucket, Key: manifest.objectKey },
    }),
    { abortSignal: expect.any(AbortSignal) },
  );
});
test.each(["size", "checksum", "png"] as const)(
  "rejects mismatched %s evidence",
  async (change) => {
    const bytes = change === "png" ? Buffer.from("not a captured PNG") : png;
    storage.send.mockResolvedValue({
      ContentLength: bytes.length,
      Body: { transformToByteArray: async () => bytes },
    });
    await expect(
      readStoredFigmaPreview({
        ...manifest,
        byteCount: change === "size" ? png.length + 1 : bytes.length,
        sha256:
          change === "checksum"
            ? "a".repeat(64)
            : createHash("sha256").update(bytes).digest("hex"),
      }),
    ).rejects.toThrow();
  },
);
test("rejects another storage account or oversized manifest before external I/O", async () => {
  await expect(
    readStoredFigmaPreview({
      ...manifest,
      storageBucket: "another-team-store",
    }),
  ).rejects.toThrow();
  await expect(
    readStoredFigmaPreview({ ...manifest, byteCount: 9 * 1024 * 1024 }),
  ).rejects.toThrow();
  expect(storage.send).not.toHaveBeenCalled();
});
