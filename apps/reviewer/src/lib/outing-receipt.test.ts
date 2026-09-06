import { describe, expect, test } from "vitest";
import { outingReceiptMessage } from "./outing-receipt";

describe("outing scan instructions", () => {
  test("waiting is a refusal with the actual queue position", () => {
    expect(outingReceiptMessage({ status: "waiting", position: 4, returnBy: null }, 0)).toContain("queue position 4. Permission has not been granted");
  });
  test("a permitted departure shows the return deadline and return scan instruction", () => {
    const message = outingReceiptMessage({ status: "out", position: null, returnBy: 900_000 }, 0);
    expect(message).toContain("Permission confirmed · 15-minute outing");
    expect(message).toContain("Return by");
    expect(message).toContain("Scan their ID on return");
  });
  test("late return is recorded, with no instruction to withhold re-entry", () => {
    expect(outingReceiptMessage({ status: "returned", position: null, returnBy: 900_000 }, 900_001)).toBe("Return recorded after the 15-minute limit. Their outing slot is released.");
  });
  test("offline departure never appears accepted", () => {
    expect(outingReceiptMessage({ status: "online_required", position: null, returnBy: null }, 0)).toContain("departure was not recorded");
  });
});
