import { api } from '@code2create/backend/api'
import { useQuery } from 'convex/react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { GpuSky } from '../components/portal/GpuSky'
import { LiveTeamCluster } from '../components/portal/LiveTeamCluster'
import { Petal } from '../components/portal/Petal'
import { PortalButton } from '../components/portal/PortalButton'
import { PortalScene } from '../components/portal/PortalScene'
import { eventSlug } from '../lib/config'
import type { CurrentTeam, CurrentTeamMember } from '../types'

// The five-petal journey the mockup counts through: idea, two follow-ups,
// review, submit.
const JOURNEY_STAGES = 5

function journeyState(draft: { stage: string; followUps: readonly { state: string }[] } | null) {
  if (!draft || draft.stage === 'opening') {
    return { current: 0, headline: 'Start with the idea.', action: 'Write it' }
  }
  if (draft.stage === 'follow_up') {
    const answered = draft.followUps.filter((followUp) => followUp.state !== 'active').length
    const remaining = Math.max(2 - answered, 1)
    return {
      current: 1 + answered,
      headline: remaining === 1 ? 'One answer left.' : `${remaining} answers left.`,
      action: 'Answer it',
    }
  }
  return { current: 3, headline: 'Read it together.', action: 'Open the review' }
}

const STAGE_WORDS = ['one', 'two', 'three', 'four', 'five']

function BottomCard({
  label,
  children,
  grow = false,
}: {
  label: string
  children: React.ReactNode
  grow?: boolean
}) {
  return (
    <div
      className={`rounded-petal-sm border border-[rgb(254_180_203/.45)] bg-[linear-gradient(155deg,rgba(255,255,255,.07),rgba(12,0,4,.48)_60%)] px-5 py-4 backdrop-blur-[10px] ${
        grow ? 'flex-[1.4]' : 'flex-1'
      }`}
    >
      <p className="mb-[5px] text-[10.5px] font-semibold tracking-[.14em] text-[rgb(248_248_248/.5)] uppercase">
        {label}
      </p>
      {children}
    </div>
  )
}

/**
 * Mockup f1: the home stage while the proposal is being written. A live sky,
 * one headline for what's left, and three quiet cards along the bottom.
 */
export function HomeScreen({
  team,
  members,
  onSignOut,
}: {
  team: CurrentTeam
  members: CurrentTeamMember[]
  onSignOut: () => void
}) {
  const navigate = useNavigate()
  const intake = useQuery(api.intake.current, { eventSlug })

  // Snapshotted once per mount: a day-level countdown doesn't need a ticker.
  const [now] = useState(() => Date.now())
  const draft = intake?.draft ?? null
  const journey = journeyState(draft)
  const daysLeft = intake
    ? Math.max(0, Math.ceil((intake.applicationsCloseAt - now) / 86_400_000))
    : null

  return (
    <PortalScene
      tree="left"
      backdrop={<GpuSky />}
      header={<LiveTeamCluster team={team} members={members} onSignOut={onSignOut} />}
    >
      <div className="flex w-full max-w-[1048px] flex-1 flex-col justify-center pb-40">
        <div className="max-w-[600px]">
          <p className="mb-3 font-ui text-lg text-rose-light text-shadow-[0_2px_14px_rgba(0,0,0,.6)]">
            stage {STAGE_WORDS[journey.current] ?? 'one'} of {STAGE_WORDS[JOURNEY_STAGES - 1]}
          </p>
          <h1 className="mb-8 font-display font-light tracking-[-.01em] text-5xl leading-none text-shadow-[0_8px_50px_rgba(0,0,0,.6)] lg:text-7xl">
            {journey.headline}
          </h1>
          <PortalButton type="button" onClick={() => navigate('/write')}>
            {journey.action}
          </PortalButton>
        </div>
      </div>

      <div className="absolute inset-x-5 bottom-8 z-[3] flex flex-col gap-3 sm:flex-row sm:gap-[18px] lg:inset-x-24 lg:bottom-14">
        <BottomCard label="deadline">
          <p className="m-0 font-display font-light tracking-[-.01em] text-[26px] text-rose-light">
            {daysLeft ?? '·'} <span className="text-sm">{daysLeft === 1 ? 'day' : 'days'}</span>
          </p>
        </BottomCard>
        <BottomCard label="journey">
          <div className="flex gap-1.5 pt-1.5">
            {Array.from({ length: JOURNEY_STAGES }, (_, index) => (
              <Petal
                key={index}
                state={
                  index < journey.current ? 'done' : index === journey.current ? 'current' : 'todo'
                }
              />
            ))}
          </div>
        </BottomCard>
        <BottomCard label="editable until" grow>
          <p className="m-0 font-ui text-[14.5px] text-paper">
            {intake
              ? new Date(intake.applicationsCloseAt).toLocaleString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })
              : '—'}
            <span className="ml-2 text-[10.5px] font-semibold tracking-[.14em] text-[rgb(248_248_248/.5)] uppercase">
              writing stays open after submit
            </span>
          </p>
        </BottomCard>
      </div>
    </PortalScene>
  )
}
