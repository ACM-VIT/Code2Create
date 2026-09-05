import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { defaultParticipantEmailTemplates } from "@code2create/domain";

import { api, components } from "./_generated/api";
import { defaultDeterministicIntakePolicy } from "./lib/intakePolicy.ts";
import { defaultParticipantPolicy } from "./lib/participantPolicy.ts";
import {
  eventOwnerPermissionKeys,
  isPermissionKey,
  permissionCatalog,
  type PermissionKey,
} from "./lib/permissionCatalog.ts";
import { insertPermissionGrant } from "./lib/permissions.ts";
import { supremeSelfPermissionKeys } from "./lib/rolePermissions.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

describe("event bootstrap", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_SITE_URL", "http://localhost:3211");
    vi.stubEnv("PARTICIPANT_SITE_URL", "http://localhost:4173");
    vi.stubEnv("OPERATIONS_SITE_URL", "http://localhost:4174");
  });
  afterEach(() => vi.unstubAllEnvs());

  test("derives every non-event-wide self permission for Supreme", () => {
    const catalogSelfPermissions = Object.keys(permissionCatalog)
      .filter(isPermissionKey)
      .filter((permissionKey) => {
        const definition = permissionCatalog[permissionKey];
        return !definition.eventWide && definition.scopes.some((scope) => scope === "self");
      });

    expect(supremeSelfPermissionKeys).toEqual(catalogSelfPermissions);
    expect(supremeSelfPermissionKeys).toContain("communications.call_consent.manage");
  });

  test("advertises external email sign-in only with complete delivery configuration", async () => {
    vi.stubEnv("CLOUDFLARE_EMAIL_ACCOUNT_ID", "test-account");
    vi.stubEnv("CLOUDFLARE_EMAIL_API_TOKEN", "test-token");
    vi.stubEnv("CLOUDFLARE_EMAIL_FROM", "");
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);

    await expect(
      backend.query(api.system.getPublicShellState, {
        eventSlug: "code2create-7",
      }),
    ).resolves.toMatchObject({
      auth: { emailOtpConfigured: false },
    });

    vi.stubEnv("CLOUDFLARE_EMAIL_FROM", "Code2Create <updates@example.test>");
    await expect(
      backend.query(api.system.getPublicShellState, {
        eventSlug: "code2create-7",
      }),
    ).resolves.toMatchObject({
      auth: { emailOtpConfigured: true },
    });
  });

  test("lets the configured owner create the complete draft baseline once", async () => {
    vi.stubEnv("AUTH_SITE_URL", "http://localhost:3211");
    vi.stubEnv("PARTICIPANT_SITE_URL", "http://localhost:4173");
    vi.stubEnv("OPERATIONS_SITE_URL", "http://localhost:4174");
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
      await owner.query(api.system.bootstrapEligibility, {
        eventSlug: "code2create-7",
      }),
    ).toEqual({
      allowed: true,
      email: "owner@example.test",
      eventExists: false,
    });

    const startsAt = Date.now() + 7 * 24 * 60 * 60 * 1_000;
    const endsAt = startsAt + 48 * 60 * 60 * 1_000;
    const created = await owner.mutation(api.system.bootstrapEvent, {
      eventSlug: "code2create-7",
      eventName: "Code2Create 7.0",
      timezone: "Asia/Kolkata",
      externalApplicationsCloseAt: startsAt - 24 * 60 * 60 * 1_000,
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
        nextSteps: [
          {
            stableKey: "join_discord",
            title: "Join Discord",
            detail: "Use the event server for announcements and participant support.",
            actionUrl: "https://discord.gg/code2create",
          },
        ],
        discordUrl: "https://discord.gg/code2create",
        discordLabel: "Open event Discord",
        notificationProvider: "cloudflare_email",
        emailTemplates: defaultParticipantEmailTemplates(),
      },
      integrationPolicy: {
        version: "integrations-v1",
        requiredGitHubTopic: "code2create-7",
        maxActiveGitHubRepositoriesPerTeam: 10,
        maxActiveFigmaFilesPerTeam: 10,
      },
    });

    const operationsAccess = await owner.query(api.access.operationsCapabilities, {
      eventSlug: "code2create-7",
    });
    expect(operationsAccess).toMatchObject({
      isSupreme: true,
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
    if (!accessDetail) throw new Error("The Supreme access detail is missing.");
    expect(accessDetail.effectivePermissionKeys).toEqual(
      expect.arrayContaining([...eventOwnerPermissionKeys, ...supremeSelfPermissionKeys]),
    );
    await expect(
      owner.query(api.outboundCallConsents.mine, {
        eventSlug: "code2create-7",
      }),
    ).resolves.toMatchObject({ state: "not_configured", version: 0 });
    await backend.run(async (ctx) => {
      const subject = await ctx.db
        .query("eventAccessSubjects")
        .withIndex("by_event_person", (index) =>
          index.eq("eventId", created.eventId).eq("personId", ownerPersonId),
        )
        .unique();
      if (!subject) throw new Error("The Supreme event account is missing.");
      for (const permissionKey of supremeSelfPermissionKeys) {
        const grants = await ctx.db
          .query("permissionGrants")
          .withIndex("by_subject_permission_status", (index) =>
            index
              .eq("eventAccessSubjectId", subject._id)
              .eq("permissionKey", permissionKey)
              .eq("status", "active"),
          )
          .take(2);
        for (const grant of grants) await ctx.db.delete(grant._id);
      }
    });
    await expect(
      owner.query(api.outboundCallConsents.mine, {
        eventSlug: "code2create-7",
      }),
    ).rejects.toThrow("does not have permission");
    const synchronized = await owner.mutation(api.accessRoles.set, {
      eventSlug: "code2create-7",
      targetPersonId: ownerPersonId,
      role: "supreme",
      expectedAccessVersion: accessDetail.accessVersion,
      reason: "Synchronize the Supreme permission template.",
      clientOperationId: "bootstrap-supreme-permission-sync",
    });
    expect(synchronized.accessVersion).toBe(accessDetail.accessVersion + 1);
    await expect(
      owner.query(api.outboundCallConsents.mine, {
        eventSlug: "code2create-7",
      }),
    ).resolves.toMatchObject({ state: "not_configured", version: 0 });
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
        externalApplicationsCloseAt: startsAt - 24 * 60 * 60 * 1_000,
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
            .withIndex("by_policy", (index) => index.eq("policyVersionId", autonomyPolicy._id))
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

    expect(
      await owner.query(api.system.bootstrapEligibility, {
        eventSlug: "code2create-7",
      }),
    ).toMatchObject({ allowed: false, eventExists: true });
    await expect(
      owner.mutation(api.system.bootstrapEvent, {
        eventSlug: "code2create-7",
        eventName: "Code2Create 7.0",
        timezone: "Asia/Kolkata",
        externalApplicationsCloseAt: startsAt - 24 * 60 * 60 * 1_000,
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
          nextSteps: [
            {
              stableKey: "join_discord",
              title: "Join Discord",
              detail: "Use the event server for announcements and participant support.",
              actionUrl: "https://discord.gg/code2create",
            },
          ],
          discordUrl: "https://discord.gg/code2create",
          discordLabel: "Open event Discord",
          notificationProvider: "cloudflare_email",
          emailTemplates: defaultParticipantEmailTemplates(),
        },
        integrationPolicy: {
          version: "integrations-v1",
          requiredGitHubTopic: "code2create-7",
          maxActiveGitHubRepositoriesPerTeam: 10,
          maxActiveFigmaFilesPerTeam: 10,
        },
      }),
    ).rejects.toThrow("already has an event");
  });

  test("synchronizes missing Supreme catalog keys without re-assigning the role", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const identity = await createGoogleIdentity(backend, "owner@example.test");
    const owner = backend.withIdentity({
      subject: identity.authUserId,
      sessionId: identity.authSessionId,
    });
    const seeded = await seedSupremeOrganizer(backend, {
      authUserId: identity.authUserId,
      email: "owner@example.test",
      omitPermissionKeys: ["team.roster.import"],
    });
    const obsoleteGrantId = await seedObsoleteSupremeGrant(backend, seeded, "active");

    const importGrantCount = await backend.run(async (ctx) => {
      const grants = await ctx.db
        .query("permissionGrants")
        .withIndex("by_subject_permission_status", (index) =>
          index
            .eq("eventAccessSubjectId", seeded.subjectId)
            .eq("permissionKey", "team.roster.import")
            .eq("status", "active"),
        )
        .take(1);
      return grants.length;
    });
    expect(importGrantCount).toBe(0);

    const synchronized = await owner.mutation(api.access.synchronizeSupremePermissions, {
      eventSlug: seeded.eventSlug,
    });
    expect(synchronized.createdCount).toBeGreaterThan(0);
    expect(synchronized.revokedCount).toBe(1);
    expect(synchronized.accessVersion).toBe(seeded.accessVersion + 1);

    await backend.run(async (ctx) => {
      expect(await ctx.db.get(obsoleteGrantId)).toMatchObject({
        permissionKey: "floor.plan.read",
        status: "revoked",
        revokedByPersonId: seeded.personId,
      });
      const grants = await ctx.db
        .query("permissionGrants")
        .withIndex("by_subject_permission_status", (index) =>
          index
            .eq("eventAccessSubjectId", seeded.subjectId)
            .eq("permissionKey", "team.roster.import")
            .eq("status", "active"),
        )
        .take(1);
      expect(grants).toHaveLength(1);
      const subject = await ctx.db.get(seeded.subjectId);
      expect(subject?.accessVersion).toBe(seeded.accessVersion + 1);
      const audits = await ctx.db
        .query("auditEvents")
        .withIndex("by_target_time", (index) =>
          index.eq("targetType", "event_access_subject").eq("targetId", seeded.subjectId),
        )
        .take(8);
      expect(
        audits.some((event) => event.action === "access.supreme_permissions_synchronized"),
      ).toBe(true);
    });
  });

  test.each(["active", "scheduled"] as const)(
    "retires a %s removed catalog permission without rewriting current grants",
    async (status) => {
      const backend = convexTest(schema, modules);
      backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
      const identity = await createGoogleIdentity(backend, "owner@example.test");
      const owner = backend.withIdentity({
        subject: identity.authUserId,
        sessionId: identity.authSessionId,
      });
      const seeded = await seedSupremeOrganizer(backend, {
        authUserId: identity.authUserId,
        email: "owner@example.test",
        omitPermissionKeys: [],
      });
      const baseline = await owner.mutation(api.access.synchronizeSupremePermissions, {
        eventSlug: seeded.eventSlug,
      });
      const currentGrants = await backend.run((ctx) => ctx.db
        .query("permissionGrants")
        .withIndex("by_source", (index) => index
          .eq("eventId", seeded.eventId)
          .eq("sourceType", "role_template")
          .eq("sourceId", seeded.roleId)
          .eq("status", "active"))
        .take(256));
      const obsoleteGrantId = await seedObsoleteSupremeGrant(backend, seeded, status);
      const result = await owner.mutation(api.access.synchronizeSupremePermissions, {
        eventSlug: seeded.eventSlug,
      });
      expect(result).toEqual({
        createdCount: 0,
        revokedCount: 1,
        accessVersion: baseline.accessVersion + 1,
      });
      await backend.run(async (ctx) => {
        expect(await ctx.db.get(obsoleteGrantId)).toMatchObject({
          permissionKey: "floor.plan.read",
          status: "revoked",
          revokedByPersonId: seeded.personId,
          revokeReason: "Permission removed from the Supreme catalog.",
        });
        const unchanged = await Promise.all(currentGrants.map((grant) => ctx.db.get(grant._id)));
        expect(unchanged).toEqual(currentGrants);
        const audits = await ctx.db.query("auditEvents")
          .withIndex("by_target_time", (index) => index
            .eq("targetType", "event_access_subject")
            .eq("targetId", seeded.subjectId))
          .take(8);
        const cleanup = audits.find((audit) => {
          const summary: unknown = JSON.parse(audit.nextSummary);
          return typeof summary === "object" && summary !== null &&
            "revokedGrantCount" in summary && summary.revokedGrantCount === 1;
        });
        expect(cleanup?.nextSummary).toContain(obsoleteGrantId);
      });
      await expect(owner.mutation(api.access.synchronizeSupremePermissions, {
        eventSlug: seeded.eventSlug,
      })).resolves.toEqual({
        createdCount: 0,
        revokedCount: 0,
        accessVersion: result.accessVersion,
      });
    },
  );

  test("requires existing revoke authority before cleaning up a removed permission", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const identity = await createGoogleIdentity(backend, "owner@example.test");
    const owner = backend.withIdentity({
      subject: identity.authUserId,
      sessionId: identity.authSessionId,
    });
    const seeded = await seedSupremeOrganizer(backend, {
      authUserId: identity.authUserId,
      email: "owner@example.test",
      omitPermissionKeys: ["access.permissions.revoke_any"],
    });
    const obsoleteGrantId = await seedObsoleteSupremeGrant(backend, seeded, "active");
    await expect(owner.mutation(api.access.synchronizeSupremePermissions, {
      eventSlug: seeded.eventSlug,
    })).rejects.toThrow("does not have permission for that exact resource");
    await backend.run(async (ctx) => {
      expect(await ctx.db.get(obsoleteGrantId)).toMatchObject({ status: "active" });
      expect(await ctx.db.get(seeded.subjectId)).toMatchObject({
        accessVersion: seeded.accessVersion,
      });
      const grants = await ctx.db.query("permissionGrants")
        .withIndex("by_subject_permission_status", (index) => index
          .eq("eventAccessSubjectId", seeded.subjectId)
          .eq("permissionKey", "access.permissions.revoke_any")
          .eq("status", "active"))
        .take(1);
      expect(grants).toHaveLength(0);
    });
  });

  test("keeps Supreme role assignment inside the assigner's grant ceiling", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const identity = await createGoogleIdentity(backend, "role-owner@example.test");
    const organizer = backend.withIdentity({
      subject: identity.authUserId,
      sessionId: identity.authSessionId,
    });
    const seeded = await seedEventOrganizer(backend, {
      authUserId: identity.authUserId,
      email: "role-owner@example.test",
      role: "jc",
    });
    const target = await backend.run(async (ctx) => {
      const now = Date.now();
      const personId = await ctx.db.insert("people", {
        authUserId: `role-target-${crypto.randomUUID()}`,
        googleSubject: `role-target-google-${crypto.randomUUID()}`,
        verifiedEmail: `role-target-${crypto.randomUUID()}@example.test`,
        displayName: "Role target",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const subjectId = await ctx.db.insert("eventAccessSubjects", {
        eventId: seeded.eventId,
        personId,
        emailNormalized: `role-target-${crypto.randomUUID()}@example.test`,
        displayName: "Role target",
        status: "active",
        linkedBy: "access_invitation",
        accessVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      await insertPermissionGrant(ctx, {
        eventId: seeded.eventId,
        personId: seeded.personId,
        eventAccessSubjectId: seeded.subjectId,
        permissionKey: "access.roles.assign",
        scopeType: "person",
        scopeId: personId,
        sourceType: "manual",
        sourceId: "role-assignment-only",
        grantedByPersonId: seeded.personId,
        reason: "Role assignment fixture",
      });
      return { personId, subjectId };
    });

    await expect(
      organizer.mutation(api.accessRoles.set, {
        eventSlug: seeded.eventSlug,
        targetPersonId: target.personId,
        role: "supreme",
        expectedAccessVersion: 1,
        reason: "Assign event ownership",
        clientOperationId: "role-ceiling-denied",
      }),
    ).rejects.toThrow("Scoped grant authority cannot create permission-administration authority");

    await backend.run((ctx) =>
      insertPermissionGrant(ctx, {
        eventId: seeded.eventId,
        personId: seeded.personId,
        eventAccessSubjectId: seeded.subjectId,
        permissionKey: "access.permissions.grant_any",
        scopeType: "event",
        sourceType: "manual",
        sourceId: "role-assignment-grant-ceiling",
        grantedByPersonId: seeded.personId,
        reason: "Role assignment ceiling fixture",
      }),
    );
    await expect(
      organizer.mutation(api.accessRoles.set, {
        eventSlug: seeded.eventSlug,
        targetPersonId: target.personId,
        role: "supreme",
        expectedAccessVersion: 1,
        reason: "Assign event ownership",
        clientOperationId: "role-ceiling-allowed",
      }),
    ).resolves.toMatchObject({ accessVersion: 2 });

    await expect(
      organizer.mutation(api.accessRoles.set, {
        eventSlug: seeded.eventSlug,
        targetPersonId: target.personId,
        role: "board",
        expectedAccessVersion: 2,
        reason: "Replace event ownership",
        clientOperationId: "role-revoke-ceiling-denied",
      }),
    ).rejects.toThrow("Scoped revoke authority cannot revoke permission-administration authority");

    await backend.run((ctx) =>
      insertPermissionGrant(ctx, {
        eventId: seeded.eventId,
        personId: seeded.personId,
        eventAccessSubjectId: seeded.subjectId,
        permissionKey: "access.permissions.revoke_any",
        scopeType: "event",
        sourceType: "manual",
        sourceId: "role-assignment-revoke-ceiling",
        grantedByPersonId: seeded.personId,
        reason: "Role removal ceiling fixture",
      }),
    );
    await expect(
      organizer.mutation(api.accessRoles.set, {
        eventSlug: seeded.eventSlug,
        targetPersonId: target.personId,
        role: "board",
        expectedAccessVersion: 2,
        reason: "Replace event ownership",
        clientOperationId: "role-revoke-ceiling-allowed",
      }),
    ).resolves.toMatchObject({ accessVersion: 3 });

    await backend.run(async (ctx) => {
      const role = await ctx.db
        .query("eventRoles")
        .withIndex("by_event_person_status", (index) =>
          index
            .eq("eventId", seeded.eventId)
            .eq("personId", target.personId)
            .eq("status", "active"),
        )
        .unique();
      expect(role?.role).toBe("board");
      const grant = await ctx.db
        .query("permissionGrants")
        .withIndex("by_subject_permission_status", (index) =>
          index
            .eq("eventAccessSubjectId", target.subjectId)
            .eq("permissionKey", "access.permissions.grant_any")
            .eq("status", "active"),
        )
        .unique();
      expect(grant).toBeNull();
    });
  });

  test("does not grant Supreme catalog keys to a non-Supreme organizer", async () => {
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const identity = await createGoogleIdentity(backend, "jc@example.test");
    const organizer = backend.withIdentity({
      subject: identity.authUserId,
      sessionId: identity.authSessionId,
    });
    const seeded = await seedEventOrganizer(backend, {
      authUserId: identity.authUserId,
      email: "jc@example.test",
      role: "jc",
    });

    await expect(
      organizer.mutation(api.access.synchronizeSupremePermissions, {
        eventSlug: seeded.eventSlug,
      }),
    ).rejects.toThrow("Only a Supreme organizer can synchronize Supreme catalog permissions.");

    await backend.run(async (ctx) => {
      const grants = await ctx.db
        .query("permissionGrants")
        .withIndex("by_subject_permission_status", (index) =>
          index
            .eq("eventAccessSubjectId", seeded.subjectId)
            .eq("permissionKey", "team.roster.import")
            .eq("status", "active"),
        )
        .take(1);
      expect(grants).toHaveLength(0);
    });
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

    expect(
      await visitor.query(api.system.bootstrapEligibility, {
        eventSlug: "code2create-7",
      }),
    ).toEqual({
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
        externalApplicationsCloseAt: Date.UTC(2027, 6, 16, 3, 30),
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
          emailTemplates: defaultParticipantEmailTemplates(),
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
  test("rejects application deadlines that break the external-VIT-start ordering", async () => {
    vi.stubEnv("INITIAL_SUPREME_EMAILS", "owner@example.test");
    vi.stubEnv("INITIAL_EVENT_SLUG", "code2create-7");
    const backend = convexTest(schema, modules);
    backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
    const identity = await createGoogleIdentity(backend, "owner@example.test");
    const owner = backend.withIdentity({
      subject: identity.authUserId,
      sessionId: identity.authSessionId,
    });
    const day = 24 * 60 * 60 * 1_000;
    const startsAt = Date.now() + 7 * day;
    const bootstrapInput = (deadlines: {
      externalApplicationsCloseAt: number;
      applicationsCloseAt: number;
    }) => ({
      eventSlug: "code2create-7",
      eventName: "Code2Create 7.0",
      timezone: "Asia/Kolkata",
      ...deadlines,
      vitEmailDomains: ["vitstudent.ac.in"],
      participantPolicy: defaultParticipantPolicy,
      admissionPolicyVersion: "admission-v1",
      admissionParticipantCapacity: 1_000,
      admissionMinimumHumanReviews: 2,
      intakePolicy: defaultDeterministicIntakePolicy,
      communicationsPolicy: {
        venueName: "VIT Chennai",
        startsAt,
        endsAt: startsAt + 2 * day,
        nextSteps: [
          {
            stableKey: "join_discord",
            title: "Join Discord",
            detail: "Use the event server for announcements and participant support.",
            actionUrl: "https://discord.gg/code2create",
          },
        ],
        discordUrl: "https://discord.gg/code2create",
        discordLabel: "Open event Discord",
        notificationProvider: "cloudflare_email" as const,
        emailTemplates: defaultParticipantEmailTemplates(),
      },
      integrationPolicy: {
        version: "integrations-v1",
        requiredGitHubTopic: "code2create-7",
        maxActiveGitHubRepositoriesPerTeam: 10,
        maxActiveFigmaFilesPerTeam: 10,
      },
    });
    const rejection = "external must close no later than VIT";

    await expect(
      owner.mutation(
        api.system.bootstrapEvent,
        bootstrapInput({
          externalApplicationsCloseAt: startsAt - day,
          applicationsCloseAt: startsAt - 2 * day,
        }),
      ),
      "external deadline after the VIT deadline",
    ).rejects.toThrow(rejection);
    await expect(
      owner.mutation(
        api.system.bootstrapEvent,
        bootstrapInput({
          externalApplicationsCloseAt: startsAt - day,
          applicationsCloseAt: startsAt + day,
        }),
      ),
      "VIT deadline after the event start",
    ).rejects.toThrow(rejection);
    await expect(
      owner.mutation(
        api.system.bootstrapEvent,
        bootstrapInput({
          externalApplicationsCloseAt: Date.now() - day,
          applicationsCloseAt: startsAt - day,
        }),
      ),
      "external deadline in the past",
    ).rejects.toThrow(rejection);
    expect(
      await owner.query(api.system.bootstrapEligibility, {
        eventSlug: "code2create-7",
      }),
    ).toMatchObject({ allowed: true, eventExists: false });

    await owner.mutation(
      api.system.bootstrapEvent,
      bootstrapInput({
        externalApplicationsCloseAt: startsAt - 2 * day,
        applicationsCloseAt: startsAt - day,
      }),
    );
    expect(
      await owner.query(api.system.bootstrapEligibility, {
        eventSlug: "code2create-7",
      }),
    ).toMatchObject({ eventExists: true });
  });
});

async function createGoogleIdentity(backend: BackendTest, email: string) {
  const now = Date.now();
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
        token: crypto.randomUUID(),
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
      displayName: "Event owner",
      tokenIssuedAt: now - 1_000,
      tokenExpiresAt: now + 60 * 60 * 1_000,
      verifiedAt: now,
    });
  });
  return { authUserId, authSessionId };
}

async function seedObsoleteSupremeGrant(
  backend: BackendTest,
  seeded: Awaited<ReturnType<typeof seedSupremeOrganizer>>,
  status: "active" | "scheduled",
) {
  return backend.run((ctx) => ctx.db.insert("permissionGrants", {
    eventId: seeded.eventId,
    personId: seeded.personId,
    eventAccessSubjectId: seeded.subjectId,
    permissionKey: "floor.plan.read",
    scopeType: "event",
    status,
    sourceType: "role_template",
    sourceId: seeded.roleId,
    grantedByPersonId: seeded.personId,
    reason: "Supreme role authority",
    validFrom: Date.now() + (status === "scheduled" ? 60_000 : 0),
    createdAt: Date.now(),
  }));
}

async function seedSupremeOrganizer(
  backend: BackendTest,
  args: {
    authUserId: string;
    email: string;
    omitPermissionKeys: readonly PermissionKey[];
  },
) {
  const omitted = new Set<PermissionKey>(args.omitPermissionKeys);
  const seeded = await seedEventOrganizer(backend, {
    authUserId: args.authUserId,
    email: args.email,
    role: "supreme",
  });
  await backend.run(async (ctx) => {
    const assignerKey = crypto.randomUUID();
    const assignedByPersonId = await ctx.db.insert("people", {
      authUserId: `assigner-${assignerKey}`,
      googleSubject: `google:assigner-${assignerKey}`,
      verifiedEmail: `assigner-${assignerKey}@example.test`,
      displayName: "Original role assigner",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    for (const permissionKey of eventOwnerPermissionKeys) {
      if (omitted.has(permissionKey)) continue;
      await insertPermissionGrant(ctx, {
        eventId: seeded.eventId,
        personId: seeded.personId,
        eventAccessSubjectId: seeded.subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "role_template",
        sourceId: seeded.roleId,
        grantedByPersonId: assignedByPersonId,
        reason: "Supreme role authority",
      });
    }
  });
  return seeded;
}

async function seedEventOrganizer(
  backend: BackendTest,
  args: {
    authUserId: string;
    email: string;
    role: "supreme" | "jc";
  },
) {
  const now = Date.now();
  const eventSlug = `supreme-sync-${crypto.randomUUID()}`;
  return backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId: args.authUserId,
      googleSubject: `google:${args.email}`,
      verifiedEmail: args.email,
      displayName: args.email,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Supreme permission sync fixture",
      timezone: "Asia/Kolkata",
      status: "draft",
      vitEmailDomains: ["vitstudent.ac.in"],
      externalApplicationsCloseAt: now + 86_400_000,
      applicationsCloseAt: now + 86_400_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: args.email,
      displayName: args.email,
      status: "active",
      linkedBy: "access_invitation",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    const roleId = await ctx.db.insert("eventRoles", {
      eventId,
      personId,
      eventAccessSubjectId: subjectId,
      role: args.role,
      validFrom: now,
      status: "active",
      sourceType: "manual",
      sourceId: `fixture-role:${personId}`,
      assignedByPersonId: personId,
      createdAt: now,
      reason: "Fixture role",
    });
    return {
      eventSlug,
      eventId,
      personId,
      subjectId,
      roleId,
      accessVersion: 1,
    };
  });
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
