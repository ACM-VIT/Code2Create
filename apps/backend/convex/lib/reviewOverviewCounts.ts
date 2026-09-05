import type { Doc, Id } from "../_generated/dataModel";

export function reviewOverviewCounts(args: {
  states: readonly Pick<Doc<"teamRoundStates">, "teamId" | "panelId" | "state">[];
  liveSessions: readonly Pick<Doc<"reviewSessions">, "panelId">[];
  reviewableTeams: readonly Pick<Doc<"teams">, "_id">[];
}) {
  const queuedByPanel = new Map<Id<"reviewPanels">, number>();
  const activeByPanel = new Map<Id<"reviewPanels">, number>();
  const stateTeamIds = new Set<Id<"teams">>();
  const stateCounts = { unassigned: 0, queued: 0, called: 0, inReview: 0, completed: 0, held: 0 };
  for (const state of args.states) {
    stateTeamIds.add(state.teamId);
    switch (state.state) {
      case "unassigned":
        stateCounts.unassigned += 1;
        break;
      case "queued":
        stateCounts.queued += 1;
        if (state.panelId !== undefined) {
          queuedByPanel.set(state.panelId, (queuedByPanel.get(state.panelId) ?? 0) + 1);
        }
        break;
      case "called":
      case "at_table":
        stateCounts.called += 1;
        break;
      case "in_review":
        stateCounts.inReview += 1;
        break;
      case "completed":
        stateCounts.completed += 1;
        break;
      case "held":
        stateCounts.held += 1;
        break;
    }
  }
  for (const team of args.reviewableTeams) {
    if (!stateTeamIds.has(team._id)) stateCounts.unassigned += 1;
  }
  for (const session of args.liveSessions) {
    activeByPanel.set(session.panelId, (activeByPanel.get(session.panelId) ?? 0) + 1);
  }
  return { queuedByPanel, activeByPanel, stateCounts };
}
