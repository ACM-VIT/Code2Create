import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api, components } from "./_generated/api";
import { defaultDeterministicIntakePolicy } from "./lib/intakePolicy.ts";
import { defaultParticipantPolicy } from "./lib/participantPolicy.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

describe("event bootstrap", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("lets the configured owner create the complete draft baseline once", async () => {
    vi.stubEnv("INITIAL_SUPREME_EMAILS", "owner@example.test");
    vi.stubEnv("INITIAL_EVENT_SLUG", "code2create-7");
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const identity = await createGoogleIdentity(backend, "owner@example.test");
    const owner = backend.withIdentity({
      subject: identity.authUserId,
      sessionId: identity.authSessionId,
    });

    expect(await owner.query(api.system.bootstrapEligibility, {
      eventSlug: "code2create-7",
    })).toEqual({
      allowed: true,
      email: "owner@example.test",
      eventExists: false,
    });

    const startsAt = Date.UTC(2027, 6, 18, 3, 30);
    const endsAt = startsAt + 48 * 60 * 60 * 1_000;
    const created = await owner.mutation(api.system.bootstrapEvent, {
      eventSlug: "code2create-7",
      eventName: "Code2Create 7.0",
      timezone: "Asia/Kolkata",
      applicationsCloseAt: startsAt - 24 * 60 * 60 * 1_000,
      vitEmailDomains: ["vitstudent.ac.in"],
      participantPolicy: defaultParticipantPolicy,
      admissionPolicyVersion: "admission-v1",
      admissionParticipantCapacity: 1_000,
      admissionMinimumHumanReviews: 2,
      intakePolicy: defaultDeterministicIntakePolicy,
      communicationsPolicy: {
        venueName: "VIT Chennai",
        venueAddress: "Vandalur–Kelambakkam Road, Chennai",
        startsAt,
        endsAt,
        nextSteps: [{
          stableKey: "join_discord",
          title: "Join Discord",
          detail: "Use the event server for announcements and participant support.",
          actionUrl: "https://discord.gg/code2create",
        }],
        discordUrl: "https://discord.gg/code2create",
        discordLabel: "Open event Discord",
        notificationProvider: "cloudflare_email",
        notificationSubject: "Code2Create event update",
        notificationIntro: "There is a new Code2Create event update in your portal.",
      },
      integrationPolicy: {
        version: "integrations-v1",
        requiredGitHubTopic: "code2create-7",
        maxActiveGitHubRepositoriesPerTeam: 10,
        maxActiveFigmaFilesPerTeam: 10,
      },
    });

    const [handbookAccess, operationsAccess] = await Promise.all([
      owner.query(api.access.handbookCapabilities, { eventSlug: "code2create-7" }),
      owner.query(api.access.operationsCapabilities, { eventSlug: "code2create-7" }),
    ]);
    expect(handbookAccess).toEqual({ read: true });
    expect(operationsAccess).toMatchObject({
      eventLifecycle: true,
      accessPeople: true,
      health: true,
      incidents: true,
      reviews: true,
    });
    expect(operationsAccess).not.toHaveProperty("grants");
    const shellState = await owner.query(api.system.getPublicShellState, {
      eventSlug: "code2create-7",
    });
    expect(shellState.event).toMatchObject({
      id: created.eventId,
      slug: "code2create-7",
      name: "Code2Create 7.0",
      status: "draft",
    });
    expect(shellState.event).not.toHaveProperty("phases");
    const ownerPersonId = await backend.run(async (ctx) => {
      const person = await ctx.db
        .query("people")
        .withIndex("by_auth_user", (index) => index.eq("authUserId", identity.authUserId))
        .unique();
      if (!person) throw new Error("The bootstrap owner person is missing.");
      return person._id;
    });
    const accessDetail = await owner.query(api.access.detail, {
      eventSlug: "code2create-7",
      personId: ownerPersonId,
    });
    expect(accessDetail?.effectivePermissionKeys).toContain("event.lifecycle.manage");
    expect(accessDetail).not.toHaveProperty("grants");
    const grantPage = await owner.query(api.access.grantLedger, {
      eventSlug: "code2create-7",
      personId: ownerPersonId,
      paginationOpts: { cursor: null, numItems: 5 },
    });
    expect(grantPage.page).toHaveLength(5);
    expect(grantPage.isDone).toBe(false);
    await expect(
      owner.query(api.access.grantLedger, {
        eventSlug: "code2create-7",
        personId: ownerPersonId,
        paginationOpts: { cursor: null, numItems: 51 },
      }),
    ).rejects.toThrow("Request 1–50 permission grants");

    await backend.run(async (ctx) => {
      const event = await ctx.db.get(created.eventId);
      expect(event).toMatchObject({
        slug: "code2create-7",
        status: "draft",
        startsAt,
        endsAt,
        applicationsCloseAt: startsAt - 24 * 60 * 60 * 1_000,
      });
      expect(event?.publishedParticipantPolicyId).toBeDefined();
      expect(event?.publishedIntakePolicyId).toBeDefined();
      expect(event?.publishedAdmissionPolicyId).toBeDefined();
      expect(event?.publishedCommunicationsPolicyId).toBeDefined();
      expect(event?.publishedIntegrationPolicyId).toBeDefined();

      const autonomyPolicy = await ctx.db
        .query("operationsAutonomyPolicyVersions")
        .withIndex("by_event_status", (index) =>
          index.eq("eventId", created.eventId).eq("status", "published"),
        )
        .unique();
      expect(autonomyPolicy).toMatchObject({
        enabled: false,
        mode: "observe",
        allowedReadTools: expect.arrayContaining(["operations_health"]),
        allowedRecommendationKinds: [],
      });
      const autonomyState = autonomyPolicy
        ? await ctx.db
            .query("operationsAutonomyStates")
            .withIndex("by_policy", (index) =>
              index.eq("policyVersionId", autonomyPolicy._id),
            )
            .unique()
        : null;
      expect(autonomyState?.lifecycle.kind).toBe("disabled");

      const subject = await ctx.db
        .query("eventAccessSubjects")
        .withIndex("by_event_email", (index) =>
          index.eq("eventId", created.eventId).eq("emailNormalized", "owner@example.test"),
        )
        .unique();
      expect(subject?.status).toBe("active");
      const role = subject
        ? await ctx.db
            .query("eventRoles")
            .withIndex("by_event_person_status", (index) =>
              index
                .eq("eventId", created.eventId)
                .eq("personId", subject.personId)
                .eq("status", "active"),
            )
            .unique()
        : null;
      expect(role?.role).toBe("supreme");
      const lifecycleGrants = subject
        ? await ctx.db
            .query("permissionGrants")
            .withIndex("by_subject_permission_status", (index) =>
              index
                .eq("eventAccessSubjectId", subject._id)
                .eq("permissionKey", "event.lifecycle.manage")
                .eq("status", "active"),
            )
            .collect()
        : [];
      expect(lifecycleGrants).toHaveLength(1);
    });

    expect(await owner.query(api.system.bootstrapEligibility, {
      eventSlug: "code2create-7",
    })).toMatchObject({ allowed: false, eventExists: true });
    await expect(owner.mutation(api.system.bootstrapEvent, {
      eventSlug: "code2create-7",
      eventName: "Code2Create 7.0",
      timezone: "Asia/Kolkata",
      applicationsCloseAt: startsAt - 24 * 60 * 60 * 1_000,
      vitEmailDomains: ["vitstudent.ac.in"],
      participantPolicy: defaultParticipantPolicy,
      admissionPolicyVersion: "admission-v1",
      admissionParticipantCapacity: 1_000,
      admissionMinimumHumanReviews: 2,
      intakePolicy: defaultDeterministicIntakePolicy,
      communicationsPolicy: {
        venueName: "VIT Chennai",
        startsAt,
        endsAt,
        nextSteps: [{
          stableKey: "join_discord",
          title: "Join Discord",
          detail: "Use the event server for announcements and participant support.",
          actionUrl: "https://discord.gg/code2create",
        }],
        discordUrl: "https://discord.gg/code2create",
        discordLabel: "Open event Discord",
        notificationProvider: "cloudflare_email",
        notificationSubject: "Code2Create event update",
        notificationIntro: "There is a new Code2Create event update in your portal.",
      },
      integrationPolicy: {
        version: "integrations-v1",
        requiredGitHubTopic: "code2create-7",
        maxActiveGitHubRepositoriesPerTeam: 10,
        maxActiveFigmaFilesPerTeam: 10,
      },
    })).rejects.toThrow("already has an event");
  });

  test("does not offer setup to an unconfigured Google account", async () => {
    vi.stubEnv("INITIAL_SUPREME_EMAILS", "owner@example.test");
    vi.stubEnv("INITIAL_EVENT_SLUG", "code2create-7");
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const identity = await createGoogleIdentity(backend, "someone-else@example.test");
    const visitor = backend.withIdentity({
      subject: identity.authUserId,
      sessionId: identity.authSessionId,
    });

    expect(await visitor.query(api.system.bootstrapEligibility, {
      eventSlug: "code2create-7",
    })).toEqual({
      allowed: false,
      email: "someone-else@example.test",
      eventExists: false,
    });
  });

  test("pins bootstrap to the configured slug before the first event is created", async () => {
    vi.stubEnv("INITIAL_SUPREME_EMAILS", "owner@example.test");
    vi.stubEnv("INITIAL_EVENT_SLUG", "code2create-7");
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const identity = await createGoogleIdentity(backend, "owner@example.test");
    const owner = backend.withIdentity({
      subject: identity.authUserId,
      sessionId: identity.authSessionId,
    });

    expect(
      await owner.query(api.system.bootstrapEligibility, { eventSlug: "attacker-event" }),
    ).toMatchObject({ allowed: false, eventExists: false });
    await expect(
      owner.mutation(api.system.bootstrapEvent, {
        eventSlug: "attacker-event",
        eventName: "Attacker event",
        timezone: "Asia/Kolkata",
        applicationsCloseAt: Date.UTC(2027, 6, 17, 3, 30),
        vitEmailDomains: ["vitstudent.ac.in"],
        participantPolicy: defaultParticipantPolicy,
        admissionPolicyVersion: "admission-v1",
        admissionParticipantCapacity: 1_000,
        admissionMinimumHumanReviews: 2,
        intakePolicy: defaultDeterministicIntakePolicy,
        communicationsPolicy: {
          venueName: "VIT Chennai",
          startsAt: Date.UTC(2027, 6, 18, 3, 30),
          endsAt: Date.UTC(2027, 6, 20, 3, 30),
          nextSteps: [],
          discordUrl: "https://discord.gg/code2create",
          discordLabel: "Open event Discord",
          notificationProvider: "cloudflare_email",
          notificationSubject: "Event update",
          notificationIntro: "There is a new event update in your portal.",
        },
        integrationPolicy: {
          version: "integrations-v1",
          requiredGitHubTopic: "code2create-7",
          maxActiveGitHubRepositoriesPerTeam: 10,
          maxActiveFigmaFilesPerTeam: 10,
        },
      }),
    ).rejects.toThrow("not configured to create that event");
  });
});

async function createGoogleIdentity(backend: BackendTest, email: string) {
  const now = Date.UTC(2027, 5, 1, 9, 0);
  const authUserResult: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Event owner",
        email,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const authUserId = documentId(authUserResult, "Better Auth user");
  const authSessionResult: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        expiresAt: now + 60 * 60 * 1_000,
        token: `bootstrap-session-${email}`,
        createdAt: now,
        updatedAt: now,
        userId: authUserId,
      },
    },
  });
  const authSessionId = documentId(authSessionResult, "Better Auth session");
  await backend.run(async (ctx) => {
    await ctx.db.insert("googleIdentityClaims", {
      authUserId,
      googleSubject: `google:${email}`,
      verifiedEmail: email,
      tokenIssuedAt: now - 1_000,
      tokenExpiresAt: now + 60 * 60 * 1_000,
      verifiedAt: now,
    });
  });
  return { authUserId, authSessionId };
}

function documentId(value: unknown, label: string): string {
  if (typeof value !== "object" || value === null || !("_id" in value)) {
    throw new Error(`${label} did not return a document ID.`);
  }
  const id = value._id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${label} returned an invalid document ID.`);
  }
  return id;
}
