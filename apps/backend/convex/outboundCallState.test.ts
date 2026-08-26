import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

describe("outbound call provider state", () => {
  test("keeps an ambiguous provider dispatch distinct from a definite failure", async () => {
    const backend = convexTest(schema, modules);
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const deliveryId = await backend.run(async (ctx) => {
      const eventId = await ctx.db.insert("events", {
        slug: `voice-${crypto.randomUUID()}`,
        name: "Voice fixture",
        timezone: "Asia/Kolkata",
        status: "live",
        vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: now - 60_000,
        startsAt: now - 1_000,
        endsAt: now + 600_000,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const personId = await ctx.db.insert("people", {
        authUserId: crypto.randomUUID(),
        googleSubject: crypto.randomUUID(),
        verifiedEmail: "voice@example.test",
        displayName: "Voice fixture",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return ctx.db.insert("outboundCallDeliveries", {
        eventId,
        targetPersonId: personId,
        sourceType: "reviewer_page",
        sourceId: "fixture-page",
        purpose: "reviewer_substitute_page",
        destinationPhoneE164: "+919876543210",
        script: "Open the reviewer app now.",
        locale: "en-IN",
        scriptPolicyVersion: "reviewer-substitute-page-v1",
        authorizationGrantIds: [],
        state: "provider_accepted",
        attemptCount: 1,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    });
    const providerEventId = crypto.randomUUID();
    await backend.mutation(internal.outboundCallState.recordProviderEvent, {
      providerEventId,
      deliveryId,
      eventType: "call.failed",
      providerAt: now + 1_000,
      providerErrorCode: "provider_dispatch_ambiguous",
    });
    const delivery = await backend.run((ctx) => ctx.db.get(deliveryId));
    expect(delivery).toMatchObject({
      state: "ambiguous",
      providerErrorCode: "provider_dispatch_ambiguous",
      completedAt: now,
    });
    await expect(
      backend.mutation(internal.outboundCallState.recordProviderEvent, {
        providerEventId,
        deliveryId,
        eventType: "call.failed",
        providerAt: now + 2_000,
        providerErrorCode: "provider_rejected",
      }),
    ).rejects.toThrow("event ID was reused with different data");
  });
});
