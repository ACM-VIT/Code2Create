import { ConvexError, v } from "convex/values";
import { z } from "zod";

import { components, internal } from "./_generated/api";
import type { DataModel, Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { TableNamesInDataModel } from "convex/server";
import { operationFingerprint } from "./lib/operations";
import { normalizeEmail, normalizedText } from "./lib/strings";
import { bootstrapEventInput, createInitialEvent } from "./system";

const testerInput = v.object({
  email: v.string(),
  displayName: v.string(),
});

const emailAddress = z.email().max(254);
const bootstrapAuthUserId = "staging-bootstrap";
const bootstrapEmail = "staging-bootstrap@c2c.sh";

function requireStagingDeployment() {
  if (process.env.C2C_DEPLOYMENT_ENVIRONMENT?.trim() !== "staging") {
    throw new ConvexError({
      code: "STAGING_SETUP_NOT_ALLOWED",
      message: "Staging setup can run only on the staging deployment.",
    });
  }
}

async function deleteAllFromTable<TableName extends TableNamesInDataModel<DataModel>>(
  ctx: MutationCtx,
  table: TableName,
) {
  const documents = await ctx.db.query(table).collect();
  for (const document of documents) await ctx.db.delete(document._id);
  return documents.length;
}

async function stagingActor(ctx: MutationCtx) {
  const existing = await ctx.db
    .query("people")
    .withIndex("by_auth_user", (index) => index.eq("authUserId", bootstrapAuthUserId))
    .unique();
  if (existing) return existing;
  const now = Date.now();
  const personId = await ctx.db.insert("people", {
    authUserId: bootstrapAuthUserId,
    googleSubject: bootstrapAuthUserId,
    verifiedEmail: bootstrapEmail,
    displayName: "Staging setup",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const person = await ctx.db.get("people", personId);
  if (!person) throw new Error("The staging setup actor did not persist.");
  return person;
}

function normalizedTesters(testers: readonly { email: string; displayName: string }[]) {
  if (testers.length < 1 || testers.length > 20) {
    throw new ConvexError({
      code: "INVALID_STAGING_TESTERS",
      message: "Configure between one and twenty staging testers.",
    });
  }
  const normalized = testers.map((tester) => {
    const email = normalizeEmail(tester.email);
    if (!emailAddress.safeParse(email).success) {
      throw new ConvexError({
        code: "INVALID_STAGING_TESTER_EMAIL",
        message: "Every staging tester needs one complete email address.",
      });
    }
    return {
      email,
      displayName: normalizedText(tester.displayName, "Tester name", 2, 100),
    };
  });
  if (new Set(normalized.map((tester) => tester.email)).size !== normalized.length) {
    throw new ConvexError({
      code: "DUPLICATE_STAGING_TESTER",
      message: "Each staging tester email may appear only once.",
    });
  }
  return normalized;
}

async function createTesterRoster(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    actor: Doc<"people">;
    testers: readonly { email: string; displayName: string }[];
  },
) {
  if (args.event.endsAt === undefined) {
    throw new Error("The staging event end time is not configured.");
  }
  const missing: Array<{ email: string; displayName: string }> = [];
  let unchangedCount = 0;
  let alreadyClaimedCount = 0;
  for (const tester of args.testers) {
    const [pending, claimed] = await Promise.all([
      ctx.db
        .query("rosterEntries")
        .withIndex("by_event_email_status", (index) =>
          index
            .eq("eventId", args.event._id)
            .eq("emailNormalized", tester.email)
            .eq("status", "pending"),
        )
        .unique(),
      ctx.db
        .query("rosterEntries")
        .withIndex("by_event_email_status", (index) =>
          index
            .eq("eventId", args.event._id)
            .eq("emailNormalized", tester.email)
            .eq("status", "claimed"),
        )
        .unique(),
    ]);
    if (claimed) {
      alreadyClaimedCount += 1;
    } else if (pending) {
      unchangedCount += 1;
    } else {
      missing.push(tester);
    }
  }
  if (missing.length === 0) return 0;

  const now = Date.now();
  const validFrom = now;
  const validUntil = args.event.endsAt;
  const configurationChecksum = operationFingerprint([validFrom, validUntil]);
  const previewChecksum = operationFingerprint([
    configurationChecksum,
    ...missing.flatMap((tester) => [tester.email, tester.displayName, "supreme"]),
  ]);
  const rosterImportId = await ctx.db.insert("rosterImports", {
    eventId: args.event._id,
    sourceName: "Staging tester access",
    validFrom,
    validUntil,
    bundleSelections: [],
    configurationChecksum,
    previewChecksum,
    rowCount: missing.length,
    createdCount: missing.length,
    replacedCount: 0,
    unchangedCount,
    alreadyClaimedCount,
    reason: "Approved staging idea-submission testing",
    authorizingGrantIds: [],
    createdByPersonId: args.actor._id,
    clientOperationId: `staging-testers:${previewChecksum}`,
    createdAt: now,
  });
  await Promise.all(
    missing.map((tester, index) =>
      ctx.db.insert("rosterEntries", {
        eventId: args.event._id,
        rosterImportId,
        sourceRowNumber: index + 2,
        emailNormalized: tester.email,
        displayName: tester.displayName,
        role: "supreme",
        configurationChecksum,
        validFrom,
        validUntil,
        status: "pending",
        version: 1,
        createdByPersonId: args.actor._id,
        createdAt: now,
      }),
    ),
  );
  await ctx.scheduler.runAt(validUntil, internal.rosters.expireImportEntries, {
    rosterImportId,
  });
  return missing.length;
}

export const configureIdeaRound = internalMutation({
  args: {
    event: bootstrapEventInput,
    supremeTesters: v.array(testerInput),
  },
  returns: v.object({
    eventId: v.id("events"),
    eventStatus: v.literal("registration_open"),
    createdTesterRosterEntries: v.number(),
  }),
  handler: async (ctx, args) => {
    requireStagingDeployment();
    const testers = normalizedTesters(args.supremeTesters);
    const actor = await stagingActor(ctx);
    let event = await ctx.db
      .query("events")
      .withIndex("by_slug", (index) => index.eq("slug", args.event.eventSlug))
      .unique();
    const eventAlreadyExisted = event !== null;
    if (!event) {
      const created = await createInitialEvent(ctx, args.event, actor, "registration_open");
      event = await ctx.db.get("events", created.eventId);
    }
    if (!event) throw new Error("The staging event did not persist.");
    if (
      event.name !== args.event.eventName.trim() ||
      event.timezone !== args.event.timezone.trim() ||
      event.externalApplicationsCloseAt !== args.event.externalApplicationsCloseAt ||
      event.applicationsCloseAt !== args.event.applicationsCloseAt ||
      event.startsAt !== args.event.communicationsPolicy.startsAt ||
      event.endsAt !== args.event.communicationsPolicy.endsAt
    ) {
      throw new ConvexError({
        code: "STAGING_EVENT_CONFIGURATION_MISMATCH",
        message: "The existing staging event does not match this setup request.",
      });
    }
    if (event.status === "draft") {
      await ctx.db.patch("events", event._id, {
        status: "registration_open",
        version: event.version + 1,
        updatedAt: Date.now(),
      });
      event = await ctx.db.get("events", event._id);
    }
    if (!event || event.status !== "registration_open") {
      throw new ConvexError({
        code: "STAGING_EVENT_NOT_OPEN",
        message: "The staging event exists but cannot be opened for applications.",
      });
    }
    if (eventAlreadyExisted) {
      await ctx.scheduler.runAt(
        args.event.externalApplicationsCloseAt,
        internal.eventLifecycle.markExternalRegistrationClosedAtDeadline,
        {
          eventId: event._id,
          expectedExternalApplicationsCloseAt: args.event.externalApplicationsCloseAt,
        },
      );
    }
    const createdTesterRosterEntries = await createTesterRoster(ctx, {
      event,
      actor,
      testers,
    });
    return {
      eventId: event._id,
      eventStatus: "registration_open" as const,
      createdTesterRosterEntries,
    };
  },
});

export const addSupremeTesters = internalMutation({
  args: {
    eventSlug: v.string(),
    supremeTesters: v.array(testerInput),
  },
  returns: v.object({
    eventId: v.id("events"),
    createdTesterRosterEntries: v.number(),
  }),
  handler: async (ctx, args) => {
    requireStagingDeployment();
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (index) => index.eq("slug", args.eventSlug.trim()))
      .unique();
    if (!event) {
      throw new ConvexError({
        code: "STAGING_EVENT_NOT_FOUND",
        message: "Create the staging event before adding testers.",
      });
    }
    const actor = await stagingActor(ctx);
    const createdTesterRosterEntries = await createTesterRoster(ctx, {
      event,
      actor,
      testers: normalizedTesters(args.supremeTesters),
    });
    return { eventId: event._id, createdTesterRosterEntries };
  },
});

export const resetParticipantTestingData = internalMutation({
  args: { eventSlug: v.string() },
  returns: v.object({
    deletedDocuments: v.number(),
    deletedParticipantPermissionGrants: v.number(),
  }),
  handler: async (ctx, args) => {
    requireStagingDeployment();
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (index) => index.eq("slug", args.eventSlug.trim()))
      .unique();
    if (!event) {
      throw new ConvexError({
        code: "STAGING_EVENT_NOT_FOUND",
        message: "The staging event does not exist.",
      });
    }

    const participantPermissionGrants = (
      await ctx.db
        .query("permissionGrants")
        .withIndex("by_person_status", (index) => index.eq("eventId", event._id))
        .collect()
    ).filter(
      (grant) =>
        grant.sourceType === "participant_membership" ||
        grant.sourceType === "team_membership" ||
        grant.sourceType === "team_lead" ||
        grant.sourceType === "application_assignment" ||
        grant.sourceType === "panel_assignment" ||
        grant.sourceType === "reserve_assignment" ||
        grant.sourceType === "page_assignment" ||
        grant.sourceType === "station_assignment",
    );

    for (const grant of participantPermissionGrants) await ctx.db.delete(grant._id);

    const participantAssistantThreads = await ctx.db.query("participantAssistantThreads").collect();
    for (const thread of participantAssistantThreads) {
      await ctx.runMutation(components.agent.threads.deleteAllForThreadIdAsync, {
        threadId: thread.threadId,
      });
    }

    const deletedCounts = await Promise.all([
      deleteAllFromTable(ctx, "participantAssistantRequests"),
      deleteAllFromTable(ctx, "participantAssistantThreads"),
      deleteAllFromTable(ctx, "participantNotificationProviderEvents"),
      deleteAllFromTable(ctx, "participantNotificationDeliveries"),
      deleteAllFromTable(ctx, "participantNotificationDestinations"),
      deleteAllFromTable(ctx, "outboundCallProviderEvents"),
      deleteAllFromTable(ctx, "outboundCallDeliveries"),
      deleteAllFromTable(ctx, "outboundCallConsents"),
      deleteAllFromTable(ctx, "benefitGrantRuns"),
      deleteAllFromTable(ctx, "benefitGrants"),
      deleteAllFromTable(ctx, "benefitCodes"),
      deleteAllFromTable(ctx, "benefits"),
      deleteAllFromTable(ctx, "admissionCapacityReservations"),
      deleteAllFromTable(ctx, "admissionOffers"),
      deleteAllFromTable(ctx, "admissionInformationRequests"),
      deleteAllFromTable(ctx, "admissionHumanReviews"),
      deleteAllFromTable(ctx, "admissionAIRecommendations"),
      deleteAllFromTable(ctx, "admissionReviewAssignments"),
      deleteAllFromTable(ctx, "applications"),
      deleteAllFromTable(ctx, "reviewEvaluations"),
      deleteAllFromTable(ctx, "reviewAssignments"),
      deleteAllFromTable(ctx, "reviewPresence"),
      deleteAllFromTable(ctx, "reviewParticipantAvailabilityWaivers"),
      deleteAllFromTable(ctx, "reviewTeamQrTokens"),
      deleteAllFromTable(ctx, "teamRoundStates"),
      deleteAllFromTable(ctx, "scorecardCorrectionCases"),
      deleteAllFromTable(ctx, "scorecardVersions"),
      deleteAllFromTable(ctx, "scorecards"),
      deleteAllFromTable(ctx, "teamCheckpointSubmissions"),
      deleteAllFromTable(ctx, "teamCheckpointDrafts"),
      deleteAllFromTable(ctx, "figmaWebhookDeliveries"),
      deleteAllFromTable(ctx, "figmaSnapshotActivity"),
      deleteAllFromTable(ctx, "figmaNodeFacts"),
      deleteAllFromTable(ctx, "figmaVersionFacts"),
      deleteAllFromTable(ctx, "figmaFileSnapshots"),
      deleteAllFromTable(ctx, "figmaFileMetrics"),
      deleteAllFromTable(ctx, "figmaFileBindings"),
      deleteAllFromTable(ctx, "figmaPreviewSets"),
      deleteAllFromTable(ctx, "figmaSetupIntents"),
      deleteAllFromTable(ctx, "figmaCredentialConnections"),
      deleteAllFromTable(ctx, "figmaOAuthCredentials"),
      deleteAllFromTable(ctx, "githubWebhookDeliveries"),
      deleteAllFromTable(ctx, "githubPushEvents"),
      deleteAllFromTable(ctx, "githubRepositorySnapshots"),
      deleteAllFromTable(ctx, "githubRepositoryMetrics"),
      deleteAllFromTable(ctx, "githubRepositoryBindings"),
      deleteAllFromTable(ctx, "githubTeamMetrics"),
      deleteAllFromTable(ctx, "githubStarAuthorizations"),
      deleteAllFromTable(ctx, "githubStarSetupIntents"),
      deleteAllFromTable(ctx, "githubStarCompletions"),
      deleteAllFromTable(ctx, "githubSetupIntents"),
      deleteAllFromTable(ctx, "githubInstallationConnections"),
      deleteAllFromTable(ctx, "integrationArtifacts"),
      deleteAllFromTable(ctx, "noveltyPreviewRequests"),
      deleteAllFromTable(ctx, "noveltyTeamIdeas"),
      deleteAllFromTable(ctx, "intakeInterpretations"),
      deleteAllFromTable(ctx, "intakeGeneratedQuestions"),
      deleteAllFromTable(ctx, "intakeAnswerVersions"),
      deleteAllFromTable(ctx, "projectVersions"),
      deleteAllFromTable(ctx, "projectDrafts"),
      deleteAllFromTable(ctx, "intakeWorkingFields"),
      deleteAllFromTable(ctx, "teamSubmissionMembers"),
      deleteAllFromTable(ctx, "teamSubmissionAttempts"),
      deleteAllFromTable(ctx, "teamLeadershipTransfers"),
      deleteAllFromTable(ctx, "teamMembers"),
      deleteAllFromTable(ctx, "teams"),
      deleteAllFromTable(ctx, "teamRosterEntries"),
      deleteAllFromTable(ctx, "teamRosterImports"),
      deleteAllFromTable(ctx, "participantProfiles"),
      deleteAllFromTable(ctx, "participantPhoneVerifications"),
      deleteAllFromTable(ctx, "eventMemberships"),
    ]);

    const deletedOperationResults = await deleteAllFromTable(ctx, "operationResults");

    return {
      deletedDocuments:
        deletedCounts.reduce((total, count) => total + count, 0) + deletedOperationResults,
      deletedParticipantPermissionGrants: participantPermissionGrants.length,
    };
  },
});
