import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import {
  currentAuthSessionFreshness,
  ensurePerson,
  requireVerifiedGoogleIdentity,
  sensitiveCommandSessionMaxAgeMs,
} from "./lib/identity";
import {
  admissionModelConfigurationChecksum,
  admissionPolicyChecksum,
  defaultAdmissionCriteria,
  defaultAdmissionReasonCodes,
} from "./lib/admissionPolicy";
import {
  communicationsPolicyChecksum,
  communicationsPolicyInput,
  normalizeCommunicationsPolicy,
} from "./lib/communicationsPolicy";
import {
  intakePolicyChecksum,
  intakePolicyInput,
  normalizeIntakePolicy,
} from "./lib/intakePolicy";
import {
  integrationPolicyChecksum,
  normalizeIntegrationPolicy,
} from "./lib/integrationPolicy";
import { localBrowserFixtureOrigins } from "./lib/localBrowserFixtures";
import {
  defaultOperationsAutonomyPolicy,
  normalizeOperationsAutonomyPolicy,
  operationsAutonomyPolicyChecksum,
} from "./lib/operationsAutonomyPolicy";
import {
  loadPublishedParticipantPolicy,
  normalizeParticipantPolicy,
  participantPolicyChecksum,
  participantPolicyInput,
} from "./lib/participantPolicy";
import { addEventSubjectSelfGrants, insertPermissionGrant } from "./lib/permissions";
import type { PermissionKey } from "./lib/permissionCatalog";
import { normalizeEmail, normalizedText } from "./lib/strings";
import { loadPublishedPhaseSchedule } from "./lib/phaseSchedule";
import { eventPhaseKey, eventStatus } from "./values";

const publicEventPhase = v.object({
  phaseKey: eventPhaseKey,
  displayName: v.string(),
  description: v.string(),
  startsAt: v.number(),
  endsAt: v.number(),
  displayOrder: v.number(),
});

const publicShellState = v.object({
  serverNow: v.number(),
  auth: v.object({
    googleConfigured: v.boolean(),
    localDevelopmentFixturesEnabled: v.boolean(),
  }),
  event: v.union(
    v.null(),
    v.object({
      id: v.id("events"),
      slug: v.string(),
      name: v.string(),
      timezone: v.string(),
      status: eventStatus,
    }),
  ),
});

function publicAuthState() {
  return {
    googleConfigured: Boolean(
      process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim(),
    ),
    localDevelopmentFixturesEnabled: localBrowserFixtureOrigins() !== null,
  };
}

function initialSupremeEmails() {
  return (process.env.INITIAL_SUPREME_EMAILS ?? "")
    .split(",")
    .map(normalizeEmail)
    .filter(Boolean);
}

function initialEventSlug() {
  const configured = process.env.INITIAL_EVENT_SLUG?.trim();
  if (!configured) return null;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(configured)) {
    throw new Error("INITIAL_EVENT_SLUG must be a lowercase URL slug.");
  }
  return configured;
}

export const freshAuthenticationStatus = query({
  args: {},
  returns: v.object({ fresh: v.boolean() }),
  handler: async (ctx) => ({
    fresh: (await currentAuthSessionFreshness(
      ctx,
      sensitiveCommandSessionMaxAgeMs,
    )).fresh,
  }),
});

export const bootstrapEligibility = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    allowed: v.boolean(),
    email: v.string(),
    eventExists: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { user } = await requireVerifiedGoogleIdentity(ctx);
    const event = await ctx.db.query("events").first();
    const email = normalizeEmail(user.email);
    const requestedSlug = args.eventSlug.trim();
    return {
      allowed:
        event === null &&
        requestedSlug === initialEventSlug() &&
        initialSupremeEmails().includes(email),
      email,
      eventExists: event !== null,
    };
  },
});

export const getPublicState = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    auth: v.object({
      googleConfigured: v.boolean(),
      localDevelopmentFixturesEnabled: v.boolean(),
    }),
    event: v.union(
      v.null(),
      v.object({
        id: v.id("events"),
        slug: v.string(),
        name: v.string(),
        timezone: v.string(),
        status: eventStatus,
        registrationOpen: v.boolean(),
        applicationsCloseAt: v.number(),
        teamMinSize: v.number(),
        teamMaxSize: v.number(),
        phases: v.array(publicEventPhase),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (index) => index.eq("slug", args.eventSlug))
      .unique();
    const auth = publicAuthState();
    if (!event) {
      return {
        auth,
        event: null,
      };
    }

    const [phaseSchedule, participantPolicy] = await Promise.all([
      loadPublishedPhaseSchedule(ctx, event),
      loadPublishedParticipantPolicy(ctx, event),
    ]);

    return {
      auth,
      event: {
        id: event._id,
        slug: event.slug,
        name: event.name,
        timezone: event.timezone,
        status: event.status,
        registrationOpen:
          event.status === "registration_open" && Date.now() < event.applicationsCloseAt,
        applicationsCloseAt: event.applicationsCloseAt,
        teamMinSize: participantPolicy.normalized.teamMinimumSize,
        teamMaxSize: participantPolicy.normalized.teamMaximumSize,
        phases: phaseSchedule
          ? phaseSchedule.windows.map((phase) => ({
              phaseKey: phase.phaseKey,
              displayName: phase.displayName,
              description: phase.description,
              startsAt: phase.startsAt,
              endsAt: phase.endsAt,
              displayOrder: phase.displayOrder,
            }))
          : [],
      },
    };
  },
});

export const getPublicShellState = query({
  args: { eventSlug: v.string() },
  returns: publicShellState,
  handler: async (ctx, args) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (index) => index.eq("slug", args.eventSlug))
      .unique();
    return {
      serverNow: Date.now(),
      auth: publicAuthState(),
      event: event
        ? {
            id: event._id,
            slug: event.slug,
            name: event.name,
            timezone: event.timezone,
            status: event.status,
          }
        : null,
    };
  },
});

export const bootstrapEvent = mutation({
  args: {
    eventSlug: v.string(),
    eventName: v.string(),
    timezone: v.string(),
    applicationsCloseAt: v.number(),
    vitEmailDomains: v.array(v.string()),
    participantPolicy: participantPolicyInput,
    admissionPolicyVersion: v.string(),
    admissionParticipantCapacity: v.number(),
    admissionMinimumHumanReviews: v.number(),
    intakePolicy: intakePolicyInput,
    communicationsPolicy: communicationsPolicyInput,
    admissionModel: v.optional(
      v.object({
        version: v.string(),
        modelId: v.string(),
        promptVersion: v.string(),
        schemaVersion: v.string(),
        evaluationSuiteVersion: v.string(),
        maxOutputTokens: v.number(),
        timeoutMs: v.number(),
      }),
    ),
    integrationPolicy: v.object({
      version: v.string(),
      requiredGitHubTopic: v.string(),
      maxActiveGitHubRepositoriesPerTeam: v.number(),
      maxActiveFigmaFilesPerTeam: v.number(),
      githubFreezeAt: v.optional(v.number()),
      figmaFreezeAt: v.optional(v.number()),
    }),
  },
  returns: v.object({ eventId: v.id("events") }),
  handler: async (ctx, args) => {
    const { user, person } = await ensurePerson(ctx);
    if (!initialSupremeEmails().includes(normalizeEmail(user.email))) {
      throw new ConvexError({
        code: "BOOTSTRAP_NOT_ALLOWED",
        message: "This verified Google account is not in INITIAL_SUPREME_EMAILS.",
      });
    }

    const eventSlug = args.eventSlug.trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(eventSlug)) {
      throw new ConvexError({ code: "INVALID_EVENT_SLUG", message: "Use a lowercase URL slug." });
    }
    const configuredSlug = initialEventSlug();
    if (configuredSlug === null || eventSlug !== configuredSlug) {
      throw new ConvexError({
        code: "BOOTSTRAP_EVENT_NOT_CONFIGURED",
        message: "This deployment is not configured to create that event.",
      });
    }
    const existingEvent = await ctx.db.query("events").first();
    if (existingEvent) {
      throw new ConvexError({ code: "EVENT_EXISTS", message: "This deployment already has an event." });
    }
    const participantPolicy = normalizeParticipantPolicy(args.participantPolicy);
    if (
      !Number.isInteger(args.admissionParticipantCapacity) ||
      args.admissionParticipantCapacity < participantPolicy.teamMaximumSize ||
      !Number.isInteger(args.admissionMinimumHumanReviews) ||
      args.admissionMinimumHumanReviews < 1 ||
      args.admissionMinimumHumanReviews > 5
    ) {
      throw new ConvexError({
        code: "INVALID_ADMISSION_POLICY",
        message: "Admission capacity or minimum human-review coverage is invalid.",
      });
    }
    if (
      args.admissionModel &&
      (!Number.isInteger(args.admissionModel.maxOutputTokens) ||
        args.admissionModel.maxOutputTokens < 300 ||
        args.admissionModel.maxOutputTokens > 2_000 ||
        !Number.isInteger(args.admissionModel.timeoutMs) ||
        args.admissionModel.timeoutMs < 2_000 ||
        args.admissionModel.timeoutMs > 30_000)
    ) {
      throw new ConvexError({
        code: "INVALID_ADMISSION_MODEL_POLICY",
        message: "Admission model limits are invalid.",
      });
    }
    const integrationPolicy = normalizeIntegrationPolicy({
      policyVersion: args.integrationPolicy.version,
      requiredGitHubTopic: args.integrationPolicy.requiredGitHubTopic,
      maxActiveGitHubRepositoriesPerTeam:
        args.integrationPolicy.maxActiveGitHubRepositoriesPerTeam,
      maxActiveFigmaFilesPerTeam: args.integrationPolicy.maxActiveFigmaFilesPerTeam,
      ...(args.integrationPolicy.githubFreezeAt !== undefined
        ? { githubFreezeAt: args.integrationPolicy.githubFreezeAt }
        : {}),
      ...(args.integrationPolicy.figmaFreezeAt !== undefined
        ? { figmaFreezeAt: args.integrationPolicy.figmaFreezeAt }
        : {}),
    });

    const intakePolicy = normalizeIntakePolicy(args.intakePolicy);
    const communicationsPolicy = normalizeCommunicationsPolicy(args.communicationsPolicy);

    const now = Date.now();
    if (
      !Number.isSafeInteger(args.applicationsCloseAt) ||
      args.applicationsCloseAt <= now ||
      args.applicationsCloseAt > communicationsPolicy.startsAt
    ) {
      throw new ConvexError({
        code: "INVALID_APPLICATION_DEADLINE",
        message: "The application deadline must be in the future and no later than the event start.",
      });
    }
    const admissionPolicyVersion = normalizedText(
      args.admissionPolicyVersion,
      "Admission policy version",
      1,
      80,
    );
    const eventId = await ctx.db.insert("events", {
      slug: eventSlug,
      name: normalizedText(args.eventName, "Event name", 3, 80),
      timezone: args.timezone.trim(),
      status: "draft",
      vitEmailDomains: args.vitEmailDomains.map((domain) => domain.trim().toLowerCase()),
      applicationsCloseAt: args.applicationsCloseAt,
      startsAt: communicationsPolicy.startsAt,
      endsAt: communicationsPolicy.endsAt,
      createdByPersonId: person._id,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const participantPolicyVersionId = await ctx.db.insert("participantPolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...participantPolicy,
      checksum: participantPolicyChecksum(participantPolicy),
      createdByPersonId: person._id,
      createdAt: now,
      publishedAt: now,
    });
    const intakePolicyVersionId = await ctx.db.insert("intakePolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...intakePolicy,
      checksum: intakePolicyChecksum(intakePolicy),
      createdByPersonId: person._id,
      createdAt: now,
      publishedAt: now,
    });
    const communicationsPolicyVersionId = await ctx.db.insert(
      "communicationsPolicyVersions",
      {
        eventId,
        version: 1,
        status: "published",
        ...communicationsPolicy,
        checksum: communicationsPolicyChecksum(communicationsPolicy),
        createdByPersonId: person._id,
        createdAt: now,
        publishedAt: now,
      },
    );
    await ctx.db.patch(eventId, {
      publishedParticipantPolicyId: participantPolicyVersionId,
      publishedIntakePolicyId: intakePolicyVersionId,
      publishedCommunicationsPolicyId: communicationsPolicyVersionId,
    });

    const integrationPolicyId = await ctx.db.insert("integrationPolicyVersions", {
      eventId,
      ...integrationPolicy,
      version: 1,
      status: "published",
      checksum: integrationPolicyChecksum(integrationPolicy),
      createdByPersonId: person._id,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.patch(eventId, { publishedIntegrationPolicyId: integrationPolicyId });

    const policyPayload = {
      version: admissionPolicyVersion,
      aiRecommendationMode: args.admissionModel ? "enabled" as const : "disabled" as const,
      minimumHumanReviews: args.admissionMinimumHumanReviews,
      overallParticipantCapacity: args.admissionParticipantCapacity,
      criteria: defaultAdmissionCriteria,
      decisionReasonCodes: defaultAdmissionReasonCodes,
    };
    const admissionPolicyId = await ctx.db.insert("admissionPolicyVersions", {
      eventId,
      ...policyPayload,
      criteria: defaultAdmissionCriteria.map((criterion) => ({
        criterionKey: criterion.criterionKey,
        label: criterion.label,
        guidanceByBand: criterion.guidanceByBand,
      })),
      decisionReasonCodes: defaultAdmissionReasonCodes.map((reason) => ({
        key: reason.key,
        label: reason.label,
        allowedDecisions: [...reason.allowedDecisions],
      })),
      status: "published",
      checksum: admissionPolicyChecksum({
        ...policyPayload,
        criteria: defaultAdmissionCriteria.map((criterion) => ({
          criterionKey: criterion.criterionKey,
          label: criterion.label,
          guidanceByBand: criterion.guidanceByBand,
        })),
        decisionReasonCodes: defaultAdmissionReasonCodes.map((reason) => ({
          key: reason.key,
          label: reason.label,
          allowedDecisions: [...reason.allowedDecisions],
        })),
      }),
      createdByPersonId: person._id,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.insert("admissionCapacityBuckets", {
      eventId,
      admissionPolicyVersionId: admissionPolicyId,
      capacity: args.admissionParticipantCapacity,
      reserved: 0,
      version: 1,
      updatedAt: now,
    });
    let admissionModelConfigId: Id<"admissionModelConfigVersions"> | undefined;
    if (args.admissionModel) {
      const modelConfig = {
        version: normalizedText(args.admissionModel.version, "Admission model version", 1, 80),
        modelId: normalizedText(args.admissionModel.modelId, "Admission model ID", 2, 120),
        promptVersion: normalizedText(args.admissionModel.promptVersion, "Prompt version", 1, 80),
        schemaVersion: normalizedText(args.admissionModel.schemaVersion, "Schema version", 1, 80),
        evaluationSuiteVersion: normalizedText(
          args.admissionModel.evaluationSuiteVersion,
          "Evaluation suite version",
          1,
          80,
        ),
        maxOutputTokens: args.admissionModel.maxOutputTokens,
        timeoutMs: args.admissionModel.timeoutMs,
      };
      admissionModelConfigId = await ctx.db.insert("admissionModelConfigVersions", {
        eventId,
        admissionPolicyVersionId: admissionPolicyId,
        ...modelConfig,
        status: "published",
        checksum: admissionModelConfigurationChecksum(modelConfig),
        createdByPersonId: person._id,
        createdAt: now,
        publishedAt: now,
      });
    }
    await ctx.db.patch(eventId, {
      publishedAdmissionPolicyId: admissionPolicyId,
      ...(admissionModelConfigId !== undefined
        ? { publishedAdmissionModelConfigId: admissionModelConfigId }
        : {}),
    });

    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId: person._id,
      emailNormalized: person.verifiedEmail,
      displayName: person.displayName,
      status: "active",
      linkedBy: "access_invitation",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    await addEventSubjectSelfGrants(ctx, {
      eventId,
      personId: person._id,
      eventAccessSubjectId: subjectId,
    });
    const autonomyPolicy = normalizeOperationsAutonomyPolicy(
      defaultOperationsAutonomyPolicy(subjectId),
    );
    const autonomyPolicyVersionId = await ctx.db.insert("operationsAutonomyPolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...autonomyPolicy,
      checksum: operationsAutonomyPolicyChecksum(autonomyPolicy),
      createdByPersonId: person._id,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.insert("operationsAutonomyStates", {
      eventId,
      policyVersionId: autonomyPolicyVersionId,
      lifecycle: {
        kind: "disabled",
        disabledAt: now,
        disabledByPersonId: person._id,
        reason: "Autonomous operations start disabled.",
      },
      nextEvaluationAt: now,
      pendingWorkCount: 0,
      cycle: 1,
      version: 1,
      updatedAt: now,
    });
    await ctx.db.insert("eventRoles", {
      eventId,
      personId: person._id,
      eventAccessSubjectId: subjectId,
      role: "supreme",
      validFrom: now,
      status: "active",
      sourceType: "production_seed",
      sourceId: `bootstrap:${eventId}`,
      assignedByPersonId: person._id,
      createdAt: now,
      reason: "Initial event bootstrap",
    });

    const bootstrapSource = `bootstrap:${eventId}`;
    const eventLifecyclePermissions = [
      "event.lifecycle.read",
      "event.lifecycle.manage",
    ] satisfies PermissionKey[];
    for (const permissionKey of eventLifecyclePermissions) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: person._id,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "production_seed",
        sourceId: bootstrapSource,
        grantedByPersonId: person._id,
        reason: "Initial event lifecycle authority",
      });
    }
    await insertPermissionGrant(ctx, {
      eventId,
      personId: person._id,
      eventAccessSubjectId: subjectId,
      permissionKey: "handbook.read",
      scopeType: "event",
      sourceType: "production_seed",
      sourceId: bootstrapSource,
      grantedByPersonId: person._id,
      reason: "Initial handbook access",
    });
    await insertPermissionGrant(ctx, {
      eventId,
      personId: person._id,
      eventAccessSubjectId: subjectId,
      permissionKey: "access.permissions.read",
      scopeType: "event",
      sourceType: "production_seed",
      sourceId: bootstrapSource,
      grantedByPersonId: person._id,
      reason: "Initial event access visibility",
    });
    await insertPermissionGrant(ctx, {
      eventId,
      personId: person._id,
      eventAccessSubjectId: subjectId,
      permissionKey: "access.permissions.grant_any",
      scopeType: "event",
      sourceType: "production_seed",
      sourceId: bootstrapSource,
      grantedByPersonId: person._id,
      reason: "Initial event authority",
    });
    await insertPermissionGrant(ctx, {
      eventId,
      personId: person._id,
      eventAccessSubjectId: subjectId,
      permissionKey: "access.permissions.revoke_any",
      scopeType: "event",
      sourceType: "production_seed",
      sourceId: bootstrapSource,
      grantedByPersonId: person._id,
      reason: "Initial event authority",
    });
    await insertPermissionGrant(ctx, {
      eventId,
      personId: person._id,
      eventAccessSubjectId: subjectId,
      permissionKey: "access.subjects.invite",
      scopeType: "event",
      sourceType: "production_seed",
      sourceId: bootstrapSource,
      grantedByPersonId: person._id,
      reason: "Initial event account-linking authority",
    });
    await insertPermissionGrant(ctx, {
      eventId,
      personId: person._id,
      eventAccessSubjectId: subjectId,
      permissionKey: "access.roles.assign",
      scopeType: "event",
      sourceType: "production_seed",
      sourceId: bootstrapSource,
      grantedByPersonId: person._id,
      reason: "Initial organisational-label authority",
    });
    const permissionBundlePermissions = [
      "access.permission_bundles.read",
      "access.permission_bundles.publish",
      "access.permission_bundles.apply",
      "access.permission_bundles.migrate",
    ] satisfies PermissionKey[];
    for (const permissionKey of permissionBundlePermissions) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: person._id,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "production_seed",
        sourceId: bootstrapSource,
        grantedByPersonId: person._id,
        reason: "Initial permission-bundle authority",
      });
    }
    const rosterPermissions = [
      "access.roster.read",
      "access.roster.import",
      "access.roster.revoke",
    ] satisfies PermissionKey[];
    for (const permissionKey of rosterPermissions) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: person._id,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "production_seed",
        sourceId: bootstrapSource,
        grantedByPersonId: person._id,
        reason: "Initial roster authority",
      });
    }
    const subjectLifecyclePermissions = [
      "access.subjects.suspend",
      "access.subjects.reactivate",
    ] satisfies PermissionKey[];
    for (const permissionKey of subjectLifecyclePermissions) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: person._id,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "production_seed",
        sourceId: bootstrapSource,
        grantedByPersonId: person._id,
        reason: "Initial event-account lifecycle authority",
      });
    }
    await insertPermissionGrant(ctx, {
      eventId,
      personId: person._id,
      eventAccessSubjectId: subjectId,
      permissionKey: "configuration.manage",
      scopeType: "event",
      sourceType: "production_seed",
      sourceId: bootstrapSource,
      grantedByPersonId: person._id,
      reason: "Initial event configuration authority",
    });
    const phaseConfigurationPermissions = [
      "configuration.phase.read",
      "configuration.phase.draft.create",
      "configuration.phase.validate",
      "configuration.phase.publish",
    ] satisfies PermissionKey[];
    for (const permissionKey of phaseConfigurationPermissions) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: person._id,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "production_seed",
        sourceId: bootstrapSource,
        grantedByPersonId: person._id,
        reason: "Initial event-phase configuration authority",
      });
    }
    const checkpointConfigurationPermissions = [
      "configuration.checkpoint.read",
      "configuration.checkpoint.draft.create",
      "configuration.checkpoint.validate",
      "configuration.checkpoint.publish",
    ] satisfies PermissionKey[];
    for (const permissionKey of checkpointConfigurationPermissions) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: person._id,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "production_seed",
        sourceId: bootstrapSource,
        grantedByPersonId: person._id,
        reason: "Initial project-checkpoint configuration authority",
      });
    }
    const participantConfigurationPermissions = [
      "configuration.participant.read",
      "configuration.participant.draft.create",
      "configuration.participant.validate",
      "configuration.participant.publish",
    ] satisfies PermissionKey[];
    for (const permissionKey of participantConfigurationPermissions) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: person._id,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "production_seed",
        sourceId: bootstrapSource,
        grantedByPersonId: person._id,
        reason: "Initial participant-policy configuration authority",
      });
    }
    const admissionConfigurationPermissions = [
      "configuration.admission.read",
      "configuration.admission.draft.create",
      "configuration.admission.validate",
      "configuration.admission.publish",
    ] satisfies PermissionKey[];
    for (const permissionKey of admissionConfigurationPermissions) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: person._id,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "production_seed",
        sourceId: bootstrapSource,
        grantedByPersonId: person._id,
        reason: "Initial admission-policy configuration authority",
      });
    }
    const adaptiveIntakeConfigurationPermissions = [
      "configuration.intake.read",
      "configuration.intake.draft.create",
      "configuration.intake.validate",
      "configuration.intake.publish",
    ] satisfies PermissionKey[];
    for (const permissionKey of adaptiveIntakeConfigurationPermissions) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: person._id,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "production_seed",
        sourceId: bootstrapSource,
        grantedByPersonId: person._id,
        reason: "Initial adaptive-intake configuration authority",
      });
    }
    const noveltyConfigurationPermissions = [
      "configuration.novelty.read",
      "configuration.novelty.draft.create",
      "configuration.novelty.entries.write",
      "configuration.novelty.publish",
    ] satisfies PermissionKey[];
    for (const permissionKey of noveltyConfigurationPermissions) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: person._id,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "production_seed",
        sourceId: bootstrapSource,
        grantedByPersonId: person._id,
        reason: "Initial novelty-corpus configuration authority",
      });
    }
    const communicationsConfigurationPermissions = [
      "configuration.communications.read",
      "configuration.communications.draft.create",
      "configuration.communications.validate",
      "configuration.communications.publish",
    ] satisfies PermissionKey[];
    for (const permissionKey of communicationsConfigurationPermissions) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: person._id,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "production_seed",
        sourceId: bootstrapSource,
        grantedByPersonId: person._id,
        reason: "Initial accepted-team communications authority",
      });
    }
    const integrationConfigurationPermissions = [
      "configuration.integration.read",
      "configuration.integration.draft.create",
      "configuration.integration.validate",
      "configuration.integration.publish",
    ] satisfies PermissionKey[];
    for (const permissionKey of integrationConfigurationPermissions) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: person._id,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "production_seed",
        sourceId: bootstrapSource,
        grantedByPersonId: person._id,
        reason: "Initial integration-policy configuration authority",
      });
    }
    await insertPermissionGrant(ctx, {
      eventId,
      personId: person._id,
      eventAccessSubjectId: subjectId,
      permissionKey: "project.checkpoint.read",
      scopeType: "event",
      sourceType: "production_seed",
      sourceId: bootstrapSource,
      grantedByPersonId: person._id,
      reason: "Initial project-checkpoint visibility",
    });
    await insertPermissionGrant(ctx, {
      eventId,
      personId: person._id,
      eventAccessSubjectId: subjectId,
      permissionKey: "integration.read",
      scopeType: "event",
      sourceType: "production_seed",
      sourceId: bootstrapSource,
      grantedByPersonId: person._id,
      reason: "Initial event integration visibility",
    });
    await insertPermissionGrant(ctx, {
      eventId,
      personId: person._id,
      eventAccessSubjectId: subjectId,
      permissionKey: "integration.artifact.read",
      scopeType: "event",
      sourceType: "production_seed",
      sourceId: bootstrapSource,
      grantedByPersonId: person._id,
      reason: "Initial protected integration evidence access",
    });
    const synesthesiaPermissions = [
      "synesthesia.catalog.read",
      "synesthesia.catalog.manage",
      "synesthesia.window.read",
      "synesthesia.window.manage",
      "synesthesia.window.publish",
      "synesthesia.queue.read",
      "synesthesia.request.moderate",
      "synesthesia.queue.schedule",
      "synesthesia.playback.acknowledge",
      "synesthesia.playback.pause",
      "synesthesia.report.read",
      "synesthesia.report.resolve",
      "synesthesia.access.suspend",
      "synesthesia.access.restore",
    ] satisfies PermissionKey[];
    for (const permissionKey of synesthesiaPermissions) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: person._id,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "production_seed",
        sourceId: bootstrapSource,
        grantedByPersonId: person._id,
        reason: "Initial Synesthesia authority",
      });
    }
    const attendancePermissions = [
      "attendance.plan.publish",
      "attendance.session.manage",
      "attendance.station.manage",
      "attendance.venue_check_in.read",
      "attendance.venue_check_in.record",
      "attendance.venue_check_in.override_identity",
      "attendance.venue_check_in.reverse",
      "attendance.credential.enrol",
      "attendance.history.read",
      "attendance.presence.reconcile",
      "attendance.remedy.read",
      "attendance.remedy.open",
      "attendance.remedy.decide",
      "attendance.roll_call.read",
      "attendance.roll_call.start",
      "attendance.roll_call.close",
      "attendance.export.identifiable",
      "attendance.manual_sheet.read",
      "attendance.manual_sheet.enter",
      "attendance.manual_sheet.verify",
      "attendance.manual_sheet.source.read",
    ] satisfies PermissionKey[];
    for (const permissionKey of attendancePermissions) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: person._id,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "production_seed",
        sourceId: bootstrapSource,
        grantedByPersonId: person._id,
        reason: "Initial event attendance authority",
      });
    }
    const incidentPermissions = [
      "incident.read",
      "incident.create",
      "incident.manual_mode.approve",
      "incident.resolve",
    ] satisfies PermissionKey[];
    for (const permissionKey of incidentPermissions) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: person._id,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "production_seed",
        sourceId: bootstrapSource,
        grantedByPersonId: person._id,
        reason: "Initial event incident authority",
      });
    }
    const operationsHealthPermissions = [
      "configuration.intelligence.read",
      "configuration.intelligence.draft.create",
      "configuration.intelligence.validate",
      "configuration.intelligence.publish",
      "operations.health.read",
      "operations.attention.manage",
      "operations.intelligence.read",
      "operations.intelligence.generate",
    ] satisfies PermissionKey[];
    for (const permissionKey of operationsHealthPermissions) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: person._id,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "production_seed",
        sourceId: bootstrapSource,
        grantedByPersonId: person._id,
        reason: "Initial event operations health authority",
      });
    }
    const supportPermissions = [
      "support.case.create",
      "support.case.read",
      "support.case.manage",
    ] satisfies PermissionKey[];
    for (const permissionKey of supportPermissions) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: person._id,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "production_seed",
        sourceId: bootstrapSource,
        grantedByPersonId: person._id,
        reason: "Initial event support authority",
      });
    }
    const rehearsalPermissions = [
      "rehearsal.read",
      "rehearsal.manage",
      "rehearsal.execute",
      "rehearsal.complete",
    ] satisfies PermissionKey[];
    for (const permissionKey of rehearsalPermissions) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: person._id,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "production_seed",
        sourceId: bootstrapSource,
        grantedByPersonId: person._id,
        reason: "Initial event rehearsal authority",
      });
    }
    const communicationsPermissions = [
      "communications.delivery.read",
      "communications.delivery.manage",
    ] satisfies PermissionKey[];
    for (const permissionKey of communicationsPermissions) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: person._id,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "production_seed",
        sourceId: bootstrapSource,
        grantedByPersonId: person._id,
        reason: "Initial participant communications authority",
      });
    }
    const reviewPermissions = [
      "review.configuration.read",
      "review.configuration.publish",
      "reviewer.profile.read",
      "reviewer.profile.manage",
      "round.read",
      "round.manage",
      "review.round.pause",
      "review.round.resume",
      "round.close",
      "round.export.read",
      "round.export.verify",
      "round.export.retry",
      "round.reopen",
      "panel.read",
      "queue.manage",
      "review.queue.hold",
      "review.queue.resume",
      "review.queue.miss",
      "review.queue.move",
      "review.panel.pause",
      "review.reviewer.no_show",
      "review.substitute.page",
      "review.substitute.assign",
      "review.participant_availability.waive",
      "review.presence.waive",
      "review.read",
      "review.prepare",
      "review.start",
      "review.timer.extend",
      "review.complete",
      "review.manual_record.read",
      "review.manual_record.enter",
      "review.manual_record.verify",
      "review.manual_record.source.read",
      "score.completeness.read",
      "score.values.read",
      "scorecard.correction.open",
      "scorecard.void",
      "score.release",
    ] satisfies PermissionKey[];
    for (const permissionKey of reviewPermissions) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: person._id,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "production_seed",
        sourceId: bootstrapSource,
        grantedByPersonId: person._id,
        reason: "Initial event review authority",
      });
    }
    const admissionsPermissions = [
      "application.read",
      "application.review.read",
      "application.review",
      "application.assign",
      "application.profile_context.read",
      "application.ai_recommendation.read",
      "application.ai_recommendation.run",
      "application.decide",
      "application.offer.manage",
    ] satisfies PermissionKey[];
    for (const permissionKey of admissionsPermissions) {
      await insertPermissionGrant(ctx, {
        eventId,
        personId: person._id,
        eventAccessSubjectId: subjectId,
        permissionKey,
        scopeType: "event",
        sourceType: "production_seed",
        sourceId: bootstrapSource,
        grantedByPersonId: person._id,
        reason: "Initial admissions authority",
      });
    }

    await ctx.scheduler.runAt(
      args.applicationsCloseAt,
      internal.eventLifecycle.closeRegistrationAtDeadline,
      {
        eventId,
        expectedApplicationsCloseAt: args.applicationsCloseAt,
      },
    );
    await ctx.scheduler.runAfter(0, internal.operationsHealth.refresh, {});
    return { eventId };
  },
});
