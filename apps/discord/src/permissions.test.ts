import assert from "node:assert/strict";
import test from "node:test";
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { canReplyToSupport } from "./permissions.ts";

test("administrators can reply without a configured support role", () => {
  assert.equal(canReplyToSupport(new PermissionsBitField(PermissionFlagsBits.Administrator), [], ["support"]), true);
});

test("a configured support role allows replies without administrator", () => {
  assert.equal(canReplyToSupport(new PermissionsBitField(), ["member", "support"], ["support"]), true);
});

test("ordinary channel and management permissions do not grant support access", () => {
  const permissions = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles,
  ]);
  assert.equal(canReplyToSupport(permissions, ["member"], ["support"]), false);
});

test("removing the allowed role removes access", () => {
  const permissions = new PermissionsBitField();
  assert.equal(canReplyToSupport(permissions, ["support"], ["support"]), true);
  assert.equal(canReplyToSupport(permissions, [], ["support"]), false);
});
