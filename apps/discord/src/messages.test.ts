import assert from "node:assert/strict";
import test from "node:test";

import { channelTopic, inboundMessageText, isPortalTicketTopic, splitDiscordMessage, supportChannelName } from "./messages.ts";

test("splits long Discord messages without exceeding the platform limit", () => {
  const chunks = splitDiscordMessage("word ".repeat(1_000));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 1_900));
  assert.equal(chunks.join(" ").replaceAll(/\s+/gu, " ").trim(), "word ".repeat(1_000).trim());
});

test("includes attachment links in participant-facing Discord replies", () => {
  assert.equal(
    inboundMessageText("Please check this", ["https://cdn.discord.test/screenshot.png"]),
    "Please check this\n\nAttachment: https://cdn.discord.test/screenshot.png",
  );
});

test("creates a Discord-safe ticket channel name", () => {
  const delivery = {
    supportCase: {
      publicCode: "C2C-0042",
      teamName: "Binary Brains / VIT",
      reporterName: "Support reporter",
    },
  };
  assert.equal(supportChannelName(delivery), "c2c-0042-binary-brains-vit");
});

test("a channel the bridge opened is recognised by its topic", () => {
  // A Convex document id: lowercase alphanumeric, which is what the topic holds.
  assert.equal(isPortalTicketTopic(channelTopic("k17abc9xyz0q4m2")), true);
});

test("a channel nobody stamped is left alone", () => {
  for (const topic of [null, undefined, "", "general chatter", "Code2Create support case:"]) {
    assert.equal(
      isPortalTicketTopic(topic),
      false,
      `${JSON.stringify(topic)} is not a portal ticket`,
    );
  }
});

test("a topic that merely mentions support is not a ticket", () => {
  assert.equal(isPortalTicketTopic("ask about Code2Create support case:123 here"), false);
});

test("a topic with something appended to a real case is not a ticket", () => {
  // Anchored on purpose: a channel renamed to trail the stamp is not one of ours.
  assert.equal(isPortalTicketTopic(`${channelTopic("k17abc9xyz0q4m2")} (archived)`), false);
});
