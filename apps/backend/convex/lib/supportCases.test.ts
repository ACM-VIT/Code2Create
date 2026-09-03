import { describe, expect, test } from "vitest";

import {
  applySupportCaseCounterChange,
  emptySupportCaseCounters,
  supportCaseCounterShardCount,
  supportCaseCounterShardFor,
  type SupportCaseCounterSource,
} from "./supportCases";

const openedSafetyCase: SupportCaseCounterSource = {
  state: "open",
  category: "safety",
  awaitingStaffReply: true,
};

describe("support case counters", () => {
  test("tracks state, ownership, reply duty, and live safety cases together", () => {
    const opened = applySupportCaseCounterChange(
      emptySupportCaseCounters(),
      undefined,
      openedSafetyCase,
    );
    expect(opened).toEqual({
      open: 1,
      investigating: 0,
      waiting: 0,
      resolved: 0,
      closed: 0,
      unowned: 1,
      awaitingStaffReply: 1,
      safety: 1,
    });

    const investigating: SupportCaseCounterSource = {
      state: "investigating",
      category: "safety",
      ownerPersonId: "person-1",
      awaitingStaffReply: false,
    };
    const assigned = applySupportCaseCounterChange(opened, openedSafetyCase, investigating);
    expect(assigned).toMatchObject({
      open: 0,
      investigating: 1,
      unowned: 0,
      awaitingStaffReply: 0,
      safety: 1,
    });

    const resolved: SupportCaseCounterSource = {
      ...investigating,
      state: "resolved",
    };
    const settled = applySupportCaseCounterChange(assigned, investigating, resolved);
    expect(settled).toMatchObject({
      investigating: 0,
      resolved: 1,
      safety: 0,
    });

    const reopened: SupportCaseCounterSource = {
      ...resolved,
      state: "open",
      awaitingStaffReply: true,
    };
    expect(applySupportCaseCounterChange(settled, resolved, reopened)).toMatchObject({
      open: 1,
      resolved: 0,
      unowned: 0,
      awaitingStaffReply: 1,
      safety: 1,
    });
  });

  test("rejects projection drift instead of hiding a negative count", () => {
    expect(() =>
      applySupportCaseCounterChange(emptySupportCaseCounters(), openedSafetyCase, undefined),
    ).toThrow("would become invalid");
  });

  test("routes a case to one stable bounded counter shard", () => {
    const shard = supportCaseCounterShardFor("support-case-123");
    expect(shard).toBe(supportCaseCounterShardFor("support-case-123"));
    expect(shard).toBeGreaterThanOrEqual(0);
    expect(shard).toBeLessThan(supportCaseCounterShardCount);
  });
});
