import type { ReactNode } from 'react'

import { canLeaveByTeamRule, canLeaveCurrentTeam } from '../../lib/teamLeave'
import { Flower } from './FlowerAvatar'
import { PortalButton } from './PortalButton'
import { PortalError } from './PortalField'
import { PortalScene } from './PortalScene'

export type ChoiceCurrentTeam = {
  id: string
  name: string
  version: number
  activeMemberCount: number
  currentMembershipId: string
  currentRole: 'lead' | 'member'
  canLeave: boolean
}

export type ImportedTeamChoice = {
  id: string
  version: number
  teamName: string
  role: 'lead' | 'member'
  status: 'pending' | 'waiting_for_lead' | 'choice_required'
  assignees: readonly {
    displayName: string
    role: 'lead' | 'member'
    signedIn: boolean
    isYou: boolean
  }[]
}

/**
 * The organisers' roster already lists this person on a team. Usually that
 * lands before they have made one of their own: one card says where they are
 * headed and what is holding it up, and the only decision is whether to go
 * their own way instead. If they somehow already lead or sit on a team here,
 * the two teams stand side by side and each card carries its own answer.
 */
export function ImportedTeamChoiceView({
  header,
  currentTeam,
  importedTeam,
  joining,
  keeping,
  error,
  onJoin,
  onKeep,
}: {
  header: ReactNode
  /** The team they made themselves — absent in the usual, pre-team case. */
  currentTeam?: ChoiceCurrentTeam
  importedTeam: ImportedTeamChoice
  joining: boolean
  keeping: boolean
  error: string | null
  /** Accept the imported team over the current one (two-team case only). */
  onJoin: () => void
  /** Decline the imported team: keep the current one, or go make your own. */
  onKeep: () => void
}) {
  const busy = joining || keeping
  const importedLead = importedTeam.assignees.find((assignee) => assignee.role === 'lead')
  const leadName = importedLead?.displayName.split(/\s+/)[0] ?? 'your lead'
  const listedAs = importedTeam.role === 'lead' ? 'the lead' : 'a member'
  const arrival =
    importedTeam.role === 'lead'
      ? 'The team forms around you as soon as you continue.'
      : importedLead && !importedLead.signedIn
        ? `You’ll join automatically once ${leadName} signs in.`
        : 'You’ll join automatically in a moment.'

  if (!currentTeam) {
    return (
      <PortalScene tree="both" header={header}>
        <div className="flex w-full max-w-[640px] flex-col items-center text-center">
          <h1 className="mb-3 font-display font-light tracking-[-.01em] text-balance text-3xl text-shadow-[0_4px_30px_var(--scene-text-glow)] lg:text-[42px]">
            You’re already on a team.
          </h1>
          <p className="mb-7 max-w-[480px] text-[13px] leading-relaxed text-fg/60">
            The organisers’ roster lists you on{' '}
            <span className="text-fg/90">{importedTeam.teamName}</span> as {listedAs}.
          </p>

          <TeamChoiceCard
            name={importedTeam.teamName}
            meta={arrival}
            seed={`${importedTeam.id}:imported`}
            lead={importedTeam.role === 'lead'}
            assignees={importedTeam.assignees}
            action={
              <PortalButton type="button" size="sm" className="w-full" disabled={busy} onClick={onKeep}>
                {keeping ? 'Leaving…' : 'Find my own team instead'}
              </PortalButton>
            }
          />

          <PortalError message={error} />
        </div>
      </PortalScene>
    )
  }

  const canLeave = canLeaveCurrentTeam(currentTeam)
  const mustTransferLeadership = currentTeam.canLeave && !canLeaveByTeamRule(currentTeam)
  const joinBlocked = mustTransferLeadership
    ? `You lead ${currentTeam.name} and others are still on it — hand the lead to someone first.`
    : !currentTeam.canLeave
      ? `You can’t leave ${currentTeam.name} right now. Keep it, or ask the event team.`
      : null
  const people = currentTeam.activeMemberCount

  return (
    <PortalScene tree="both" header={header}>
      <div className="flex w-full max-w-[640px] flex-col items-center text-center">
        <h1 className="mb-3 font-display font-light tracking-[-.01em] text-3xl text-shadow-[0_4px_30px_var(--scene-text-glow)] lg:text-[42px]">
          Which team is yours?
        </h1>
        <p className="mb-7 max-w-[480px] text-[13px] leading-relaxed text-fg/60">
          You made <span className="text-fg/90">{currentTeam.name}</span>, and the organisers’
          roster lists you on <span className="text-fg/90">{importedTeam.teamName}</span>.
        </p>

        <div className="grid w-full grid-cols-1 gap-3.5 sm:grid-cols-2 sm:gap-4">
          <TeamChoiceCard
            name={currentTeam.name}
            meta={`${people} ${people === 1 ? 'person' : 'people'} · you’re ${currentTeam.currentRole === 'lead' ? 'the lead' : 'a member'}`}
            seed={currentTeam.currentMembershipId}
            lead={currentTeam.currentRole === 'lead'}
            action={
              <PortalButton type="button" size="sm" className="w-full" disabled={busy} onClick={onKeep}>
                {keeping ? 'Keeping…' : `Keep ${currentTeam.name}`}
              </PortalButton>
            }
          />
          <TeamChoiceCard
            name={importedTeam.teamName}
            meta={`you’re listed as ${listedAs}`}
            seed={`${importedTeam.id}:imported`}
            lead={importedTeam.role === 'lead'}
            assignees={importedTeam.assignees}
            note={joinBlocked}
            noteTone="rose"
            action={
              <PortalButton
                type="button"
                size="sm"
                variant="solid"
                className="w-full"
                disabled={busy || !canLeave}
                onClick={onJoin}
              >
                {joining ? 'Joining…' : `Join ${importedTeam.teamName}`}
              </PortalButton>
            }
          />
        </div>

        <PortalError message={error} />
      </div>
    </PortalScene>
  )
}

function TeamChoiceCard({
  name,
  meta,
  seed,
  lead,
  assignees = [],
  note = null,
  noteTone = 'muted',
  action,
}: {
  name: string
  meta: string
  seed: string
  lead: boolean
  assignees?: ImportedTeamChoice['assignees']
  note?: string | null
  noteTone?: 'muted' | 'rose'
  action: ReactNode
}) {
  return (
    <section className="flex flex-col rounded-petal-sm glass-tile px-5 py-5 text-left">
      <div className="flex items-center gap-3.5">
        <span
          className={`flex size-11 flex-none items-center justify-center rounded-full ${
            lead
              ? 'border-2 border-ring-lead bg-avatar-lead shadow-[0_0_16px_var(--avatar-glow)]'
              : 'border-2 border-rose/70 bg-avatar'
          }`}
        >
          <Flower seed={seed} lead={lead} className="size-[62%]" />
        </span>
        <div className="min-w-0">
          <p className="m-0 truncate font-display font-light tracking-[-.01em] text-[21px] text-fg/90">
            {name}
          </p>
          <p className="m-0 mt-0.5 text-[12px] text-fg/55">{meta}</p>
        </div>
      </div>

      {assignees.length > 0 ? (
        <ul className="m-0 mt-4 list-none border-t border-petal-line p-0 pt-2">
          {assignees.slice(0, 4).map((assignee, index) => (
            <li
              key={`${assignee.role}:${assignee.displayName}:${index}`}
              className="flex items-center justify-between gap-3 py-1.5"
            >
              <span className={`min-w-0 truncate text-[12.5px] ${assignee.isYou ? 'text-rose-light' : 'text-fg/80'}`}>
                {assignee.displayName}
              </span>
              <span className="flex-none text-[10.5px] text-fg/45">
                {[
                  assignee.role === 'lead' ? 'lead' : null,
                  assignee.isYou ? 'you' : assignee.signedIn ? null : 'not signed in yet',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-auto pt-5">
        {action}
        {note ? (
          <p
            className={`m-0 mt-2.5 text-[11.5px] leading-relaxed ${
              noteTone === 'rose' ? 'text-rose-light' : 'text-fg/50'
            }`}
          >
            {note}
          </p>
        ) : null}
      </div>
    </section>
  )
}
