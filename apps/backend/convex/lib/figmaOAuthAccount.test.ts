import assert from "node:assert/strict";
import test from "node:test";

import { figmaAccountIdentityMatches, figmaOAuthScopes } from "./figmaOAuthAccount.ts";

test("requests account identity alongside every evidence capability", () => {
  assert.deepEqual(figmaOAuthScopes, [
    "current_user:read",
    "file_metadata:read",
    "file_content:read",
    "file_versions:read",
    "file_comments:read",
    "webhooks:write",
  ]);
  assert.equal(new Set(figmaOAuthScopes).size, figmaOAuthScopes.length);
});

test("accepts an exact provider identity match", () => {
  assert.equal(figmaAccountIdentityMatches("stable-figma-user-id", "stable-figma-user-id"), true);
});

test("compares provider user ids as opaque strings", () => {
  assert.equal(figmaAccountIdentityMatches("00123", "123"), false);
  assert.equal(figmaAccountIdentityMatches("User-A", "user-a"), false);
  assert.equal(figmaAccountIdentityMatches("user-a", "user-b"), false);
});
