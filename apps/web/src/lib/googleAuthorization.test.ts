import assert from "node:assert/strict";
import test from "node:test";

import {
  restrictGoogleAuthorizationToVitStudents,
  vitStudentEmailDomain,
} from "./googleAuthorization.ts";

test("restricts Google account selection to the VIT student hosted domain", () => {
  const authorizationUrl = restrictGoogleAuthorizationToVitStudents(
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=client&state=state",
  );
  const url = new URL(authorizationUrl);

  assert.equal(url.searchParams.get("hd"), vitStudentEmailDomain);
  assert.equal(url.searchParams.get("client_id"), "client");
  assert.equal(url.searchParams.get("state"), "state");
});

test("rejects an authorization URL outside Google Accounts", () => {
  assert.throws(
    () => restrictGoogleAuthorizationToVitStudents("https://example.com/oauth"),
    /unexpected authorization URL/,
  );
});
