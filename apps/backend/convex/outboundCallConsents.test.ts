import { reviewerCallConsentPolicyVersion } from "@code2create/domain";
import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, components } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

describe("reviewer outbound-call consent", () => {
  test("grants, replays, and revokes one self-scoped consent", async () => {
    const backend = convexTest({ schema, modules });
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules,
    );
    const now = Date.now();
    const identity = await createIdentity(backend, now);
    const eventSlug = `call-consent-${crypto.randomUUID()}`;
    await backend.run(async (ctx) => {
      const eventId = await ctx.db.insert("events", {
        slug: eventSlug,
        name: "Call consent fixture",
        timezone: "Asia/Kolkata",
        status: "registration_open",
        vitEmailDomains: ["vitstudent.ac.in"],
        applicationsCloseAt: now + 600_000,
        startsAt: now + 1_000_000,
        endsAt: now + 2_000_000,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const personId = await ctx.db.insert("people", {
        authUserId: identity.authUserId,
        googleSubject: crypto.randomUUID(),
        verifiedEmail: "reviewer@example.test",
        displayName: "Reviewer",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const subjectId = await ctx.db.insert("eventAccessSubjects", {
        eventId,
        personId,
        emailNormalized: "reviewer@example.test",
        displayName: "Reviewer",
        status: "active",
        linkedBy: "access_invitation",
        accessVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("reviewerProfiles", {
        eventId,
        personId,
        contactPhone: "+919111111111",
        seniority: "sc",
        strength: 2,
        technicalDomains: [],
        productDomains: [],
        languages: ["english"],
        criterionKeys: [],
        status: "active",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("permissionGrants", {
        eventId,
        personId,
        eventAccessSubjectId: subjectId,
        permissionKey: "communications.call_consent.manage",
        scopeType: "self",
        scopeId: subjectId,
        validFrom: now - 1_000,
        status: "active",
        sourceType: "reserve_assignment",
        sourceId: "call-consent-test",
        reason: "Call consent test",
        createdAt: now,
        activatedAt: now,
      });
    });
    const reviewer = backend.withIdentity({
      subject: identity.authUserId,
      sessionId: identity.authSessionId,
    });
    await expect(
      reviewer.query(api.outboundCallConsents.mine, { eventSlug }),
    ).resolves.toMatchObject({
      state: "not_configured",
      suggestedPhoneE164: "+919111111111",
      version: 0,
    });
    const requestWithoutNotice = {
      eventSlug,
      state: "granted" as const,
      destinationPhone: "+91 98765 43210",
      expectedVersion: 0,
      clientOperationId: "grant-call-consent",
    };
    const grantRequest = {
      ...requestWithoutNotice,
      consentPolicyVersion: reviewerCallConsentPolicyVersion,
    };
    for (const notice of [{}, { consentPolicyVersion: "reviewer-page-call-consent-v1" }]) {
      await expect(
        reviewer.mutation(api.outboundCallConsents.saveReviewerConsent, {
          ...requestWithoutNotice,
          ...notice,
        }),
      ).rejects.toMatchObject({
        data: expect.objectContaining({ code: "CALL_NOTICE_CHANGED" }),
      });
    }
    const granted = await reviewer.mutation(
      api.outboundCallConsents.saveReviewerConsent,
      grantRequest,
    );
    await expect(
      reviewer.mutation(api.outboundCallConsents.saveReviewerConsent, grantRequest,
      ),
    ).resolves.toEqual(granted);
    await expect(
      reviewer.query(api.outboundCallConsents.mine, { eventSlug }),
    ).resolves.toMatchObject({
      state: "granted",
      destinationPhoneE164: "+919876543210",
      version: 1,
    });
    await reviewer.mutation(api.outboundCallConsents.saveReviewerConsent, {
      eventSlug,
      state: "revoked",
      expectedVersion: 1,
      clientOperationId: "revoke-call-consent",
    });
    await expect(
      reviewer.query(api.outboundCallConsents.mine, { eventSlug }),
    ).resolves.toMatchObject({ state: "revoked", version: 2 });
    const rows = await backend.run((ctx) => ctx.db.query("outboundCallConsents").collect(),
    );
    expect(rows).toHaveLength(1);
  });
});

async function createIdentity(backend: BackendTest, now: number) {
  const user: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Reviewer",
        email: "reviewer@example.test",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  },
  );
  const authUserId = documentId(user, "Better Auth user");
  const session: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        expiresAt: now + 60 * 60_000,
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        userId: authUserId,
      },
    },
  },
  );
  return { authUserId, authSessionId: documentId(session, "Better Auth session"),
  };
}

function documentId(value: unknown, label: string) {
  if (typeof value !== "object" || value === null || !("_id" in value)) {
    throw new Error(`${label} did not return a document ID.`);
  }
  const id = value._id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${label} returned an invalid document ID.`);
  }
  return id;
}
