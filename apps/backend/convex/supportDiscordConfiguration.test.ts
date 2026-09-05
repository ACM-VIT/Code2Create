import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import {
  discordSupportPullSignatureContext,
  signServiceBody,
} from "@code2create/domain";
import { convexTest, type TestConvex } from "convex-test";
import { beforeAll, afterAll } from "vitest";
import { describe, expect, test } from "vitest";

import { api, components, internal } from "./_generated/api";
import { insertPermissionGrant } from "./lib/permissions.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

const bridgeSecret = `test-${crypto.randomUUID()}-${crypto.randomUUID()}`;

/** Registering the HTTP routes reads these, so the signed poll needs them set. */
const httpEnvironment = {
  AUTH_SITE_URL: "http://localhost:3211",
  PARTICIPANT_SITE_URL: "http://localhost:4173",
  OPERATIONS_SITE_URL: "http://localhost:4174",
  DISCORD_SUPPORT_BRIDGE_SECRET: bridgeSecret,
};
const previousEnvironment: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [name, value] of Object.entries(httpEnvironment)) {
    previousEnvironment[name] = process.env[name];
    process.env[name] = value;
  }
});
afterAll(() => {
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("discord support bridge configuration", () => {
  test("starts on the defaults and reports nobody has changed them", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend);
    const view = await staff(backend, fixture).query(api.supportDiscordConfiguration.settings, {
      eventSlug: fixture.eventSlug,
    });
    expect(view).toMatchObject({
      reactionsEnabled: true,
      allowedRoleIds: [],
      updatedAt: null,
      updatedByName: null,
    });
  });

  test("saving switches receipts off and records who did it", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend);
    const as = staff(backend, fixture);

    const saved = await as.mutation(api.supportDiscordConfiguration.saveSettings, {
      eventSlug: fixture.eventSlug,
      reactionsEnabled: false,
      allowedRoleIds: ["123456789012345678"],
      expectedRevision: 0,
      reason: "Channel is too noisy during the event.",
    });
    expect(saved).toMatchObject({
      reactionsEnabled: false,
      allowedRoleIds: ["123456789012345678"],
      updatedByName: "Support operator",
    });

    const view = await as.query(api.supportDiscordConfiguration.settings, {
      eventSlug: fixture.eventSlug,
    });
    expect(view.reactionsEnabled).toBe(false);
    expect(view.allowedRoleIds).toEqual(["123456789012345678"]);
  });

  test("the bridge poll hands the bot whatever was saved", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend);

    // Before anyone saves, the poll carries the defaults.
    const before = await backend.mutation(internal.supportDiscordBridge.claimNext, {
      eventSlug: fixture.eventSlug,
    });
    expect(before).toMatchObject({
      state: "idle",
      settings: { reactionsEnabled: true, allowedRoleIds: [] },
    });

    await staff(backend, fixture).mutation(api.supportDiscordConfiguration.saveSettings, {
      eventSlug: fixture.eventSlug,
      reactionsEnabled: false,
      allowedRoleIds: ["222222222222222222"],
      expectedRevision: 0,
      reason: "Quieter channel, tighter roles.",
    });

    // The bot learns about both on the poll it already makes for work: no
    // restart, and no endpoint of its own.
    const after = await backend.mutation(internal.supportDiscordBridge.claimNext, {
      eventSlug: fixture.eventSlug,
    });
    expect(after).toMatchObject({
      state: "idle",
      settings: { reactionsEnabled: false, allowedRoleIds: ["222222222222222222"] },
    });
  });

  test("roles are cleaned, de-duplicated and kept in order", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend);
    const saved = await staff(backend, fixture).mutation(
      api.supportDiscordConfiguration.saveSettings,
      {
        eventSlug: fixture.eventSlug,
        reactionsEnabled: true,
        allowedRoleIds: [" 111111111111111111 ", "111111111111111111", "222222222222222222"],
        expectedRevision: 0,
        reason: "Pasted straight out of Discord.",
      },
    );
    expect(saved.allowedRoleIds).toEqual(["111111111111111111", "222222222222222222"]);
  });

  test("a list of nothing but rubbish is refused rather than silently emptied", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend);
    await expect(
      staff(backend, fixture).mutation(api.supportDiscordConfiguration.saveSettings, {
        eventSlug: fixture.eventSlug,
        reactionsEnabled: true,
        allowedRoleIds: ["@moderators", "not-an-id"],
        expectedRevision: 0,
        reason: "Typed the role names.",
      }),
    ).rejects.toThrow("6 to 32 digits");
  });

  test("an empty list is allowed, and means the deployed roles stand", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend);
    const saved = await staff(backend, fixture).mutation(
      api.supportDiscordConfiguration.saveSettings,
      {
        eventSlug: fixture.eventSlug,
        reactionsEnabled: true,
        allowedRoleIds: [],
        expectedRevision: 0,
        reason: "Fall back to the deployment.",
      },
    );
    expect(saved.allowedRoleIds).toEqual([]);
  });

  test("a save needs a reason", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend);
    await expect(
      staff(backend, fixture).mutation(api.supportDiscordConfiguration.saveSettings, {
        eventSlug: fixture.eventSlug,
        reactionsEnabled: false,
        allowedRoleIds: [],
        expectedRevision: 0,
        reason: "  ",
      }),
    ).rejects.toThrow("Say why");
  });

  test("a save made against a stale revision is refused, not merged", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend);
    const as = staff(backend, fixture);

    // Two operators open the screen on the same revision.
    const opened = await as.query(api.supportDiscordConfiguration.settings, {
      eventSlug: fixture.eventSlug,
    });
    expect(opened.revision).toBe(0);

    await as.mutation(api.supportDiscordConfiguration.saveSettings, {
      eventSlug: fixture.eventSlug,
      reactionsEnabled: false,
      allowedRoleIds: ["111111111111111111"],
      expectedRevision: opened.revision,
      reason: "First operator turns receipts off.",
    });

    // The second still holds revision 0 and must not silently win.
    await expect(
      as.mutation(api.supportDiscordConfiguration.saveSettings, {
        eventSlug: fixture.eventSlug,
        reactionsEnabled: true,
        allowedRoleIds: ["222222222222222222"],
        expectedRevision: opened.revision,
        reason: "Second operator, working from the old screen.",
      }),
    ).rejects.toThrow("Reload");

    const view = await as.query(api.supportDiscordConfiguration.settings, {
      eventSlug: fixture.eventSlug,
    });
    expect(view).toMatchObject({
      reactionsEnabled: false,
      allowedRoleIds: ["111111111111111111"],
      revision: 1,
    });
  });

  test("a poll from a version 1 bot gets the shape it can parse", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend);
    await staff(backend, fixture).mutation(api.supportDiscordConfiguration.saveSettings, {
      eventSlug: fixture.eventSlug,
      reactionsEnabled: false,
      allowedRoleIds: [],
      expectedRevision: 0,
      reason: "Quieter channel.",
    });

    // The bot and the backend deploy separately, so a bot that has not been
    // restarted still has to be able to deliver tickets.
    const version1 = await pull(backend, fixture.eventSlug, 1);
    expect(version1.status).toBe(200);
    await expect(version1.json()).resolves.toEqual({ state: "idle" });

    const version2 = await pull(backend, fixture.eventSlug, 2);
    expect(version2.status).toBe(200);
    await expect(version2.json()).resolves.toEqual({
      state: "idle",
      settings: { reactionsEnabled: false, allowedRoleIds: [] },
    });
  });

  test("reading needs permission, and saving needs more of it", async () => {
    const backend = seededBackend();
    const fixture = await seedFixture(backend);
    const outsider = backend.withIdentity({
      subject: fixture.outsider.authUserId,
      sessionId: fixture.outsider.authSessionId,
    });
    await expect(
      outsider.query(api.supportDiscordConfiguration.settings, { eventSlug: fixture.eventSlug }),
    ).rejects.toThrow();

    // A reader may look but not change.
    const reader = backend.withIdentity({
      subject: fixture.reader.authUserId,
      sessionId: fixture.reader.authSessionId,
    });
    await expect(
      reader.query(api.supportDiscordConfiguration.settings, { eventSlug: fixture.eventSlug }),
    ).resolves.toMatchObject({ reactionsEnabled: true });
    await expect(
      reader.mutation(api.supportDiscordConfiguration.saveSettings, {
        eventSlug: fixture.eventSlug,
        reactionsEnabled: false,
        allowedRoleIds: [],
        expectedRevision: 0,
        reason: "Trying to turn receipts off.",
      }),
    ).rejects.toThrow();
  });
});

/**
 * One signed poll at a chosen protocol version, the way the bot makes it.
 * The bridge secret is read from the environment at request time.
 */
async function pull(backend: BackendTest, eventSlug: string, protocolVersion: 1 | 2) {
  const body = JSON.stringify({ protocolVersion, eventSlug });
  const timestamp = Date.now().toString();
  const signature = await signServiceBody({
    context: discordSupportPullSignatureContext,
    secret: bridgeSecret,
    timestamp,
    body,
  });
  return await backend.fetch("/integrations/discord/support/pull", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-c2c-signature": signature,
      "x-c2c-timestamp": timestamp,
    },
    body,
  });
}

type Account = { email: string; authUserId: string; authSessionId: string };

function seededBackend() {
  const backend = convexTest({ schema, modules });
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return backend;
}

function staff(backend: BackendTest, fixture: { operator: Account }) {
  return backend.withIdentity({
    subject: fixture.operator.authUserId,
    sessionId: fixture.operator.authSessionId,
  });
}

async function seedFixture(backend: BackendTest) {
  const now = Date.now();
  const eventSlug = `discord-bridge-${crypto.randomUUID()}`;
  const operator = await insertAccount(backend, "operator", now);
  const reader = await insertAccount(backend, "reader", now);
  const outsider = await insertAccount(backend, "outsider", now);

  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Discord bridge fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      applicationsCloseAt: now + 86_400_000,
      startsAt: now - 60_000,
      endsAt: now + 3_600_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    async function join(account: Account, displayName: string, keys: readonly string[]) {
      const personId = await ctx.db.insert("people", {
        authUserId: account.authUserId,
        verifiedEmail: account.email,
        displayName,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const subjectId = await ctx.db.insert("eventAccessSubjects", {
        eventId,
        personId,
        emailNormalized: account.email,
        displayName,
        status: "active",
        linkedBy: "access_invitation",
        accessVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      for (const permissionKey of keys) {
        await insertPermissionGrant(ctx, {
          eventId,
          personId,
          eventAccessSubjectId: subjectId,
          permissionKey: permissionKey as "support.case.read",
          scopeType: "event",
          sourceType: "manual",
          sourceId: `discord-bridge-fixture:${permissionKey}:${displayName}`,
          grantedByPersonId: personId,
          reason: "Discord bridge configuration test",
        });
      }
      return { personId, subjectId };
    }

    await join(operator, "Support operator", ["support.case.read", "support.case.manage"]);
    await join(reader, "Support reader", ["support.case.read"]);
    await join(outsider, "Outsider", []);

    return { eventSlug, operator, reader, outsider };
  });
}

async function insertAccount(backend: BackendTest, name: string, now: number) {
  const email = `${name}-${crypto.randomUUID()}@example.test`;
  const user: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: { name, email, emailVerified: true, createdAt: now, updatedAt: now },
    },
  });
  const authUserId = documentId(user, "Better Auth user");
  const session: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        expiresAt: now + 3_600_000,
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        userId: authUserId,
      },
    },
  });
  return { email, authUserId, authSessionId: documentId(session, "Better Auth session") };
}

function documentId(value: unknown, label: string) {
  if (typeof value !== "object" || value === null || !("_id" in value)) {
    throw new Error(`${label} did not return an ID.`);
  }
  const id = value._id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${label} returned an invalid ID.`);
  }
  return id;
}
