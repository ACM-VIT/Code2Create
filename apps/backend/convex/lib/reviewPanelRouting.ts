import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { matchingPermissionGrantIds } from "./permissions";
import { reviewerConfirmedForReview } from "./reviewConfirmation";
import {
  maximumReviewPanelsPerRound,
  maximumReviewersPerPanel,
} from "./reviewLimits";
import { queuedTeamCount } from "./reviewQueueProjection";
import { observedPace } from "./queueEstimate";

export type ReviewPanelRoute = {
  panel: Doc<"reviewPanels">;
  matchedDomains: string[];
  estimatedWaitSeconds: number;
};
function domainText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, " ")
    .trim();
}
export function matchingReviewDomains(
  project: string,
  domains: readonly string[],
) {
  const source = ` ${domainText(project)} `;
  return [
    ...new Set(
      domains
        .map(domainText)
        .filter((domain) => domain && source.includes(` ${domain} `)),
    ),
  ].sort();
}
export function rankReviewPanelRoutes<
  T extends {
    matchedDomains: readonly string[];
    estimatedWaitSeconds: number;
    id: string;
  },
>(routes: readonly T[], preference: "skills_then_wait" | "shortest_wait") {
  return [...routes].sort(
    (a, b) =>
      (preference === "skills_then_wait"
        ? b.matchedDomains.length - a.matchedDomains.length
        : 0) ||
      a.estimatedWaitSeconds - b.estimatedWaitSeconds ||
      a.id.localeCompare(b.id),
  );
}

/** Staff still admit a walk-up team; this only selects a currently eligible panel in that transaction. */
export async function routeReviewTeam(
  ctx: MutationCtx,
  round: Doc<"reviewRounds">,
  team: Doc<"teams">,
  subject: Doc<"eventAccessSubjects">,
): Promise<ReviewPanelRoute | undefined> {
  const [panels, criteria, project, repositories, policy] = await Promise.all([
    ctx.db
      .query("reviewPanels")
      .withIndex("by_round_status", (q) =>
        q.eq("roundId", round._id).eq("status", "ready"),
      )
      .take(maximumReviewPanelsPerRound + 1),
    ctx.db
      .query("reviewRubricCriteria")
      .withIndex("by_rubric_order", (q) =>
        q.eq("rubricVersionId", round.rubricVersionId),
      )
      .take(21),
    team.lockedProjectVersionId
      ? ctx.db.get(team.lockedProjectVersionId)
      : null,
    ctx.db
      .query("githubRepositoryBindings")
      .withIndex("by_team_state", (q) => q.eq("teamId", team._id))
      .collect(),
    ctx.db
      .query("reviewQueuePolicies")
      .withIndex("by_round", (q) => q.eq("roundId", round._id))
      .unique(),
  ]);
  if (panels.length > maximumReviewPanelsPerRound || criteria.length > 20)
    throw new Error("Review configuration limit exceeded.");
  if (
    !project ||
    project.teamId !== team._id ||
    project.eventId !== round.eventId
  )
    throw new Error("Review project unavailable.");
  const repositoryText = await Promise.all(
    repositories
      .filter((repository) => repository.state !== "archived")
      .map(async (repository) => {
        const snapshot = await ctx.db
          .query("githubRepositorySnapshots")
          .withIndex("by_binding_time", (q) =>
            q.eq("repositoryBindingId", repository._id),
          )
          .order("desc")
          .first();
        return `${repository.purpose} ${repository.kind} ${snapshot?.languageBytes.map((language) => language.language).join(" ") ?? ""}`;
      }),
  );
  const text = [
    project.initialIdea,
    ...project.intakeResponses.map((response) => response.answer),
    ...repositoryText,
  ].join(" ");
  const now = Date.now();
  const routes = await Promise.all(
    panels.map(async (panel) => {
      if (
        !(
          await matchingPermissionGrantIds(ctx, {
            eventId: round.eventId,
            eventAccessSubjectId: subject._id,
            permissionKey: "queue.manage",
            scopeType: "panel",
            scopeId: panel._id,
          })
        ).length
      )
        return null;
      const members = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (q) =>
          q.eq("panelId", panel._id).eq("status", "active"),
        )
        .take(maximumReviewersPerPanel + 1);
      if (
        members.length !== round.requiredPanelSize ||
        criteria.some(
          (criterion) =>
            members.filter((member) =>
              member.assignedCriterionIds.includes(criterion._id),
            ).length < round.minimumScorersPerCriterion,
        )
      )
        return null;
      const profiles = await Promise.all(
        members.map(async (member) => {
          const [profile, clock, conflict] = await Promise.all([
            ctx.db
              .query("reviewerProfiles")
              .withIndex("by_event_person", (q) =>
                q.eq("eventId", round.eventId).eq("personId", member.personId),
              )
              .unique(),
            ctx.db
              .query("reviewerClockIns")
              .withIndex("by_round_person", (q) =>
                q
                  .eq("roundId", round._id)
                  .eq("reviewerPersonId", member.personId),
              )
              .unique(),
            ctx.db
              .query("reviewerConflicts")
              .withIndex("by_reviewer_team_status", (q) =>
                q
                  .eq("reviewerPersonId", member.personId)
                  .eq("teamId", team._id)
                  .eq("status", "active"),
              )
              .first(),
          ]);
          if (
            !profile ||
            profile.status !== "active" ||
            profile.trainingStatus !== "complete" ||
            clock?.status !== "present" ||
            conflict ||
            !(await reviewerConfirmedForReview(
              ctx,
              round,
              member.personId,
              now,
            ))
          )
            return null;
          return profile;
        }),
      );
      if (profiles.some((profile) => profile === null)) return null;
      const [queued, completed, live] = await Promise.all([
        queuedTeamCount(ctx, panel._id),
        ctx.db
          .query("reviewSessions")
          .withIndex("by_panel_status", (q) =>
            q.eq("panelId", panel._id).eq("status", "completed"),
          )
          .order("desc")
          .take(9),
        Promise.all(
          (["awaiting_presence", "active", "scoring"] as const).map((status) =>
            ctx.db
              .query("reviewSessions")
              .withIndex("by_panel_status", (q) =>
                q.eq("panelId", panel._id).eq("status", status),
              )
              .unique(),
          ),
        ),
      ]);
      const pace = observedPace(
        round.reviewDurationSeconds + (policy?.scoringBufferSeconds ?? 90),
        completed.flatMap((session) =>
          session.startedAt !== undefined && session.completedAt !== undefined
            ? [(session.completedAt - session.startedAt) / 1000]
            : [],
        ),
      ).paceSeconds;
      const current = live.find((session) => session !== null);
      const remaining = current
        ? Math.max(
            pace * 0.35,
            current.plannedEndAt === undefined
              ? pace
              : (current.plannedEndAt - now) / 1000 +
                  (policy?.scoringBufferSeconds ?? 90),
          )
        : 0;
      return {
        id: panel._id,
        panel,
        matchedDomains: matchingReviewDomains(
          text,
          profiles.flatMap((profile) =>
            profile
              ? [
                  ...profile.technicalDomains,
                  ...profile.productDomains,
                  ...profile.languages,
                ]
              : [],
          ),
        ),
        estimatedWaitSeconds: Math.round(queued * pace + remaining),
      };
    }),
  );
  return rankReviewPanelRoutes(
    routes.filter((route) => route !== null),
    policy?.routingPreference ?? "skills_then_wait",
  )[0];
}
