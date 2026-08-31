import type { VersionedSessionDraft } from './sessionDraft'

export type ProposalRevisionBase<ProjectVersionId extends string = string> = {
  applicationContentVersion: number
  projectVersionId: ProjectVersionId
  projectVersion: number
}

export function proposalRevisionBase<ProjectVersionId extends string>(
  application: { contentVersion: number },
  project: { id: ProjectVersionId; version: number },
): ProposalRevisionBase<ProjectVersionId> {
  return {
    applicationContentVersion: application.contentVersion,
    projectVersionId: project.id,
    projectVersion: project.version,
  }
}

export function proposalRevisionBaseFingerprint(base: ProposalRevisionBase) {
  return [
    base.applicationContentVersion,
    base.projectVersionId,
    base.projectVersion,
  ].join(':')
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
    }
  }
  const baseDraftVersion = Number(stored.base)
  if (!Number.isSafeInteger(baseDraftVersion) || baseDraftVersion < 0) {
    return {
      answer: savedAnswer,
      baseDraftVersion: currentDraftVersion,
      recovered: false,
    }
  }
  return {
    answer: stored.value,
    baseDraftVersion,
    recovered: true,
  }
}
