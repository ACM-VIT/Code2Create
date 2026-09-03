import assert from "node:assert/strict";
import test from "node:test";

import { reviewerPagePushData } from "./reviewerPagePush.ts";

test("reviewer page push carries expiry and omits participant-chosen names", () => {
  const participantChosenName = "PRIVATE TEAM SENTINEL";
  const data = reviewerPagePushData({
    ...{ teamName: participantChosenName },
    pageId: "page-42",
    roundName: "Round A",
    expiresAt: 1_800_000_123_456,
  });

  assert.deepEqual(data, {
    kind: "reviewer_substitute_page",
    pageId: "page-42",
    title: "Substitute request",
    body: "Round A. Open Code2Create Ops now.",
    expiresAt: "1800000123456",
  });
  assert.equal(JSON.stringify(data).includes(participantChosenName), false);
  assert.equal("responseSeconds" in data, false);
});
