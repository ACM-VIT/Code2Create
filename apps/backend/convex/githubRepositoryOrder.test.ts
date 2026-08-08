import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "./_generated/dataModel.js";
import { reorderTeamRepositories } from "./githubIntegrations.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

describe("GitHub repository order", () => {
  test("changes the complete team order atomically and only versions moved rows", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    const repositoryIds = fixtureRepositoryIds(fixture);

    const result = await backend.run((ctx) =>
      reorderTeamRepositories(ctx, {
        eventId: fixture.eventId,
        teamId: fixture.teamId,
        orderedRepositories: [
          { bindingId: fixture.modelRepositoryId, expectedVersion: 1 },
          { bindingId: fixture.apiRepositoryId, expectedVersion: 1 },
          { bindingId: fixture.portalRepositoryId, expectedVersion: 1 },
        ],
        now: fixture.now + 1,
      }),
    );

    expect(result.previousOrder).toEqual(repositoryIds);
    expect(result.nextOrder).toEqual(repositoryIds.toReversed());
    expect(result.updatedBindingIds).toEqual([
      fixture.modelRepositoryId,
      fixture.portalRepositoryId,
    ]);
    expect(await readOrder(backend, fixture.teamId)).toEqual([
      { id: fixture.modelRepositoryId, order: 1, version: 2 },
      { id: fixture.apiRepositoryId, order: 2, version: 1 },
      { id: fixture.portalRepositoryId, order: 3, version: 2 },
    ]);
  });

  test("rejects a stale complete order without partially restoring it", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    await backend.run((ctx) =>
      reorderTeamRepositories(ctx, {
        eventId: fixture.eventId,
        teamId: fixture.teamId,
        orderedRepositories: [
          { bindingId: fixture.apiRepositoryId, expectedVersion: 1 },
          { bindingId: fixture.portalRepositoryId, expectedVersion: 1 },
          { bindingId: fixture.modelRepositoryId, expectedVersion: 1 },
        ],
        now: fixture.now + 1,
      }),
    );

    await expect(
      backend.run((ctx) =>
        reorderTeamRepositories(ctx, {
          eventId: fixture.eventId,
          teamId: fixture.teamId,
          orderedRepositories: fixtureRepositoryIds(fixture).map((bindingId) => ({
            bindingId,
            expectedVersion: 1,
          })),
          now: fixture.now + 2,
        }),
      ),
    ).rejects.toThrow("changed in another session");

    expect(await readOrder(backend, fixture.teamId)).toEqual([
      { id: fixture.apiRepositoryId, order: 1, version: 2 },
      { id: fixture.portalRepositoryId, order: 2, version: 2 },
      { id: fixture.modelRepositoryId, order: 3, version: 1 },
    ]);
  });

  test("requires every current repository exactly once", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);

    await expect(
      backend.run((ctx) =>
        reorderTeamRepositories(ctx, {
          eventId: fixture.eventId,
          teamId: fixture.teamId,
          orderedRepositories: [
            { bindingId: fixture.portalRepositoryId, expectedVersion: 1 },
            { bindingId: fixture.portalRepositoryId, expectedVersion: 1 },
            { bindingId: fixture.modelRepositoryId, expectedVersion: 1 },
          ],
          now: fixture.now + 1,
        }),
      ),
    ).rejects.toThrow("exactly once");

    expect(await readOrder(backend, fixture.teamId)).toEqual([
      { id: fixture.portalRepositoryId, order: 1, version: 1 },
      { id: fixture.apiRepositoryId, order: 2, version: 1 },
      { id: fixture.modelRepositoryId, order: 3, version: 1 },
    ]);
  });
});

async function seedFixture(backend: BackendTest) {
  const now = Date.UTC(2027, 7, 8, 8, 0, 0);
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: `github-order-${now}`,
      name: "Code2Create GitHub order fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      startsAt: now,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const personId = await ctx.db.insert("people", {
      authUserId: `github-order-user-${now}`,
      googleSubject: `github-order-subject-${now}`,
      verifiedEmail: `github-order-${now}@example.test`,
      displayName: "Mira Sen",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: `github-order-${now}@example.test`,
      displayName: "Mira Sen",
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
      onboardingStatus: "accepted",
      acceptedParticipantPolicyVersionIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const teamId = await ctx.db.insert("teams", {
      eventId,
      name: "Ordered Orbit",
      publicCode: "ORDER01",
      leadMembershipId: membershipId,
      status: "confirmed",
      membershipLocked: true,
      trackLocked: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const connectionId = await ctx.db.insert("githubInstallationConnections", {
      eventId,
      teamId,
      installationId: "42001",
      accountId: "31001",
      accountLogin: "ordered-orbit",
      targetType: "Organization",
      repositorySelection: "selected",
      state: "active",
      connectedByPersonId: personId,
      connectedAt: now,
      lastVerifiedAt: now,
      version: 1,
    });
    const insertRepository = (
      name: string,
      displayOrder: number,
    ): Promise<Id<"githubRepositoryBindings">> =>
      ctx.db.insert("githubRepositoryBindings", {
        eventId,
        teamId,
        installationConnectionId: connectionId,
        repositoryId: `repository-${displayOrder}`,
        repositoryNodeId: `R_${displayOrder}`,
        owner: "ordered-orbit",
        name,
        fullName: `ordered-orbit/${name}`,
        url: `https://github.com/ordered-orbit/${name}`,
        isPrivate: true,
        isFork: false,
        defaultBranch: "main",
        kind: displayOrder === 1 ? "frontend" : displayOrder === 2 ? "backend_api" : "ai_ml",
        purpose: `${name} project surface`,
        trackedBranch: "main",
        displayOrder,
        requiredTopic: "code2create-7-0",
        topicState: "present",
        state: "active",
        baselineSha: `${displayOrder}`.repeat(40),
        currentHeadSha: `${displayOrder}`.repeat(40),
        lastReconciledAt: now,
        syncRevision: 1,
        syncedRevision: 1,
        syncState: "ready",
        version: 1,
        providerCreatedAt: now,
        connectedAt: now,
        updatedAt: now,
      });
    const portalRepositoryId = await insertRepository("portal", 1);
    const apiRepositoryId = await insertRepository("api", 2);
    const modelRepositoryId = await insertRepository("model", 3);
    return {
      eventId,
      teamId,
      portalRepositoryId,
      apiRepositoryId,
      modelRepositoryId,
      now,
    };
  });
}

function fixtureRepositoryIds(fixture: Awaited<ReturnType<typeof seedFixture>>) {
  return [
    fixture.portalRepositoryId,
    fixture.apiRepositoryId,
    fixture.modelRepositoryId,
  ];
}

async function readOrder(
  backend: BackendTest,
  teamId: Awaited<ReturnType<typeof seedFixture>>["teamId"],
) {
  return backend.run(async (ctx) => {
    const bindings = await ctx.db
      .query("githubRepositoryBindings")
      .withIndex("by_team_state", (index) => index.eq("teamId", teamId))
      .collect();
    return bindings
      .toSorted((left, right) => left.displayOrder - right.displayOrder)
      .map((binding) => ({
        id: binding._id,
        order: binding.displayOrder,
        version: binding.version,
      }));
  });
}
