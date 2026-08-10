import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, describe, expect, test } from "vitest";

import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { insertPermissionGrant } from "./lib/permissions.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

const savedEnvironment = {
  AUTH_SITE_URL: process.env.AUTH_SITE_URL,
  PARTICIPANT_SITE_URL: process.env.PARTICIPANT_SITE_URL,
  OPERATIONS_SITE_URL: process.env.OPERATIONS_SITE_URL,
  HANDBOOK_SITE_URL: process.env.HANDBOOK_SITE_URL,
};

process.env.AUTH_SITE_URL = "http://localhost:3211";
process.env.PARTICIPANT_SITE_URL = "http://localhost:4173";
process.env.OPERATIONS_SITE_URL = "http://localhost:4174";
process.env.HANDBOOK_SITE_URL = "http://localhost:4175";

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("intelligence observability", () => {
  test("the overview needs the intelligence read grant", async () => {
    const backend = seededBackend();
    const fixture = await seedActivity(backend);
    const outsider = backend.withIdentity({
      subject: fixture.outsiderAuthUserId,
      sessionId: fixture.outsiderAuthSessionId,
    });
    await expect(
      outsider.query(api.intelligenceObservability.overview, {
        eventSlug: fixture.eventSlug,
      }),
    ).rejects.toThrow();
  });

  test("brief runs, automation cadence, and copilot instances come back grouped", async () => {
    const backend = seededBackend();
    const fixture = await seedActivity(backend);
    const viewer = backend.withIdentity({
      subject: fixture.viewerAuthUserId,
      sessionId: fixture.viewerAuthSessionId,
    });
    const overview = await viewer.query(api.intelligenceObservability.overview, {
      eventSlug: fixture.eventSlug,
    });

    // Newest run first: the in-flight one, then the settled one with its
    // headline and outcome intact.
    expect(overview.briefRuns.map((run) => run.state)).toEqual(["accepted", "succeeded"]);
    expect(overview.briefRuns[1]).toMatchObject({
      origin: "automation",
      headline: "Queue pressure is the story",
      model: "cloudflare/test-model",
    });

    expect(overview.automation).toMatchObject({
      state: "active",
      briefsStartedToday: 1,
      maximumBriefsPerLocalDay: 4,
      cooldownMinutes: 30,
      accountableOwner: "Operations lead",
    });

    // Two recommendations in one conversation fold into one instance; the
    // lone one in another conversation stands alone and sorts by recency.
    expect(overview.copilotInstances.map((instance) => instance.instanceId)).toEqual([
      `copilot:${fixture.eventSlug}:conversation-busy`,
      `copilot:${fixture.eventSlug}:conversation-quiet`,
    ]);
    const busy = overview.copilotInstances[0];
    expect(busy).toMatchObject({ conversationId: "conversation-busy", openCount: 1 });
    expect(busy?.recommendations).toHaveLength(2);
    expect(busy?.recommendations.map((recommendation) => recommendation.status)).toEqual([
      "proposed",
      "approved",
    ]);
    expect(busy?.recommendations[0]?.citedReads).toEqual(["support_load"]);
  });
});

function seededBackend() {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return backend;
}

/**
 * One event with the full activity surface populated: an active automation
 * state over a published policy, one settled and one in-flight brief run, and
 * three recommendations across two copilot conversations. The viewer holds
 * the intelligence read; the outsider holds nothing.
 */
async function seedActivity(backend: BackendTest) {
  const now = Date.now();
  const eventSlug = `observability-${crypto.randomUUID()}`;
  const viewerAuthUserId = await createAuthUser(backend, now, "viewer");
  const viewerAuthSessionId = await createAuthSession(backend, viewerAuthUserId, now);
  const outsiderAuthUserId = await createAuthUser(backend, now, "outsider");
  const outsiderAuthSessionId = await createAuthSession(backend, outsiderAuthUserId, now);

  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Observability fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const viewer = await insertAccount(ctx, eventId, "viewer", now, viewerAuthUserId);
    await insertAccount(ctx, eventId, "outsider", now, outsiderAuthUserId);
    await insertPermissionGrant(ctx, {
      eventId,
      personId: viewer.personId,
      eventAccessSubjectId: viewer.subjectId,
      permissionKey: "operations.intelligence.read",
      scopeType: "event",
      sourceType: "manual",
      sourceId: `${eventSlug}:operations.intelligence.read`,
      grantedByPersonId: viewer.personId,
      reason: "Observability test",
    });

    const policyVersionId = await ctx.db.insert("operationsIntelligencePolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      enabled: true,
      triggerSeverities: ["critical"],
      triggerAreas: ["reviews"],
      cooldownMinutes: 30,
      maximumBriefsPerLocalDay: 4,
      relevanceMinutes: 45,
      accountableOwner: "Operations lead",
      audience: "operations_dashboard",
      checksum: "fixture-policy",
      createdByPersonId: viewer.personId,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.insert("operationsIntelligenceAutomationStates", {
      eventId,
      policyVersionId,
      state: "active",
      nextEvaluationAt: now + 60_000,
      lastEvaluatedAt: now - 30_000,
      lastTriggerAt: now - 10 * 60_000,
      cycle: 1,
      localBudgetDate: "2026-08-10",
      briefsStartedToday: 1,
      version: 3,
      updatedAt: now,
    });

    await ctx.db.insert("operationsIntelligenceBriefs", {
      eventId,
      origin: "automation",
      automationPolicyVersionId: policyVersionId,
      state: "succeeded",
      headline: "Queue pressure is the story",
      summary: "Two panels carry the whole queue.",
      priorities: [],
      agentVersion: "operations-brief-v1",
      model: "cloudflare/test-model",
      requestedAt: now - 20 * 60_000,
      workerAcceptedAt: now - 19 * 60_000,
      completedAt: now - 18 * 60_000,
      updatedAt: now - 18 * 60_000,
      version: 3,
    });
    await ctx.db.insert("operationsIntelligenceBriefs", {
      eventId,
      requestedByPersonId: viewer.personId,
      origin: "manual",
      state: "accepted",
      workerAcceptedAt: now - 60_000,
      requestedAt: now - 2 * 60_000,
      updatedAt: now - 60_000,
      version: 2,
    });

    const recommendation = (
      conversationId: string,
      key: string,
      status: "proposed" | "approved",
      proposedAt: number,
    ) =>
      ctx.db.insert("intelligenceRecommendations", {
        eventId,
        proposalKey: `${conversationId}:${key}`,
        conversationId,
        arguments: {
          kind: "open_support_case",
          category: "queue",
          description: "The reads disagree about the queue depth.",
        },
        statement: `Open a support case (${key}).`,
        reasoning: "support_load shows an unattributable backlog.",
        citations: [
          { read: "support_load", generatedAt: proposedAt, keys: ["open_cases"] },
        ],
        status,
        agentVersion: "operations-copilot-v1",
        model: "cloudflare/test-model",
        proposedAt,
        ...(status === "approved"
          ? { decidedByPersonId: viewer.personId, decidedAt: proposedAt + 60_000 }
          : {}),
        version: status === "approved" ? 2 : 1,
        createdAt: proposedAt,
        updatedAt: proposedAt,
      });
    await recommendation("conversation-busy", "first", "approved", now - 40 * 60_000);
    await recommendation("conversation-busy", "second", "proposed", now - 5 * 60_000);
    await recommendation("conversation-quiet", "only", "proposed", now - 60 * 60_000);

    return {
      eventSlug,
      eventId,
      viewerAuthUserId,
      viewerAuthSessionId,
      outsiderAuthUserId,
      outsiderAuthSessionId,
    };
  });
}

async function insertAccount(
  ctx: Parameters<Parameters<BackendTest["run"]>[0]>[0],
  eventId: Id<"events">,
  key: string,
  now: number,
  authUserId?: string,
) {
  const email = `${key}-${crypto.randomUUID()}@example.test`;
  const personId = await ctx.db.insert("people", {
    authUserId: authUserId ?? `${key}-${crypto.randomUUID()}`,
    googleSubject: `google-${key}-${crypto.randomUUID()}`,
    verifiedEmail: email,
    displayName: `${key} person`,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const subjectId = await ctx.db.insert("eventAccessSubjects", {
    eventId,
    personId,
    emailNormalized: email,
    displayName: `${key} person`,
    status: "active",
    linkedBy: "access_invitation",
    accessVersion: 1,
    createdAt: now,
    updatedAt: now,
  });
  return { personId, subjectId };
}

async function createAuthUser(backend: BackendTest, now: number, key: string) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: `Observability ${key}`,
        email: `observability-${key}-${crypto.randomUUID()}@example.test`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  return documentId(result, "Better Auth user");
}

async function createAuthSession(backend: BackendTest, userId: string, now: number) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        expiresAt: now + 60 * 60 * 1_000,
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        userId,
      },
    },
  });
  return documentId(result, "Better Auth session");
}

function documentId(value: unknown, label: string): string {
  if (typeof value !== "object" || value === null || !("_id" in value)) {
    throw new Error(`${label} did not return a document ID.`);
  }
  const id = value._id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${label} returned an invalid document ID.`);
  }
  return id;
}
