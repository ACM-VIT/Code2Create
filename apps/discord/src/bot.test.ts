import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { ChannelType, Events, PermissionFlagsBits, PermissionsBitField } from "discord.js";

import { SupportBackend } from "./backend.ts";
import { DiscordSupportBot } from "./bot.ts";
import type { DiscordSupportConfig } from "./config.ts";

const config: DiscordSupportConfig = {
  DISCORD_BOT_TOKEN: "test-token-never-used-for-login",
  DISCORD_GUILD_ID: "100000",
  DISCORD_OPEN_CATEGORY_ID: "200000",
  DISCORD_CLOSED_CATEGORY_ID: "300000",
  DISCORD_ALLOWED_ROLE_IDS: ["400000"],
  DISCORD_SUPPORT_BRIDGE_SECRET: "test-secret-never-used-for-a-request",
  CONVEX_SITE_URL: "https://backend.example.test",
  OPERATIONS_SITE_URL: "https://ops.example.test",
  C2C_EVENT_SLUG: "test-event",
  PORT: 8080,
};

function messageHarness(t: TestContext, administrator = true) {
  const bot = new DiscordSupportBot(config);
  t.after(() => bot.stop());
  // Simulate category discovery without logging in or contacting Discord.
  Object.assign(bot, {
    openCategories: [{ id: config.DISCORD_OPEN_CATEGORY_ID }, { id: "200002" }],
    closedCategories: [{ id: config.DISCORD_CLOSED_CATEGORY_ID }],
  });
  const reply = t.mock.method(SupportBackend.prototype, "reply", async () => ({
    state: "accepted" as const, publicCode: "C2C-TEST", version: 1,
  }));
  const fetchMember = t.mock.fn(async () => ({
    displayName: "Test operator",
    permissions: new PermissionsBitField(administrator ? PermissionFlagsBits.Administrator : 0n),
    roles: { cache: new Map() },
  }));
  const react = t.mock.fn(async (_emoji: string) => {});
  const listener = bot.client.listeners(Events.MessageCreate)[0];
  assert.ok(listener);
  return {
    reply, fetchMember, react,
    async send(topic: string | null, parentId = config.DISCORD_OPEN_CATEGORY_ID) {
      listener({
        id: "500000",
        author: { id: "600000", bot: false },
        webhookId: null,
        guildId: config.DISCORD_GUILD_ID,
        channel: {
          id: "700000", name: "c2c-general", type: ChannelType.GuildText, parentId, topic,
          guild: { members: { fetch: fetchMember } },
        },
        cleanContent: "Please check this",
        attachments: [],
        react,
      });
      await setImmediate();
    },
  };
}

for (const administrator of [true, false]) {
  test(`ignores unrelated category channels before checking ${administrator ? "admin" : "member"} permissions`, async (t) => {
    const harness = messageHarness(t, administrator);
    for (const parentId of [config.DISCORD_OPEN_CATEGORY_ID, config.DISCORD_CLOSED_CATEGORY_ID, "200002"]) {
      for (const topic of [null, "General event discussion", "Code2Create support case:", "Code2Create support case:case123 extra text"]) {
        await harness.send(topic, parentId);
      }
    }
    assert.equal(harness.fetchMember.mock.callCount(), 0);
    assert.equal(harness.reply.mock.callCount(), 0);
    assert.equal(harness.react.mock.callCount(), 0);
  });
}

test("recognizes existing ticket markers after startup in base and rollover categories", async (t) => {
  const harness = messageHarness(t);
  for (const parentId of [config.DISCORD_OPEN_CATEGORY_ID, config.DISCORD_CLOSED_CATEGORY_ID, "200002"]) {
    await harness.send("Code2Create support case:case123", parentId);
  }
  assert.equal(harness.fetchMember.mock.callCount(), 3);
  assert.equal(harness.reply.mock.callCount(), 3);
  assert.deepEqual(harness.react.mock.calls.map((call) => call.arguments), [["✅"], ["✅"], ["✅"]]);
});

test("still rejects unauthorized replies inside ticket channels", async (t) => {
  const harness = messageHarness(t, false);
  await harness.send("Code2Create support case:case123");
  assert.equal(harness.reply.mock.callCount(), 0);
  assert.deepEqual(harness.react.mock.calls.map((call) => call.arguments), [["⛔"]]);
});

test("ignores a ticket marker outside the support categories", async (t) => {
  const harness = messageHarness(t);
  await harness.send("Code2Create support case:case123", "900000");
  assert.equal(harness.fetchMember.mock.callCount(), 0);
  assert.equal(harness.reply.mock.callCount(), 0);
  assert.equal(harness.react.mock.callCount(), 0);
});
