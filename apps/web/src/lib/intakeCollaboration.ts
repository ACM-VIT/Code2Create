import { convexErrorCode } from "./errors.ts";

const collaborationConflictCodes = new Set([
  "DRAFT_CHANGED",
  "FOLLOW_UP_CHANGED",
  "WORKING_FIELD_CHANGED",
]);

export function isIntakeCollaborationConflict(error: unknown) {
  const code = convexErrorCode(error);
  return code !== null && collaborationConflictCodes.has(code);
}

export type CommittedFieldReconciliation =
  | { kind: "unchanged" }
  | { kind: "rebase"; version: number }
  | { kind: "acknowledge"; version: number }
  | { kind: "conflict" };

export function reconcileCommittedField(args: {
  baseVersion: number;
  baseValue: string;
  localValue: string;
  serverVersion: number;
  serverValue: string;
}): CommittedFieldReconciliation {
  if (args.serverVersion === args.baseVersion) return { kind: "unchanged" };
  if (args.serverValue === args.baseValue) {
    return { kind: "rebase", version: args.serverVersion };
  }
  if (args.serverValue === args.localValue) {
    return { kind: "acknowledge", version: args.serverVersion };
  }
  return { kind: "conflict" };
}

export function shouldRecoverFollowUpDraft(args: {
  answer: string;
  currentMembershipId: string;
  lastEditedByMembershipId: string | undefined;
  nextQuestionId: string | null;
  priorQuestionId: string | null;
}) {
  return (
    args.priorQuestionId !== null &&
    args.priorQuestionId !== args.nextQuestionId &&
    args.answer.trim().length > 0 &&
    args.lastEditedByMembershipId !== undefined &&
    args.lastEditedByMembershipId !== args.currentMembershipId
  );
}

export function shouldReplaceFollowUpEditorValue(
  currentQuestionId: string | null,
  nextQuestionId: string | null,
) {
  return currentQuestionId !== nextQuestionId;
}

export function nextReviewQuestionId(
  questionIds: readonly string[],
  currentQuestionId: string | null,
) {
  if (currentQuestionId === null) return questionIds[0] ?? null;
  const currentIndex = questionIds.indexOf(currentQuestionId);
  if (currentIndex < 0) return null;
  return questionIds[currentIndex + 1] ?? null;
}

export function firstReviewQuestionAfterIdeaSave(args: {
  questionIds: readonly string[];
  reviewSequenceActive: boolean;
  savedDraftVersion: number;
  submittedDraftVersion: number;
}) {
  if (!args.reviewSequenceActive || args.savedDraftVersion !== args.submittedDraftVersion)
    return null;
  return nextReviewQuestionId(args.questionIds, null);
}

export function nextReviewQuestionAfterAnswerSave(args: {
  currentQuestionId: string;
  questionIds: readonly string[];
  reviewSequenceActive: boolean;
  savedDraftVersion: number;
  submittedDraftVersion: number;
}) {
  if (!args.reviewSequenceActive || args.savedDraftVersion !== args.submittedDraftVersion)
    return null;
  return nextReviewQuestionId(args.questionIds, args.currentQuestionId);
}

export type WorkingCopyReconciliation =
  | { kind: "unchanged" }
  | { kind: "acknowledge"; revision: number }
  | { kind: "continue"; revision: number }
  | { kind: "adopt"; revision: number; value: string }
  | { kind: "conflict" };

export function reconcileWorkingCopy(args: {
  knownRevision: number;
  localDirty: boolean;
  localValue: string;
  pendingValue: string | null;
  serverRevision: number;
  serverValue: string;
}): WorkingCopyReconciliation {
  if (args.serverRevision === args.knownRevision) return { kind: "unchanged" };
  if (!args.localDirty) {
    return {
      kind: "adopt",
      revision: args.serverRevision,
      value: args.serverValue,
    };
  }
  if (args.serverValue === args.localValue) {
    return { kind: "acknowledge", revision: args.serverRevision };
  }
  if (args.serverValue === args.pendingValue) {
    return { kind: "continue", revision: args.serverRevision };
  }
  return { kind: "conflict" };
}
