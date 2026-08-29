import type { EditingSurface } from '../hooks/useEditingPresence'
import type { CurrentTeamMember } from '../types'

type Editor = {
  membershipId: CurrentTeamMember['membershipId']
  surface: EditingSurface
}

export function EditingPresence({
  editors,
  members,
}: {
  editors: readonly Editor[]
  members: readonly CurrentTeamMember[]
}) {
  if (editors.length === 0) return null

  const names = editors.map((editor) => (
    members.find((member) => member.membershipId === editor.membershipId)?.displayName ??
    'A teammate'
  ))
  const uniqueNames = [...new Set(names)]
  const subject = uniqueNames.length === 1
    ? uniqueNames[0]
    : uniqueNames.length === 2
      ? `${uniqueNames[0]} and ${uniqueNames[1]}`
      : `${uniqueNames[0]} and ${uniqueNames.length - 1} others`
  const sharedSurface = editors.every(
    (editor) => editor.surface === editors[0]?.surface,
  )
    ? editors[0]?.surface
    : null
  const action = sharedSurface === 'idea'
    ? 'editing the idea'
    : sharedSurface === 'follow_up'
      ? 'answering a question'
      : sharedSurface === 'proposal_revision'
        ? 'updating the proposal'
        : 'editing the proposal'

  return (
    <p className="editing-presence" role="status" aria-live="polite">
      <span aria-hidden="true" />
      {subject} {uniqueNames.length === 1 ? 'is' : 'are'} {action}…
    </p>
  )
}
