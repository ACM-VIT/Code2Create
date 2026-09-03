import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

describe("operations background lease", () => {
  test("serializes each job independently and permits expiry recovery", async () => {
    const backend = convexTest(schema, modules);

    await expect(
      backend.mutation(internal.operationsBackground.renew, {
        holder: "autonomy_tick",
        leaseId: "autonomy-2",
        now: 1_250,
        leaseDurationMs: 100,
      }),
    ).resolves.toBe(false);
    await expect(
      backend.mutation(internal.operationsBackground.claim, {
        holder: "health_refresh",
        leaseId: "health-1",
        now: 1_000,
        leaseDurationMs: 100,
      }),
    ).resolves.toBe(true);
    await expect(
      backend.mutation(internal.operationsBackground.claim, {
        holder: "autonomy_tick",
        leaseId: "autonomy-1",
        now: 1_050,
        leaseDurationMs: 100,
      }),
    ).resolves.toBe(true);
    await expect(
      backend.mutation(internal.operationsBackground.claim, {
        holder: "health_refresh",
        leaseId: "health-2",
        now: 1_050,
        leaseDurationMs: 100,
      }),
    ).resolves.toBe(false);
    await expect(
      backend.mutation(internal.operationsBackground.release, {
        holder: "health_refresh",
        leaseId: "not-the-owner",
      }),
    ).resolves.toBe(false);
    await expect(
      backend.mutation(internal.operationsBackground.release, {
        holder: "health_refresh",
        leaseId: "health-1",
      }),
    ).resolves.toBe(true);

    await expect(
      backend.mutation(internal.operationsBackground.claim, {
        holder: "autonomy_tick",
        leaseId: "autonomy-2",
        now: 1_060,
        leaseDurationMs: 100,
      }),
    ).resolves.toBe(false);
    await expect(
      backend.mutation(internal.operationsBackground.renew, {
        holder: "autonomy_tick",
        leaseId: "autonomy-1",
        now: 1_140,
        leaseDurationMs: 100,
      }),
    ).resolves.toBe(true);
    await expect(
      backend.mutation(internal.operationsBackground.claim, {
        holder: "health_refresh",
        leaseId: "health-2",
        now: 1_150,
        leaseDurationMs: 100,
      }),
    ).resolves.toBe(true);
    await expect(
      backend.mutation(internal.operationsBackground.claim, {
        holder: "health_refresh",
        leaseId: "health-3",
        now: 1_250,
        leaseDurationMs: 100,
      }),
    ).resolves.toBe(true);
    await expect(
      backend.mutation(internal.operationsBackground.renew, {
        holder: "health_refresh",
        leaseId: "health-2",
        now: 1_250,
        leaseDurationMs: 100,
      }),
    ).resolves.toBe(false);
  });
});
