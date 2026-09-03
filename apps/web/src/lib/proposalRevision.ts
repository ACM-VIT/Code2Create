import type { VersionedSessionDraft } from "./sessionDraft";

export type ProposalRevisionBase<ProjectVersionId extends string = string> = {
  applicationContentVersion: number;
  projectVersionId: ProjectVersionId;
  projectVersion: number;
};

export function proposalRevisionBase<ProjectVersionId extends string>(
  application: { contentVersion: number },
  project: { id: ProjectVersionId; version: number },
): ProposalRevisionBase<ProjectVersionId> {
  return {
    applicationContentVersion: application.contentVersion,
    projectVersionId: project.id,
    projectVersion: project.version,
  };
}

export function proposalRevisionBaseFingerprint(base: ProposalRevisionBase) {
  return [base.applicationContentVersion, base.projectVersionId, base.projectVersion].join(":");
}

function normalizedProposalText(value: string) {
  return value.trim().replace(/\r\n/g, "\n");
}

export function proposalRevisionRegeneratesQuestions(args: {
  savedIdea: string;
  nextIdea: string;
  savedResponses: readonly { ordinal: number; answer: string }[];
  nextResponses: readonly { answer: string }[];
  deterministicFollowUpCount: number;
  maximumFollowUpCount: number;
}) {
  if (
    normalizedProposalText(args.savedIdea) !== normalizedProposalText(args.nextIdea) &&
    args.deterministicFollowUpCount < args.maximumFollowUpCount
  ) {
    return true;
  }
  return args.savedResponses.some((response, index) => {
    const next = args.nextResponses[index];
    return (
      next !== undefined &&
      normalizedProposalText(response.answer) !== normalizedProposalText(next.answer) &&
      Math.max(response.ordinal, args.deterministicFollowUpCount) < args.maximumFollowUpCount
    );
  });
}

export function recoverProposalRevision(
  savedAnswer: string,
  currentDraftVersion: number,
  stored: VersionedSessionDraft | null,
) {
  if (stored === null || stored.value === savedAnswer) {
    return {
      answer: savedAnswer,
      baseDraftVersion: currentDraftVersion,
      recovered: false,
    };
  }
  const baseDraftVersion = Number(stored.base);
  if (!Number.isSafeInteger(baseDraftVersion) || baseDraftVersion < 0) {
    return {
      answer: savedAnswer,
      baseDraftVersion: currentDraftVersion,
      recovered: false,
    };
  }
  return {
    answer: stored.value,
    baseDraftVersion,
    recovered: true,
  };
}
