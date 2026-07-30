import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

const authSecret = "test-auth-secret-with-enough-entropy";
const docsPassword = "test-docs-password";

process.env.AUTH_SECRET = authSecret;
process.env.DOCS_PASSWORD = docsPassword;

async function fetchApp(path = "/", init = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set(
    "test",
    `${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, init),
    {
      AUTH_SECRET: authSecret,
      DOCS_PASSWORD: docsPassword,
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

function authenticatedCookie() {
  const expiresAt = String(Date.now() + 60_000);
  const signature = createHmac("sha256", authSecret)
    .update(expiresAt)
    .digest("base64url");
  return `c2c_specs_session=${expiresAt}.${signature}`;
}

test("redirects an anonymous handbook request to login", async () => {
  const response = await fetchApp("/");
  assert.equal(response.status, 307);
  assert.equal(new URL(response.headers.get("location")).pathname, "/login");
});

test("renders the minimal password screen", async () => {
  const response = await fetchApp("/login", {
    headers: { accept: "text/html" },
  });
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /Code2Create 7\.0 — Platform Specifications/);
  assert.match(html, /Shared access password/);
  assert.match(html, /Restricted working document/);
  assert.doesNotMatch(html, /vinext-starter|Your site is taking shape/i);
});

test("accepts the configured password and issues a session cookie", async () => {
  const response = await fetchApp("/api/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: docsPassword }),
    redirect: "manual",
  });

  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get("location")).pathname, "/");
  assert.match(response.headers.get("set-cookie") ?? "", /c2c_specs_session=/);
});

test("server-renders the authenticated Code2Create handbook", async () => {
  const response = await fetchApp("/", {
    headers: {
      accept: "text/html",
      cookie: authenticatedCookie(),
    },
  });
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /Code2Create 7\.0/);
  assert.match(html, /Production architecture/);
  assert.match(html, /Data model &amp; realtime/);
  assert.match(html, /Integrations &amp; release/);
  assert.match(html, /Better Auth/);
  assert.match(html, /VIT Student/);
  assert.match(html, /GitHub App/);
  assert.match(html, /code2create-7-0/);
  assert.match(html, /file_content:read/);
  assert.match(html, /@convex-dev\/workpool/);
  assert.match(html, /team-scoped/i);
  assert.match(html, /maxActiveGitHubRepositoriesPerTeam/);
  assert.match(html, /backend_api/);
  assert.match(html, /evidenceCheckpointSets/);
  assert.match(html, /What is your project about\?/);
  assert.match(html, /OpenAI Responses API/);
  assert.match(html, /Structured Outputs/);
  assert.match(html, /store: false/);
  assert.match(html, /trackCatalogVersions/);
  assert.match(html, /intakeFlowVersions/);
  assert.match(html, /intakeModelConfigVersions/);
  assert.match(html, /deterministic fallback/i);
  assert.doesNotMatch(
    html,
    /vinext-starter|Workspace Auth Headers|Sign in with ChatGPT|Clerk with Google-only|does not fetch full document content|does not read the full design document|one selected repository|grants one primary repository|binds one team to one repository|The required prompts are:/i,
  );
});
