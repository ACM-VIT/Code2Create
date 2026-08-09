/**
 * The closed set of commands an attention item may propose.
 *
 * A proposal is data, never authority. Confirming one opens the ordinary
 * mutation named here, which rechecks the confirming human's grant, scope,
 * reason, operation ID, and the target version carried below. Nothing in this
 * file executes anything.
 *
 * The shapes are a union rather than a serialised argument blob because there
 * are six of them and they never change without the mutation changing: keeping
 * them typed end to end means a detector cannot prefill an argument the command
 * does not take, and the operations client can dispatch without guessing.
 *
 * `eventSlug` and `clientOperationId` are deliberately absent. The confirming
 * client already knows its event and mints its own operation ID, so putting
 * them here would only create two places for them to disagree.
 */

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

/**
 * The grant each command actually requires, taken from the permission catalog
 * rather than restated by each detector, so a row can never offer a command
 * under the wrong authority.
 */
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

/** What the confirmation panel calls the command, in an operator's words. */
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
