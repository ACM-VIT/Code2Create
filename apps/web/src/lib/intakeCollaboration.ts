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
