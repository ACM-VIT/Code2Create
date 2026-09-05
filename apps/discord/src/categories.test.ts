import assert from "node:assert/strict";
import test from "node:test";

import {
  nextSupportCategoryRolloverIndex,
  supportCategoryHasSpace,
  supportCategoryRolloverIndex,
  supportCategoryRolloverName,
} from "./categories.ts";

test("rolls over before Discord's 51st category child", () => {
  assert.equal(supportCategoryHasSpace(49), true);
  assert.equal(supportCategoryHasSpace(50), false);
});

test("names and discovers support rollover categories by state", () => {
  assert.equal(supportCategoryRolloverName("open", 2), "c2c-support-open-02");
  assert.equal(supportCategoryRolloverName("closed", 12), "c2c-support-closed-12");
  assert.equal(supportCategoryRolloverIndex("open", "c2c-support-open-09"), 9);
  assert.equal(supportCategoryRolloverIndex("closed", "c2c-support-open-09"), null);
  assert.equal(supportCategoryRolloverIndex("open", "support-open"), null);
});

test("selects the next unused rollover category number", () => {
  assert.equal(nextSupportCategoryRolloverIndex("open", []), 2);
  assert.equal(
    nextSupportCategoryRolloverIndex("open", [
      "c2c-support-open-02",
      "c2c-support-closed-08",
      "c2c-support-open-05",
    ]),
    6,
  );
});
