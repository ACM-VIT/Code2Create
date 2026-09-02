import { areaForPermission, permissionName } from "@code2create/domain";
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { z } from "zod";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireAccessVersion } from "./lib/accessVersion";
import { requireEventBySlug } from "./lib/events";
import {
  findCurrentPerson,
  requireCurrentPerson,
  requireEventSubject,
  stagingParticipantAccessAllowed,
} from "./lib/identity";
import {
  scorecardScopeMustMatchTarget,
  selfScopeKind,
  validateGrantScope,
} from "./lib/grantScopes";
import {
  assertDelegatedPermissionKey,
  delegationCanTargetAnyPerson,
  isScopedPermissionAuthority,
  requireGrantAuthorities,
  requireGrantAuthority,
  requireRevokeAuthority,
  scopedAuthorityMatches,
  type PermissionAdministrationAction,
  type PermissionDelegationAuthority,
} from "./lib/permissionDelegation";
import {
  isPermissionKey,
  permissionCatalog,
  type PermissionKey,
} from "./lib/permissionCatalog";
import {
  hasActivePermissionGrantAtScopeTypes,
  hasAnyActivePermissionGrant,
  hasAnyScheduledPermissionGrant,
  insertPermissionGrant,
  insertPermissionGrantGroup,
  assertPermissionKey,
  matchingPermissionGrantIds,
  requirePermission,
  type PermissionGrantPlan,
} from "./lib/permissions";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationResult,
  storedOperationVersion,
} from "./lib/operations";
import {
  grantSupremeRolePermissions,
  missingSupremeRolePermissionPlans,
  supremeRolePermissionPlans,
} from "./lib/rolePermissions";
import { normalizeEmail, normalizedText } from "./lib/strings";
import {
  eventRole,
  permissionGrantSourceType,
  permissionGrantStatus,
  scopeType,
} from "./values";

const revokedStatus = "revoked" as const;
const maximumAccessGrantPageSize = 50;
const maximumDirectGrantBatchSize = 20;
const directGrantBatchResult = z.object({
  grantIds: z.array(z.string()).min(1).max(maximumDirectGrantBatchSize),
  createdCount: z.number().int().min(0).max(maximumDirectGrantBatchSize),
  accessVersion: z.number().int().min(1),
});
const directRevokeBatchResult = z.object({
  grantIds: z.array(z.string()).min(1).max(maximumDirectGrantBatchSize),
  revokedCount: z.number().int().min(1).max(maximumDirectGrantBatchSize),
  accessVersion: z.number().int().min(1),
});
const accessSubjectStatus = v.union(
  v.literal("active"),
  v.literal("suspended"),
  v.literal("closed"),
);
const permissionDelegationInput = v.object({
  permissionKey: v.string(),
  scopeType,
  scopeId: v.optional(v.string()),
  target: v.union(
    v.object({ kind: v.literal("any_event_person") }),
    v.object({ kind: v.literal("exact_email"), email: v.string() }),
  ),
});
type PermissionScopeType = Doc<"permissionGrants">["scopeType"];
type PermissionDelegation = NonNullable<
  Doc<"permissionGrants">["delegation"]
>;

function unhandledScope(scope: never): never {
  throw new ConvexError({
    code: "SCOPE_NOT_AVAILABLE",
    message: `No resource resolver exists for ${scope}.`,
  });
}

const participantCapabilitiesView = v.object({
  profileRead: v.boolean(),
  profileWrite: v.boolean(),
  teamJoin: v.boolean(),
  hasTeamMembership: v.boolean(),
  teamRead: v.boolean(),
  integrations: v.boolean(),
  notifications: v.boolean(),
  attendance: v.boolean(),
  floor: v.boolean(),
  projectCheckpoints: v.boolean(),
  reviewQueue: v.boolean(),
  scoreFeedback: v.boolean(),
  supportRead: v.boolean(),
  supportCreate: v.boolean(),
});

const reviewerCapabilitiesView = v.object({
  reviews: v.boolean(),
  attendance: v.boolean(),
  floor: v.boolean(),
  support: v.boolean(),
  operations: v.boolean(),
  incidents: v.boolean(),
  supportCreate: v.boolean(),
  attentionManage: v.boolean(),
});

const operationsCapabilitiesView = v.object({
  isSupreme: v.boolean(),
  admissions: v.boolean(),
  applicationRead: v.boolean(),
  applicationReviewRead: v.boolean(),
  applicationAssign: v.boolean(),
  attendance: v.boolean(),
  attendanceSetup: v.boolean(),
  teamRoster: v.boolean(),
  roster: v.boolean(),
  projectCheckpoints: v.boolean(),
  reviews: v.boolean(),
  scores: v.boolean(),
  synesthesia: v.boolean(),
  rehearsal: v.boolean(),
  floorConfiguration: v.boolean(),
  floorLocations: v.boolean(),
  intelligence: v.boolean(),
  intelligenceRead: v.boolean(),
  intelligenceGenerate: v.boolean(),
  emergencyRecovery: v.boolean(),
  emergencyPackRead: v.boolean(),
  emergencyPackPrepare: v.boolean(),
  emergencyPackPrint: v.boolean(),
  health: v.boolean(),
  attentionManage: v.boolean(),
  incidents: v.boolean(),
  support: v.boolean(),
  eventLifecycle: v.boolean(),
  phaseConfiguration: v.boolean(),
  intakeConfiguration: v.boolean(),
  noveltyConfiguration: v.boolean(),
  participantConfiguration: v.boolean(),
  admissionConfiguration: v.boolean(),
  communicationsConfiguration: v.boolean(),
  intelligenceConfiguration: v.boolean(),
  checkpointConfiguration: v.boolean(),
  accessPeople: v.boolean(),
  accessDirectory: v.boolean(),
  invitations: v.boolean(),
  bundles: v.boolean(),
  integrations: v.boolean(),
  integrationConfiguration: v.boolean(),
  reviewConfigurationRead: v.boolean(),
  reviewConfigurationPublish: v.boolean(),
  reviewerProfilesRead: v.boolean(),
});

const attendanceWorkspacePermissions = [
  "configuration.manage",
  "attendance.plan.publish",
  "attendance.venue_check_in.read",
  "attendance.station.read",
  "attendance.station.manage",
  "attendance.history.read",
  "attendance.session.manage",
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
] satisfies readonly PermissionKey[];

const floorConfigurationPermissions = [
  "floor.plan.create",
  "floor.plan.read",
  "floor.plan.publish",
  "floor.plan.freeze",
] satisfies readonly PermissionKey[];

function capabilityReader(
  ctx: QueryCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
  },
) {
  const anyCache = new Map<PermissionKey, Promise<boolean>>();
  const scopedCache = new Map<string, Promise<boolean>>();
  const any = (permissionKey: PermissionKey) => {
    const prior = anyCache.get(permissionKey);
    if (prior) return prior;
    const value = hasAnyActivePermissionGrant(ctx, { ...args, permissionKey });
    anyCache.set(permissionKey, value);
    return value;
  };
  const at = (
    permissionKey: PermissionKey,
    scopeTypes: readonly PermissionScopeType[],
  ) => {
    const cacheKey = `${permissionKey}:${scopeTypes.join(",")}`;
    const prior = scopedCache.get(cacheKey);
    if (prior) return prior;
    const value = hasActivePermissionGrantAtScopeTypes(ctx, {
      ...args,
      permissionKey,
      scopeTypes,
    });
    scopedCache.set(cacheKey, value);
    return value;
  };
  const anyOf = async (permissionKeys: readonly PermissionKey[]) =>
    (await Promise.all(permissionKeys.map(any))).some(Boolean);
  const event = (permissionKey: PermissionKey) => at(permissionKey, ["event"]);
  const selfOrEvent = (permissionKey: PermissionKey) =>
    at(permissionKey, ["self", "event"]);

  return { any, anyOf, at, event, selfOrEvent };
}

async function resolveParticipantCapabilities(
  ctx: QueryCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    personId: Id<"people">;
  },
) {
  const { selfOrEvent } = capabilityReader(ctx, args);
  const membership = await ctx.db
    .query("eventMemberships")
    .withIndex("by_event_person", (index) =>
      index.eq("eventId", args.eventId).eq("personId", args.personId),
    )
    .unique();
  const teamMember = membership
    ? await ctx.db
        .query("teamMembers")
        .withIndex("by_event_membership_status", (index) =>
          index
            .eq("eventId", args.eventId)
            .eq("membershipId", membership._id)
            .eq("status", "active"),
        )
        .unique()
    : null;
  const teamId = teamMember?.teamId;
  const [
    supportRead,
    supportCreate,
    profileReadGrantIds,
    profileWriteGrantIds,
    teamJoinGrantIds,
    teamReadGrantIds,
    integrationGrantIds,
    notificationGrantIds,
    attendanceGrantIds,
    floorGrantIds,
    projectCheckpointGrantIds,
    reviewQueueGrantIds,
    scoreFeedbackGrantIds,
  ] = await Promise.all([
    selfOrEvent("support.case.read"),
    selfOrEvent("support.case.create"),
    membership
      ? matchingPermissionGrantIds(ctx, {
          eventId: args.eventId,
          eventAccessSubjectId: args.eventAccessSubjectId,
          permissionKey: "participant.profile.read",
          scopeType: "self",
          scopeId: membership._id,
        })
      : Promise.resolve([]),
    membership
      ? matchingPermissionGrantIds(ctx, {
          eventId: args.eventId,
          eventAccessSubjectId: args.eventAccessSubjectId,
          permissionKey: "participant.profile.write",
          scopeType: "self",
          scopeId: membership._id,
        })
      : Promise.resolve([]),
    membership
      ? matchingPermissionGrantIds(ctx, {
          eventId: args.eventId,
          eventAccessSubjectId: args.eventAccessSubjectId,
          permissionKey: "team.join",
          scopeType: "self",
          scopeId: membership._id,
        })
      : Promise.resolve([]),
    teamId
      ? matchingPermissionGrantIds(ctx, {
          eventId: args.eventId,
          eventAccessSubjectId: args.eventAccessSubjectId,
          permissionKey: "team.read",
          scopeType: "team",
          scopeId: teamId,
        })
      : Promise.resolve([]),
    teamId
      ? matchingPermissionGrantIds(ctx, {
          eventId: args.eventId,
          eventAccessSubjectId: args.eventAccessSubjectId,
          permissionKey: "integration.read",
          scopeType: "team",
          scopeId: teamId,
        })
      : Promise.resolve([]),
    membership
      ? matchingPermissionGrantIds(ctx, {
          eventId: args.eventId,
          eventAccessSubjectId: args.eventAccessSubjectId,
          permissionKey: "communications.delivery.self.read",
          scopeType: "self",
          scopeId: membership._id,
        })
      : Promise.resolve([]),
    membership
      ? matchingPermissionGrantIds(ctx, {
          eventId: args.eventId,
          eventAccessSubjectId: args.eventAccessSubjectId,
          permissionKey: "attendance.self.read",
          scopeType: "self",
          scopeId: membership._id,
        })
      : Promise.resolve([]),
    teamId
      ? matchingPermissionGrantIds(ctx, {
          eventId: args.eventId,
          eventAccessSubjectId: args.eventAccessSubjectId,
          permissionKey: "floor.team.read",
          scopeType: "team",
          scopeId: teamId,
        })
      : Promise.resolve([]),
    teamId
      ? matchingPermissionGrantIds(ctx, {
          eventId: args.eventId,
          eventAccessSubjectId: args.eventAccessSubjectId,
          permissionKey: "project.checkpoint.read",
          scopeType: "team",
          scopeId: teamId,
        })
      : Promise.resolve([]),
    teamId
      ? matchingPermissionGrantIds(ctx, {
          eventId: args.eventId,
          eventAccessSubjectId: args.eventAccessSubjectId,
          permissionKey: "queue.participant.read",
          scopeType: "team",
          scopeId: teamId,
        })
      : Promise.resolve([]),
    teamId
      ? matchingPermissionGrantIds(ctx, {
          eventId: args.eventId,
          eventAccessSubjectId: args.eventAccessSubjectId,
          permissionKey: "score.feedback.read",
          scopeType: "team",
          scopeId: teamId,
        })
      : Promise.resolve([]),
  ]);
  return {
    profileRead: profileReadGrantIds.length > 0,
    profileWrite: profileWriteGrantIds.length > 0,
    teamJoin: teamJoinGrantIds.length > 0,
    hasTeamMembership: teamId !== undefined,
    teamRead: teamReadGrantIds.length > 0,
    integrations: integrationGrantIds.length > 0,
    notifications: notificationGrantIds.length > 0,
    attendance: attendanceGrantIds.length > 0,
    floor: floorGrantIds.length > 0,
    projectCheckpoints: projectCheckpointGrantIds.length > 0,
    reviewQueue: reviewQueueGrantIds.length > 0,
    scoreFeedback: scoreFeedbackGrantIds.length > 0,
    supportRead,
    supportCreate,
  };
}

async function resolveReviewerCapabilities(
  ctx: QueryCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
  },
) {
  const { any, anyOf, selfOrEvent } = capabilityReader(ctx, args);
  const [
    reviews,
    attendance,
    floor,
    support,
    operations,
    incidents,
    supportCreate,
    attentionManage,
  ] = await Promise.all([
    anyOf([
      "reviewer.device.register",
      "communications.call_consent.manage",
      "reviewer.clock_in",
      "panel.read",
      "review.read",
    ]),
    anyOf(["attendance.station.manage", "attendance.station.read", "attendance.scan.execute"]),
    anyOf(["floor.location.map", "floor.location.override"]),
    selfOrEvent("support.case.read"),
    any("operations.health.read"),
    any("incident.read"),
    selfOrEvent("support.case.create"),
    any("operations.attention.manage"),
  ]);
  return {
    reviews,
    attendance,
    floor,
    support,
    operations,
    incidents,
    supportCreate,
    attentionManage,
  };
}

async function resolveOperationsCapabilities(
  ctx: QueryCtx,
  args: {
    eventId: Id<"events">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
  },
) {
  const { any, anyOf, at, event } = capabilityReader(ctx, args);

  const [
    applicationRead,
    applicationReviewRead,
    applicationAssign,
    attendance,
    attendanceSetup,
    roster,
    teamRoster,
    projectCheckpoints,
    reviews,
    scores,
    synesthesiaCatalogRead,
    synesthesiaWindowRead,
    synesthesiaWindowManage,
    synesthesiaQueueRead,
    rehearsal,
    floorConfiguration,
    floorLocations,
    intelligenceRead,
    intelligenceGenerate,
    emergencyPackRead,
    emergencyPackPrepare,
    emergencyPackPrint,
    health,
    attentionManage,
    incidents,
    supportCreateEvent,
    supportReadStaff,
    eventLifecycle,
    phaseConfiguration,
    intakeConfiguration,
    noveltyConfiguration,
    participantConfiguration,
    admissionConfiguration,
    communicationsConfiguration,
    intelligenceConfiguration,
    checkpointConfiguration,
    accessPeople,
    accessDirectory,
    invitations,
    bundles,
    integrations,
    integrationConfiguration,
    reviewConfigurationRead,
    reviewConfigurationPublish,
    reviewerProfilesRead,
  ] = await Promise.all([
    any("application.read"),
    any("application.review.read"),
    any("application.assign"),
    anyOf(attendanceWorkspacePermissions),
    anyOf(["configuration.manage", "attendance.plan.publish"]),
    any("access.roster.read"),
    any("team.roster.read"),
    any("project.checkpoint.read"),
    any("round.read"),
    any("score.completeness.read"),
    event("synesthesia.catalog.read"),
    any("synesthesia.window.read"),
    event("synesthesia.window.manage"),
    any("synesthesia.queue.read"),
    any("rehearsal.read"),
    anyOf(floorConfigurationPermissions),
    any("floor.location.read"),
    event("operations.intelligence.read"),
    event("operations.intelligence.generate"),
    event("emergency_pack.read"),
    event("emergency_pack.prepare"),
    event("emergency_pack.print"),
    event("operations.health.read"),
    event("operations.attention.manage"),
    any("incident.read"),
    event("support.case.create"),
    at("support.case.read", ["event", "support_case"]),
    event("event.lifecycle.read"),
    event("configuration.phase.read"),
    event("configuration.intake.read"),
    event("configuration.novelty.read"),
    event("configuration.participant.read"),
    event("configuration.admission.read"),
    event("configuration.communications.read"),
    event("configuration.intelligence.read"),
    event("configuration.checkpoint.read"),
    any("access.permissions.read"),
    event("access.permissions.read"),
    event("access.subjects.invite"),
    any("access.permission_bundles.read"),
    any("integration.read"),
    event("configuration.integration.read"),
    event("review.configuration.read"),
    event("review.configuration.publish"),
    event("reviewer.profile.read"),
  ]);

  return {
    admissions: applicationRead || applicationReviewRead,
    applicationRead,
    applicationReviewRead,
    applicationAssign,
    attendance,
    attendanceSetup,
    roster,
    teamRoster,
    projectCheckpoints,
    reviews,
    scores,
    synesthesia:
      synesthesiaCatalogRead ||
      synesthesiaWindowRead ||
      synesthesiaWindowManage ||
      synesthesiaQueueRead,
    rehearsal,
    floorConfiguration,
    floorLocations,
    intelligence: intelligenceRead || intelligenceGenerate,
    intelligenceRead,
    intelligenceGenerate,
    emergencyRecovery: emergencyPackRead || emergencyPackPrepare,
    emergencyPackRead,
    emergencyPackPrepare,
    emergencyPackPrint,
    health,
    attentionManage,
    incidents,
    support: supportCreateEvent || supportReadStaff,
    eventLifecycle,
    phaseConfiguration,
    intakeConfiguration,
    noveltyConfiguration,
    participantConfiguration,
    admissionConfiguration,
    communicationsConfiguration,
    intelligenceConfiguration,
    checkpointConfiguration,
    accessPeople,
    accessDirectory,
    invitations,
    bundles,
    integrations,
    integrationConfiguration,
    reviewConfigurationRead,
    reviewConfigurationPublish,
    reviewerProfilesRead,
  };
}

async function currentCapabilitySubject(ctx: QueryCtx, eventSlug: string) {
  const event = await requireEventBySlug(ctx, eventSlug);
  const person = await findCurrentPerson(ctx);
  if (!person) return null;
  const subject = await ctx.db
    .query("eventAccessSubjects")
    .withIndex("by_event_person", (index) =>
      index.eq("eventId", event._id).eq("personId", person._id),
    )
    .unique();
  if (!subject || subject.status !== "active") return null;
  return {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    personId: person._id,
    emailNormalized: person.verifiedEmail,
  };
}

export const participantCapabilities = query({
  args: { eventSlug: v.string() },
  returns: v.union(v.null(), participantCapabilitiesView),
  handler: async (ctx, args) => {
    const subject = await currentCapabilitySubject(ctx, args.eventSlug);
    if (
      !subject ||
      !(await stagingParticipantAccessAllowed(
        ctx,
        subject.eventId,
        subject.emailNormalized,
      ))
    ) {
      return null;
    }
    return resolveParticipantCapabilities(ctx, subject);
  },
});

export const reviewerCapabilities = query({
  args: { eventSlug: v.string() },
  returns: v.union(v.null(), reviewerCapabilitiesView),
  handler: async (ctx, args) => {
    const subject = await currentCapabilitySubject(ctx, args.eventSlug);
    return subject ? resolveReviewerCapabilities(ctx, subject) : null;
  },
});

export const operationsCapabilities = query({
  args: { eventSlug: v.string() },
  returns: v.union(v.null(), operationsCapabilitiesView),
  handler: async (ctx, args) => {
    const subject = await currentCapabilitySubject(ctx, args.eventSlug);
    if (!subject) return null;
    const [capabilities, role] = await Promise.all([
      resolveOperationsCapabilities(ctx, subject),
      ctx.db
        .query("eventRoles")
        .withIndex("by_event_person_status", (index) =>
          index
            .eq("eventId", subject.eventId)
            .eq("personId", subject.personId)
            .eq("status", "active"),
        )
        .unique(),
    ]);
    return {
      ...capabilities,
      isSupreme: role?.role === "supreme",
    };
  },
});

export const synchronizeSupremePermissions = mutation({
  args: { eventSlug: v.string() },
  returns: v.object({
    createdCount: v.number(),
    accessVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const role = await ctx.db
      .query("eventRoles")
      .withIndex("by_event_person_status", (index) =>
        index
          .eq("eventId", event._id)
          .eq("personId", person._id)
          .eq("status", "active"),
      )
      .unique();
    if (!role || role.role !== "supreme") {
      throw new ConvexError({
        code: "SUPREME_ROLE_REQUIRED",
        message: "Only a Supreme organizer can synchronize Supreme catalog permissions.",
      });
    }
    const missingPlans = await missingSupremeRolePermissionPlans(ctx, {
      eventId: event._id,
      personId: person._id,
      eventAccessSubjectId: subject._id,
      roleId: role._id,
    });
    if (missingPlans.length === 0) {
      return { createdCount: 0, accessVersion: subject.accessVersion };
    }
    const authority = await requireGrantAuthorities(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      actorPersonId: person._id,
      actions: supremeRolePermissionPlans(subject._id).map((plan) => ({
        permissionKey: plan.permissionKey,
        scopeType: plan.scopeType,
        ...(plan.scopeType === "event" ? {} : { scopeId: plan.scopeId }),
        targetPersonId: person._id,
      })),
    });
    const createdCount = await grantSupremeRolePermissions(ctx, {
      eventId: event._id,
      personId: person._id,
      eventAccessSubjectId: subject._id,
      roleId: role._id,
      grantedByPersonId: person._id,
    });
    let accessVersion = subject.accessVersion;
    if (createdCount > 0) {
      const now = Date.now();
      accessVersion += 1;
      await ctx.db.patch(subject._id, { accessVersion, updatedAt: now });
      await writeAuditEvent(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        permissionKey: "access.roles.assign",
        grantIds: authority.grantIds,
        scopeType: "person",
        scopeId: person._id,
        action: "access.supreme_permissions_synchronized",
        targetType: "event_access_subject",
        targetId: subject._id,
        previousSummary: JSON.stringify({ role: "supreme" }),
        nextSummary: JSON.stringify({
          role: "supreme",
          createdGrantCount: createdCount,
        }),
        reason: "Synchronize Supreme catalog permissions.",
      });
    }
    return { createdCount, accessVersion };
  },
});

const directoryItem = v.object({
  personId: v.id("people"),
  displayName: v.string(),
  email: v.string(),
  status: accessSubjectStatus,
  isParticipant: v.boolean(),
  role: v.optional(eventRole),
  accessVersion: v.number(),
});

async function readDirectoryItem(
  ctx: QueryCtx,
  eventId: Id<"events">,
  subject: Doc<"eventAccessSubjects">,
) {
  const [role, membership] = await Promise.all([
    ctx.db
      .query("eventRoles")
      .withIndex("by_event_person_status", (index) =>
        index
          .eq("eventId", eventId)
          .eq("personId", subject.personId)
          .eq("status", "active"),
      )
      .unique(),
    ctx.db
      .query("eventMemberships")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", eventId).eq("personId", subject.personId),
      )
      .unique(),
  ]);
  return {
    personId: subject.personId,
    displayName: subject.displayName,
    email: subject.emailNormalized,
    status: subject.status,
    isParticipant: membership !== null,
    ...(role ? { role: role.role } : {}),
    accessVersion: subject.accessVersion,
  };
}

export const directory = query({
  args: {
    eventSlug: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(directoryItem),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const actorSubject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: actorSubject._id,
      permissionKey: "access.permissions.read",
      scopeType: "event",
    });
    const page = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_status_email", (index) =>
        index.eq("eventId", event._id).eq("status", "active"),
      )
      .paginate(args.paginationOpts);
    const people = await Promise.all(
      page.page.map((subject) => readDirectoryItem(ctx, event._id, subject)),
    );
    return { ...page, page: people };
  },
});

export const findByEmail = query({
  args: { eventSlug: v.string(), email: v.string() },
  returns: v.union(v.null(), directoryItem),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const actorSubject = await requireEventSubject(ctx, event._id, person._id);
    const subject = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_email", (index) =>
        index.eq("eventId", event._id).eq("emailNormalized", normalizeEmail(args.email)),
      )
      .unique();
    if (!subject) return null;
    const grants = await matchingPermissionGrantIds(ctx, {
      eventId: event._id,
      eventAccessSubjectId: actorSubject._id,
      permissionKey: "access.permissions.read",
      scopeType: "person",
      scopeId: subject.personId,
    });
    return grants.length > 0
      ? readDirectoryItem(ctx, event._id, subject)
      : null;
  },
});

const delegationCeilingView = v.object({
  authorityGrantId: v.id("permissionGrants"),
  permissionKey: v.string(),
  scopeType,
  scopeId: v.optional(v.string()),
  scopeLabel: v.string(),
  targetKind: v.union(
    v.literal("exact_person"),
    v.literal("any_event_person"),
  ),
  targetPersonId: v.optional(v.id("people")),
  targetLabel: v.string(),
  validUntil: v.number(),
});

const grantView = v.object({
  id: v.id("permissionGrants"),
  permissionKey: v.string(),
  scopeType,
  scopeId: v.optional(v.string()),
  scopeLabel: v.string(),
  validFrom: v.number(),
  validUntil: v.optional(v.number()),
  status: permissionGrantStatus,
  sourceType: permissionGrantSourceType,
  reason: v.string(),
  createdAt: v.number(),
  activatedAt: v.optional(v.number()),
  expiredAt: v.optional(v.number()),
  revokedAt: v.optional(v.number()),
  revokeReason: v.optional(v.string()),
  delegation: v.optional(delegationCeilingView),
  canRevoke: v.boolean(),
});

function readableState(value: string) {
  return value.replaceAll("_", " ");
}

async function eventPersonLabel(
  ctx: QueryCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
) {
  const subject = await ctx.db
    .query("eventAccessSubjects")
    .withIndex("by_event_person", (index) =>
      index.eq("eventId", eventId).eq("personId", personId),
    )
    .unique();
  return subject
    ? `${subject.displayName} · ${subject.emailNormalized}`
    : undefined;
}

async function resolveScopeLabel(
  ctx: QueryCtx,
  eventId: Id<"events">,
  targetPersonId: Id<"people">,
  requestedScopeType: PermissionScopeType,
  scopeId: string | undefined,
) {
  if (requestedScopeType === "event") return "Entire event";
  if (!scopeId) return "Missing resource";

  if (requestedScopeType === "self") {
    const membershipId = ctx.db.normalizeId("eventMemberships", scopeId);
    const membership = membershipId ? await ctx.db.get(membershipId) : null;
    if (
      membership &&
      membership.eventId === eventId &&
      membership.personId === targetPersonId
    ) {
      return "Own participant membership";
    }
    const subjectId = ctx.db.normalizeId("eventAccessSubjects", scopeId);
    const subject = subjectId ? await ctx.db.get(subjectId) : null;
    if (
      subject &&
      subject.eventId === eventId &&
      subject.personId === targetPersonId
    ) {
      return "Own event account";
    }
    return "Unavailable self resource";
  }
  if (requestedScopeType === "person") {
    const personId = ctx.db.normalizeId("people", scopeId);
    return personId
      ? (await eventPersonLabel(ctx, eventId, personId)) ?? "Unavailable person"
      : "Unavailable person";
  }
  if (requestedScopeType === "team") {
    const id = ctx.db.normalizeId("teams", scopeId);
    const team = id ? await ctx.db.get(id) : null;
    return team?.eventId === eventId ? team.name : "Unavailable team";
  }
  if (requestedScopeType === "application") {
    const id = ctx.db.normalizeId("applications", scopeId);
    const application = id ? await ctx.db.get(id) : null;
    if (!application || application.eventId !== eventId) return "Unavailable application";
    const team = await ctx.db.get(application.teamId);
    return team
      ? `${team.name} · ${readableState(application.state)}`
      : "Unavailable application";
  }
  if (requestedScopeType === "attendance_plan") {
    const id = ctx.db.normalizeId("attendancePlanVersions", scopeId);
    const plan = id ? await ctx.db.get(id) : null;
    return plan?.eventId === eventId
      ? `${plan.name} · version ${plan.version}`
      : "Unavailable attendance plan";
  }
  if (requestedScopeType === "floor_plan") {
    const id = ctx.db.normalizeId("floorPlanVersions", scopeId);
    const plan = id ? await ctx.db.get("floorPlanVersions", id) : null;
    return plan?.eventId === eventId
      ? `${plan.name} · plan ${plan.planNumber} · ${readableState(plan.mappingState)}`
      : "Unavailable floor plan";
  }
  if (requestedScopeType === "floor_zone") {
    const id = ctx.db.normalizeId("floorZones", scopeId);
    const zone = id ? await ctx.db.get("floorZones", id) : null;
    if (!zone || zone.eventId !== eventId) return "Unavailable floor zone";
    const plan = await ctx.db.get(zone.planVersionId);
    return `${plan?.name ?? "Floor plan"} · ${zone.name}`;
  }
  if (requestedScopeType === "attendance_session") {
    const id = ctx.db.normalizeId("attendanceSessions", scopeId);
    const session = id ? await ctx.db.get(id) : null;
    return session?.eventId === eventId
      ? `${session.name} · ${readableState(session.status)}`
      : "Unavailable attendance session";
  }
  if (requestedScopeType === "station") {
    const id = ctx.db.normalizeId("attendanceStations", scopeId);
    const station = id ? await ctx.db.get(id) : null;
    return station?.eventId === eventId
      ? `${station.name} · ${readableState(station.status)}`
      : "Unavailable station";
  }
  if (requestedScopeType === "incident") {
    const id = ctx.db.normalizeId("incidents", scopeId);
    const incident = id ? await ctx.db.get(id) : null;
    return incident?.eventId === eventId
      ? `${incident.title} · ${readableState(incident.state)}`
      : "Unavailable incident";
  }
  if (requestedScopeType === "synesthesia_window") {
    const id = ctx.db.normalizeId("synesthesiaWindows", scopeId);
    const window = id ? await ctx.db.get("synesthesiaWindows", id) : null;
    return window?.eventId === eventId
      ? `${window.name} · ${readableState(window.status)}`
      : "Unavailable Synesthesia window";
  }
  if (requestedScopeType === "song_request") {
    const id = ctx.db.normalizeId("songRequests", scopeId);
    const request = id ? await ctx.db.get("songRequests", id) : null;
    return request?.eventId === eventId
      ? `${request.title} · ${request.artist} · ${readableState(request.state)}`
      : "Unavailable song request";
  }
  if (requestedScopeType === "round") {
    const id = ctx.db.normalizeId("reviewRounds", scopeId);
    const round = id ? await ctx.db.get(id) : null;
    return round?.eventId === eventId
      ? `${round.name} · ${readableState(round.status)}`
      : "Unavailable round";
  }
  if (requestedScopeType === "panel") {
    const id = ctx.db.normalizeId("reviewPanels", scopeId);
    const panel = id ? await ctx.db.get(id) : null;
    if (!panel || panel.eventId !== eventId) return "Unavailable panel";
    const round = await ctx.db.get(panel.roundId);
    return `${round?.name ?? "Round"} · ${panel.name}`;
  }
  if (requestedScopeType === "review") {
    const id = ctx.db.normalizeId("reviewSessions", scopeId);
    const session = id ? await ctx.db.get(id) : null;
    if (!session || session.eventId !== eventId) return "Unavailable review";
    const [round, team, panel] = await Promise.all([
      ctx.db.get(session.roundId),
      ctx.db.get(session.teamId),
      ctx.db.get(session.panelId),
    ]);
    return `${round?.name ?? "Round"} · ${team?.name ?? "Team"} · ${panel?.name ?? "Panel"}`;
  }
  if (requestedScopeType === "page") {
    const id = ctx.db.normalizeId("reviewerPages", scopeId);
    const page = id ? await ctx.db.get(id) : null;
    if (!page || page.eventId !== eventId) return "Unavailable reviewer page";
    const [round, panel, reviewer] = await Promise.all([
      ctx.db.get(page.roundId),
      ctx.db.get(page.panelId),
      eventPersonLabel(ctx, eventId, page.targetPersonId),
    ]);
    return `${round?.name ?? "Round"} · ${panel?.name ?? "Panel"} · ${reviewer ?? "Reviewer"} · ${readableState(page.state)}`;
  }
  if (requestedScopeType === "scorecard") {
    const id = ctx.db.normalizeId("scorecards", scopeId);
    const scorecard = id ? await ctx.db.get(id) : null;
    if (!scorecard || scorecard.eventId !== eventId) return "Unavailable scorecard";
    const [round, session, reviewer] = await Promise.all([
      ctx.db.get(scorecard.roundId),
      ctx.db.get(scorecard.reviewSessionId),
      eventPersonLabel(ctx, eventId, scorecard.reviewerPersonId),
    ]);
    const team = session ? await ctx.db.get(session.teamId) : null;
    return `${round?.name ?? "Round"} · ${team?.name ?? "Team"} · ${reviewer ?? "Reviewer"} · ${readableState(scorecard.status)}`;
  }
  if (requestedScopeType === "evidence_checkpoint") {
    const id = ctx.db.normalizeId("reviewEvidenceCheckpointSets", scopeId);
    const checkpoint = id ? await ctx.db.get(id) : null;
    if (!checkpoint || checkpoint.eventId !== eventId) {
      return "Unavailable evidence checkpoint";
    }
    const [round, team] = await Promise.all([
      ctx.db.get(checkpoint.roundId),
      ctx.db.get(checkpoint.teamId),
    ]);
    return `${round?.name ?? "Round"} · ${team?.name ?? "Team"} · ${readableState(checkpoint.completeness)}`;
  }
  if (requestedScopeType === "permission_bundle") {
    const id = ctx.db.normalizeId("permissionBundles", scopeId);
    const bundle = id ? await ctx.db.get("permissionBundles", id) : null;
    return bundle?.eventId === eventId
      ? `${bundle.label} · version ${bundle.publishedVersion}`
      : "Unavailable permission bundle";
  }
  if (requestedScopeType === "roster_entry") {
    const id = ctx.db.normalizeId("rosterEntries", scopeId);
    const entry = id ? await ctx.db.get("rosterEntries", id) : null;
    return entry?.eventId === eventId
      ? `${entry.displayName} · ${entry.emailNormalized} · ${readableState(entry.status)}`
      : "Unavailable roster entry";
  }
  if (requestedScopeType === "support_case") {
    const id = ctx.db.normalizeId("supportCases", scopeId);
    const supportCase = id ? await ctx.db.get("supportCases", id) : null;
    return supportCase?.eventId === eventId
      ? `${supportCase.publicCode} · ${readableState(supportCase.category)} · ${readableState(supportCase.state)}`
      : "Unavailable support case";
  }
  if (requestedScopeType === "rehearsal_run") {
    const id = ctx.db.normalizeId("rehearsalRuns", scopeId);
    const rehearsalRun = id ? await ctx.db.get("rehearsalRuns", id) : null;
    return rehearsalRun?.eventId === eventId
      ? `${rehearsalRun.name} · ${readableState(rehearsalRun.state)}`
      : "Unavailable rehearsal run";
  }
  return unhandledScope(requestedScopeType);
}

async function activeAuthorityGrants(
  ctx: QueryCtx,
  eventId: Id<"events">,
  eventAccessSubjectId: Id<"eventAccessSubjects">,
  permissionKey:
    | "access.permissions.grant_scoped"
    | "access.permissions.revoke_scoped",
) {
  const ids = await matchingPermissionGrantIds(ctx, {
    eventId,
    eventAccessSubjectId,
    permissionKey,
    scopeType: "event",
  });
  const grants = await Promise.all(ids.map((id) => ctx.db.get(id)));
  return grants.filter((grant) => grant !== null);
}

function permissionDelegationAuthority(
  grant: Doc<"permissionGrants">,
): PermissionDelegationAuthority {
  return {
    id: grant._id,
    permissionKey: grant.permissionKey,
    status: grant.status,
    validFrom: grant.validFrom,
    ...(grant.validUntil !== undefined ? { validUntil: grant.validUntil } : {}),
    ...(grant.delegation !== undefined
      ? { delegation: grant.delegation }
      : {}),
  };
}

async function delegationCeiling(
  ctx: QueryCtx,
  eventId: Id<"events">,
  authorityOwnerPersonId: Id<"people">,
  grant: Doc<"permissionGrants">,
) {
  if (!grant.delegation || grant.validUntil === undefined) return null;
  const targetPersonId =
    grant.delegation.target.kind === "exact_person"
      ? grant.delegation.target.personId
      : undefined;
  const targetLabel = targetPersonId
    ? (await eventPersonLabel(ctx, eventId, targetPersonId)) ??
      "Unavailable event account"
    : "Any active event person";
  const scopeLabel = await resolveScopeLabel(
    ctx,
    eventId,
    targetPersonId ?? authorityOwnerPersonId,
    grant.delegation.scopeType,
    grant.delegation.scopeId,
  );
  return {
    authorityGrantId: grant._id,
    permissionKey: grant.delegation.permissionKey,
    scopeType: grant.delegation.scopeType,
    ...(grant.delegation.scopeId !== undefined
      ? { scopeId: grant.delegation.scopeId }
      : {}),
    scopeLabel,
    targetKind: grant.delegation.target.kind,
    ...(targetPersonId !== undefined ? { targetPersonId } : {}),
    targetLabel,
    validUntil: grant.validUntil,
  };
}

async function permissionGrantView(
  ctx: QueryCtx,
  args: {
    eventId: Id<"events">;
    targetPersonId: Id<"people">;
    grant: Doc<"permissionGrants">;
    now: number;
    canRevokeAny: boolean;
    revokeAuthorities: readonly Doc<"permissionGrants">[];
  },
) {
  const permissionKey = isPermissionKey(args.grant.permissionKey)
    ? args.grant.permissionKey
    : null;
  const action: PermissionAdministrationAction | null = permissionKey
    ? {
        permissionKey,
        scopeType: args.grant.scopeType,
        ...(args.grant.scopeId !== undefined
          ? { scopeId: args.grant.scopeId }
          : {}),
        targetPersonId: args.targetPersonId,
      }
    : null;
  const canRevoke =
    (args.grant.status === "active" || args.grant.status === "scheduled") &&
    (args.canRevokeAny ||
      (action !== null &&
        args.revokeAuthorities.some((authority) =>
          scopedAuthorityMatches(
            permissionDelegationAuthority(authority),
            "access.permissions.revoke_scoped",
            action,
            args.now,
          ),
        )));
  const delegation = await delegationCeiling(
    ctx,
    args.eventId,
    args.grant.personId,
    args.grant,
  );
  return {
    id: args.grant._id,
    permissionKey: args.grant.permissionKey,
    scopeType: args.grant.scopeType,
    ...(args.grant.scopeId !== undefined ? { scopeId: args.grant.scopeId } : {}),
    scopeLabel: await resolveScopeLabel(
      ctx,
      args.eventId,
      args.targetPersonId,
      args.grant.scopeType,
      args.grant.scopeId,
    ),
    validFrom: args.grant.validFrom,
    ...(args.grant.validUntil !== undefined
      ? { validUntil: args.grant.validUntil }
      : {}),
    status:
      args.grant.status === "active" && args.grant.validFrom > args.now
        ? "scheduled"
        : args.grant.status === "active" &&
            args.grant.validUntil !== undefined &&
            args.grant.validUntil <= args.now
          ? "expired"
          : args.grant.status,
    sourceType: args.grant.sourceType,
    reason: args.grant.reason,
    createdAt: args.grant.createdAt,
    ...(args.grant.activatedAt !== undefined
      ? { activatedAt: args.grant.activatedAt }
      : {}),
    ...(args.grant.expiredAt !== undefined
      ? { expiredAt: args.grant.expiredAt }
      : {}),
    ...(args.grant.revokedAt !== undefined
      ? { revokedAt: args.grant.revokedAt }
      : {}),
    ...(args.grant.revokeReason !== undefined
      ? { revokeReason: args.grant.revokeReason }
      : {}),
    ...(delegation !== null ? { delegation } : {}),
    canRevoke,
  };
}

export const detail = query({
  args: { eventSlug: v.string(), personId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      person: v.object({
        id: v.id("people"),
        displayName: v.string(),
        email: v.string(),
        status: accessSubjectStatus,
        isParticipant: v.boolean(),
        role: v.optional(eventRole),
      }),
      accessVersion: v.number(),
      actions: v.object({
        assignRole: v.boolean(),
        suspend: v.boolean(),
        reactivate: v.boolean(),
        useBundles: v.boolean(),
      }),
      effectivePermissionKeys: v.array(v.string()),
      currentPermissionKeys: v.array(v.string()),
      canGrantAny: v.boolean(),
      canRevokeAny: v.boolean(),
      grantDelegations: v.array(delegationCeilingView),
      revokeDelegations: v.array(delegationCeilingView),
      catalog: v.array(
        v.object({
          key: v.string(),
          label: v.string(),
          area: v.string(),
          eventWide: v.boolean(),
          scopes: v.array(scopeType),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const actorSubject = await requireEventSubject(ctx, event._id, person._id);
    const targetPersonId = ctx.db.normalizeId("people", args.personId);
    if (!targetPersonId) return null;
    const targetSubject = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", targetPersonId),
      )
      .unique();
    if (!targetSubject) return null;
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: actorSubject._id,
      permissionKey: "access.permissions.read",
      scopeType: "person",
      scopeId: targetPersonId,
    });
    const [
      targetPerson,
      role,
      membership,
      grantAnyIds,
      revokeAnyIds,
      grantScopedAuthorities,
      revokeScopedAuthorities,
      assignRoleIds,
      suspendIds,
      reactivateIds,
      bundleReadIds,
      bundleApplyIds,
    ] = await Promise.all([
      ctx.db.get(targetPersonId),
      ctx.db
        .query("eventRoles")
        .withIndex("by_event_person_status", (index) =>
          index
            .eq("eventId", event._id)
            .eq("personId", targetPersonId)
            .eq("status", "active"),
        )
        .unique(),
      ctx.db
        .query("eventMemberships")
        .withIndex("by_event_person", (index) =>
          index.eq("eventId", event._id).eq("personId", targetPersonId),
        )
        .unique(),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: actorSubject._id,
        permissionKey: "access.permissions.grant_any",
        scopeType: "event",
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: actorSubject._id,
        permissionKey: "access.permissions.revoke_any",
        scopeType: "event",
      }),
      activeAuthorityGrants(
        ctx,
        event._id,
        actorSubject._id,
        "access.permissions.grant_scoped",
      ),
      activeAuthorityGrants(
        ctx,
        event._id,
        actorSubject._id,
        "access.permissions.revoke_scoped",
      ),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: actorSubject._id,
        permissionKey: "access.roles.assign",
        scopeType: "person",
        scopeId: targetPersonId,
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: actorSubject._id,
        permissionKey: "access.subjects.suspend",
        scopeType: "person",
        scopeId: targetPersonId,
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: actorSubject._id,
        permissionKey: "access.subjects.reactivate",
        scopeType: "person",
        scopeId: targetPersonId,
      }),
      hasAnyActivePermissionGrant(ctx, {
        eventId: event._id,
        eventAccessSubjectId: actorSubject._id,
        permissionKey: "access.permission_bundles.read",
      }),
      hasAnyActivePermissionGrant(ctx, {
        eventId: event._id,
        eventAccessSubjectId: actorSubject._id,
        permissionKey: "access.permission_bundles.apply",
      }),
    ]);
    if (!targetPerson) return null;
    const delegationTargetsPerson = (grant: Doc<"permissionGrants">) =>
      grant.delegation?.target.kind === "any_event_person" ||
      grant.delegation?.target.personId === targetPersonId;
    const visibleGrantAuthorities =
      person._id === targetPersonId
        ? []
        : grantScopedAuthorities.filter(delegationTargetsPerson);
    const visibleRevokeAuthorities =
      revokeScopedAuthorities.filter(delegationTargetsPerson);
    const [grantDelegations, revokeDelegations] = await Promise.all([
      Promise.all(
        visibleGrantAuthorities.map((grant) =>
          delegationCeiling(ctx, event._id, person._id, grant),
        ),
      ).then((views) => views.filter((view) => view !== null)),
      Promise.all(
        visibleRevokeAuthorities.map((grant) =>
          delegationCeiling(ctx, event._id, person._id, grant),
        ),
      ).then((views) => views.filter((view) => view !== null)),
    ]);
    const catalogKeys = Object.keys(permissionCatalog).filter(isPermissionKey);
    const permissionStates = await Promise.all(
      catalogKeys.map(async (permissionKey) => {
        const permissionArgs = {
          eventId: event._id,
          eventAccessSubjectId: targetSubject._id,
          permissionKey,
        };
        const [effective, scheduled] = await Promise.all([
          hasAnyActivePermissionGrant(ctx, permissionArgs),
          hasAnyScheduledPermissionGrant(ctx, permissionArgs),
        ]);
        return { permissionKey, effective, scheduled };
      }),
    );
    const effectivePermissionKeys = permissionStates
      .filter(({ effective }) => effective)
      .map(({ permissionKey }) => permissionKey);
    const currentPermissionKeys = permissionStates
      .filter(({ effective, scheduled }) => effective || scheduled)
      .map(({ permissionKey }) => permissionKey);
    return {
      person: {
        id: targetPerson._id,
        displayName: targetSubject.displayName,
        email: targetSubject.emailNormalized,
        status: targetSubject.status,
        isParticipant: membership !== null,
        ...(role ? { role: role.role } : {}),
      },
      accessVersion: targetSubject.accessVersion,
      actions: {
        assignRole: assignRoleIds.length > 0,
        suspend: person._id !== targetPersonId && suspendIds.length > 0,
        reactivate: reactivateIds.length > 0,
        useBundles: bundleReadIds && bundleApplyIds,
      },
      effectivePermissionKeys,
      currentPermissionKeys,
      canGrantAny: grantAnyIds.length > 0,
      canRevokeAny: revokeAnyIds.length > 0,
      grantDelegations,
      revokeDelegations,
      catalog: Object.entries(permissionCatalog).map(([key, definition]) => ({
        key,
        label: permissionName(key),
        area: areaForPermission(key),
        eventWide: definition.eventWide,
        scopes: [...definition.scopes],
      })),
    };
  },
});

export const grantLedger = query({
  args: {
    eventSlug: v.string(),
    personId: v.string(),
    permissionKey: v.optional(v.string()),
    status: v.optional(permissionGrantStatus),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(grantView),
  handler: async (ctx, args) => {
    if (
      !Number.isSafeInteger(args.paginationOpts.numItems) ||
      args.paginationOpts.numItems < 1 ||
      args.paginationOpts.numItems > maximumAccessGrantPageSize
    ) {
      throw new ConvexError({
        code: "PAGE_SIZE_INVALID",
        message: `Request 1–${maximumAccessGrantPageSize} permission grants at a time.`,
      });
    }
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const actorSubject = await requireEventSubject(ctx, event._id, person._id);
    const targetPersonId = ctx.db.normalizeId("people", args.personId);
    if (!targetPersonId) {
      throw new ConvexError({ code: "PERSON_NOT_FOUND", message: "The target account is invalid." });
    }
    const targetSubject = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", targetPersonId),
      )
      .unique();
    if (!targetSubject) {
      throw new ConvexError({ code: "PERSON_NOT_FOUND", message: "The target event account is unavailable." });
    }
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: actorSubject._id,
      permissionKey: "access.permissions.read",
      scopeType: "person",
      scopeId: targetPersonId,
    });
    const [revokeAnyIds, revokeScopedAuthorities] = await Promise.all([
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: actorSubject._id,
        permissionKey: "access.permissions.revoke_any",
        scopeType: "event",
      }),
      activeAuthorityGrants(
        ctx,
        event._id,
        actorSubject._id,
        "access.permissions.revoke_scoped",
      ),
    ]);
    const visibleRevokeAuthorities = revokeScopedAuthorities.filter(
      (grant) =>
        grant.delegation?.target.kind === "any_event_person" ||
        grant.delegation?.target.personId === targetPersonId,
    );
    const permissionKeyValue = args.permissionKey;
    const statusValue = args.status;
    const page = permissionKeyValue
      ? await ctx.db
          .query("permissionGrants")
          .withIndex("by_subject_permission_status", (index) => {
            const permissionIndex = index
              .eq("eventAccessSubjectId", targetSubject._id)
              .eq("permissionKey", permissionKeyValue);
            return statusValue
              ? permissionIndex.eq("status", statusValue)
              : permissionIndex;
          })
          .order("desc")
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("permissionGrants")
          .withIndex("by_person_status", (index) => {
            const personIndex = index
              .eq("eventId", event._id)
              .eq("personId", targetPersonId);
            return statusValue ? personIndex.eq("status", statusValue) : personIndex;
          })
          .order("desc")
          .paginate(args.paginationOpts);
    const now = Date.now();
    return {
      ...page,
      page: await Promise.all(
        page.page.map((grant) =>
          permissionGrantView(ctx, {
            eventId: event._id,
            targetPersonId,
            grant,
            now,
            canRevokeAny: revokeAnyIds.length > 0,
            revokeAuthorities: visibleRevokeAuthorities,
          }),
        ),
      ),
    };
  },
});

const scopeOption = v.object({ id: v.string(), label: v.string() });

export const scopeOptions = query({
  args: {
    eventSlug: v.string(),
    targetPersonId: v.string(),
    permissionKey: v.string(),
    requestedScopeType: scopeType,
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(scopeOption),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const targetPersonId = ctx.db.normalizeId("people", args.targetPersonId);
    if (!targetPersonId) {
      throw new ConvexError({ code: "PERSON_NOT_FOUND", message: "The target account is invalid." });
    }
    const actorSubject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: actorSubject._id,
      permissionKey: "access.permissions.grant_any",
      scopeType: "event",
    });
    const targetSubject = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", targetPersonId),
      )
      .unique();
    if (!targetSubject || targetSubject.status !== "active") {
      throw new ConvexError({
        code: "PERSON_NOT_FOUND",
        message: "The target account is not active for this event.",
      });
    }
    const permissionKey = assertPermissionKey(args.permissionKey);
    const definition = permissionCatalog[permissionKey];
    if (
      args.requestedScopeType === "event" ||
      !definition.scopes.some((candidate) => candidate === args.requestedScopeType)
    ) {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message: "That resource type is not valid for the selected permission.",
      });
    }

    if (args.requestedScopeType === "self") {
      const kind = selfScopeKind(permissionKey);
      if (kind === "event_subject") {
        return {
          page: [{ id: targetSubject._id, label: "Own event account" }],
          isDone: true,
          continueCursor: "",
        };
      }
      if (kind !== "participant_membership") {
        throw new ConvexError({
          code: "SCOPE_NOT_AVAILABLE",
          message: "The selected permission has no self resource resolver.",
        });
      }
      const membership = await ctx.db
        .query("eventMemberships")
        .withIndex("by_event_person", (index) =>
          index.eq("eventId", event._id).eq("personId", targetPersonId),
        )
        .unique();
      return {
        page: membership
          ? [{ id: membership._id, label: "Own participant membership" }]
          : [],
        isDone: true,
        continueCursor: "",
      };
    }
    if (args.requestedScopeType === "person") {
      const resourceStatus =
        permissionKey === "access.subjects.reactivate"
          ? "suspended"
          : "active";
      const page = await ctx.db
        .query("eventAccessSubjects")
        .withIndex("by_event_status_email", (index) =>
          index.eq("eventId", event._id).eq("status", resourceStatus),
        )
        .paginate(args.paginationOpts);
      return {
        ...page,
        page: page.page.map((subject) => ({
          id: subject.personId,
          label: `${subject.displayName} · ${subject.emailNormalized} · ${subject.status}`,
        })),
      };
    }
    if (args.requestedScopeType === "permission_bundle") {
      const page = await ctx.db
        .query("permissionBundles")
        .withIndex("by_event_status_label", (index) =>
          index.eq("eventId", event._id).eq("status", "active"),
        )
        .paginate(args.paginationOpts);
      return {
        ...page,
        page: page.page.map((bundle) => ({
          id: bundle._id,
          label: `${bundle.label} · version ${bundle.publishedVersion}`,
        })),
      };
    }
    if (args.requestedScopeType === "roster_entry") {
      const page = await ctx.db
        .query("rosterEntries")
        .withIndex("by_event_status_created", (index) =>
          index.eq("eventId", event._id).eq("status", "pending"),
        )
        .order("desc")
        .paginate(args.paginationOpts);
      return {
        ...page,
        page: page.page.map((entry) => ({
          id: entry._id,
          label: `${entry.displayName} · ${entry.emailNormalized} · ${readableState(entry.role)}`,
        })),
      };
    }
    if (args.requestedScopeType === "team") {
      const page = await ctx.db
        .query("teams")
        .withIndex("by_event_status", (index) => index.eq("eventId", event._id))
        .paginate(args.paginationOpts);
      return {
        ...page,
        page: page.page.map((team) => ({
          id: team._id,
          label: `${team.name} · ${readableState(team.status)}`,
        })),
      };
    }
    if (args.requestedScopeType === "application") {
      const page = await ctx.db
        .query("applications")
        .withIndex("by_event_state_submitted", (index) => index.eq("eventId", event._id))
        .paginate(args.paginationOpts);
      return {
        ...page,
        page: await Promise.all(
          page.page.map(async (application) => {
            const team = await ctx.db.get(application.teamId);
            return {
              id: application._id,
              label: `${team?.name ?? "Team"} · ${readableState(application.state)}`,
            };
          }),
        ),
      };
    }
    if (args.requestedScopeType === "attendance_plan") {
      const page = await ctx.db
        .query("attendancePlanVersions")
        .withIndex("by_event_status", (index) =>
          index.eq("eventId", event._id).eq("status", "draft"),
        )
        .paginate(args.paginationOpts);
      return {
        ...page,
        page: page.page.map((plan) => ({
          id: plan._id,
          label: `${plan.name} · version ${plan.version} · ${readableState(plan.status)}`,
        })),
      };
    }
    if (args.requestedScopeType === "floor_plan") {
      const [draft, published] = await Promise.all([
        ctx.db
          .query("floorPlanVersions")
          .withIndex("by_event_status", (index) => index.eq("eventId", event._id).eq("status", "draft"))
          .unique(),
        event.publishedFloorPlanVersionId
          ? ctx.db.get(event.publishedFloorPlanVersionId)
          : null,
      ]);
      const candidates = [draft, published].flatMap((plan) => plan ? [plan] : []);
      return {
        page: candidates
          .filter((plan) => {
            if (permissionKey === "floor.plan.publish") return plan.status === "draft";
            if (permissionKey === "floor.plan.freeze") {
              return plan.status === "published" && plan.mappingState === "open";
            }
            return true;
          })
          .map((plan) => ({
            id: plan._id,
            label: `${plan.name} · plan ${plan.planNumber} · ${readableState(plan.mappingState)}`,
          })),
        isDone: true,
        continueCursor: "",
      };
    }
    if (args.requestedScopeType === "floor_zone") {
      const plan = event.publishedFloorPlanVersionId
        ? await ctx.db.get(event.publishedFloorPlanVersionId)
        : null;
      if (!plan || plan.status !== "published") {
        return { page: [], isDone: true, continueCursor: "" };
      }
      const page = await ctx.db
        .query("floorZones")
        .withIndex("by_plan_order", (index) => index.eq("planVersionId", plan._id))
        .paginate(args.paginationOpts);
      return {
        ...page,
        page: page.page.map((zone) => ({
          id: zone._id,
          label: `${plan.name} · ${zone.name}`,
        })),
      };
    }
    if (args.requestedScopeType === "attendance_session") {
      const page = await ctx.db
        .query("attendanceSessions")
        .withIndex("by_event_status_start", (index) => index.eq("eventId", event._id))
        .paginate(args.paginationOpts);
      return {
        ...page,
        page: page.page.map((session) => ({
          id: session._id,
          label: `${session.name} · ${readableState(session.status)}`,
        })),
      };
    }
    if (args.requestedScopeType === "station") {
      const page = await ctx.db
        .query("attendanceStations")
        .withIndex("by_event_status", (index) => index.eq("eventId", event._id))
        .paginate(args.paginationOpts);
      return {
        ...page,
        page: page.page.map((station) => ({
          id: station._id,
          label: `${station.name} · ${readableState(station.status)}`,
        })),
      };
    }
    if (args.requestedScopeType === "incident") {
      const page = await ctx.db
        .query("incidents")
        .withIndex("by_event_opened", (index) => index.eq("eventId", event._id))
        .order("desc")
        .paginate(args.paginationOpts);
      return {
        ...page,
        page: page.page.map((incident) => ({
          id: incident._id,
          label: `${incident.title} · ${readableState(incident.state)} · ${readableState(incident.manualModeState)}`,
        })),
      };
    }
    if (args.requestedScopeType === "synesthesia_window") {
      const page = await ctx.db
        .query("synesthesiaWindows")
        .withIndex("by_event_start", (index) => index.eq("eventId", event._id))
        .order("desc")
        .paginate(args.paginationOpts);
      return {
        ...page,
        page: page.page.map((window) => ({
          id: window._id,
          label: `${window.name} · ${readableState(window.status)}`,
        })),
      };
    }
    if (args.requestedScopeType === "song_request") {
      const page = await ctx.db
        .query("songRequests")
        .withIndex("by_event_created", (index) => index.eq("eventId", event._id))
        .order("desc")
        .paginate(args.paginationOpts);
      return {
        ...page,
        page: page.page.map((request) => ({
          id: request._id,
          label: `${request.title} · ${request.artist} · ${readableState(request.state)}`,
        })),
      };
    }
    if (args.requestedScopeType === "round") {
      const page = await ctx.db
        .query("reviewRounds")
        .withIndex("by_event_status_start", (index) => index.eq("eventId", event._id))
        .paginate(args.paginationOpts);
      return {
        ...page,
        page: page.page.map((round) => ({
          id: round._id,
          label: `${round.name} · ${readableState(round.status)}`,
        })),
      };
    }
    if (args.requestedScopeType === "panel") {
      const page = await ctx.db
        .query("reviewPanels")
        .withIndex("by_event_name", (index) => index.eq("eventId", event._id))
        .paginate(args.paginationOpts);
      return {
        ...page,
        page: await Promise.all(
          page.page.map(async (panel) => {
            const round = await ctx.db.get(panel.roundId);
            return {
              id: panel._id,
              label: `${round?.name ?? "Round"} · ${panel.name}`,
            };
          }),
        ),
      };
    }
    if (args.requestedScopeType === "review") {
      const page = await ctx.db
        .query("reviewSessions")
        .withIndex("by_event_created", (index) => index.eq("eventId", event._id))
        .order("desc")
        .paginate(args.paginationOpts);
      return {
        ...page,
        page: await Promise.all(
          page.page.map(async (session) => {
            const [round, team, panel] = await Promise.all([
              ctx.db.get(session.roundId),
              ctx.db.get(session.teamId),
              ctx.db.get(session.panelId),
            ]);
            return {
              id: session._id,
              label: `${round?.name ?? "Round"} · ${team?.name ?? "Team"} · ${panel?.name ?? "Panel"} · ${readableState(session.status)}`,
            };
          }),
        ),
      };
    }
    if (args.requestedScopeType === "page") {
      const page = await ctx.db
        .query("reviewerPages")
        .withIndex("by_event_person_created", (index) =>
          index.eq("eventId", event._id).eq("targetPersonId", targetPersonId),
        )
        .filter((filter) =>
          filter.and(
            filter.or(
              filter.eq(filter.field("state"), "sent"),
              filter.eq(filter.field("state"), "opened"),
            ),
            filter.gt(filter.field("expiresAt"), Date.now()),
          ),
        )
        .order("desc")
        .paginate(args.paginationOpts);
      return {
        ...page,
        page: await Promise.all(
          page.page.map(async (reviewerPage) => {
            const [round, panel, reviewer] = await Promise.all([
              ctx.db.get(reviewerPage.roundId),
              ctx.db.get(reviewerPage.panelId),
              eventPersonLabel(ctx, event._id, reviewerPage.targetPersonId),
            ]);
            return {
              id: reviewerPage._id,
              label: `${round?.name ?? "Round"} · ${panel?.name ?? "Panel"} · ${reviewer ?? "Reviewer"} · ${readableState(reviewerPage.state)}`,
            };
          }),
        ),
      };
    }
    if (args.requestedScopeType === "scorecard") {
      const page = scorecardScopeMustMatchTarget(permissionKey)
        ? await ctx.db
            .query("scorecards")
            .withIndex("by_event_reviewer_created", (index) =>
              index
                .eq("eventId", event._id)
                .eq("reviewerPersonId", targetPersonId),
            )
            .order("desc")
            .paginate(args.paginationOpts)
        : await ctx.db
            .query("scorecards")
            .withIndex("by_event_created", (index) =>
              index.eq("eventId", event._id),
            )
            .order("desc")
            .paginate(args.paginationOpts);
      return {
        ...page,
        page: await Promise.all(
          page.page.map(async (scorecard) => {
            const [round, session, reviewer] = await Promise.all([
              ctx.db.get(scorecard.roundId),
              ctx.db.get(scorecard.reviewSessionId),
              eventPersonLabel(ctx, event._id, scorecard.reviewerPersonId),
            ]);
            const team = session ? await ctx.db.get(session.teamId) : null;
            return {
              id: scorecard._id,
              label: `${round?.name ?? "Round"} · ${team?.name ?? "Team"} · ${reviewer ?? "Reviewer"} · ${readableState(scorecard.status)}`,
            };
          }),
        ),
      };
    }
    if (args.requestedScopeType === "evidence_checkpoint") {
      const page = await ctx.db
        .query("reviewEvidenceCheckpointSets")
        .withIndex("by_event_created", (index) => index.eq("eventId", event._id))
        .order("desc")
        .paginate(args.paginationOpts);
      return {
        ...page,
        page: await Promise.all(
          page.page.map(async (checkpoint) => {
            const [round, team] = await Promise.all([
              ctx.db.get(checkpoint.roundId),
              ctx.db.get(checkpoint.teamId),
            ]);
            return {
              id: checkpoint._id,
              label: `${round?.name ?? "Round"} · ${team?.name ?? "Team"} · ${readableState(checkpoint.completeness)}`,
            };
          }),
        ),
      };
    }
    if (args.requestedScopeType === "support_case") {
      const page = await ctx.db
        .query("supportCases")
        .withIndex("by_event_updated", (index) =>
          index.eq("eventId", event._id),
        )
        .order("desc")
        .paginate(args.paginationOpts);
      return {
        ...page,
        page: page.page.map((supportCase) => ({
          id: supportCase._id,
          label: `${supportCase.publicCode} · ${readableState(supportCase.category)} · ${readableState(supportCase.state)}`,
        })),
      };
    }
    if (args.requestedScopeType === "rehearsal_run") {
      const page = await ctx.db
        .query("rehearsalRuns")
        .withIndex("by_event_created", (index) =>
          index.eq("eventId", event._id),
        )
        .order("desc")
        .paginate(args.paginationOpts);
      return {
        ...page,
        page: page.page.map((run) => ({
          id: run._id,
          label: `${run.name} · ${readableState(run.state)}`,
        })),
      };
    }
    return unhandledScope(args.requestedScopeType);
  },
});

const validateScope = validateGrantScope;

type PermissionDelegationInput = {
  permissionKey: string;
  scopeType: PermissionScopeType;
  scopeId?: string;
  target:
    | { kind: "any_event_person" }
    | { kind: "exact_email"; email: string };
};

async function validatePermissionDelegation(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    delegatePersonId: Id<"people">;
    authorityKey:
      | "access.permissions.grant_scoped"
      | "access.permissions.revoke_scoped";
    input: PermissionDelegationInput;
  },
): Promise<PermissionDelegation> {
  const permissionKey = assertDelegatedPermissionKey(args.input.permissionKey);
  const definition = permissionCatalog[permissionKey];
  if (args.input.scopeType === "event") {
    if (!definition.eventWide || args.input.scopeId !== undefined) {
      throw new ConvexError({
        code: "INVALID_DELEGATION",
        message: "The delegated permission cannot use that event scope.",
      });
    }
  } else if (
    !definition.scopes.some((scope) => scope === args.input.scopeType)
  ) {
    throw new ConvexError({
      code: "INVALID_DELEGATION",
      message: "That resource type is not legal for the delegated permission.",
    });
  }

  let target: PermissionDelegation["target"];
  let validationTargetPersonId = args.delegatePersonId;
  if (args.input.target.kind === "exact_email") {
    const targetEmail = normalizeEmail(args.input.target.email);
    const targetSubject = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_email", (index) =>
        index
          .eq("eventId", args.eventId)
          .eq("emailNormalized", targetEmail),
      )
      .unique();
    if (!targetSubject || targetSubject.status !== "active") {
      throw new ConvexError({
        code: "INVALID_DELEGATION_TARGET",
        message: "That email is not an active account in this event.",
      });
    }
    if (
      args.authorityKey === "access.permissions.grant_scoped" &&
      targetSubject.personId === args.delegatePersonId
    ) {
      throw new ConvexError({
        code: "INVALID_DELEGATION_TARGET",
        message: "A scoped grant delegation cannot let its holder grant access to itself.",
      });
    }
    target = { kind: "exact_person", personId: targetSubject.personId };
    validationTargetPersonId = targetSubject.personId;
  } else {
    if (!delegationCanTargetAnyPerson(permissionKey, args.input.scopeType)) {
      throw new ConvexError({
        code: "INVALID_DELEGATION_TARGET",
        message: "That target-owned permission requires one exact recipient email.",
      });
    }
    target = { kind: "any_event_person" };
  }

  const validatedScope = await validateScope(
    ctx,
    args.eventId,
    validationTargetPersonId,
    permissionKey,
    args.input.scopeType,
    args.input.scopeId,
  );
  return {
    permissionKey,
    ...validatedScope,
    target,
  };
}

function storedGrantIds(
  ctx: MutationCtx,
  values: readonly string[],
  label: string,
) {
  return values.map((value) => {
    const grantId = ctx.db.normalizeId("permissionGrants", value);
    if (!grantId) throw new Error(`The stored ${label} result is invalid.`);
    return grantId;
  });
}

const directGrantInput = v.object({
  permissionKey: v.string(),
  scopeType,
  scopeId: v.optional(v.string()),
});

export const grant = mutation({
  args: {
    eventSlug: v.string(),
    targetPersonId: v.id("people"),
    permissionKey: v.string(),
    scopeType,
    scopeId: v.optional(v.string()),
    validUntil: v.optional(v.number()),
    delegation: v.optional(permissionDelegationInput),
    expectedAccessVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ grantId: v.id("permissionGrants"), accessVersion: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const actorSubject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Reason", 5, 300);
    const requestFingerprint = operationFingerprint([
      args.targetPersonId,
      args.permissionKey,
      args.scopeType,
      args.scopeId ?? null,
      args.validUntil ?? null,
      args.delegation?.permissionKey ?? null,
      args.delegation?.scopeType ?? null,
      args.delegation?.scopeId ?? null,
      args.delegation?.target.kind ?? null,
      args.delegation?.target.kind === "exact_email"
        ? normalizeEmail(args.delegation.target.email)
        : null,
      args.expectedAccessVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "access.grant",
      requestFingerprint,
    });
    if (prior) {
      const grantId = ctx.db.normalizeId("permissionGrants", prior.targetId);
      if (!grantId) throw new Error("Prior grant result is invalid.");
      return {
        grantId,
        accessVersion: storedOperationVersion(prior.resultJson, "permission grant"),
      };
    }
    const targetSubject = await requireEventSubject(ctx, event._id, args.targetPersonId);
    requireAccessVersion(targetSubject, args.expectedAccessVersion);
    const permissionKey = assertPermissionKey(args.permissionKey);
    const definition = permissionCatalog[permissionKey];
    if (args.scopeType === "event") {
      if (!definition.eventWide) throw new ConvexError({ code: "INVALID_SCOPE", message: "That permission cannot be event-wide." });
    } else if (!definition.scopes.some((scope) => scope === args.scopeType)) {
      throw new ConvexError({ code: "INVALID_SCOPE", message: "That scope is not valid for the permission." });
    }
    const now = Date.now();
    if (args.validUntil !== undefined && args.validUntil <= now) {
      throw new ConvexError({ code: "INVALID_EXPIRY", message: "Grant expiry must be in the future." });
    }
    if (
      args.validUntil !== undefined &&
      event.endsAt !== undefined &&
      args.validUntil > event.endsAt
    ) {
      throw new ConvexError({
        code: "INVALID_EXPIRY",
        message: "Grant expiry cannot extend beyond the event.",
      });
    }
    const validatedScope = await validateScope(
      ctx,
      event._id,
      args.targetPersonId,
      permissionKey,
      args.scopeType,
      args.scopeId,
    );
    const scopedAuthority = isScopedPermissionAuthority(permissionKey);
    if (scopedAuthority && args.validUntil === undefined) {
      throw new ConvexError({
        code: "INVALID_EXPIRY",
        message: "Scoped permission authority needs an explicit expiry ceiling.",
      });
    }
    if (scopedAuthority !== (args.delegation !== undefined)) {
      throw new ConvexError({
        code: "INVALID_DELEGATION",
        message: scopedAuthority
          ? "Choose the exact permission, resource, recipient boundary, and expiry for this delegation."
          : "Only scoped grant or revoke authority can carry a delegation ceiling.",
      });
    }
    const delegation =
      scopedAuthority && args.delegation
        ? await validatePermissionDelegation(ctx, {
            eventId: event._id,
            delegatePersonId: args.targetPersonId,
            authorityKey: permissionKey,
            input: args.delegation,
          })
        : undefined;
    const authority = await requireGrantAuthority(ctx, {
      eventId: event._id,
      eventAccessSubjectId: actorSubject._id,
      actorPersonId: person._id,
      action: {
        permissionKey,
        ...validatedScope,
        targetPersonId: args.targetPersonId,
        ...(args.validUntil !== undefined
          ? { validUntil: args.validUntil }
          : {}),
      },
    });
    const { grantId, created } = await insertPermissionGrant(ctx, {
      eventId: event._id,
      personId: args.targetPersonId,
      eventAccessSubjectId: targetSubject._id,
      permissionKey,
      ...validatedScope,
      sourceType:
        authority.permissionKey === "access.permissions.grant_scoped"
          ? "delegated"
          : "manual",
      sourceId: `${authority.permissionKey}:${args.clientOperationId}`,
      grantedByPersonId: person._id,
      reason,
      ...(args.validUntil !== undefined ? { validUntil: args.validUntil } : {}),
      ...(delegation !== undefined ? { delegation } : {}),
    });
    const accessVersion = created
      ? targetSubject.accessVersion + 1
      : targetSubject.accessVersion;
    if (created) {
      await ctx.db.patch(targetSubject._id, {
        accessVersion,
        updatedAt: Date.now(),
      });
    }
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "access.grant",
      requestFingerprint,
      targetType: "permission_grant",
      targetId: grantId,
      resultJson: String(accessVersion),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: authority.permissionKey,
      grantIds: authority.grantIds,
      scopeType: validatedScope.scopeType,
      ...(validatedScope.scopeType === "event"
        ? {}
        : { scopeId: validatedScope.scopeId }),
      action: "access.permission_granted",
      targetType: "permission_grant",
      targetId: grantId,
      nextSummary: JSON.stringify({
        targetPersonId: args.targetPersonId,
        permissionKey,
        scopeType: args.scopeType,
        scopeId: args.scopeId,
        validUntil: args.validUntil,
        delegation,
      }),
      reason,
    });
    return { grantId, accessVersion };
  },
});

export const grantBatch = mutation({
  args: {
    eventSlug: v.string(),
    targetPersonId: v.id("people"),
    grants: v.array(directGrantInput),
    validUntil: v.optional(v.number()),
    expectedAccessVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    grantIds: v.array(v.id("permissionGrants")),
    createdCount: v.number(),
    accessVersion: v.number(),
  }),
  handler: grantPermissionBatch,
});

type DirectGrantBatchArgs = {
  eventSlug: string;
  targetPersonId: Id<"people">;
  grants: ReadonlyArray<{
    permissionKey: string;
    scopeType: PermissionScopeType;
    scopeId?: string;
  }>;
  validUntil?: number;
  expectedAccessVersion: number;
  reason: string;
  clientOperationId: string;
};

function normalizeDirectGrantBatch(grants: DirectGrantBatchArgs["grants"]) {
  if (grants.length === 0 || grants.length > maximumDirectGrantBatchSize) {
    throw new ConvexError({
      code: "INVALID_GRANT_BATCH",
      message: `Choose 1–${maximumDirectGrantBatchSize} permissions.`,
    });
  }
  const exactScopes = new Set<string>();
  return grants.map((input) => {
    const permissionKey = assertPermissionKey(input.permissionKey);
    if (isScopedPermissionAuthority(permissionKey)) {
      throw new ConvexError({
        code: "INVALID_GRANT_BATCH",
        message: "Scoped permission delegation must be configured one at a time.",
      });
    }
    const definition = permissionCatalog[permissionKey];
    if (input.scopeType === "event") {
      if (!definition.eventWide || input.scopeId !== undefined) {
        throw new ConvexError({
          code: "INVALID_SCOPE",
          message: `Event scope is not valid for ${permissionKey}.`,
        });
      }
    } else if (!definition.scopes.some((scope) => scope === input.scopeType)) {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message: `That scope is not valid for ${permissionKey}.`,
      });
    }
    const normalized = {
      permissionKey,
      scopeType: input.scopeType,
      ...(input.scopeId !== undefined ? { scopeId: input.scopeId } : {}),
    };
    const exactScope = JSON.stringify([
      permissionKey,
      input.scopeType,
      input.scopeType === "event" ? null : input.scopeId ?? null,
    ]);
    if (exactScopes.has(exactScope)) {
      throw new ConvexError({
        code: "INVALID_GRANT_BATCH",
        message: "The batch repeats one exact permission scope.",
      });
    }
    exactScopes.add(exactScope);
    return normalized;
  });
}

async function grantPermissionBatch(ctx: MutationCtx, args: DirectGrantBatchArgs) {
  const normalized = normalizeDirectGrantBatch(args.grants);
  const reason = normalizedText(args.reason, "Reason", 5, 300);
  const requestFingerprint = operationFingerprint([
    args.targetPersonId,
    args.expectedAccessVersion,
    args.validUntil ?? null,
    reason,
    ...normalized.flatMap((item) => [
      item.permissionKey,
      item.scopeType,
      item.scopeType === "event" ? null : item.scopeId ?? null,
    ]),
  ]);
  const event = await requireEventBySlug(ctx, args.eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const actorSubject = await requireEventSubject(ctx, event._id, person._id);
  const prior = await findOperation(ctx, {
    eventId: event._id,
    actorPersonId: person._id,
    clientOperationId: args.clientOperationId,
    commandName: "access.grant_batch",
    requestFingerprint,
  });
  if (prior) {
    const stored = storedOperationResult(
      prior.resultJson,
      "permission grant batch",
      directGrantBatchResult,
    );
    return {
      grantIds: storedGrantIds(ctx, stored.grantIds, "permission grant batch"),
      createdCount: stored.createdCount,
      accessVersion: stored.accessVersion,
    };
  }
  const targetSubject = await requireEventSubject(
    ctx,
    event._id,
    args.targetPersonId,
  );
  requireAccessVersion(targetSubject, args.expectedAccessVersion);
  const now = Date.now();
  if (args.validUntil !== undefined && args.validUntil <= now) {
    throw new ConvexError({
      code: "INVALID_EXPIRY",
      message: "Grant expiry must be in the future.",
    });
  }
  if (
    args.validUntil !== undefined &&
    event.endsAt !== undefined &&
    args.validUntil > event.endsAt
  ) {
    throw new ConvexError({
      code: "INVALID_EXPIRY",
      message: "Grant expiry cannot extend beyond the event.",
    });
  }
  const plans: PermissionGrantPlan[] = [];
  const authorizingGrantIds = new Set<Id<"permissionGrants">>();
  let authorityPermissionKey:
    | "access.permissions.grant_any"
    | "access.permissions.grant_scoped"
    | null = null;
  for (const item of normalized) {
    const validatedScope = await validateScope(
      ctx,
      event._id,
      args.targetPersonId,
      item.permissionKey,
      item.scopeType,
      item.scopeId,
    );
    const authority = await requireGrantAuthority(ctx, {
      eventId: event._id,
      eventAccessSubjectId: actorSubject._id,
      actorPersonId: person._id,
      action: {
        permissionKey: item.permissionKey,
        ...validatedScope,
        targetPersonId: args.targetPersonId,
        ...(args.validUntil !== undefined ? { validUntil: args.validUntil } : {}),
      },
    });
    if (
      authority.permissionKey !== "access.permissions.grant_any" &&
      authority.permissionKey !== "access.permissions.grant_scoped"
    ) {
      throw new Error("Permission grant authority resolved to the wrong action.");
    }
    if (
      authorityPermissionKey !== null &&
      authorityPermissionKey !== authority.permissionKey
    ) {
      throw new Error("One grant batch cannot mix unrestricted and delegated authority.");
    }
    authorityPermissionKey = authority.permissionKey;
    for (const grantId of authority.grantIds) authorizingGrantIds.add(grantId);
    plans.push({ permissionKey: item.permissionKey, ...validatedScope });
  }
  if (authorityPermissionKey === null) {
    throw new Error("Permission grant authority was not resolved.");
  }
  const group = await insertPermissionGrantGroup(ctx, {
    eventId: event._id,
    personId: args.targetPersonId,
    eventAccessSubjectId: targetSubject._id,
    sourceType:
      authorityPermissionKey === "access.permissions.grant_scoped"
        ? "delegated"
        : "manual",
    sourceId: `access.grant_batch:${args.clientOperationId}`,
    grantedByPersonId: person._id,
    reason,
    ...(args.validUntil !== undefined ? { validUntil: args.validUntil } : {}),
    grants: plans,
  });
  const accessVersion = group.createdCount > 0
    ? targetSubject.accessVersion + 1
    : targetSubject.accessVersion;
  if (group.createdCount > 0) {
    await ctx.db.patch(targetSubject._id, { accessVersion, updatedAt: now });
  }
  const result = {
    grantIds: group.results.map((entry) => entry.grantId),
    createdCount: group.createdCount,
    accessVersion,
  };
  await recordOperation(ctx, {
    eventId: event._id,
    actorPersonId: person._id,
    clientOperationId: args.clientOperationId,
    commandName: "access.grant_batch",
    requestFingerprint,
    targetType: "event_access_subject",
    targetId: targetSubject._id,
    resultJson: JSON.stringify(result),
    createdAt: now,
  });
  await writeAuditEvent(ctx, {
    eventId: event._id,
    actorPersonId: person._id,
    permissionKey: authorityPermissionKey,
    grantIds: [...authorizingGrantIds],
    scopeType: "person",
    scopeId: args.targetPersonId,
    action: "access.permission_grant_batch",
    targetType: "event_access_subject",
    targetId: targetSubject._id,
    nextSummary: JSON.stringify({
      targetPersonId: args.targetPersonId,
      grants: plans,
      validUntil: args.validUntil ?? null,
      createdCount: group.createdCount,
      accessVersion,
    }),
    reason,
  });
  return result;
}

export const revoke = mutation({
  args: {
    eventSlug: v.string(),
    grantId: v.id("permissionGrants"),
    expectedAccessVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    grantId: v.id("permissionGrants"),
    status: v.literal("revoked"),
    accessVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const actorSubject = await requireEventSubject(ctx, event._id, person._id);
    const reason = normalizedText(args.reason, "Reason", 5, 300);
    const requestFingerprint = operationFingerprint([
      args.grantId,
      args.expectedAccessVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "access.revoke",
      requestFingerprint,
    });
    if (prior) {
      const priorGrantId = ctx.db.normalizeId("permissionGrants", prior.targetId);
      if (!priorGrantId) throw new Error("Prior revoke result is invalid.");
      return {
        grantId: priorGrantId,
        status: revokedStatus,
        accessVersion: storedOperationVersion(prior.resultJson, "permission revoke"),
      };
    }
    const grant = await ctx.db.get(args.grantId);
    if (!grant || grant.eventId !== event._id) {
      throw new ConvexError({ code: "GRANT_NOT_FOUND", message: "That grant is outside this event." });
    }
    const permissionKey = assertPermissionKey(grant.permissionKey);
    const authority = await requireRevokeAuthority(ctx, {
      eventId: event._id,
      eventAccessSubjectId: actorSubject._id,
      action: {
        permissionKey,
        scopeType: grant.scopeType,
        ...(grant.scopeId !== undefined ? { scopeId: grant.scopeId } : {}),
        targetPersonId: grant.personId,
      },
    });
    const targetSubject = await ctx.db.get(grant.eventAccessSubjectId);
    if (!targetSubject) throw new Error("Permission grant subject is missing.");
    requireAccessVersion(targetSubject, args.expectedAccessVersion);
    const now = Date.now();
    let accessVersion = targetSubject.accessVersion;
    if (grant.status === "active" || grant.status === "scheduled") {
      await ctx.db.patch(grant._id, {
        status: "revoked",
        revokedAt: now,
        revokedByPersonId: person._id,
        revokeReason: reason,
      });
      accessVersion += 1;
      await ctx.db.patch(targetSubject._id, { accessVersion, updatedAt: now });
      await writeAuditEvent(ctx, {
        eventId: event._id,
        actorPersonId: person._id,
        permissionKey: authority.permissionKey,
        grantIds: authority.grantIds,
        scopeType: grant.scopeType,
        ...(grant.scopeType === "event" ? {} : { scopeId: grant.scopeId }),
        action: "access.permission_revoked",
        targetType: "permission_grant",
        targetId: grant._id,
        previousSummary: JSON.stringify({
          targetPersonId: grant.personId,
          permissionKey: grant.permissionKey,
          scopeType: grant.scopeType,
          scopeId: grant.scopeId,
          delegation: grant.delegation,
        }),
        nextSummary: JSON.stringify({ status: "revoked", revokedAt: now }),
        reason,
      });
    } else if (grant.status !== "revoked") {
      throw new ConvexError({
        code: "GRANT_NOT_ACTIVE",
        message: "Only an active or scheduled grant can be revoked.",
      });
    }
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "access.revoke",
      requestFingerprint,
      targetType: "permission_grant",
      targetId: grant._id,
      resultJson: String(accessVersion),
      createdAt: now,
    });
    return { grantId: grant._id, status: revokedStatus, accessVersion };
  },
});

export const revokeBatch = mutation({
  args: {
    eventSlug: v.string(),
    targetPersonId: v.id("people"),
    grantIds: v.array(v.id("permissionGrants")),
    expectedAccessVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    grantIds: v.array(v.id("permissionGrants")),
    revokedCount: v.number(),
    accessVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    if (
      args.grantIds.length === 0 ||
      args.grantIds.length > maximumDirectGrantBatchSize
    ) {
      throw new ConvexError({
        code: "INVALID_REVOKE_BATCH",
        message: `Choose 1–${maximumDirectGrantBatchSize} permission grants.`,
      });
    }
    const uniqueGrantIds = new Set(args.grantIds);
    if (uniqueGrantIds.size !== args.grantIds.length) {
      throw new ConvexError({
        code: "INVALID_REVOKE_BATCH",
        message: "The batch repeats one permission grant.",
      });
    }
    const reason = normalizedText(args.reason, "Reason", 5, 300);
    const requestFingerprint = operationFingerprint([
      args.targetPersonId,
      args.expectedAccessVersion,
      reason,
      ...args.grantIds,
    ]);
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const actorSubject = await requireEventSubject(ctx, event._id, person._id);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "access.revoke_batch",
      requestFingerprint,
    });
    if (prior) {
      const stored = storedOperationResult(
        prior.resultJson,
        "permission revoke batch",
        directRevokeBatchResult,
      );
      return {
        grantIds: storedGrantIds(ctx, stored.grantIds, "permission revoke batch"),
        revokedCount: stored.revokedCount,
        accessVersion: stored.accessVersion,
      };
    }
    const targetSubject = await requireEventSubject(
      ctx,
      event._id,
      args.targetPersonId,
    );
    requireAccessVersion(targetSubject, args.expectedAccessVersion);
    const rows = await Promise.all(args.grantIds.map((grantId) => ctx.db.get(grantId)));
    const grants = rows.map((grant) => {
      if (
        !grant ||
        grant.eventId !== event._id ||
        grant.personId !== args.targetPersonId ||
        grant.eventAccessSubjectId !== targetSubject._id
      ) {
        throw new ConvexError({
          code: "GRANT_NOT_FOUND",
          message: "Every selected grant must belong to this event account.",
        });
      }
      if (grant.status !== "active" && grant.status !== "scheduled") {
        throw new ConvexError({
          code: "GRANT_NOT_ACTIVE",
          message: "Every selected grant must still be active or scheduled.",
        });
      }
      return grant;
    });
    const authorizingGrantIds = new Set<Id<"permissionGrants">>();
    let authorityPermissionKey:
      | "access.permissions.revoke_any"
      | "access.permissions.revoke_scoped"
      | null = null;
    for (const grant of grants) {
      const permissionKey = assertPermissionKey(grant.permissionKey);
      const authority = await requireRevokeAuthority(ctx, {
        eventId: event._id,
        eventAccessSubjectId: actorSubject._id,
        action: {
          permissionKey,
          scopeType: grant.scopeType,
          ...(grant.scopeId !== undefined ? { scopeId: grant.scopeId } : {}),
          targetPersonId: args.targetPersonId,
        },
      });
      if (
        authority.permissionKey !== "access.permissions.revoke_any" &&
        authority.permissionKey !== "access.permissions.revoke_scoped"
      ) {
        throw new Error("Permission revoke authority resolved to the wrong action.");
      }
      if (
        authorityPermissionKey !== null &&
        authorityPermissionKey !== authority.permissionKey
      ) {
        throw new Error("One revoke batch cannot mix unrestricted and delegated authority.");
      }
      authorityPermissionKey = authority.permissionKey;
      for (const grantId of authority.grantIds) authorizingGrantIds.add(grantId);
    }
    if (authorityPermissionKey === null) {
      throw new Error("Permission revoke authority was not resolved.");
    }
    const now = Date.now();
    for (const grant of grants) {
      await ctx.db.patch(grant._id, {
        status: "revoked",
        revokedAt: now,
        revokedByPersonId: person._id,
        revokeReason: reason,
      });
    }
    const accessVersion = targetSubject.accessVersion + 1;
    await ctx.db.patch(targetSubject._id, { accessVersion, updatedAt: now });
    const result = {
      grantIds: grants.map((grant) => grant._id),
      revokedCount: grants.length,
      accessVersion,
    };
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "access.revoke_batch",
      requestFingerprint,
      targetType: "event_access_subject",
      targetId: targetSubject._id,
      resultJson: JSON.stringify(result),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: authorityPermissionKey,
      grantIds: [...authorizingGrantIds],
      scopeType: "person",
      scopeId: args.targetPersonId,
      action: "access.permission_revoke_batch",
      targetType: "event_access_subject",
      targetId: targetSubject._id,
      previousSummary: JSON.stringify({
        targetPersonId: args.targetPersonId,
        grants: grants.map((grant) => ({
          grantId: grant._id,
          permissionKey: grant.permissionKey,
          scopeType: grant.scopeType,
          scopeId: grant.scopeId ?? null,
        })),
        accessVersion: targetSubject.accessVersion,
      }),
      nextSummary: JSON.stringify({
        status: "revoked",
        revokedCount: grants.length,
        accessVersion,
      }),
      reason,
    });
    return result;
  },
});
