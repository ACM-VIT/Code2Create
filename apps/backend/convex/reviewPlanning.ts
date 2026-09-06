import { teamRoundState, reviewRoundStatus } from "./values";
import { hasReviewConflict } from "./lib/reviewConflict";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { requirePermission } from "./lib/permissions";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
} from "./lib/operations";
import { normalizedText } from "./lib/strings";
import { writeAuditEvent } from "./lib/audit";
import { projectReviewAssessment } from "./lib/reviewPlanningFields";
import {
  defaultReviewScoringBufferSeconds,
  maximumApplicantTeamsPerEvent,
  maximumReviewPanelsPerRound,
  maximumReviewersPerPanel,
} from "./lib/reviewLimits";
import { reviewProgressionBlocker } from "./lib/reviewProgression";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

export const saveBrief = mutation({
  args: {
    eventSlug: v.string(),
    teamId: v.id("teams"),
    projectVersionId: v.id("projectVersions"),
    assessment: projectReviewAssessment,
    sourceChecksum: v.string(),
    model: v.string(),
    expectedVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "review.configuration.publish",
      scopeType: "event",
    });
    const reason = normalizedText(args.reason, "Reason", 5, 500);
    const operation = {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.planning.brief",
      requestFingerprint: operationFingerprint([
        args.teamId,
        args.projectVersionId,
        args.sourceChecksum,
        args.model,
        JSON.stringify(args.assessment),
        args.expectedVersion,
        reason,
      ]),
    };
    const prior = await findOperation(ctx, operation);
    if (prior)
      return {
        version: storedOperationVersion(prior.resultJson, "project brief"),
      };
    const [team, project, application, current] = await Promise.all([
      ctx.db.get(args.teamId),
      ctx.db.get(args.projectVersionId),
      ctx.db
        .query("applications")
        .withIndex("by_team", (q) => q.eq("teamId", args.teamId))
        .unique(),
      ctx.db
        .query("reviewProjectBriefs")
        .withIndex("by_event_team", (q) =>
          q.eq("eventId", event._id).eq("teamId", args.teamId),
        )
        .unique(),
    ]);
    if (
      !team ||
      team.eventId !== event._id ||
      team.competitionCategory === "oc" ||
      !project ||
      project.teamId !== team._id ||
      project.eventId !== event._id ||
      application?.humanDecision !== "accept" ||
      application.decisionStage !== "released" ||
      application.submittedProjectVersionId !== project._id
    )
      throw new ConvexError({
        code: "PROJECT_CHANGED",
        message: "Prepare the current accepted, competitive submission.",
      });
    if ((current?.version ?? 0) !== args.expectedVersion)
      throw new ConvexError({
        code: "BRIEF_CHANGED",
        message: "The project brief changed. Refresh before saving.",
      });
    const sources = new Set([
      "idea",
      ...(project.additionalInformation ? ["additional"] : []),
      ...project.intakeResponses.map((r) => `answer-${r.ordinal}`),
    ]);
    const a = args.assessment;
    const findings = [
      a.summary,
      a.users,
      a.minimumDeliverable,
      a.architecture,
      a.implementationEvidence,
      ...a.risksToProbe,
    ];
    const citations = [...findings, ...a.suggestedQuestions];
    if (
      JSON.stringify(a).length > 40_000 ||
      a.examinedSourceIds.length !== sources.size ||
      new Set(a.examinedSourceIds).size !== sources.size ||
      a.examinedSourceIds.some((id) => !sources.has(id)) ||
      citations.some(
        (f) =>
          !f.sourceIds.length || f.sourceIds.some((id) => !sources.has(id)),
      ) ||
      findings.some((f) => !f.text.trim()) ||
      a.suggestedQuestions.length > 5 ||
      a.suggestedQuestions.some(
        (q) =>
          ![
            "research_scope",
            "user_readiness",
            "idea_novelty",
            "technical_execution",
            "presentation",
          ].includes(q.criterionKey),
      ) ||
      a.specialistSkills.length > 20 ||
      a.secondaryPools.length > 3 ||
      !/^[a-f0-9]{64}$/.test(args.sourceChecksum)
    )
      throw new ConvexError({
        code: "INVALID_BRIEF",
        message:
          "Account for every submission source, keep the brief concise, and cite the actual answers with valid rubric questions.",
      });
    const now = Date.now();
    const version = args.expectedVersion + 1;
    const fields = {
      projectVersionId: project._id,
      assessment: a,
      sourceChecksum: args.sourceChecksum,
      model: normalizedText(args.model, "Model", 1, 100),
      version,
      updatedByPersonId: person._id,
      updatedAt: now,
    };
    const id =
      current?._id ??
      (await ctx.db.insert("reviewProjectBriefs", {
        eventId: event._id,
        teamId: team._id,
        ...fields,
      }));
    if (current) await ctx.db.patch(current._id, fields);
    await recordOperation(ctx, {
      ...operation,
      targetType: "review_project_brief",
      targetId: id,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "review.configuration.publish",
      grantIds,
      scopeType: "event",
      action: "review.project_prepared",
      targetType: "review_project_brief",
      targetId: id,
      previousSummary: JSON.stringify({
        version: current?.version ?? 0,
        checksum: current?.sourceChecksum,
      }),
      nextSummary: JSON.stringify({
        version,
        projectVersionId: project._id,
        checksum: args.sourceChecksum,
      }),
      reason,
    });
    return { version };
  },
});

const planView = v.object({
  panelId: v.id("reviewPanels"),
  backupPanelId: v.optional(v.id("reviewPanels")),
  rationale: v.string(),
  version: v.number(),
});
export const workspace = query({
  args: { eventSlug: v.string(), roundId: v.id("reviewRounds") },
  returns: v.object({
    requiredPanelSize: v.number(),
    roundStatus: reviewRoundStatus,
    roundVersion: v.number(),
    canEdit: v.boolean(),
    durationSeconds: v.number(),
    scoringBufferSeconds: v.number(),
    startsAt: v.number(),
    endsAt: v.number(),
    panels: v.array(
      v.object({
        id: v.id("reviewPanels"),
        name: v.string(),
        memberCount: v.number(),
      }),
    ),
    teams: v.array(
      v.object({
        teamId: v.id("teams"),
        name: v.string(),
        status: v.string(),
        blocker: v.union(v.string(), v.null()),
        inQueue: v.boolean(),
        state: teamRoundState,
        stateVersion: v.number(),
        plan: v.union(planView, v.null()),
        brief: v.union(v.null(), projectReviewAssessment),
        briefCurrent: v.boolean(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "round.manage",
      scopeType: "round",
      scopeId: args.roundId,
    });
    const round = await ctx.db.get(args.roundId);
    if (!round || round.eventId !== event._id)
      throw new ConvexError({
        code: "ROUND_NOT_FOUND",
        message: "Round unavailable.",
      });
    const [applications, panels, plans, briefs, queue, policy] =
      await Promise.all([
        ctx.db
          .query("applications")
          .withIndex("by_event_decision_stage", (q) =>
            q.eq("eventId", event._id).eq("decisionStage", "released"),
          )
          .take(maximumApplicantTeamsPerEvent + 1),
        ctx.db
          .query("reviewPanels")
          .withIndex("by_round_status", (q) => q.eq("roundId", round._id))
          .take(maximumReviewPanelsPerRound + 1),
        ctx.db
          .query("reviewTeamPlans")
          .withIndex("by_round_team", (q) => q.eq("roundId", round._id))
          .take(maximumApplicantTeamsPerEvent + 1),
        ctx.db
          .query("reviewProjectBriefs")
          .withIndex("by_event_team", (q) => q.eq("eventId", event._id))
          .take(maximumApplicantTeamsPerEvent + 1),
        ctx.db
          .query("teamRoundStates")
          .withIndex("by_round_state_priority_queued", (q) =>
            q.eq("roundId", round._id),
          )
          .take(maximumApplicantTeamsPerEvent + 1),
        ctx.db
          .query("reviewQueuePolicies")
          .withIndex("by_round", (q) => q.eq("roundId", round._id))
          .unique(),
      ]);
    if (
      [applications, plans, briefs, queue].some(
        (rows) => rows.length > maximumApplicantTeamsPerEvent,
      ) ||
      panels.length > maximumReviewPanelsPerRound
    )
      throw new Error("Review planning limit exceeded.");
    const byTeam = new Map(plans.map((p) => [p.teamId, p]));
    const briefByTeam = new Map(briefs.map((b) => [b.teamId, b]));
    const stateByTeam = new Map(queue.map((s) => [s.teamId, s]));
    const rows = await Promise.all(
      applications
        .filter((a) => a.humanDecision === "accept")
        .map(async (application) => {
          const team = await ctx.db.get(application.teamId);
          if (!team || team.competitionCategory === "oc") return null;
          const plan = byTeam.get(team._id);
          const brief = briefByTeam.get(team._id);
          const state = stateByTeam.get(team._id);
          return {
            teamId: team._id,
            name: team.name,
            status: application.state,
            blocker:
              state?.state === "skipped"
                ? "Review skipped by ops"
                : await reviewProgressionBlocker(ctx, round, team._id),
            inQueue: !!state && state.state !== "unassigned",
            state: state?.state ?? ("unassigned" as const),
            stateVersion: state?.version ?? 0,
            plan: plan
              ? {
                  panelId: plan.panelId,
                  ...(plan.backupPanelId
                    ? { backupPanelId: plan.backupPanelId }
                    : {}),
                  rationale: plan.rationale,
                  version: plan.version,
                }
              : null,
            brief: brief?.assessment ?? null,
            briefCurrent:
              brief?.projectVersionId === application.submittedProjectVersionId,
          };
        }),
    );
    return {
      requiredPanelSize: round.requiredPanelSize,
      roundStatus: round.status,
      roundVersion: round.version,
      canEdit: ["published", "open"].includes(round.status),
      durationSeconds: round.reviewDurationSeconds,
      scoringBufferSeconds:
        policy?.scoringBufferSeconds ?? defaultReviewScoringBufferSeconds,
      startsAt: round.startsAt,
      endsAt: round.endsAt,
      teams: rows
        .filter((t) => t !== null)
        .sort((a, b) => a.name.localeCompare(b.name)),
      panels: await Promise.all(
        panels
          .filter((p) => p.status !== "closed")
          .map(async (p) => ({
            id: p._id,
            name: p.name,
            memberCount: (
              await ctx.db
                .query("reviewPanelMembers")
                .withIndex("by_panel_status", (q) =>
                  q.eq("panelId", p._id).eq("status", "active"),
                )
                .take(maximumReviewersPerPanel + 1)
            ).length,
          })),
      ),
    };
  },
});

async function checkPlannedPanel(
  ctx: MutationCtx,
  round: Doc<"reviewRounds">,
  teamId: Id<"teams">,
  panelId: Id<"reviewPanels">,
) {
  const panel = await ctx.db.get(panelId);
  if (
    !panel ||
    panel.eventId !== round.eventId ||
    panel.roundId !== round._id ||
    panel.status === "closed"
  )
    throw new ConvexError({
      code: "PANEL_NOT_FOUND",
      message: "Choose a panel in this round.",
    });
  const members = await ctx.db
    .query("reviewPanelMembers")
    .withIndex("by_panel_status", (q) =>
      q.eq("panelId", panelId).eq("status", "active"),
    )
    .take(maximumReviewersPerPanel + 1);
  if (members.length !== round.requiredPanelSize)
    throw new ConvexError({
      code: "PANEL_INCOMPLETE",
      message: `Fill all ${round.requiredPanelSize} panel seats before assigning projects.`,
    });
  for (const member of members) {
    if (await hasReviewConflict(ctx, round.eventId, member.personId, teamId))
      throw new ConvexError({
        code: "PANEL_CONFLICT",
        message: "A panel member has a conflict with this team.",
      });
  }
}

export const assign = mutation({
  args: {
    eventSlug: v.string(),
    roundId: v.id("reviewRounds"),
    teamId: v.id("teams"),
    panelId: v.id("reviewPanels"),
    backupPanelId: v.optional(v.id("reviewPanels")),
    rationale: v.string(),
    expectedVersion: v.number(),
    expectedRoundVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "round.manage",
      scopeType: "round",
      scopeId: args.roundId,
    });
    const rationale = normalizedText(args.rationale, "Panel fit", 10, 2000);
    const operation = {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.planning.assign",
      requestFingerprint: operationFingerprint([
        args.roundId,
        args.teamId,
        args.panelId,
        args.backupPanelId ?? null,
        rationale,
        args.expectedVersion,
        args.expectedRoundVersion,
      ]),
    };
    const prior = await findOperation(ctx, operation);
    if (prior)
      return {
        version: storedOperationVersion(prior.resultJson, "planned assignment"),
      };
    const [round, team, application, state, current] = await Promise.all([
      ctx.db.get(args.roundId),
      ctx.db.get(args.teamId),
      ctx.db
        .query("applications")
        .withIndex("by_team", (q) => q.eq("teamId", args.teamId))
        .unique(),
      ctx.db
        .query("teamRoundStates")
        .withIndex("by_round_team", (q) =>
          q.eq("roundId", args.roundId).eq("teamId", args.teamId),
        )
        .unique(),
      ctx.db
        .query("reviewTeamPlans")
        .withIndex("by_round_team", (q) =>
          q.eq("roundId", args.roundId).eq("teamId", args.teamId),
        )
        .unique(),
    ]);
    if (
      !round ||
      round.eventId !== event._id ||
      !team ||
      team.eventId !== event._id ||
      team.competitionCategory === "oc" ||
      application?.humanDecision !== "accept" ||
      application.decisionStage !== "released"
    )
      throw new ConvexError({
        code: "TEAM_NOT_ELIGIBLE",
        message: "Choose an accepted competitive team in this event.",
      });
    if (
      !["published", "open"].includes(round.status) ||
      round.version !== args.expectedRoundVersion ||
      (current?.version ?? 0) !== args.expectedVersion
    )
      throw new ConvexError({
        code: "PLAN_CHANGED",
        message:
          "The round or planned assignment changed. Refresh before saving.",
      });
    if (state && state.state !== "unassigned")
      throw new ConvexError({
        code: "TEAM_ALREADY_ROUTED",
        message:
          "This team has entered the review flow. Use its queue move or restore action.",
      });
    if (args.backupPanelId === args.panelId)
      throw new ConvexError({
        code: "DUPLICATE_PANEL",
        message: "Choose a different backup panel.",
      });
    await checkPlannedPanel(ctx, round, team._id, args.panelId);
    if (args.backupPanelId)
      await checkPlannedPanel(ctx, round, team._id, args.backupPanelId);
    const now = Date.now();
    const version = args.expectedVersion + 1;
    const fields = {
      panelId: args.panelId,
      ...(args.backupPanelId ? { backupPanelId: args.backupPanelId } : {}),
      rationale,
      version,
      updatedByPersonId: person._id,
      updatedAt: now,
    };
    const id =
      current?._id ??
      (await ctx.db.insert("reviewTeamPlans", {
        eventId: event._id,
        roundId: round._id,
        teamId: team._id,
        ...fields,
      }));
    if (current)
      await ctx.db.patch(current._id, {
        ...fields,
        backupPanelId: args.backupPanelId,
      });
    await recordOperation(ctx, {
      ...operation,
      targetType: "review_team_plan",
      targetId: id,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "round.manage",
      grantIds,
      scopeType: "round",
      scopeId: round._id,
      action: "review.team_planned",
      targetType: "review_team_plan",
      targetId: id,
      previousSummary: JSON.stringify(
        current ? { panelId: current.panelId, version: current.version } : null,
      ),
      nextSummary: JSON.stringify(fields),
      reason: rationale,
    });
    return { version };
  },
});
