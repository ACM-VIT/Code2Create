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
