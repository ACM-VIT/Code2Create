/** Typed proposals; confirmation rechecks operator grants and target versions. */

import type { AttentionScopeType } from "../values";

/** Ids are plain strings so detectors stay pure; the sweep resolves them. */
export type AttentionCommand =
  | {
      name: "reviewSubstitutions.startPageChain";
      missingPanelMemberId: string;
      expectedPanelVersion: number;
      reason: string;
    }
  | {
      name: "reviewSubstitutions.markNoShow";
      panelMemberId: string;
      expectedPanelVersion: number;
      expectedClockInVersion: number;
      reason: string;
    }
  | {
      name: "reviewOperations.extendReview";
      reviewSessionId: string;
      expectedVersion: number;
      reason: string;
    }
  | {
      name: "reviewExceptions.resumeTeam";
      teamRoundStateId: string;
      expectedVersion: number;
      reason: string;
    }
  | {
      name: "reviewExceptions.markMissed";
      teamRoundStateId: string;
      expectedVersion: number;
      reason: string;
    }
  | {
      name: "reviewExceptions.moveQueuedTeam";
      teamRoundStateId: string;
      targetPanelId: string;
      expectedVersion: number;
      reason: string;
    };

export type AttentionCommandName = AttentionCommand["name"];

/** Takes command grants from the permission catalog rather than detector data. */
const commandPermissionKeys: Record<AttentionCommandName, string> = {
  "reviewSubstitutions.startPageChain": "review.substitute.page",
  "reviewSubstitutions.markNoShow": "review.reviewer.no_show",
  "reviewOperations.extendReview": "review.timer.extend",
  "reviewExceptions.resumeTeam": "review.queue.resume",
  "reviewExceptions.markMissed": "review.queue.miss",
  "reviewExceptions.moveQueuedTeam": "review.queue.move",
};

export type AttentionProposal = {
  permissionKey: string;
  scopeType: AttentionScopeType;
  scopeId: string;
  expiresAt: number;
  command: AttentionCommand;
};

/** How long a prefilled command stays offered before the desk re-derives it. */
export const attentionProposalLifetimeMs = 10 * 60 * 1_000;

export function proposeCommand(
  command: AttentionCommand,
  scope: { scopeType: AttentionScopeType; scopeId: string },
  now: number,
): AttentionProposal {
  const permissionKey = commandPermissionKeys[command.name];
  return {
    permissionKey,
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    expiresAt: now + attentionProposalLifetimeMs,
    command,
  };
}

/** Every document id a command points at, so the sweep can resolve them all. */
export function commandTargetIds(command: AttentionCommand): readonly string[] {
  switch (command.name) {
    case "reviewSubstitutions.startPageChain":
      return [command.missingPanelMemberId];
    case "reviewSubstitutions.markNoShow":
      return [command.panelMemberId];
    case "reviewOperations.extendReview":
      return [command.reviewSessionId];
    case "reviewExceptions.resumeTeam":
    case "reviewExceptions.markMissed":
      return [command.teamRoundStateId];
    case "reviewExceptions.moveQueuedTeam":
      return [command.teamRoundStateId, command.targetPanelId];
  }
}

export function commandTitle(command: AttentionCommand) {
  switch (command.name) {
    case "reviewSubstitutions.startPageChain":
      return "Page the next eligible substitute";
    case "reviewSubstitutions.markNoShow":
      return "Record a no-show and free the seat";
    case "reviewOperations.extendReview":
      return "Extend this review's timer";
    case "reviewExceptions.resumeTeam":
      return "Take this team off hold";
    case "reviewExceptions.markMissed":
      return "Mark this team missed";
    case "reviewExceptions.moveQueuedTeam":
      return "Move this team to another panel";
  }
}
