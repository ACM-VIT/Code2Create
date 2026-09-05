import assert from "node:assert/strict";
import test from "node:test";
import type { BridgeSettings } from "./contracts.ts";
import { reactionsAllowed, replyRoleIds } from "./settings.ts";

const deployed = ["deployed-role"];

function settings(overrides: Partial<BridgeSettings> = {}): BridgeSettings {
  return { reactionsEnabled: true, allowedRoleIds: [], ...overrides };
}

test("receipts are on before the first poll answers", () => {
  assert.equal(reactionsAllowed(null), true);
});

test("the dashboard can switch receipts off and on", () => {
  assert.equal(reactionsAllowed(settings({ reactionsEnabled: false })), false);
  assert.equal(reactionsAllowed(settings({ reactionsEnabled: true })), true);
});

test("the deployed roles stand until the dashboard names some", () => {
  assert.deepEqual(replyRoleIds(null, deployed), deployed);
  assert.deepEqual(replyRoleIds(settings(), deployed), deployed);
});

test("a configured list replaces the deployed roles rather than adding to them", () => {
  assert.deepEqual(
    replyRoleIds(settings({ allowedRoleIds: ["chosen-role"] }), deployed),
    ["chosen-role"],
    "removing a deployed role from the dashboard has to actually remove it",
  );
});

test("an unreachable backend answers the same as an unconfigured event", () => {
  // The bot holds its last settings; losing them must not widen or narrow who
  // may reply, so `null` and an empty list agree.
  assert.deepEqual(replyRoleIds(null, deployed), replyRoleIds(settings(), deployed));
  assert.equal(reactionsAllowed(null), reactionsAllowed(settings()));
});
