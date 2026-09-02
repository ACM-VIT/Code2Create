import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { internal } from "./_generated/api";
import {
  participantEligibilityLookupFromVerifiedIdentity,
  productionParticipantEligibilityAllowed,
} from "./lib/participantEligibility";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

afterEach(() => vi.unstubAllEnvs());

describe("production participant eligibility", () => {
  test("publishes an exact roster atomically and matches each participant class", async () => {
    vi.stubEnv("C2C_DEPLOYMENT_ENVIRONMENT", "production");
    const backend = convexTest(schema, modules);
    const now = Date.now();
    const eventSlug = `production-eligibility-${crypto.randomUUID()}`;
    await backend.run(async (ctx) => {
      const creatorPersonId = await ctx.db.insert("people", {
        authUserId: "eligibility-event-creator",
        googleSubject: "eligibility-event-google",
        verifiedEmail: "creator@example.test",
        displayName: "Event creator",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("events", {
        slug: eventSlug,
        name: "Production eligibility fixture",
        timezone: "Asia/Kolkata",
        status: "draft",
        vitEmailDomains: ["vitstudent.ac.in"],
        externalApplicationsCloseAt: now + 86_400_000,
        applicationsCloseAt: now + 172_800_000,
        startsAt: Date.UTC(2026, 8, 6),
        createdByPersonId: creatorPersonId,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    });

    const created = await backend.mutation(internal.participantEligibility.beginImport, {
      eventSlug,
      batchKey: "registration-2026-09-02",
      expectedExternalCount: 1,
      expectedVitCount: 1,
      externalSourceChecksum: "a".repeat(64),
      vitSourceChecksum: "b".repeat(64),
    });
    await backend.mutation(internal.participantEligibility.appendEntries, {
      eventSlug,
      importId: created.importId,
      rows: [
        {
          participantClass: "external_participant",
          identity: "External.Student@Example.com",
          sourceRowNumber: 2,
        },
        {
          participantClass: "vit_student",
          identity: "24BCE1234",
          sourceRowNumber: 12,
        },
      ],
    });

    await backend.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (index) => index.eq("slug", eventSlug))
        .unique();
      if (!event) throw new Error("The eligibility test event is missing.");
      const lookup = participantEligibilityLookupFromVerifiedIdentity(event, {
        verifiedEmail: "external.student@example.com",
        displayName: "External Student",
      });
      await expect(
        productionParticipantEligibilityAllowed(ctx, event, lookup),
      ).resolves.toBe(false);
    });

    await expect(
      backend.mutation(internal.participantEligibility.publishImport, {
        eventSlug,
        importId: created.importId,
      }),
    ).resolves.toEqual({ externalCount: 1, vitCount: 1 });

    await backend.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_slug", (index) => index.eq("slug", eventSlug))
        .unique();
      if (!event) throw new Error("The eligibility test event is missing.");
      const allowedExternal = participantEligibilityLookupFromVerifiedIdentity(event, {
        verifiedEmail: "external.student@example.com",
        displayName: "External Student",
      });
      const unknownExternal = participantEligibilityLookupFromVerifiedIdentity(event, {
        verifiedEmail: "unknown@example.com",
        displayName: "Unknown Student",
      });
      const allowedVit = participantEligibilityLookupFromVerifiedIdentity(event, {
        verifiedEmail: "student@vitstudent.ac.in",
        hostedDomain: "vitstudent.ac.in",
        displayName: "VIT Student 24BCE1234",
      });
      const invalidVitProfile = participantEligibilityLookupFromVerifiedIdentity(event, {
        verifiedEmail: "student@vitstudent.ac.in",
        hostedDomain: "vitstudent.ac.in",
        displayName: "VIT Student",
      });
      await expect(
        productionParticipantEligibilityAllowed(ctx, event, allowedExternal),
      ).resolves.toBe(true);
      await expect(
        productionParticipantEligibilityAllowed(ctx, event, unknownExternal),
      ).resolves.toBe(false);
      await expect(
        productionParticipantEligibilityAllowed(ctx, event, allowedVit),
      ).resolves.toBe(true);
      await expect(
        productionParticipantEligibilityAllowed(ctx, event, invalidVitProfile),
      ).resolves.toBe(false);
    });
  });

  test("refuses to publish a partial roster", async () => {
    vi.stubEnv("C2C_DEPLOYMENT_ENVIRONMENT", "production");
    const backend = convexTest(schema, modules);
    const now = Date.now();
    const eventSlug = `partial-eligibility-${crypto.randomUUID()}`;
    await backend.run(async (ctx) => {
      const creatorPersonId = await ctx.db.insert("people", {
        authUserId: "partial-event-creator",
        googleSubject: "partial-event-google",
        verifiedEmail: "creator@example.test",
        displayName: "Event creator",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("events", {
        slug: eventSlug,
        name: "Partial eligibility fixture",
        timezone: "Asia/Kolkata",
        status: "draft",
        vitEmailDomains: ["vitstudent.ac.in"],
        externalApplicationsCloseAt: now + 86_400_000,
        applicationsCloseAt: now + 172_800_000,
        startsAt: Date.UTC(2026, 8, 6),
        createdByPersonId: creatorPersonId,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    });
    const created = await backend.mutation(internal.participantEligibility.beginImport, {
      eventSlug,
      batchKey: "partial-registration-2026-09-02",
      expectedExternalCount: 2,
      expectedVitCount: 1,
      externalSourceChecksum: "c".repeat(64),
      vitSourceChecksum: "d".repeat(64),
    });
    await backend.mutation(internal.participantEligibility.appendEntries, {
      eventSlug,
      importId: created.importId,
      rows: [
        {
          participantClass: "external_participant",
          identity: "only-one@example.com",
          sourceRowNumber: 2,
        },
      ],
    });
    await expect(
      backend.mutation(internal.participantEligibility.publishImport, {
        eventSlug,
        importId: created.importId,
      }),
    ).rejects.toThrow("expected 2 and 1");
  });
});
