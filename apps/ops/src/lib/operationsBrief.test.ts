import assert from "node:assert/strict";
import test from "node:test";

import { briefStreamObserverKey } from "./operationsBrief.ts";

test("replaces a pre-acceptance stream observer when Worker creation is proven", () => {
  const beforeAcceptance = briefStreamObserverKey("brief-1", undefined);
  const afterAcceptance = briefStreamObserverKey("brief-1", 11_000);

  assert.notEqual(afterAcceptance, beforeAcceptance);
  assert.equal(briefStreamObserverKey("brief-1", 11_000), afterAcceptance);
});
