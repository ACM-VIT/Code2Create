import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";

import {
  operationsBriefStreamTicketSignatureContext,
  operationsCopilotIngressSignatureContext,
  operationsCopilotStreamTicketSignatureContext,
  signServiceBody,
  verifyServiceBody,
} from "@code2create/domain";

import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ConvexError } from "convex/values";
import {
  parseIntelligenceWorkerOrigin,
  validateIntelligenceHmacSecret,
} from "./lib/intelligenceServiceConfiguration.ts";
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
  INTELLIGENCE_INGRESS_SECRET: process.env.INTELLIGENCE_INGRESS_SECRET,
  INTELLIGENCE_STREAM_SECRET: process.env.INTELLIGENCE_STREAM_SECRET,
  INTELLIGENCE_WORKER_URL: process.env.INTELLIGENCE_WORKER_URL,
};

const ingressSecret = "observability-ingress-".padEnd(48, "i");
const streamSecret = "observability-stream-".padEnd(48, "s");

process.env.AUTH_SITE_URL = "http://localhost:3211";
process.env.PARTICIPANT_SITE_URL = "http://localhost:4173";
process.env.OPERATIONS_SITE_URL = "http://localhost:4174";
process.env.HANDBOOK_SITE_URL = "http://localhost:4175";
process.env.INTELLIGENCE_INGRESS_SECRET = ingressSecret;
process.env.INTELLIGENCE_STREAM_SECRET = streamSecret;
process.env.INTELLIGENCE_WORKER_URL = "https://intelligence.example.test";

afterEach(() => vi.unstubAllGlobals());

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("intelligence observability", () => {
  test("intelligence service configuration accepts only canonical origins and strong secrets", () => {
    expect(parseIntelligenceWorkerOrigin("https://intelligence.example.test").origin).toBe(
      "https://intelligence.example.test",
    );
    expect(parseIntelligenceWorkerOrigin("http://localhost:8787").origin).toBe(
      "http://localhost:8787",
    );
    for (const invalid of [
      "http://intelligence.example.test",
      "https://user:password@intelligence.example.test",
      "https://intelligence.example.test/",
      "https://intelligence.example.test/v1",
      "https://intelligence.example.test?view=updates",
      "https://intelligence.example.test#stream",
    ]) {
      expect(() => parseIntelligenceWorkerOrigin(invalid), invalid).toThrow();
    }

    expect(validateIntelligenceHmacSecret("s".repeat(32), "TEST_SECRET")).toBe(
      "s".repeat(32),
    );
    expect(validateIntelligenceHmacSecret("é".repeat(16), "TEST_SECRET")).toBe(
      "é".repeat(16),
    );
    expect(() => validateIntelligenceHmacSecret("s".repeat(31), "TEST_SECRET")).toThrow(
      "at least 32 UTF-8 bytes",
    );
  });

  test("brief history needs the intelligence read grant", async () => {
    const backend = seededBackend();
    const fixture = await seedActivity(backend);
    const outsider = backend.withIdentity({
      subject: fixture.outsiderAuthUserId,
      sessionId: fixture.outsiderAuthSessionId,
    });
    await expect(
      outsider.query(api.intelligenceObservability.briefHistory, {
        eventSlug: fixture.eventSlug,
        paginationOpts: { numItems: 20, cursor: null },
      }),
    ).rejects.toThrow();
  });

  test("manual brief history is paginated without hiding older runs", async () => {
    const backend = seededBackend();
    const fixture = await seedActivity(backend);
    const viewer = backend.withIdentity({
      subject: fixture.viewerAuthUserId,
      sessionId: fixture.viewerAuthSessionId,
    });
    await backend.run(async (ctx) => {
      const source = await ctx.db.get(fixture.manualBriefId);
      if (!source) throw new Error("The manual brief fixture is missing.");
      for (let index = 0; index < 25; index += 1) {
        await ctx.db.insert("operationsIntelligenceBriefs", {
          eventId: source.eventId,
          requestedByPersonId: source.requestedByPersonId,
          state: "succeeded",
          headline: `Historical brief ${index}`,
          summary: "A paginated historical intelligence brief.",
          priorities: [],
          agentVersion: "operations-brief-v2",
          model: "cloudflare/test-model",
          sourceSnapshot: source.sourceSnapshot,
          sourceChecksum: `historical-source-${index}`,
          requestedAt: source.requestedAt - (index + 1) * 60_000,
          workerAcceptedAt: source.requestedAt - (index + 1) * 60_000 + 1_000,
          completedAt: source.requestedAt - (index + 1) * 60_000 + 2_000,
          updatedAt: source.requestedAt - (index + 1) * 60_000 + 2_000,
          version: 3,
        });
      }
    });
    const first = await viewer.query(api.intelligenceObservability.briefHistory, {
      eventSlug: fixture.eventSlug,
      paginationOpts: { numItems: 20, cursor: null },
    });
    const second = await viewer.query(api.intelligenceObservability.briefHistory, {
      eventSlug: fixture.eventSlug,
      paginationOpts: { numItems: 20, cursor: first.continueCursor },
    });
    expect(first.page).toHaveLength(20);
    expect(second.page).toHaveLength(7);
    expect(new Set([...first.page, ...second.page].map((run) => run.id)).size).toBe(27);
    expect([...first.page, ...second.page]).toContainEqual(expect.objectContaining({
      headline: "Queue pressure is the story",
      model: "cloudflare/test-model",
    }));
  });

  test("stream capabilities are short-lived, read-only, and bound to the exact run", async () => {
    const backend = seededBackend();
    const fixture = await seedActivity(backend);
    const viewer = backend.withIdentity({
      subject: fixture.viewerAuthUserId,
      sessionId: fixture.viewerAuthSessionId,
    });

    const copilot = await viewer.action(api.operationsIntelligenceActions.openCopilotStream, {
      eventSlug: fixture.eventSlug,
    });
    expect(copilot.expiresAt - copilot.issuedAt).toBe(60_000);
    expect(copilot.conversationUrl).toMatch(
      /^https:\/\/intelligence\.example\.test\/v1\/operations-copilot\/conversations\//u,
    );
    const copilotBody = Buffer.from(copilot.ticket, "base64url").toString("utf8");
    expect(copilotBody).toContain('"agentName":"operations-copilot"');
    expect(copilotBody).toContain('"capability":"read"');
    expect(copilot.signature).toBe(
      await signTicket(copilotBody, copilot.issuedAt, operationsCopilotStreamTicketSignatureContext),
    );

    const brief = await viewer.action(api.operationsIntelligenceActions.openBriefStream, {
      eventSlug: fixture.eventSlug,
      briefId: fixture.manualBriefId,
    });
    expect(brief.conversationUrl).toBe(
      `https://intelligence.example.test/v1/operations-brief-runs/${fixture.manualBriefId}`,
    );
    const briefBody = Buffer.from(brief.ticket, "base64url").toString("utf8");
    expect(briefBody).toContain(`"briefId":"${fixture.manualBriefId}"`);
    expect(briefBody).not.toContain("conversationId");
    expect(brief.signature).toBe(
      await signTicket(briefBody, brief.issuedAt, operationsBriefStreamTicketSignatureContext),
    );
  });

  test("turn submission needs generate permission and validates the echoed coordinates", async () => {
    const backend = seededBackend();
    const fixture = await seedActivity(backend);
    const viewer = backend.withIdentity({
      subject: fixture.viewerAuthUserId,
      sessionId: fixture.viewerAuthSessionId,
    });
    const args = {
      eventSlug: fixture.eventSlug,
      turnId: "turn-console-0001",
      message: "Show current review exceptions.",
    };

    await expect(
      viewer.action(api.operationsIntelligenceActions.submitCopilotTurn, args),
    ).rejects.toThrow();

    await backend.run(async (ctx) => {
      await insertPermissionGrant(ctx, {
        eventId: fixture.eventId,
        personId: fixture.viewerPersonId,
        eventAccessSubjectId: fixture.viewerSubjectId,
        permissionKey: "operations.intelligence.generate",
        scopeType: "event",
        sourceType: "manual",
        sourceId: `${fixture.eventSlug}:operations.intelligence.generate`,
        grantedByPersonId: fixture.viewerPersonId,
        reason: "Stream action test",
      });
    });
    const requestBodies: string[] = [];
    let attempt = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://intelligence.example.test/v1/operations-copilot/turns");
      if (typeof init?.body !== "string") throw new Error("Expected a string request body.");
      requestBodies.push(init.body);
      attempt += 1;
      const timestamp = new Headers(init.headers).get("x-c2c-timestamp") ?? "";
      const signature = new Headers(init.headers).get("x-c2c-signature") ?? "";
      expect(
        await verifyServiceBody({
          context: operationsCopilotIngressSignatureContext,
          secret: ingressSecret,
          timestamp,
          signature,
          body: init.body,
          now: Number(timestamp),
          maximumAgeMs: 1,
        }),
      ).toBe(true);
      const parsed = turnCoordinates(init.body);
      if (attempt === 1) {
        return Response.json({ error: "internal_error" }, { status: 500 });
      }
      if (attempt === 2) {
        return Response.json({ error: "unparseable_conflict" }, { status: 409 });
      }
      return Response.json(
        {
          state: "accepted",
          conversationId: parsed.conversationId,
          instanceId: `copilot:${fixture.eventSlug}:${parsed.conversationId}`,
          submissionId: "submission-0001",
          acceptedAt: "2026-08-13T00:00:00.000Z",
          uid: "uid-0001",
          deduplicated: false,
        },
        { status: 202 },
      );
    });

    let ambiguousFailure: unknown;
    try {
      await viewer.action(api.operationsIntelligenceActions.submitCopilotTurn, args);
    } catch (error) {
      ambiguousFailure = error;
    }
    expect(ambiguousFailure).toBeInstanceOf(Error);
    expect(ambiguousFailure).not.toBeInstanceOf(ConvexError);

    let malformedConflict: unknown;
    try {
      await viewer.action(api.operationsIntelligenceActions.submitCopilotTurn, args);
    } catch (error) {
      malformedConflict = error;
    }
    expect(malformedConflict).toBeInstanceOf(Error);
    expect(malformedConflict).not.toBeInstanceOf(ConvexError);

    const receipt = await viewer.action(
      api.operationsIntelligenceActions.submitCopilotTurn,
      args,
    );
    expect(receipt).toMatchObject({
      submissionId: "submission-0001",
      acceptedAt: "2026-08-13T00:00:00.000Z",
      deduplicated: false,
    });
    expect(receipt.instanceId).toBe(
      `copilot:${fixture.eventSlug}:${receipt.conversationId}`,
    );
    expect(requestBodies).toHaveLength(3);
    expect(requestBodies[1]).toBe(requestBodies[0]);
    expect(requestBodies[2]).toBe(requestBodies[0]);

    vi.stubGlobal("fetch", async () =>
      Response.json(
        { error: "turn_conflict", submissionId: "submission-existing" },
        { status: 409 },
      ),
    );
    let definitiveConflict: unknown;
    try {
      await viewer.action(api.operationsIntelligenceActions.submitCopilotTurn, {
        ...args,
        turnId: "turn-console-conflict",
      });
    } catch (error) {
      definitiveConflict = error;
    }
    expect(definitiveConflict).toBeInstanceOf(ConvexError);
  });

});

async function signTicket(body: string, issuedAt: number, context: string) {
  return signServiceBody({
    context,
    secret: streamSecret,
    timestamp: String(issuedAt),
    body,
  });
}

function turnCoordinates(body: string) {
  const parsed: unknown = JSON.parse(body);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("conversationId" in parsed) ||
    typeof parsed.conversationId !== "string"
  ) {
    throw new Error("The turn body has no conversation ID.");
  }
  return { conversationId: parsed.conversationId };
}

function seededBackend() {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return backend;
}

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

    const sourceSnapshot = {
      generatedAt: now - 20 * 60_000,
      event: {
        slug: eventSlug,
        name: "Observability fixture",
        timezone: "Asia/Kolkata",
        status: "live" as const,
      },
      summary: {
        status: "healthy" as const,
        signalCount: 0,
        criticalSignalCount: 0,
        attentionSignalCount: 0,
        watchSignalCount: 0,
      },
      signals: [],
    };

    await ctx.db.insert("operationsIntelligenceBriefs", {
      eventId,
      requestedByPersonId: viewer.personId,
      state: "succeeded",
      headline: "Queue pressure is the story",
      summary: "Two panels carry the whole queue.",
      priorities: [],
      agentVersion: "operations-brief-v1",
      model: "cloudflare/test-model",
      sourceSnapshot,
      sourceChecksum: "older-manual-source",
      requestedAt: now - 20 * 60_000,
      workerAcceptedAt: now - 19 * 60_000,
      completedAt: now - 18 * 60_000,
      updatedAt: now - 18 * 60_000,
      version: 3,
    });
    const manualBriefId = await ctx.db.insert("operationsIntelligenceBriefs", {
      eventId,
      requestedByPersonId: viewer.personId,
      state: "accepted",
      sourceSnapshot: { ...sourceSnapshot, generatedAt: now - 2 * 60_000 },
      sourceChecksum: "manual-source",
      workerAcceptedAt: now - 60_000,
      requestedAt: now - 2 * 60_000,
      updatedAt: now - 60_000,
      version: 2,
    });

    return {
      eventSlug,
      eventId,
      manualBriefId,
      viewerPersonId: viewer.personId,
      viewerSubjectId: viewer.subjectId,
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
