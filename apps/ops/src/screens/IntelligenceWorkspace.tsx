import { api } from '@code2create/backend/api'
import { useQuery } from 'convex/react'
import { type ReactNode, useEffect, useState } from 'react'
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'

import { OperationsCopilotConsole } from '../components/OperationsCopilotConsole'
import { usePendingRecommendations } from '../components/intelligence'
import { eventSlug } from '../lib/config'
import { promptFromNavigationState } from '../lib/copilotPrompts'
import { formatRelativeTime } from '../lib/dateTime'
import {
  type AutonomyStatus,
  autonomyStatusSummary,
} from '../lib/operationsAutonomyPresentation'
import { IntelligenceActivity } from './IntelligenceActivity'
import { IntelligenceDecisions } from './IntelligenceDecisions'
import { IntelligenceOverview } from './IntelligenceOverview'
import { IntelligenceSituations } from './IntelligenceSituations'

export const intelligencePath = '/intelligence'

type IntelligenceTab = {
  badge?: string | undefined
  end?: boolean
  label: string
  to: string
}

/**
 * The operations agent, organised by what an operator wants from it: a place
 * to start, a conversation, proposals to decide on, situations being watched,
 * and the engine room where runs and agents can be inspected.
 */
export function IntelligenceWorkspace({
  canConfigure,
  canGenerate,
  canRead,
}: {
  canConfigure: boolean
  canGenerate: boolean
  canRead: boolean
}) {
  const autonomy = useQuery(api.operationsAutonomy.status, canRead ? { eventSlug } : 'skip')
  const pending = usePendingRecommendations(canRead)
  const tabs: IntelligenceTab[] = [
    { to: intelligencePath, label: 'Overview', end: true },
    { to: `${intelligencePath}/ask`, label: 'Ask' },
    ...(canRead
      ? [
          {
            to: `${intelligencePath}/decisions`,
            label: 'Decisions',
            badge: pending.count === 0 ? undefined : `${pending.count}${pending.atLeast ? '+' : ''}`,
          },
          { to: `${intelligencePath}/situations`, label: 'Situations' },
          { to: `${intelligencePath}/activity`, label: 'Activity' },
        ]
      : []),
  ]

  return (
    <section className="intelligence-workspace flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line px-4 py-2 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="m-0 shrink-0 text-[13px] font-medium tracking-normal text-ink">Operations agent</h1>
          <span aria-hidden className="h-4 w-px shrink-0 bg-line-strong" />
          <nav
            aria-label="Operations agent views"
            className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
          >
            {tabs.map((tab) => (
              <NavLink
                className={({ isActive }) => `flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] px-2.5 text-[12.5px] no-underline transition-colors duration-100 ${
                  isActive ? 'bg-field text-ink' : 'text-ink-3 hover:bg-hover hover:text-ink'
                }`}
                end={tab.end === true}
                key={tab.to}
                to={tab.to}
              >
                {tab.label}
                {tab.badge === undefined ? null : (
                  <span className="rounded-full bg-amber/15 px-1.5 text-[10.5px] font-medium text-amber tabular-nums">
                    {tab.badge}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>
        </div>
        {canRead ? <AutonomyStatusPill autonomy={autonomy} /> : null}
      </header>
      <Routes>
        <Route
          element={(
            <Panel>
              <IntelligenceOverview
                canGenerate={canGenerate}
                canRead={canRead}
                pending={pending}
              />
            </Panel>
          )}
          index
        />
        <Route element={<AskView canGenerate={canGenerate} canRead={canRead} />} path="ask" />
        {canRead ? (
          <Route element={<Panel><IntelligenceDecisions /></Panel>} path="decisions" />
        ) : null}
        {canRead ? (
          <Route element={<Panel><IntelligenceSituations /></Panel>} path="situations" />
        ) : null}
        {canRead ? (
          <Route
            element={(
              <Panel>
                <IntelligenceActivity autonomy={autonomy} canConfigure={canConfigure} canGenerate={canGenerate} />
              </Panel>
            )}
            path="activity"
          />
        ) : null}
        <Route element={<Navigate replace to={intelligencePath} />} path="*" />
      </Routes>
    </section>
  )
}

/** Scrollable page body for every view except the full-height conversation. */
function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1072px] px-4 py-5 sm:px-6 sm:py-6">{children}</div>
    </div>
  )
}

function AskView({ canGenerate, canRead }: { canGenerate: boolean; canRead: boolean }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [initialPrompt] = useState(() => promptFromNavigationState(location.state))

  // The prompt travels in router state from the overview composer. Clear it so a
  // reload or a back-navigation does not send the same question twice.
  useEffect(() => {
    if (initialPrompt === undefined) return
    navigate(location.pathname, { replace: true, state: null })
  }, [initialPrompt, location.pathname, navigate])

  return (
    <OperationsCopilotConsole
      canGenerate={canGenerate}
      canRead={canRead}
      {...initialPrompt === undefined ? {} : { initialPrompt }}
    />
  )
}

function AutonomyStatusPill({ autonomy }: { autonomy: AutonomyStatus | undefined }) {
  if (autonomy === undefined) {
    return <span className="text-[11.5px] text-ink-3" role="status">Checking the agent…</span>
  }
  const summary = autonomyStatusSummary(autonomy, (at) => formatRelativeTime(at))
  const dot = summary.tone === 'live'
    ? 'bg-green shadow-[0_0_0_4px_rgb(143_185_159/0.12)]'
    : summary.tone === 'ready'
      ? 'bg-green/70'
      : 'bg-ink-3'
  return (
    <Link
      className="flex shrink-0 items-center gap-2 rounded-full border border-line px-2.5 py-1 text-[11.5px] text-ink-2 no-underline transition-colors duration-100 hover:border-line-strong hover:text-ink"
      title={summary.detail}
      to={`${intelligencePath}/activity`}
    >
      <span aria-hidden className={`size-1.5 rounded-full ${dot}`} />
      <span>Autonomy · {summary.label}</span>
      <span className="hidden text-ink-3 md:inline">· {summary.detail}</span>
    </Link>
  )
}
