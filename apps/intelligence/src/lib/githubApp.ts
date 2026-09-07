import * as v from "valibot";

import { readBoundedJsonResponse } from "./boundedHttpBody.ts";

const githubApiOrigin = "https://api.github.com";
const githubApiVersion = "2026-03-10";
const githubRequestTimeoutMs = 30_000;
const githubResponseMaximumBytes = 4 * 1024 * 1024;
const encoder = new TextEncoder();

export type GithubAppConfiguration = { appId: string; privateKey: string };

/** One provider outcome the reconciliation can settle without a stack trace. */
export class GithubProviderError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, retryAfterMs?: number) {
    super(`GitHub responded with HTTP ${status}.`);
    this.name = "GithubProviderError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }

  get rateLimited() {
    return this.retryAfterMs !== undefined;
  }
}

export class GithubResponseInvalidError extends Error {
  constructor(label: string) {
    super(`GitHub returned an invalid ${label}.`);
    this.name = "GithubResponseInvalidError";
  }
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64Decode(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function derLength(length: number) {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function derSequence(...parts: Uint8Array[]) {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(1 + derLength(length).byteLength + length);
  result.set([0x30], 0);
  result.set(derLength(length), 1);
  let offset = 1 + derLength(length).byteLength;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

/** GitHub issues PKCS#1 keys; WebCrypto imports only PKCS#8, so wrap the DER body. */
function pkcs8FromPkcs1(pkcs1: Uint8Array) {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaEncryption = Uint8Array.of(
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  );
  const privateKey = new Uint8Array(1 + derLength(pkcs1.byteLength).byteLength + pkcs1.byteLength);
  privateKey.set([0x04], 0);
  privateKey.set(derLength(pkcs1.byteLength), 1);
  privateKey.set(pkcs1, 1 + derLength(pkcs1.byteLength).byteLength);
  return derSequence(version, rsaEncryption, privateKey);
}

async function importAppPrivateKey(pem: string) {
  const normalized = pem.replaceAll("\\n", "\n").trim();
  const pkcs1 = normalized.includes("-----BEGIN RSA PRIVATE KEY-----");
  const body = normalized
    .replace(/-----BEGIN [A-Z ]+-----/u, "")
    .replace(/-----END [A-Z ]+-----/u, "")
    .replace(/\s+/gu, "");
  if (body.length === 0) throw new Error("GITHUB_APP_PRIVATE_KEY is not a PEM private key.");
  const der = base64Decode(body);
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs1 ? pkcs8FromPkcs1(der) : der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** Signs the short-lived App JWT GitHub requires before minting installation tokens. */
export async function githubAppJwt(configuration: GithubAppConfiguration, now = Date.now()) {
  const appId = configuration.appId.trim();
  if (!/^\d{1,20}$/u.test(appId)) throw new Error("GITHUB_APP_ID must be a numeric App ID.");
  const issuedAt = Math.floor(now / 1000) - 60;
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64UrlEncode(
    encoder.encode(JSON.stringify({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: appId })),
  );
  const key = await importAppPrivateKey(configuration.privateKey);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function retryAfterMs(headers: Headers, now: number) {
  const retryAfter = Number(headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter * 1000);
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return Math.max(1_000, reset * 1000 - now);
  return 60_000;
}

function rateLimited(status: number, headers: Headers) {
  return (
    status === 429 ||
    (status === 403 &&
      (headers.get("x-ratelimit-remaining") === "0" || headers.get("retry-after") !== null))
  );
}

export type GithubRequester = (
  path: string,
  init?: { method?: "GET" | "POST"; body?: string },
) => Promise<{ status: number; value: unknown }>;

/** Bounded, versioned GitHub REST access with one bearer token and one deadline per call. */
export function githubRequester(token: string, request: typeof fetch): GithubRequester {
  return async (path, init) => {
    const response = await request(new URL(path, githubApiOrigin), {
      method: init?.method ?? "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": githubApiVersion,
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init?.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(githubRequestTimeoutMs),
    });
    if (rateLimited(response.status, response.headers)) {
      throw new GithubProviderError(response.status, retryAfterMs(response.headers, Date.now()));
    }
    if (response.status < 200 || response.status >= 300) {
      throw new GithubProviderError(response.status);
    }
    if (response.status === 204) return { status: response.status, value: null };
    return {
      status: response.status,
      value: await readBoundedJsonResponse(response, githubResponseMaximumBytes),
    };
  };
}

const installationTokenSchema = v.object({ token: v.pipe(v.string(), v.minLength(1)) });

/** Mints an installation token restricted to one repository and read permissions. */
export async function repositoryInstallationRequester(
  configuration: GithubAppConfiguration,
  installationId: string,
  repositoryId: string,
  request: typeof fetch,
) {
  if (!/^\d{1,20}$/u.test(installationId) || !/^\d{1,20}$/u.test(repositoryId)) {
    throw new GithubResponseInvalidError("installation or repository identifier");
  }
  const appRequester = githubRequester(await githubAppJwt(configuration), request);
  const minted = await appRequester(`/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    body: JSON.stringify({
      repository_ids: [Number(repositoryId)],
      permissions: { contents: "read", metadata: "read" },
    }),
  });
  const parsed = v.safeParse(installationTokenSchema, minted.value);
  if (!parsed.success) throw new GithubResponseInvalidError("installation token");
  return githubRequester(parsed.output.token, request);
}
