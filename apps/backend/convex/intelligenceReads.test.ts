import { convexTest, type TestConvex } from "convex-test";
import { afterAll, describe, expect, test } from "vitest";

import {
  operationsIntelligenceCallbackSignatureContext,
  operationsIntelligenceProtocolVersion,
  operationsIntelligenceReadSignatureContext,
  signServiceBody,
} from "@code2create/domain";

import type { Id } from "./_generated/dataModel";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

const readSecret = "read-secret-".padEnd(48, "r");
const savedEnvironment = {
  INTELLIGENCE_READ_SECRET: process.env.INTELLIGENCE_READ_SECRET,
  AUTH_SITE_URL: process.env.AUTH_SITE_URL,
  PARTICIPANT_SITE_URL: process.env.PARTICIPANT_SITE_URL,
  OPERATIONS_SITE_URL: process.env.OPERATIONS_SITE_URL,
  HANDBOOK_SITE_URL: process.env.HANDBOOK_SITE_URL,
};

// Registering the HTTP router pulls the auth routes in with it, and those
// refuse to exist without their site origins.
process.env.INTELLIGENCE_READ_SECRET = readSecret;
process.env.AUTH_SITE_URL = "http://localhost:3211";
process.env.PARTICIPANT_SITE_URL = "http://localhost:4173";
process.env.OPERATIONS_SITE_URL = "http://localhost:4174";
process.env.HANDBOOK_SITE_URL = "http://localhost:4175";

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** These names and addresses exist only to prove they never leave Convex. */
const canaryPersonName = "Redaction Canary";
const canaryEmail = "redaction-canary@example.test";
const canaryTeamName = "Nightshift Canaries";
const canarySupportText = "A participant lost her badge near hall B";

async function signedRead(
  backend: BackendTest,
  eventSlug: string,
  read: string,
  options: { context?: string; timestamp?: string; mutateBody?: (body: string) => string } = {},
) {
  const body = JSON.stringify({
    protocolVersion: operationsIntelligenceProtocolVersion,
    read,
    eventSlug,
  });
  const timestamp = options.timestamp ?? Date.now().toString();
  const signature = await signServiceBody({
    context: options.context ?? operationsIntelligenceReadSignatureContext,
    secret: readSecret,
    timestamp,
    body,
  });
  return backend.fetch("/intelligence/operations-reads", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-c2c-signature": signature,
      "x-c2c-timestamp": timestamp,
    },
    body: options.mutateBody ? options.mutateBody(body) : body,
  });
}

describe("intelligence read endpoint", () => {
  test("accepts only a current signature over the exact body and read context", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedEvent(backend);

    const accepted = await signedRead(backend, fixture.eventSlug, "review_rounds");
    expect(accepted.status).toBe(200);

    const wrongContext = await signedRead(backend, fixture.eventSlug, "review_rounds", {
      context: operationsIntelligenceCallbackSignatureContext,
    });
    expect(wrongContext.status).toBe(401);

    const stale = await signedRead(backend, fixture.eventSlug, "review_rounds", {
      timestamp: (Date.now() - 6 * 60 * 1_000).toString(),
    });
    expect(stale.status).toBe(401);

    const tampered = await signedRead(backend, fixture.eventSlug, "review_rounds", {
      mutateBody: (body) => `${body} `,
    });
    expect(tampered.status).toBe(401);
  });

  test("refuses reads outside the whitelist and events that do not exist", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedEvent(backend);

    const unknownRead = await signedRead(backend, fixture.eventSlug, "raw_table_scan");
    expect(unknownRead.status).toBe(422);

    const unknownEvent = await signedRead(backend, "no-such-event", "review_rounds");
    expect(unknownEvent.status).toBe(404);
  });

  test("every read returns aggregates and ids, never a person, email, team name, or score", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedEvent(backend);

    for (const read of [
      "operations_health",
      "operations_attention",
      "review_rounds",
      "review_exceptions",
      "attendance_counts",
      "floor_mapping_progress",
      "support_load",
      "recommendation_history",
    ]) {
      const response = await signedRead(backend, fixture.eventSlug, read);
      expect(response.status, read).toBe(200);
      const text = await response.text();
      expect(text, read).not.toContain(canaryPersonName);
      expect(text, read).not.toContain("Canary");
      expect(text, read).not.toContain(canaryEmail);
      expect(text, read).not.toContain(canaryTeamName);
      expect(text, read).not.toContain(canarySupportText);
      expect(text.toLowerCase(), read).not.toContain("scorecard");
      expect(text.toLowerCase(), read).not.toMatch(/"score/);
    }
  });

  test("the review exceptions read carries the ids a recommendation must cite", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedEvent(backend);

    const response = await signedRead(backend, fixture.eventSlug, "review_exceptions");
    const payload = (await response.json()) as {
      read: string;
      data: {
        vacancies: Array<{ missingPanelMemberId: string; panelName: string }>;
        teams: Array<{ teamRoundStateId: string; state: string; callAttemptCount: number }>;
      };
    };
    expect(payload.read).toBe("review_exceptions");
    expect(payload.data.vacancies).toEqual([
      expect.objectContaining({
        missingPanelMemberId: fixture.removedPanelMemberId,
        panelName: "Panel D",
      }),
    ]);
    expect(payload.data.teams).toEqual([
      expect.objectContaining({
        teamRoundStateId: fixture.teamRoundStateId,
        state: "called",
        callAttemptCount: 2,
      }),
    ]);
  });
});

/**
 * A floor with one of everything the reads project, each seeded with canary
 * text where the schema stores free prose about people, so the redaction
 * assertions bite on every read at once.
 */
async function seedEvent(backend: BackendTest) {
  const now = Date.now();
  const eventSlug = `reads-${crypto.randomUUID()}`;
  return backend.run(async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: "Reads fixture",
      timezone: "Asia/Kolkata",
      status: "live",
      vitEmailDomains: ["vitstudent.ac.in"],
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const personId = await ctx.db.insert("people", {
      authUserId: `reads-${crypto.randomUUID()}`,
      googleSubject: `reads-${crypto.randomUUID()}`,
      verifiedEmail: canaryEmail,
      displayName: canaryPersonName,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: canaryEmail,
      displayName: canaryPersonName,
      status: "active",
      linkedBy: "access_invitation",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    const rubricVersionId = await ctx.db.insert("reviewRubricVersions", {
      eventId,
      version: 1,
      name: "Fixture rubric",
      status: "published",
      scoreMinimum: 0,
      scoreMaximum: 4,
      aggregationFormula: "criterion_mean_weighted_v1",
      spreadThreshold: 2,
      checksum: "fixture-rubric",
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    const roundId = await ctx.db.insert("reviewRounds", {
      eventId,
      rubricVersionId,
      stableKey: "fixture-round",
      name: "Review 1",
      sequence: 1,
      status: "open",
      startsAt: now - 60 * 60 * 1_000,
      endsAt: now + 60 * 60 * 1_000,
      reviewDurationSeconds: 600,
      ordinaryExtensionSeconds: 120,
      maximumOrdinaryExtensions: 1,
      missedCallGraceSeconds: 120,
      requiredCallAttempts: 2,
      substituteResponseSeconds: 60,
      missedReentryPolicy: "preserve_queue_time",
      requiredPanelSize: 3,
      minimumScorersPerCriterion: 1,
      minimumPresentParticipants: 1,
      requiresSharedCommitments: true,
      minimumReviewerBuild: 1,
      requiresCamera: false,
      requiresNotifications: false,
      version: 1,
      configurationChecksum: "fixture-round",
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
      openedAt: now,
    });
    const panelId = await ctx.db.insert("reviewPanels", {
      eventId,
      roundId,
      stableKey: "fixture-panel",
      name: "Panel D",
      coordinatorPersonId: personId,
      status: "needs_reviewer",
      version: 2,
      createdAt: now,
      updatedAt: now,
    });
    const removedPanelMemberId = await ctx.db.insert("reviewPanelMembers", {
      eventId,
      roundId,
      panelId,
      personId,
      eventAccessSubjectId: subjectId,
      assignedCriterionIds: [],
      isCoordinator: false,
      status: "removed",
      assignedAt: now,
      endedAt: now,
    });
    const membershipId = await ctx.db.insert("eventMemberships", {
      eventId,
      personId,
      eventAccessSubjectId: subjectId,
      participantClass: "vit_student",
      eligibilityStatus: "eligible",
      onboardingStatus: "accepted",
      acceptedParticipantPolicyVersionIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const teamId = await ctx.db.insert("teams", {
      eventId,
      name: canaryTeamName,
      publicCode: "CANARY",
      leadMembershipId: membershipId,
      status: "confirmed",
      membershipLocked: true,
      trackLocked: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const teamRoundStateId = await ctx.db.insert("teamRoundStates", {
      eventId,
      roundId,
      teamId,
      panelId,
      state: "called",
      queuedAt: now - 20 * 60 * 1_000,
      calledAt: now - 5 * 60 * 1_000,
      callAttemptCount: 2,
      priority: 0,
      version: 1,
      updatedByPersonId: personId,
      updatedAt: now,
    });
    await ctx.db.insert("supportCases", {
      eventId,
      publicCode: "C2C-0001",
      category: "queue",
      description: canarySupportText,
      origin: "participant",
      reporterPersonId: personId,
      reporterEventAccessSubjectId: subjectId,
      contactEmail: canaryEmail,
      state: "open",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("operationsAttentionItems", {
      eventId,
      detectorKey: "panel_seat_empty",
      dedupeKey: `panel_seat_empty:${panelId}`,
      subjectType: "panel",
      subjectId: panelId,
      severity: "critical",
      statement: "Panel D is short one reviewer",
      route: "/reviews",
      actionLabel: "Page a substitute",
      visibility: { permissionKey: "round.read", scopeType: "round", scopeId: roundId },
      evidenceJson: JSON.stringify({ panelId }),
      state: "open",
      recurrenceCount: 1,
      firstObservedAt: now,
      lastObservedAt: now,
      version: 1,
    });
    return {
      eventSlug,
      eventId,
      roundId,
      panelId,
      removedPanelMemberId: removedPanelMemberId as Id<"reviewPanelMembers">,
      teamRoundStateId: teamRoundStateId as Id<"teamRoundStates">,
    };
  });
}
