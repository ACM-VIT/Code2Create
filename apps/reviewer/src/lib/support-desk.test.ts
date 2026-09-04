import { describe, expect, it } from "vitest";
import { orderStaffCases, supportStatusChoices, type StaffCase } from "./support-desk";

function row(code: string, overrides: Partial<StaffCase> = {}): StaffCase {
  return {
    id: code as StaffCase["id"],
    publicCode: code,
    category: "queue",
    description: "Needs help",
    origin: "participant",
    reporterName: "Reporter",
    contactEmail: "reporter@example.test",
    ownedByViewer: false,
    state: "open",
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    lastActionAt: 1,
    awaitingStaffReply: false,
    canReply: false,
    canManage: true,
    ...overrides,
  };
}

describe("mobile help desk", () => {
  it("puts active safety cases first, then oldest unanswered work, with completed work last", () => {
    const rows = [
      row("resolved-safety", { category: "safety", state: "resolved" }),
      row("new-reply", { awaitingStaffReply: true, lastActionAt: 20 }),
      row("waiting", { state: "waiting" }),
      row("old-reply", { awaitingStaffReply: true, lastActionAt: 2 }),
      row("working"),
      row("safety", { category: "safety" }),
    ];
    expect(orderStaffCases(rows).map((item) => item.publicCode)).toEqual([
      "safety",
      "old-reply",
      "new-reply",
      "working",
      "waiting",
      "resolved-safety",
    ]);
    expect(rows[0]?.publicCode).toBe("resolved-safety");
  });

  it("allows reopening closed cases without offering an invalid direct resolution", () => {
    expect(supportStatusChoices("closed")).toEqual(["closed", "open"]);
    expect(supportStatusChoices("resolved")).toEqual([
      "resolved",
      "open",
      "investigating",
      "closed",
    ]);
    expect(supportStatusChoices("waiting")).toContain("resolved");
  });
});
