import { githubSyncProtocolVersion, type GithubRepositorySyncRequest } from "@code2create/domain";
import { describe, expect, test } from "vitest";

import { githubAppJwt } from "./githubApp.ts";
import { reconcileRepository } from "./githubSync.ts";

const request: GithubRepositorySyncRequest = {
  protocolVersion: githubSyncProtocolVersion,
  bindingId: "binding-1",
  syncRevision: 4,
  installationId: "52001",
  repositoryId: "9001",
  owner: "measured-moon",
  name: "portal",
  trackedBranch: "main",
  baselineSha: "a".repeat(40),
  requiredTopic: "code2create-7",
};

function pem(label: string, bytes: ArrayBuffer) {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const lines = base64.match(/.{1,64}/gu) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

async function generatedKeyPair() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in pair)) throw new Error("Expected an RSA key pair.");
  const exported = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  if (!(exported instanceof ArrayBuffer)) throw new Error("Expected PKCS#8 bytes.");
  return { pkcs8: exported, publicKey: pair.publicKey };
}

async function appKeyPair() {
  const pair = await generatedKeyPair();
  return { privateKey: pem("PRIVATE KEY", pair.pkcs8), publicKey: pair.publicKey };
}

function json(value: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  return new Response(JSON.stringify(value), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;

function providerFetch(routes: Record<string, Route>, calls: { url: string; auth: string | null }[]) {
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    calls.push({ url: `${url.pathname}${url.search}`, auth: headers.get("authorization") });
    const route = routes[`${init?.method ?? "GET"} ${url.pathname}`];
    if (!route) return json({ message: "Not Found" }, { status: 404 });
    return route(url, init ?? {});
  };
  return fetcher;
}

const repository = {
  id: 9001,
  name: "portal",
  full_name: "measured-moon/portal",
  html_url: "https://github.com/measured-moon/portal",
  private: false,
  fork: false,
  default_branch: "main",
  owner: { login: "measured-moon" },
};

describe("GitHub App reconciliation", () => {
  test("mints a repository-scoped installation token and reports the compared head", async () => {
    const keys = await appKeyPair();
    const calls: { url: string; auth: string | null }[] = [];
    let installationBody: unknown;
    const fetcher = providerFetch(
      {
        "POST /app/installations/52001/access_tokens": (_url, init) => {
          installationBody = JSON.parse(String(init.body));
          return json({ token: "ghs_installation", expires_at: "2027-08-08T10:00:00Z" }, { status: 201 });
        },
        "GET /repos/measured-moon/portal": () => json(repository),
        "GET /repos/measured-moon/portal/topics": () => json({ names: ["code2create-7", "hackathon"] }),
        "GET /repos/measured-moon/portal/languages": () => json({ CSS: 200, TypeScript: 1500 }),
        "GET /repos/measured-moon/portal/branches/main": () =>
          json({
            commit: {
              sha: "b".repeat(40),
              commit: { committer: { date: "2027-08-08T09:30:00Z" }, author: null },
            },
          }),
        [`GET /repos/measured-moon/portal/compare/${"a".repeat(40)}...${"b".repeat(40)}`]: () =>
          json({
            total_commits: 2,
            commits: [{ sha: "c".repeat(40) }, { sha: "d".repeat(40) }],
            files: [
              { filename: "src/app.ts", additions: 30, deletions: 5 },
              { filename: "README.md", additions: 10, deletions: 0 },
            ],
          }),
      },
      calls,
    );

    const settlement = await reconcileRepository(
      request,
      { appId: "303", privateKey: keys.privateKey },
      fetcher,
      () => 1_800_000_000_000,
    );

    expect(settlement).toEqual({
      protocolVersion: githubSyncProtocolVersion,
      bindingId: "binding-1",
      syncRevision: 4,
      completedAt: 1_800_000_000_000,
      status: "succeeded",
      observation: {
        repositoryId: "9001",
        owner: "measured-moon",
        name: "portal",
        fullName: "measured-moon/portal",
        url: "https://github.com/measured-moon/portal",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        topicState: "present",
        headSha: "b".repeat(40),
        providerCommitAt: Date.parse("2027-08-08T09:30:00Z"),
        commitCount: 2,
        additions: 40,
        deletions: 5,
        changedFiles: 2,
        observedCommitShas: ["c".repeat(40), "d".repeat(40)],
        commitIdentityComplete: true,
        languageBytes: [
          { language: "TypeScript", bytes: 1500 },
          { language: "CSS", bytes: 200 },
        ],
        completeness: "complete",
        compareTruncated: false,
      },
    });
    expect(installationBody).toEqual({
      repository_ids: [9001],
      permissions: { contents: "read", metadata: "read" },
    });
    const tokenCall = calls.find((call) => call.url.startsWith("/app/installations/"));
    expect(tokenCall?.auth?.startsWith("Bearer ey")).toBe(true);
    const jwt = tokenCall?.auth?.slice("Bearer ".length) ?? "";
    const [header, payload, signature] = jwt.split(".");
    const decode = (part: string) =>
      Uint8Array.from(atob(part.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
    expect(JSON.parse(new TextDecoder().decode(decode(header ?? "")))).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(new TextDecoder().decode(decode(payload ?? "")))).toMatchObject({ iss: "303" });
    expect(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        keys.publicKey,
        decode(signature ?? ""),
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).toBe(true);
    expect(calls.filter((call) => call.auth === "Bearer ghs_installation")).toHaveLength(5);
  });

  test("filters a project root and marks root-scoped comparisons partial", async () => {
    const keys = await appKeyPair();
    const fetcher = providerFetch(
      {
        "POST /app/installations/52001/access_tokens": () => json({ token: "ghs_x" }, { status: 201 }),
        "GET /repos/measured-moon/portal": () => json(repository),
        "GET /repos/measured-moon/portal/topics": () => json({ names: [] }),
        "GET /repos/measured-moon/portal/languages": () => json({}),
        "GET /repos/measured-moon/portal/branches/main": () =>
          json({ commit: { sha: "b".repeat(40), commit: { committer: null, author: null } } }),
        "GET /repos/measured-moon/portal/contents/apps/web": () => json([]),
        [`GET /repos/measured-moon/portal/compare/${"a".repeat(40)}...${"b".repeat(40)}`]: () =>
          json({
            total_commits: 1,
            commits: [{ sha: "c".repeat(40) }],
            files: [
              { filename: "apps/web/index.ts", additions: 3, deletions: 1 },
              { filename: "apps/webs/other.ts", additions: 9, deletions: 9 },
            ],
          }),
      },
      [],
    );

    const settlement = await reconcileRepository(
      { ...request, rootPath: "apps/web" },
      { appId: "303", privateKey: keys.privateKey },
      fetcher,
    );

    expect(settlement).toMatchObject({
      status: "succeeded",
      observation: {
        topicState: "missing",
        additions: 3,
        deletions: 1,
        changedFiles: 1,
        observedCommitShas: [],
        commitIdentityComplete: false,
        completeness: "partial",
      },
    });
  });

  test("settles provider rate limits, missing repositories, and identity mismatches", async () => {
    const keys = await appKeyPair();
    const configuration = { appId: "303", privateKey: keys.privateKey };
    const token = { "POST /app/installations/52001/access_tokens": () => json({ token: "ghs_x" }, { status: 201 }) };

    const limited = await reconcileRepository(
      request,
      configuration,
      providerFetch(
        {
          ...token,
          "GET /repos/measured-moon/portal": () =>
            json({ message: "rate limited" }, {
              status: 403,
              headers: { "x-ratelimit-remaining": "0", "retry-after": "120" },
            }),
        },
        [],
      ),
    );
    expect(limited).toMatchObject({
      status: "rate_limited",
      errorCode: "github_rate_limited",
      retryAfterMs: 120_000,
    });

    const missing = await reconcileRepository(request, configuration, providerFetch(token, []));
    expect(missing).toMatchObject({ status: "failed", errorCode: "github_not_found" });

    const mismatched = await reconcileRepository(
      request,
      configuration,
      providerFetch(
        {
          ...token,
          "GET /repos/measured-moon/portal": () => json({ ...repository, id: 1 }),
          "GET /repos/measured-moon/portal/topics": () => json({ names: [] }),
          "GET /repos/measured-moon/portal/languages": () => json({}),
          "GET /repos/measured-moon/portal/branches/main": () =>
            json({ commit: { sha: "b".repeat(40), commit: { committer: null, author: null } } }),
        },
        [],
      ),
    );
    expect(mismatched).toMatchObject({ status: "failed", errorCode: "repository_id_mismatch" });
  });

  test("accepts PKCS#1 keys as GitHub issues them", async () => {
    const pkcs1 = pem("RSA PRIVATE KEY", pkcs1FromPkcs8((await generatedKeyPair()).pkcs8));
    const jwt = await githubAppJwt({ appId: "303", privateKey: pkcs1 });
    expect(jwt.split(".")).toHaveLength(3);
  });
});

/** Strips the PKCS#8 wrapper so the fixture matches GitHub's PEM download format. */
function pkcs1FromPkcs8(pkcs8: ArrayBuffer) {
  const bytes = new Uint8Array(pkcs8);
  // PrivateKeyInfo: SEQUENCE { version, algorithm, OCTET STRING privateKey }
  let offset = 0;
  const readHeader = () => {
    offset += 1;
    let length = bytes[offset] ?? 0;
    offset += 1;
    if (length & 0x80) {
      const size = length & 0x7f;
      length = 0;
      for (let index = 0; index < size; index += 1) {
        length = (length << 8) | (bytes[offset] ?? 0);
        offset += 1;
      }
    }
    return length;
  };
  readHeader(); // outer SEQUENCE
  const versionLength = readHeader();
  offset += versionLength;
  const algorithmLength = readHeader();
  offset += algorithmLength;
  const keyLength = readHeader();
  return bytes.slice(offset, offset + keyLength).buffer;
}
