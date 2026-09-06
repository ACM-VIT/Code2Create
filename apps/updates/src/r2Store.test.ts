import { describe, expect, it, vi } from "vitest";
import { R2UpdateStore } from "./r2Store.js";

const key = "a".repeat(64);
const contentType = "application/javascript";

function storedAsset(size: number): R2Object {
  return {
    key: `assets/${key}`, version: "one", size, etag: "etag", httpEtag: '"etag"',
    uploaded: new Date(0), storageClass: "Standard", checksums: { toJSON: () => ({}) },
    customMetadata: { sha256: key }, httpMetadata: { contentType }, writeHttpMetadata: vi.fn(),
  };
}

function setup() {
  const bucket = {
    get: vi.fn<R2Bucket["get"]>(), head: vi.fn<R2Bucket["head"]>(),
    put: vi.fn<(key: string, value: string | ArrayBuffer, options: R2PutOptions) => Promise<R2Object | null>>(),
  };
  return { bucket, store: new R2UpdateStore(bucket) };
}

describe("immutable update assets", () => {
  it("does not send an existing large bundle through R2 put again", async () => {
    const { bucket, store } = setup();
    const bytes = new ArrayBuffer(6_200_000);
    bucket.head.mockResolvedValue(storedAsset(bytes.byteLength));
    bucket.put.mockRejectedValue(new Error("Network connection lost."));
    expect(await store.putAssetIfAbsent(key, bytes, contentType)).toBe("unchanged");
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it.each(["size", "hash", "content type"])("rejects an existing asset with different %s", async field => {
    const { bucket, store } = setup();
    const stored = {
      ...storedAsset(field === "size" ? 5 : 4),
      writeHttpMetadata: vi.fn(),
      ...(field === "hash" ? { customMetadata: { sha256: "b".repeat(64) } } : {}),
      ...(field === "content type" ? { httpMetadata: { contentType: "image/png" } } : {}),
    };
    bucket.head.mockResolvedValue(stored);
    expect(await store.putAssetIfAbsent(key, new ArrayBuffer(4), contentType)).toBe("conflict");
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it("keeps the conditional write when an asset is new", async () => {
    const { bucket, store } = setup();
    bucket.head.mockResolvedValue(null);
    bucket.put.mockResolvedValue(storedAsset(4));
    const bytes = new ArrayBuffer(4);
    expect(await store.putAssetIfAbsent(key, bytes, contentType)).toBe("created");
    expect(bucket.put).toHaveBeenCalledWith(`assets/${key}`, bytes, expect.objectContaining({ onlyIf: { etagDoesNotMatch: "*" } }));
  });

  it("accepts the same asset winning a concurrent upload", async () => {
    const { bucket, store } = setup();
    bucket.head.mockResolvedValueOnce(null).mockResolvedValueOnce(storedAsset(4));
    bucket.put.mockResolvedValue(null);
    expect(await store.putAssetIfAbsent(key, new ArrayBuffer(4), contentType)).toBe("unchanged");
  });

  it("does not hide a failed write of a new asset", async () => {
    const { bucket, store } = setup();
    bucket.head.mockResolvedValue(null);
    bucket.put.mockRejectedValue(new Error("Network connection lost."));
    await expect(store.putAssetIfAbsent(key, new ArrayBuffer(4), contentType)).rejects.toThrow("Network connection lost.");
  });
});
