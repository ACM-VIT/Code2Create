import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { defaultParticipantEmailTemplates } from "@code2create/domain";
import { internal } from "./_generated/api";
import { createInitialEvent } from "./system";
import { defaultParticipantPolicy } from "./lib/participantPolicy";
import { defaultDeterministicIntakePolicy } from "./lib/intakePolicy";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
afterEach(() => vi.unstubAllEnvs());
test("staging reset is unavailable in production", async () => {
  vi.stubEnv("C2C_DEPLOYMENT_ENVIRONMENT", "production");
  const t = convexTest(schema, modules);
  await expect(
    t.mutation(internal.stagingInternalHack.clearOperationalRemainders, {}),
  ).rejects.toThrow("requires staging");
});
test.each([2, 5])(
  "seeds a %i-person locked application, answers and own-team conflicts without sending mail",
  async (size) => {
    vi.stubEnv("C2C_DEPLOYMENT_ENVIRONMENT", "staging");
    vi.stubEnv("INITIAL_EVENT_SLUG", "internal");
    const t = convexTest(schema, modules);
    const now = Date.now();
    const setup = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("people", {
        authUserId: "owner",
        verifiedEmail: "owner@example.test",
        displayName: "Operator",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const owner = await ctx.db.get(ownerId);
      if (!owner) throw new Error("Missing owner");
      const { eventId } = await createInitialEvent(
        ctx,
        {
          eventSlug: "internal",
          eventName: "Internal staging",
          timezone: "Asia/Kolkata",
          applicationsCloseAt: now + 3600000,
          externalApplicationsCloseAt: now + 3600000,
          vitEmailDomains: ["vitstudent.ac.in"],
          participantPolicy: defaultParticipantPolicy,
          admissionPolicyVersion: "internal-v1",
          admissionParticipantCapacity: 1000,
          admissionMinimumHumanReviews: 2,
          intakePolicy: defaultDeterministicIntakePolicy,
          communicationsPolicy: {
            venueName: "Internal",
            startsAt: now + 7200000,
            endsAt: now + 14400000,
            nextSteps: [
              {
                stableKey: "rsvp",
                title: "Confirm your spot",
                detail: "Team lead confirms in staging.",
              },
            ],
            discordUrl: "https://discord.gg/code2create",
            discordLabel: "Discord",
            notificationProvider: "cloudflare_email",
            emailTemplates: defaultParticipantEmailTemplates(),
          },
          integrationPolicy: {
            version: "internal-v1",
            requiredGitHubTopic: "internal",
            maxActiveGitHubRepositoriesPerTeam: 10,
            maxActiveFigmaFilesPerTeam: 10,
          },
        },
        owner,
        "registration_open",
      );
      const people = [];
      for (let i = 0; i < size; i++)
        people.push(
          await ctx.db.insert("people", {
            authUserId: `person-${i}`,
            verifiedEmail: `person${i}@vitstudent.ac.in`,
            displayName: `Person ${i}`,
            status: "active",
            createdAt: now,
            updatedAt: now,
          }),
        );
      return { eventId, ownerPersonId: ownerId, people };
    });
    await t.run(async ctx => {
      const event = await ctx.db.get(setup.eventId);
      if (!event?.publishedCommunicationsPolicyId) throw new Error("Missing communications");
      const policy = await ctx.db.get(event.publishedCommunicationsPolicyId);
      if (!policy) throw new Error("Missing communications");
      await ctx.db.patch(policy._id, {emailTemplates:policy.emailTemplates.slice(0,3)});
    });
    await t.mutation(internal.stagingInternalHack.prepare,{eventId:setup.eventId,startsAt:now+7200000,endsAt:now+14400000});
    const args = {
      ...setup,
      number: 1,
      name: "Seeded team",
      idea: "A campus navigation app with accessible routes and live building access information.",
    };
    const id = await t.mutation(internal.stagingInternalHack.populateTeam, args);
    expect(await t.mutation(internal.stagingInternalHack.populateTeam, args)).toBe(id);
    await t.run(async (ctx) => {
      const team = await ctx.db.get(id);
      expect(team?.activeMemberCount).toBe(size);
      expect(team?.status).toBe("admitted");
      const project = team?.lockedProjectVersionId
        ? await ctx.db.get(team.lockedProjectVersionId)
        : null;
      expect(project?.intakeResponses.length).toBeGreaterThanOrEqual(2);
      expect(project?.lockedMemberCount).toBe(size);
      expect((await ctx.db.query("reviewerConflicts").collect()).length).toBe(size);
      expect(await ctx.db.query("admissionOffers").collect()).toHaveLength(0);
      expect(await ctx.db.query("participantNotificationDeliveries").collect()).toHaveLength(0);
    });
  },
);
