import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, components } from "./_generated/api";
import {
  integrationPolicyChecksum,
  normalizeIntegrationPolicy,
} from "./lib/integrationPolicy.ts";
import { insertPermissionGrant } from "./lib/permissions.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const betterAuthModules = import.meta.glob(
  "../node_modules/@convex-dev/better-auth/src/component/**/*.ts",
);
type BackendTest = TestConvex<typeof schema>;

describe("review links", () => {
  test("participants can submit GitHub and Figma URLs and staff can read them", async () => {
    const { actor, fixture } = await seededActor("read");
    const now = fixture.now;
    await actor.mutation(api.reviewLinks.addGithub, {
      eventSlug: fixture.eventSlug,
      repositoryUrl: "https://github.com/acm-vit/portal",
      clientOperationId: `github-${now}`,
    });
    await actor.mutation(api.reviewLinks.addFigma, {
      eventSlug: fixture.eventSlug,
      fileUrl: "https://www.figma.com/design/AbCdEf123456/Portal",
      clientOperationId: `figma-${now}`,
    });

    const mine = await actor.query(api.reviewLinks.current, { eventSlug: fixture.eventSlug });
    expect(mine?.github.map((link) => link.url)).toEqual(["https://github.com/acm-vit/portal"]);
    expect(mine?.figma.map((link) => link.url)).toEqual([
      "https://www.figma.com/design/AbCdEf123456/Portal",
    ]);

    const staffView = await actor.query(api.reviewLinks.listForTeam, {
      eventSlug: fixture.eventSlug,
      teamId: fixture.teamId,
    });
    expect(staffView.map((link) => link.url)).toEqual([
      "https://github.com/acm-vit/portal",
      "https://www.figma.com/design/AbCdEf123456/Portal",
    ]);
  }, 30_000);

  test("restoring an archived link stays within the published quota", async () => {
    const { actor, backend, fixture } = await seededActor("quota", {
      githubLimit: 1,
      figmaLimit: 1,
    });
    const first = await actor.mutation(api.reviewLinks.addGithub, {
      eventSlug: fixture.eventSlug,
      repositoryUrl: "https://github.com/acm-vit/portal",
      clientOperationId: `github-first-${fixture.now}`,
    });
    const current = await actor.query(api.reviewLinks.current, { eventSlug: fixture.eventSlug });
    const submitted = current?.github[0];
    if (!submitted) throw new Error("The first review link was not stored.");
    await actor.mutation(api.reviewLinks.archive, {
      eventSlug: fixture.eventSlug,
      linkId: first.linkId,
      expectedVersion: submitted.version,
      clientOperationId: `github-archive-${fixture.now}`,
    });
    await actor.mutation(api.reviewLinks.addGithub, {
      eventSlug: fixture.eventSlug,
      repositoryUrl: "https://github.com/acm-vit/judge-app",
      clientOperationId: `github-second-${fixture.now}`,
    });

    await expect(
      actor.mutation(api.reviewLinks.addGithub, {
        eventSlug: fixture.eventSlug,
        repositoryUrl: "https://github.com/acm-vit/portal",
        clientOperationId: `github-restore-${fixture.now}`,
      }),
    ).rejects.toThrow("already submitted 1 GitHub links");

    const after = await actor.query(api.reviewLinks.current, { eventSlug: fixture.eventSlug });
    expect(after?.github.map((link) => link.url)).toEqual([
      "https://github.com/acm-vit/judge-app",
    ]);
    const archived = await backend.run(async (ctx) => {
      const link = await ctx.db.get(first.linkId);
      return link?.state;
    });
    expect(archived).toBe("archived");
  }, 30_000);

  test("restoring an archived link writes an audit event", async () => {
    const { actor, backend, fixture } = await seededActor("audit");
    const added = await actor.mutation(api.reviewLinks.addGithub, {
      eventSlug: fixture.eventSlug,
      repositoryUrl: "https://github.com/acm-vit/portal",
      clientOperationId: `github-add-${fixture.now}`,
    });
    const current = await actor.query(api.reviewLinks.current, { eventSlug: fixture.eventSlug });
    const submitted = current?.github[0];
    if (!submitted) throw new Error("The review link was not stored.");
    await actor.mutation(api.reviewLinks.archive, {
      eventSlug: fixture.eventSlug,
      linkId: added.linkId,
      expectedVersion: submitted.version,
      clientOperationId: `github-archive-${fixture.now}`,
    });
    await actor.mutation(api.reviewLinks.addGithub, {
      eventSlug: fixture.eventSlug,
      repositoryUrl: "https://github.com/acm-vit/portal",
      clientOperationId: `github-restore-${fixture.now}`,
    });

    const audits = await backend.run(async (ctx) =>
      (await ctx.db.query("auditEvents").collect())
        .filter((event) => event.targetId === added.linkId)
        .toSorted((left, right) => left.serverTime - right.serverTime),
    );
    expect(audits.map((event) => [event.action, event.reason, event.authorizingGrantIds.length])).toEqual([
      ["review_link.added", "Participant submitted a review link", 1],
      ["review_link.archived", "Participant removed a review link", 1],
      ["review_link.added", "Participant restored a review link", 1],
    ]);
  }, 30_000);
});

async function seededActor(
  label: string,
  limits?: { githubLimit: number; figmaLimit: number },
) {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  const now = Date.now();
  const authUserId = await createAuthUser(backend, `${label}-${now}`);
  const authSessionId = await createAuthSession(backend, authUserId, `${label}-${now}`);
  const fixture = await seedReviewLinksFixture(backend, {
    now,
    slug: `review-links-${label}-${now}`,
    authUserId,
    ...(limits ? { limits } : {}),
  });
  return {
    backend,
    actor: backend.withIdentity({ subject: authUserId, sessionId: authSessionId }),
    fixture,
  };
}

async function seedReviewLinksFixture(
  backend: BackendTest,
  args: {
    now: number;
    slug: string;
    authUserId: string;
    limits?: { githubLimit: number; figmaLimit: number };
  },
) {
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: args.slug,
      name: "Review links fixture",
      timezone: "Asia/Kolkata",
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
      applicationsCloseAt: args.now + 86_400_000,
      version: 1,
      createdAt: args.now,
      updatedAt: args.now,
    });
    const personId = await ctx.db.insert("people", {
      authUserId: args.authUserId,
      googleSubject: `google-${args.slug}`,
      verifiedEmail: `${args.slug}@example.test`,
      displayName: "Review participant",
      status: "active",
      createdAt: args.now,
      updatedAt: args.now,
    });
    if (args.limits) {
      const policy = normalizeIntegrationPolicy({
        policyVersion: `${args.slug}-policy`,
        requiredGitHubTopic: "code2create",
        maxActiveGitHubRepositoriesPerTeam: args.limits.githubLimit,
        maxActiveFigmaFilesPerTeam: args.limits.figmaLimit,
      });
      const policyId = await ctx.db.insert("integrationPolicyVersions", {
        eventId,
        version: 1,
        status: "published",
        ...policy,
        checksum: integrationPolicyChecksum(policy),
        createdByPersonId: personId,
        createdAt: args.now,
        publishedAt: args.now,
      });
      await ctx.db.patch(eventId, { publishedIntegrationPolicyId: policyId });
    }
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: `${args.slug}@example.test`,
      displayName: "Review participant",
      status: "active",
      linkedBy: "participant_provisioning",
      accessVersion: 1,
      createdAt: args.now,
      updatedAt: args.now,
    });
    const membershipId = await ctx.db.insert("eventMemberships", {
      eventId,
      personId,
      eventAccessSubjectId: subjectId,
      participantClass: "external_participant",
      eligibilityStatus: "eligible",
      onboardingStatus: "accepted",
      acceptedParticipantPolicyVersionIds: [],
      createdAt: args.now,
      updatedAt: args.now,
    });
    const teamId = await ctx.db.insert("teams", {
      eventId,
      name: "Review team",
      publicCode: "REVLINKS",
      leadMembershipId: membershipId,
      status: "forming",
      activeMemberCount: 1,
      activeVitMemberCount: 0,
      activeExternalMemberCount: 1,
      membershipLocked: false,
      version: 1,
      createdAt: args.now,
      updatedAt: args.now,
    });
    await ctx.db.insert("teamMembers", {
      eventId,
      teamId,
      membershipId,
      role: "lead",
      status: "active",
      joinedAt: args.now,
      source: "created",
    });
    await insertPermissionGrant(ctx, {
      eventId,
      personId,
      eventAccessSubjectId: subjectId,
      permissionKey: "integration.read",
      scopeType: "team",
      scopeId: teamId,
      sourceType: "event_subject",
      sourceId: subjectId,
      reason: "Review links test",
      validFrom: args.now - 1,
    });
    return { eventSlug: args.slug, teamId, now: args.now };
  });
}

async function createAuthUser(backend: BackendTest, suffix: string) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Review participant",
        email: `review-links-${suffix}@example.test`,
        emailVerified: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
  });
  return documentId(result, "Better Auth user");
}

async function createAuthSession(backend: BackendTest, userId: string, suffix: string) {
  const result: unknown = await backend.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        expiresAt: Date.now() + 60 * 60 * 1_000,
        token: `review-links-session-${suffix}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        userId,
      },
    },
  });
  return documentId(result, "Better Auth session");
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
