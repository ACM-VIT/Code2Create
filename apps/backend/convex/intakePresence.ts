import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { currentReadTeamContext, currentTeamContext } from "./intake";
import { applicationsCloseAtFor, requireRegistrationOpen } from "./lib/events";
import { requireCurrentPerson } from "./lib/identity";
import {
  intakeEditingPresence,
  intakeEditingRoomId,
  maximumIntakeEditors,
  type IntakeEditingSurface,
} from "./lib/intakeEditingPresence";
import { requirePermission } from "./lib/permissions";

const editingSurface = v.union(
  v.literal("idea"),
  v.literal("follow_up"),
  v.literal("proposal_revision"),
);
type EditingSurface = IntakeEditingSurface;

const heartbeatIntervalMs = 4_000;

async function requireEditingTarget(
  ctx: MutationCtx,
  args: {
    teamId: Id<"teams">;
    surface: EditingSurface;
    questionId?: Id<"intakeGeneratedQuestions">;
  },
) {
  if (args.surface === "idea") {
    if (args.questionId !== undefined) {
      throw new ConvexError({
        code: "INVALID_EDITING_TARGET",
        message: "The idea editor cannot target a follow-up question.",
      });
    }
    return;
  }
  if (args.surface === "follow_up") {
    if (args.questionId === undefined) {
      throw new ConvexError({
        code: "INVALID_EDITING_TARGET",
        message: "The follow-up editor requires its exact question.",
      });
    }
    const question = await ctx.db.get(args.questionId);
    if (
      !question ||
      question.teamId !== args.teamId ||
      (question.state !== "active" && question.state !== "answered")
    ) {
      throw new ConvexError({
        code: "INVALID_EDITING_TARGET",
        message: "That follow-up is no longer editable.",
      });
    }
    return;
  }
  if (args.questionId === undefined) return;
  const application = await ctx.db
    .query("applications")
    .withIndex("by_team", (index) => index.eq("teamId", args.teamId))
    .unique();
  const project = application
    ? await ctx.db.get(application.submittedProjectVersionId)
    : null;
  if (!project?.intakeResponses.some(({ questionId }) => questionId === args.questionId)) {
    throw new ConvexError({
      code: "INVALID_EDITING_TARGET",
      message: "That submitted follow-up is no longer editable.",
    });
  }
}

export const heartbeat = mutation({
  args: {
    eventSlug: v.string(),
    surface: editingSurface,
    questionId: v.optional(v.id("intakeGeneratedQuestions")),
    sessionId: v.string(),
  },
  returns: v.object({
    roomToken: v.string(),
    sessionToken: v.string(),
  }),
  handler: async (ctx, args) => {
    const { event, subject, membership, member, team } =
      await currentTeamContext(ctx, args.eventSlug);
    await requireEditingTarget(ctx, {
      teamId: team._id,
      surface: args.surface,
      ...(args.questionId !== undefined ? { questionId: args.questionId } : {}),
    });
    if (args.surface === "proposal_revision") {
      if (
        Date.now() >= applicationsCloseAtFor(event, membership.participantClass)
      ) {
        throw new ConvexError({
          code: "APPLICATION_DEADLINE_PASSED",
          message: "The application deadline has passed.",
        });
      }
      if (
        member.role !== "lead" ||
        team.leadMembershipId !== membership._id
      ) {
        throw new ConvexError({
          code: "TEAM_LEAD_REQUIRED",
          message: "Only the current team lead can edit the submitted proposal.",
        });
      }
      await requirePermission(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "application.submit",
        scopeType: "team",
        scopeId: team._id,
      });
      const application = await ctx.db
        .query("applications")
        .withIndex("by_team", (index) => index.eq("teamId", team._id))
        .unique();
      if (!application || !["submitted", "under_review"].includes(application.state)) {
        throw new ConvexError({
          code: "APPLICATION_NOT_EDITABLE",
          message: "This application can no longer be edited.",
        });
      }
    } else {
      requireRegistrationOpen(event, membership.participantClass);
      const application = await ctx.db
        .query("applications")
        .withIndex("by_team", (index) => index.eq("teamId", team._id))
        .unique();
      if (application) {
        throw new ConvexError({
          code: "APPLICATION_ALREADY_SUBMITTED",
          message: "This application has been submitted. Edit its current proposal instead.",
        });
      }
      if (team.membershipLocked) {
        throw new ConvexError({
          code: "SUBMISSION_LOCKED",
          message: "This team has submitted and the project intake is locked.",
        });
      }
    }
    return intakeEditingPresence.heartbeat(
      ctx,
      intakeEditingRoomId(team._id, args.surface, args.questionId),
      membership._id,
      args.sessionId,
      heartbeatIntervalMs,
    );
  },
});

export const list = query({
  args: { eventSlug: v.string() },
  returns: v.array(v.object({
    membershipId: v.id("eventMemberships"),
    surface: editingSurface,
    questionId: v.optional(v.id("intakeGeneratedQuestions")),
    label: v.string(),
  })),
  handler: async (ctx, args) => {
    const context = await currentReadTeamContext(ctx, args.eventSlug);
    if (!context) return [];
    const [draft, application] = await Promise.all([
      ctx.db
        .query("projectDrafts")
        .withIndex("by_team", (index) => index.eq("teamId", context.team._id))
        .unique(),
      ctx.db
        .query("applications")
        .withIndex("by_team", (index) => index.eq("teamId", context.team._id))
        .unique(),
    ]);
    const [activeQuestions, answeredQuestions] = draft
      ? await Promise.all([
          ctx.db
            .query("intakeGeneratedQuestions")
            .withIndex("by_draft_state_ordinal", (index) =>
              index.eq("draftId", draft._id).eq("state", "active"),
            )
            .take(2),
          ctx.db
            .query("intakeGeneratedQuestions")
            .withIndex("by_draft_state_ordinal", (index) =>
              index.eq("draftId", draft._id).eq("state", "answered"),
            )
            .take(2),
        ])
      : [[], []];
    const draftQuestions = [...activeQuestions, ...answeredQuestions]
      .toSorted((left, right) => left.ordinal - right.ordinal);
    const project = application
      ? await ctx.db.get(application.submittedProjectVersionId)
      : null;
    const targets: {
      surface: EditingSurface;
      questionId?: Id<"intakeGeneratedQuestions">;
      label: string;
    }[] = [
      { surface: "idea", label: "the idea" },
      ...draftQuestions.map((question) => ({
        surface: "follow_up" as const,
        questionId: question._id,
        label: question.text,
      })),
      ...(project
        ? [
            { surface: "proposal_revision" as const, label: "the idea" },
            ...project.intakeResponses.map((response) => ({
              surface: "proposal_revision" as const,
              questionId: response.questionId,
              label: response.question,
            })),
          ]
        : []),
    ];
    const byTarget = await Promise.all(targets.map(async (target) => ({
      ...target,
      members: await intakeEditingPresence.listRoom(
        ctx,
        intakeEditingRoomId(context.team._id, target.surface, target.questionId),
        true,
        maximumIntakeEditors,
      ),
    })));
    return byTarget.flatMap(({ surface, questionId, label, members }) =>
      members
        .filter(({ userId }) => userId !== context.member.membershipId)
        .map(({ userId }) => ({
          membershipId: userId,
          surface,
          ...(questionId !== undefined ? { questionId } : {}),
          label,
        })),
    );
  },
});

export const disconnect = mutation({
  args: { sessionToken: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireCurrentPerson(ctx);
    return intakeEditingPresence.disconnect(ctx, args.sessionToken);
  },
});
