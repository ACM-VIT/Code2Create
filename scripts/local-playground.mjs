import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { parseEnv } from "node:util";

const root = new URL("../", import.meta.url);
const environment = parseEnv(readFileSync(new URL("apps/backend/.env.local", root), "utf8"));
if (!/^(local|anonymous):/.test(environment.CONVEX_DEPLOYMENT ?? "") || environment.CONVEX_URL !== "http://127.0.0.1:3210") {
  throw new Error("The playground requires the local development backend.");
}
const requireBackend = createRequire(new URL("apps/backend/package.json", root));
const { ConvexHttpClient } = requireBackend("convex/browser");
const { makeFunctionReference } = requireBackend("convex/server");
const configuration = JSON.parse(readFileSync(new URL("apps/backend/.convex/local/default/config.json", root), "utf8"));
const accounts = JSON.parse(readFileSync(new URL("outputs/dev/accounts.json", root), "utf8"));
const admin = new ConvexHttpClient(environment.CONVEX_URL);
admin.setAdminAuth(configuration.adminKey);
const peers = (accounts.reviewerDevices ?? []).flatMap(device => {
  const person = accounts.reviewers.find(reviewer => reviewer.personId === device.personId);
  if (!person || person.key === "local-reviewer") return [];
  const client = new ConvexHttpClient(environment.CONVEX_URL);
  client.setAdminAuth(configuration.adminKey, {
    subject: person.authUserId, sessionId: person.sessionId,
    issuer: "http://localhost:3211", tokenIdentifier: `http://localhost:3211|${person.authUserId}`,
  });
  return [{ client, installationId: device.installationId }];
});

// These are fixture phones. The simulator keeps its own real foreground heartbeat.
async function heartbeat() {
  let failed = 0;
  for (const peer of peers) {
    try {
      await peer.client.mutation(makeFunctionReference("reviewer:heartbeat"), {
        eventSlug: "code2create-7", roundId: accounts.roundId, installationId: peer.installationId,
      });
    } catch { failed += 1; }
  }
  if (failed) console.error(`${failed} simulated reviewer heartbeats failed; check the local backend.`);
}
await heartbeat();
const timer = setInterval(() => { void heartbeat(); }, 45_000);

// The normal one-time-token flow signs in each origin independently. No tokens
// are printed, and this development helper only listens on loopback.
const server = createServer((request, response) => { void handleLogin(request, response); });
async function handleLogin(request, response) {
  const target = request.url === "/web"
    ? { account: accounts.participants[0], port: 5180 }
    : request.url === "/ops" ? { account: accounts.owner, port: 5181 } : null;
  if (request.method !== "GET" || !target) {
    response.writeHead(404).end();
    return;
  }
  try {
    const token = await admin.mutation(makeFunctionReference("developmentSeed:createLoginToken"), { sessionToken: target.account.token });
    response.writeHead(302, {
      Location: `http://localhost:${target.port}/?ott=${encodeURIComponent(token)}`,
      "Cache-Control": "no-store",
    }).end();
  } catch {
    response.writeHead(503).end("Start the local backend and run pnpm dev:seed first.");
  }
}
server.listen(5190, "127.0.0.1", () => console.log("Local logins: http://127.0.0.1:5190/web and http://127.0.0.1:5190/ops"));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  clearInterval(timer);
  server.close();
});
