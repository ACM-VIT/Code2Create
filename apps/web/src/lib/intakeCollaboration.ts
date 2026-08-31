export function shouldRecoverFollowUpDraft(args: {
  answer: string
  currentMembershipId: string
  lastEditedByMembershipId: string | undefined
  nextQuestionId: string | null
  priorQuestionId: string | null
}) {
  return (
    args.priorQuestionId !== null &&
    args.priorQuestionId !== args.nextQuestionId &&
    args.answer.trim().length > 0 &&
    args.lastEditedByMembershipId !== undefined &&
    args.lastEditedByMembershipId !== args.currentMembershipId
  )
}

export type WorkingCopyReconciliation =
  | { kind: 'unchanged' }
  | { kind: 'acknowledge'; revision: number }
  | { kind: 'continue'; revision: number }
  | { kind: 'adopt'; dirty: boolean; revision: number; value: string }
  | { kind: 'conflict' }

export function reconcileWorkingCopy(args: {
  confirmedValue: string
  knownRevision: number
  localDirty: boolean
  localValue: string
  pendingValue: string | null
  serverRevision: number
  serverValue: string
}): WorkingCopyReconciliation {
  if (args.serverRevision === args.knownRevision) return { kind: 'unchanged' }
  if (!args.localDirty) {
    return {
      kind: 'adopt',
      dirty: args.serverValue !== args.confirmedValue,
      revision: args.serverRevision,
      value: args.serverValue,
    }
  }
  if (args.serverValue === args.localValue) {
    return { kind: 'acknowledge', revision: args.serverRevision }
  }
  if (args.serverValue === args.pendingValue) {
    return { kind: 'continue', revision: args.serverRevision }
  }
  return { kind: 'conflict' }
}
