import { createHash } from "node:crypto";

import {
  isMultipartPartWithName,
  parseMultipartMixedResponseAsync,
} from "@expo/multipart-body-parser";
import { describe, expect, test } from "vitest";

import {
  maximumUpdateActivationBytes,
  maximumUpdateAssetBytes,
  maximumUpdateFutureSkewMs,
  maximumUpdateReleaseBytes,
  noUpdateDirectiveSchema,
  rollbackDirectiveSchema,
  updateManifestSchema,
} from "./contracts.js";
import { handleUpdateRequest } from "./protocol.js";
import type { ImmutableWriteResult, StoredText, UpdateStore } from "./store.js";

const origin = "https://updates.example.com";
const adminToken = "test-admin-token-that-is-at-least-32-characters";
const runtimeVersion = "1.0.0";
const createdAt = "2026-08-07T00:00:00.000Z";
const signature = 'sig="dGVzdC1zaWduYXR1cmU=", keyid="main"';

describe("Expo Updates protocol service", () => {
  test("reports when publishing is not configured", async () => {
    const response = await handleUpdateRequest(new Request(`${origin}/admin/current`), {
      store: new MemoryUpdateStore(),
      channel: "staging",
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Publishing is not configured." });
  });

  test("publishes an immutable signed manifest and returns no-update to the current client", async () => {
    const store = new MemoryUpdateStore();
    const health = await request(store, "/health");
    expect(await health.json()).toEqual({
      service: "code2create-updates",
      channel: "staging",
    });
    const release = await uploadAndRegisterRelease(store, "release-1", createdAt);
    const activation = await request(store, `/admin/releases/${release.releaseId}/activate`, {
      method: "POST",
      body: JSON.stringify({ expectedCurrentReleaseId: null }),
    });
    expect(activation.status).toBe(200);

    const manifestResponse = await request(store, "/manifest", {
      headers: updateHeaders("ios"),
    });
    expect(manifestResponse.status).toBe(200);
    const manifestPart = await multipartPart(manifestResponse, "manifest");
    expect(manifestPart.headers.get("expo-signature")).toBe(signature);
    const parsedManifest = updateManifestSchema.parse(JSON.parse(manifestPart.body));
    expect(parsedManifest).toMatchObject({
      id: release.platforms.ios.updateId,
      runtimeVersion,
    });

    const noUpdateResponse = await request(store, "/manifest", {
      headers: {
        ...updateHeaders("ios"),
        "expo-current-update-id": release.platforms.ios.updateId,
      },
    });
    const directivePart = await multipartPart(noUpdateResponse, "directive");
    expect(noUpdateDirectiveSchema.parse(JSON.parse(directivePart.body))).toEqual({
      type: "noUpdateAvailable",
    });

    const assetResponse = await request(store, new URL(parsedManifest.launchAsset.url).pathname);
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get("cache-control")).toContain("immutable");
  });

  test("rejects a release until every referenced asset exists", async () => {
    const store = new MemoryUpdateStore();
    const release = createRelease("release-missing", createdAt, [fixtureAsset("missing")]);
    const response = await request(store, `/admin/releases/${release.releaseId}`, {
      method: "PUT",
      body: JSON.stringify(release),
    });
    expect(response.status).toBe(409);
  });

  test("allows only one publisher to advance the same current pointer", async () => {
    const store = new MemoryUpdateStore();
    const first = await uploadAndRegisterRelease(store, "release-1", createdAt);
    await request(store, `/admin/releases/${first.releaseId}/activate`, {
      method: "POST",
      body: JSON.stringify({ expectedCurrentReleaseId: null }),
    });
    const second = await uploadAndRegisterRelease(store, "release-2", "2026-08-07T00:01:00.000Z");
    const third = await uploadAndRegisterRelease(store, "release-3", "2026-08-07T00:02:00.000Z");

    const responses = await Promise.all([
      request(store, `/admin/releases/${second.releaseId}/activate`, {
        method: "POST",
        body: JSON.stringify({ expectedCurrentReleaseId: first.releaseId }),
      }),
      request(store, `/admin/releases/${third.releaseId}/activate`, {
        method: "POST",
        body: JSON.stringify({ expectedCurrentReleaseId: first.releaseId }),
      }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  });

  test("serves a signed rollback directive and protects publishing routes", async () => {
    const store = new MemoryUpdateStore();
    const unauthorized = await request(
      store,
      "/admin/current?runtimeVersion=1.0.0",
      {
        headers: { authorization: "Bearer wrong" },
      },
      false,
    );
    expect(unauthorized.status).toBe(401);

    const rollback = {
      schemaVersion: 1,
      kind: "rollback",
      channel: "staging",
      runtimeVersion,
      releaseId: "rollback-1",
      createdAt,
      noUpdate: signed({ type: "noUpdateAvailable" }),
      directive: signed({
        type: "rollBackToEmbedded",
        parameters: { commitTime: createdAt },
      }),
    };
    expect(
      (
        await request(store, "/admin/releases/rollback-1", {
          method: "PUT",
          body: JSON.stringify(rollback),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(store, "/admin/releases/rollback-1/activate", {
          method: "POST",
          body: JSON.stringify({ expectedCurrentReleaseId: null }),
        })
      ).status,
    ).toBe(200);

    const response = await request(store, "/manifest", {
      headers: {
        ...updateHeaders("android"),
        "expo-current-update-id": "11111111-1111-4111-8111-111111111111",
        "expo-embedded-update-id": "22222222-2222-4222-8222-222222222222",
      },
    });
    const directive = await multipartPart(response, "directive");
    expect(rollbackDirectiveSchema.parse(JSON.parse(directive.body))).toEqual({
      type: "rollBackToEmbedded",
      parameters: { commitTime: createdAt },
    });
  });

  test.each([
    ["/admin/assets/" + "a".repeat(64), "application/octet-stream", maximumUpdateAssetBytes],
    ["/admin/releases/oversized", "application/json", maximumUpdateReleaseBytes],
    ["/admin/releases/oversized/activate", "application/json", maximumUpdateActivationBytes],
  ])("stops an undeclared oversized write to %s", async (path, contentType, maximumBytes) => {
    const store = new MemoryUpdateStore();
    const body = repeatedBody(maximumBytes + 1);
    const response = await request(store, path, {
      method: path.includes("/activate") ? "POST" : "PUT",
      headers: { "content-type": contentType },
      body,
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Payload too large." });
  });

  test("requires JSON media types for release and activation writes", async () => {
    const store = new MemoryUpdateStore();
    const release = await request(store, "/admin/releases/release-text", {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    const activation = await request(store, "/admin/releases/release-text/activate", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(release.status).toBe(415);
    expect(activation.status).toBe(415);
  });

  test("rejects a future-dated release before it can poison activation order", async () => {
    const store = new MemoryUpdateStore();
    const future = new Date(Date.now() + maximumUpdateFutureSkewMs + 60_000).toISOString();
    const release = createRelease("future-release", future, [fixtureAsset("future")]);
    const response = await request(store, "/admin/releases/future-release", {
      method: "PUT",
      body: JSON.stringify(release),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Release creation time is too far in the future.",
    });
  });
});

function repeatedBody(totalBytes: number) {
  return "a".repeat(totalBytes);
}

async function uploadAndRegisterRelease(
  store: MemoryUpdateStore,
  releaseId: string,
  releaseCreatedAt: string,
) {
  const assets = [fixtureAsset(`${releaseId}-ios`), fixtureAsset(`${releaseId}-android`)];
  for (const asset of assets) {
    const response = await request(store, `/admin/assets/${asset.key}`, {
      method: "PUT",
      headers: { "content-type": asset.contentType },
      body: asset.bytes,
    });
    expect(response.status).toBe(201);
  }
  const release = createRelease(releaseId, releaseCreatedAt, assets);
  const registration = await request(store, `/admin/releases/${releaseId}`, {
    method: "PUT",
    body: JSON.stringify(release),
  });
  expect(registration.status, await registration.clone().text()).toBe(201);
  return release;
}

function createRelease(releaseId: string, releaseCreatedAt: string, assets: FixtureAsset[]) {
  const iosAsset = assets[0] ?? fixtureAsset("fallback-ios");
  const androidAsset = assets[1] ?? iosAsset;
  const iosUpdateId = deterministicUuid(`${releaseId}:ios`);
  const androidUpdateId = deterministicUuid(`${releaseId}:android`);
  return {
    schemaVersion: 1,
    kind: "update" as const,
    channel: "staging" as const,
    runtimeVersion,
    releaseId,
    createdAt: releaseCreatedAt,
    noUpdate: signed({ type: "noUpdateAvailable" }),
    platforms: {
      ios: {
        updateId: iosUpdateId,
        manifest: signed(manifest(iosUpdateId, releaseCreatedAt, iosAsset)),
      },
      android: {
        updateId: androidUpdateId,
        manifest: signed(manifest(androidUpdateId, releaseCreatedAt, androidAsset)),
      },
    },
  };
}

function manifest(updateId: string, releaseCreatedAt: string, asset: FixtureAsset) {
  const described = {
    hash: asset.hash,
    key: asset.key,
    fileExtension: ".bundle",
    contentType: asset.contentType,
    url: `${origin}/assets/${asset.key}`,
  };
  return {
    id: updateId,
    createdAt: releaseCreatedAt,
    runtimeVersion,
    assets: [],
    launchAsset: described,
    metadata: {},
    extra: { expoClient: { name: "Code2Create Ops" } },
  };
}

function signed(value: object) {
  return { body: JSON.stringify(value), signature };
}

function fixtureAsset(value: string): FixtureAsset {
  const bytes = new TextEncoder().encode(value);
  return {
    bytes,
    key: createHash("sha256").update(bytes).digest("hex"),
    hash: createHash("sha256").update(bytes).digest("base64url"),
    contentType: "application/javascript",
  };
}

function deterministicUuid(seed: string) {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function updateHeaders(platform: "ios" | "android") {
  return {
    "expo-protocol-version": "1",
    "expo-runtime-version": runtimeVersion,
    "expo-platform": platform,
    "expo-expect-signature": "true",
  };
}

async function request(
  store: UpdateStore,
  path: string,
  init: RequestInit = {},
  authenticated = true,
) {
  const headers = new Headers(init.headers);
  if (authenticated && path.startsWith("/admin/")) {
    headers.set("authorization", `Bearer ${adminToken}`);
  }
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return handleUpdateRequest(new Request(`${origin}${path}`, { ...init, headers }), {
    store,
    channel: "staging",
    adminToken,
  });
}

async function multipartPart(response: Response, name: string) {
  const contentType = response.headers.get("content-type");
  if (!contentType) throw new Error("Multipart response has no content type.");
  const parts = await parseMultipartMixedResponseAsync(
    contentType,
    Buffer.from(await response.arrayBuffer()),
  );
  const part = parts.find((candidate) => isMultipartPartWithName(candidate, name));
  if (!part) throw new Error(`Multipart response has no ${name} part.`);
  return part;
}

interface FixtureAsset {
  bytes: Uint8Array<ArrayBuffer>;
  key: string;
  hash: string;
  contentType: string;
}

class MemoryUpdateStore implements UpdateStore {
  private readonly assets = new Map<
    string,
    { bytes: ArrayBuffer; contentType: string; sha256: string }
  >();
  private readonly releases = new Map<string, StoredText>();
  private readonly current = new Map<string, StoredText>();
  private nextEtag = 1;

  async getAsset(key: string) {
    const asset = this.assets.get(key);
    if (!asset) return null;
    const body = new Response(asset.bytes).body;
    if (!body) throw new Error("The fixture asset has no response body.");
    return { body, contentType: asset.contentType, sha256: asset.sha256 };
  }

  async hasAsset(key: string) {
    return this.assets.has(key);
  }

  async putAssetIfAbsent(
    key: string,
    bytes: ArrayBuffer,
    contentType: string,
  ): Promise<ImmutableWriteResult> {
    const existing = this.assets.get(key);
    if (existing) {
      return arraysEqual(new Uint8Array(existing.bytes), new Uint8Array(bytes)) &&
        existing.contentType === contentType
        ? "unchanged"
        : "conflict";
    }
    this.assets.set(key, { bytes, contentType, sha256: key });
    return "created";
  }

  async getRelease(releaseId: string) {
    return this.releases.get(releaseId) ?? null;
  }

  async putReleaseIfAbsent(releaseId: string, body: string): Promise<ImmutableWriteResult> {
    const existing = this.releases.get(releaseId);
    if (existing) return existing.body === body ? "unchanged" : "conflict";
    this.releases.set(releaseId, this.storedText(body));
    return "created";
  }

  async getCurrent(version: string) {
    await Promise.resolve();
    return this.current.get(version) ?? null;
  }

  async putCurrent(version: string, body: string, expectedEtag: string | null) {
    const existing = this.current.get(version);
    if ((existing?.etag ?? null) !== expectedEtag) return false;
    this.current.set(version, this.storedText(body));
    return true;
  }

  private storedText(body: string) {
    const value = { body, etag: String(this.nextEtag) };
    this.nextEtag += 1;
    return value;
  }
}

function arraysEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
