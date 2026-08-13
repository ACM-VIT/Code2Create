import { describe, expect, test } from "vitest";

import {
  sourceContext as attendanceSourceContext,
  sourceUploadContext as attendanceSourceUploadContext,
} from "./attendanceManualSheets";
import {
  sourceContext as reviewSourceContext,
  sourceUploadContext as reviewSourceUploadContext,
} from "./manualReviewRecords";

describe("private storage manifests", () => {
  test("only internal actions can resolve storage IDs and upload manifests", () => {
    expect(attendanceSourceContext.isInternal).toBe(true);
    expect(attendanceSourceUploadContext.isInternal).toBe(true);
    expect(reviewSourceContext.isInternal).toBe(true);
    expect(reviewSourceUploadContext.isInternal).toBe(true);
  });
});
