import assert from "node:assert/strict";
import test from "node:test";

import {
  inboundMessageText,
  splitDiscordMessage,
  supportChannelName,
} from "./messages.ts";

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
