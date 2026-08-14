import { api } from '@code2create/backend/api'
import { usePaginatedQuery, useQuery } from 'convex/react'
import { useState } from 'react'

import { LoadingState } from '../components/intelligence/LoadingState'
import { OperationsAutonomyRunStream } from '../components/OperationsAutonomyRunStream'
import { OperationsBrief } from '../components/OperationsBrief'
import { OperationsCopilotConsole } from '../components/OperationsCopilotConsole'
import { eventSlug } from '../lib/config'
import {
  autonomyRunIsActive,
  autonomyRunStateLabel,
} from '../lib/operationsAutonomyPresentation'
import { IntelligenceActivity } from './IntelligenceActivity'

type IntelligenceTab = 'copilot' | 'autopilot' | 'activity' | 'brief'

export function IntelligenceWorkspace({
  canGenerate,
  canRead,
}: {
  canGenerate: boolean
  canRead: boolean
}) {
  const [tab, setTab] = useState<IntelligenceTab>('copilot')
  const tabs: { id: IntelligenceTab; label: string }[] = [
    { id: 'copilot', label: 'Copilot' },
    ...(canRead
      ? [
          { id: 'autopilot' as const, label: 'Autopilot' },
          { id: 'activity' as const, label: 'Activity' },
        ]
      : []),
    { id: 'brief', label: 'Brief' },
  ]

  return (
    <section className="intelligence-workspace flex min-h-0 flex-1 flex-col">
      <h1 className="visually-hidden">Intelligence</h1>
      <header className="flex shrink-0 items-center justify-between border-b border-line p-1.5">
        <div aria-label="Intelligence views" className="flex items-center gap-0.5" role="tablist">
          {tabs.map((entry) => (
            <button
              aria-selected={tab === entry.id}
              className={`cursor-pointer rounded-[6px] border-0 px-2 py-[3px] text-[13px] text-ink transition-[background-color,opacity] duration-100 ${
                tab === entry.id ? 'bg-field' : 'bg-transparent opacity-50 hover:opacity-75'
              }`}
              key={entry.id}
              onClick={() => setTab(entry.id)}
              role="tab"
              type="button"
            >
              {entry.label}
            </button>
          ))}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col" role="tabpanel">
        {tab === 'copilot' ? (
          <OperationsCopilotConsole canGenerate={canGenerate} canRead={canRead} />
        ) : tab === 'autopilot' ? (
          <AutopilotTrace />
        ) : tab === 'activity' ? (
          <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto p-5">
            <IntelligenceActivity canGenerate={canGenerate} />
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto p-5">
            <OperationsBrief canGenerate={canGenerate} canRead={canRead} />
          </div>
        )}
      </div>
    </section>
  )
}

const autopilotRunPageSize = 8

function AutopilotTrace() {
  const autonomy = useQuery(api.operationsAutonomy.status, { eventSlug })
  const runHistory = usePaginatedQuery(
    api.operationsAutonomy.history,
    { eventSlug },
    { initialNumItems: autopilotRunPageSize },
  )
  const [selectedRunId, setSelectedRunId] = useState<string>()

  if (autonomy === undefined || runHistory.status === 'LoadingFirstPage') {
    return (
      <div className="flex flex-1 items-center justify-center">
        <LoadingState label="Loading autonomous runs" />
      </div>
    )
  }

  const activeRun = autonomy.activeRun
  const runs = activeRun === null || runHistory.results.some((run) => run.runId === activeRun.runId)
    ? runHistory.results
    : [activeRun, ...runHistory.results]
  const selectedRun = runs.find((run) => run.runId === selectedRunId)
    ?? activeRun
    ?? runs[0]

  if (selectedRun === undefined) {
    return (
      <div className="m-auto flex flex-col items-center gap-1.5 px-6 py-10 text-center">
        <strong className="text-[13px] font-medium text-ink">No autonomous run yet.</strong>
        <span className="max-w-90 text-[12.5px] leading-normal text-ink-3">
          Runs start from a schedule, a qualifying signal, or a manual request on the Activity tab.
        </span>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto px-4 py-2">
        {runs.map((run) => (
          <button
            className={`flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border-0 px-2.5 text-[11.5px] font-medium transition-colors duration-100 ${
              run.runId === selectedRun.runId
                ? 'bg-field text-ink'
                : 'bg-transparent text-ink-3 hover:bg-hover hover:text-ink-2'
            }`}
            key={run.runId}
            onClick={() => setSelectedRunId(run.runId)}
            type="button"
          >
            {autonomyRunIsActive(run.state) ? (
              <span aria-hidden className="size-1.5 rounded-full bg-green" />
            ) : null}
            {autonomyRunStateLabel(run.state)}
            <span className="font-normal text-ink-3 tabular-nums">{formatRunTime(run.createdAt)}</span>
          </button>
        ))}
        {runHistory.status === 'CanLoadMore' ? (
          <button
            className="h-6 shrink-0 cursor-pointer rounded-full border-0 bg-transparent px-2.5 text-[11.5px] text-ink-3 transition-colors duration-100 hover:text-ink"
            onClick={() => runHistory.loadMore(autopilotRunPageSize)}
            type="button"
          >
            Older runs
          </button>
        ) : null}
      </div>
      <OperationsAutonomyRunStream embedded={false} key={selectedRun.runId} run={selectedRun} />
    </div>
  )
}

function formatRunTime(value: number) {
  return new Date(value).toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}
