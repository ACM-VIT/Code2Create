import betterAuthSchema from "../../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api } from "../_generated/api";
import { requireMembership, stagingParticipantAccessAllowed } from "./identity";
import schema from "../schema";

const modules = import.meta.glob(["../**/*.ts", "!../**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);

afterEach(() => vi.unstubAllEnvs());

describe("staging participant access", () => {
  test("treats a stale authentication identity as denied entry", async () => {
    vi.stubEnv("C2C_DEPLOYMENT_ENVIRONMENT", "staging");
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const now = Date.now();
    const eventSlug = `stale-participant-session-${crypto.randomUUID()}`;
    await backend.run(async (ctx) => {
      const creatorPersonId = await ctx.db.insert("people", {
        authUserId: "stale-session-event-creator",
        googleSubject: "stale-session-event-google",
        verifiedEmail: "creator@example.test",
        displayName: "Event creator",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("events", {
        slug: eventSlug,
        name: "Stale session fixture",
        timezone: "Asia/Kolkata",
        status: "registration_open",
        vitEmailDomains: ["vitstudent.ac.in"],
        externalApplicationsCloseAt: now + 86_400_000,
        applicationsCloseAt: now + 86_400_000,
        createdByPersonId: creatorPersonId,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    });
    const staleSession = backend.withIdentity({
      subject: "removed-auth-user",
      sessionId: "removed-auth-session",
    });

    await expect(staleSession.query(api.participants.entryAllowed, {
      eventSlug,
    })).resolves.toBe(false);
  });

  test("uses the active staff roster as the participant tester allowlist", async () => {
    vi.stubEnv("C2C_DEPLOYMENT_ENVIRONMENT", "staging");
    const backend = convexTest(schema, modules);
    const now = Date.now();
    const fixture = await backend.run(async (ctx) => {
      const personId = await ctx.db.insert("people", {
        authUserId: "staging-participant-user",
        googleSubject: "staging-participant-google",
        verifiedEmail: "tester@example.test",
        displayName: "Staging Tester",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const eventId = await ctx.db.insert("events", {
        slug: "staging-participant-access",
        name: "Staging participant access",
        timezone: "Asia/Kolkata",
        status: "registration_open",
        vitEmailDomains: ["vitstudent.ac.in"],
        externalApplicationsCloseAt: now + 86_400_000,
        applicationsCloseAt: now + 86_400_000,
        createdByPersonId: personId,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const subjectId = await ctx.db.insert("eventAccessSubjects", {
        eventId,
        personId,
        emailNormalized: "tester@example.test",
        displayName: "Staging Tester",
        status: "active",
        linkedBy: "participant_provisioning",
        accessVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      const membershipId = await ctx.db.insert("eventMemberships", {
        eventId,
        personId,
        eventAccessSubjectId: subjectId,
        participantClass: "external_participant",
        eligibilityStatus: "eligible",
        onboardingStatus: "profile_required",
        acceptedParticipantPolicyVersionIds: [],
        createdAt: now,
        updatedAt: now,
      });
      return { eventId, membershipId, personId };
    });

    await expect(backend.run((ctx) =>
      requireMembership(ctx, fixture.eventId, fixture.personId),
    )).rejects.toThrow("available only to invited testers");

    const rosterEntryId = await backend.run(async (ctx) => {
      const rosterImportId = await ctx.db.insert("rosterImports", {
        eventId: fixture.eventId,
        sourceName: "Staging tester access",
        validFrom: now - 1_000,
        validUntil: now + 86_400_000,
        bundleSelections: [],
        configurationChecksum: "staging-tester-configuration",
        previewChecksum: "staging-tester-preview",
        rowCount: 1,
        createdCount: 1,
        replacedCount: 0,
        unchangedCount: 0,
        alreadyClaimedCount: 0,
        reason: "Staging participant test",
        authorizingGrantIds: [],
        createdByPersonId: fixture.personId,
        clientOperationId: "staging-participant-test",
        createdAt: now,
      });
      return ctx.db.insert("rosterEntries", {
        eventId: fixture.eventId,
        rosterImportId,
        sourceRowNumber: 2,
        emailNormalized: "tester@example.test",
        displayName: "Staging Tester",
        role: "supreme",
        configurationChecksum: "staging-tester-configuration",
        validFrom: now - 1_000,
        validUntil: now + 86_400_000,
        status: "pending",
        version: 1,
        createdByPersonId: fixture.personId,
        createdAt: now,
      });
    });

    await expect(backend.run((ctx) =>
      requireMembership(ctx, fixture.eventId, fixture.personId),
    )).resolves.toMatchObject({ _id: fixture.membershipId });

    await backend.run((ctx) => ctx.db.patch(rosterEntryId, { validUntil: now - 1 }));
    await expect(backend.run((ctx) =>
      stagingParticipantAccessAllowed(ctx, fixture.eventId, "tester@example.test"),
    )).resolves.toBe(false);
  });

  test("does not apply the tester roster gate outside staging", async () => {
    vi.stubEnv("C2C_DEPLOYMENT_ENVIRONMENT", "production");
    const backend = convexTest(schema, modules);
    const now = Date.now();
    const eventId = await backend.run(async (ctx) => {
      const personId = await ctx.db.insert("people", {
        authUserId: "production-participant-user",
        googleSubject: "production-participant-google",
        verifiedEmail: "public@example.test",
        displayName: "Public Participant",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return ctx.db.insert("events", {
        slug: "production-participant-access",
        name: "Production participant access",
        timezone: "Asia/Kolkata",
        status: "registration_open",
        vitEmailDomains: ["vitstudent.ac.in"],
        externalApplicationsCloseAt: now + 86_400_000,
        applicationsCloseAt: now + 86_400_000,
        createdByPersonId: personId,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    });
    await expect(backend.run((ctx) =>
      stagingParticipantAccessAllowed(
        ctx,
        eventId,
        "public@example.test",
      ),
    )).resolves.toBe(true);
  });
});
