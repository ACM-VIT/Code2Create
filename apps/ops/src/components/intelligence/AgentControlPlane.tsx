import { api } from '@code2create/backend/api'
import {
  intelligenceAgentDefinitions,
  intelligenceAgentDefinition,
  type IntelligenceAgentDefinition,
  type IntelligenceAgentId,
  type IntelligenceAgentPrompt,
} from '@code2create/domain'
import { usePaginatedQuery, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { eventSlug } from '../../lib/config'
import { formatCompactDateTime, formatRelativeTime } from '../../lib/dateTime'
import { Icon, type IconName } from '../Icon'
import { LoadingLabel, SkeletonList } from '../Skeleton'

const runPageSize = 20

type FleetStatus = FunctionReturnType<typeof api.intelligenceObservability.agentFleetStatus>[number]
type AgentRun = FunctionReturnType<typeof api.intelligenceObservability.agentRunHistory>['page'][number]
type AgentHistory = {
  results: AgentRun[]
  status: 'LoadingFirstPage' | 'CanLoadMore' | 'LoadingMore' | 'Exhausted'
  loadMore: (numItems: number) => void
}
type AgentView = 'runs' | 'about' | 'prompts'

const agentIcons: Record<IntelligenceAgentId, IconName> = {
  'idea-submission': 'notes',
  'operations-episode': 'pulse',
  'operations-brief': 'inbox',
  'operations-copilot': 'users',
  'operations-autopilot': 'shield',
}

const agentViews: ReadonlyArray<{ id: AgentView; label: string }> = [
  { id: 'runs', label: 'Runs' },
  { id: 'about', label: 'What it does' },
  { id: 'prompts', label: 'Prompts' },
]

/** Every deployed agent: pick one to see its runs, its limits, and the prompts it runs. */
export function AgentControlPlane() {
  const [selectedAgentId, setSelectedAgentId] = useState<IntelligenceAgentId>('idea-submission')
  const [view, setView] = useState<AgentView>('runs')
  const fleet = useQuery(api.intelligenceObservability.agentFleetStatus, { eventSlug })
  const history = usePaginatedQuery(
    api.intelligenceObservability.agentRunHistory,
    { eventSlug, agent: selectedAgentId },
    { initialNumItems: runPageSize },
  )
  const selectedAgent = useMemo(
    () => intelligenceAgentDefinition(selectedAgentId),
    [selectedAgentId],
  )
  const fleetByAgent = useMemo(
    () => new Map(fleet?.map((status) => [status.agent, status])),
    [fleet],
  )

  return (
    <section aria-labelledby="deployed-agents-heading" className="attention-section">
      <div className="section-heading">
        <h2 id="deployed-agents-heading">Deployed agents</h2>
        <FleetSummary fleet={fleet} />
      </div>
      <div className="grid gap-3">
        <nav aria-label="Intelligence agent fleet" className="overflow-hidden rounded-xl bg-surface">
          {intelligenceAgentDefinitions.map((agent) => (
            <AgentRailButton
              agent={agent}
              key={agent.id}
              onSelect={setSelectedAgentId}
              selected={agent.id === selectedAgent.id}
              status={fleetByAgent.get(agent.id)}
            />
          ))}
        </nav>

        <section aria-labelledby="selected-agent-heading" className="overflow-hidden rounded-xl bg-surface">
          <AgentHeader agent={selectedAgent} status={fleetByAgent.get(selectedAgent.id)} />
          <div aria-label="Agent detail views" className="flex items-center gap-0.5 border-b border-line px-3 py-1.5" role="tablist">
            {agentViews.map((entry) => (
              <button
                aria-selected={view === entry.id}
                className={`flex h-7 cursor-pointer items-center rounded-[6px] border-0 px-2.5 text-[12.5px] transition-colors duration-100 ${
                  view === entry.id ? 'bg-field text-ink' : 'bg-transparent text-ink-3 hover:bg-hover hover:text-ink'
                }`}
                key={entry.id}
                onClick={() => setView(entry.id)}
                role="tab"
                type="button"
              >
                {entry.label}
              </button>
            ))}
          </div>
          <div className="p-4" role="tabpanel">
            {view === 'runs' ? (
              <AgentRunLedger agent={selectedAgent} history={history} />
            ) : view === 'about' ? (
              <AgentAbout agent={selectedAgent} />
            ) : (
              <AgentPrompts agent={selectedAgent} />
            )}
          </div>
        </section>
      </div>
    </section>
  )
}

function FleetSummary({ fleet }: { fleet: FleetStatus[] | undefined }) {
  if (fleet === undefined) return null
  const active = fleet.reduce((sum, agent) => sum + agent.activeRuns, 0)
  const activeAtLeast = fleet.some((agent) => agent.activeRunsAtLeast)
  const attention = fleet.filter((agent) => agent.state === 'attention').length
  return (
    <span>
      {intelligenceAgentDefinitions.length} deployed · {active}{activeAtLeast ? '+' : ''} active
      {attention > 0 ? ` · ${attention} ${attention === 1 ? 'needs' : 'need'} attention` : ''}
    </span>
  )
}

function AgentRailButton({
  agent,
  onSelect,
  selected,
  status,
}: {
  agent: IntelligenceAgentDefinition
  onSelect: (agentId: IntelligenceAgentId) => void
  selected: boolean
  status: FleetStatus | undefined
}) {
  return (
    <button
      aria-current={selected ? 'true' : undefined}
      className={`group grid w-full cursor-pointer grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 border-0 border-b border-line px-4 py-3 text-left transition-colors last:border-b-0 ${
        selected ? 'bg-field text-ink' : 'bg-surface text-ink-2 hover:bg-hover hover:text-ink'
      }`}
      onClick={() => onSelect(agent.id)}
      type="button"
    >
      <span className={`grid size-7 place-items-center rounded-md ${selected ? 'bg-green/10 text-green' : 'bg-hover text-ink-3 group-hover:text-ink-2'}`}>
        <Icon name={agentIcons[agent.id]} size={14} />
      </span>
      <span className="min-w-0">
        <strong className="block truncate text-[13px] font-medium">{agent.name}</strong>
        <small className="mt-0.5 block truncate text-[12px] text-ink-3">{agent.description}</small>
      </span>
      <StatusDot status={status} />
    </button>
  )
}

function StatusDot({ status }: { status: FleetStatus | undefined }) {
  const tone = status === undefined
    ? 'bg-ink-3'
    : status.state === 'running'
      ? 'bg-green shadow-[0_0_0_4px_rgb(143_185_159/0.08)]'
      : status.state === 'attention'
        ? 'bg-amber'
        : 'bg-ink-3'
  return (
    <span className="flex min-w-20 items-center justify-end gap-2 text-[11.5px] text-ink-3" title={status?.stateLabel ?? 'Loading status'}>
      <span className={`size-1.5 rounded-full ${tone}`} />
      <span>{status?.stateLabel ?? 'Loading'}</span>
    </span>
  )
}

function AgentHeader({ agent, status }: { agent: IntelligenceAgentDefinition; status: FleetStatus | undefined }) {
  const dot = status?.state === 'running' ? 'bg-green' : status?.state === 'attention' ? 'bg-amber' : 'bg-ink-3'
  return (
    <header className="grid gap-1.5 border-b border-line px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="m-0 text-[15px] font-medium text-ink" id="selected-agent-heading">{agent.name}</h3>
          <span className="rounded-full bg-field px-2 py-0.5 font-mono text-[10.5px] text-ink-3">{agent.version}</span>
          <span className="rounded-full bg-field px-2 py-0.5 text-[11px] capitalize text-ink-3">{agent.operation}</span>
        </div>
        <span className="flex items-center gap-2 text-[12px] text-ink-2">
          <span aria-hidden className={`size-1.5 rounded-full ${dot}`} />
          {status?.stateLabel ?? 'Loading status'}
          {status?.lastActivityAt === undefined ? null : (
            <span className="text-ink-3">· last active {formatRelativeTime(status.lastActivityAt)}</span>
          )}
        </span>
      </div>
      <p className="m-0 max-w-3xl text-[13px] leading-6 text-ink-2">{agent.description}</p>
    </header>
  )
}

function AgentAbout({ agent }: { agent: IntelligenceAgentDefinition }) {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="grid content-start gap-5">
        <FactList items={agent.authority} title="What it may do" />
        <FactList items={agent.memory} title="What it remembers" />
      </div>
      <div className="grid content-start gap-5">
        <dl className="m-0 grid gap-2">
          <RuntimeRow label="Model" value={agent.model} />
          <RuntimeRow label="Reasoning" value={agent.thinking} />
          <RuntimeRow label="Runs when" value={agent.trigger} />
          <RuntimeRow label="Retries" value={agent.durability} />
          <RuntimeRow label="Identity" value={agent.identity} />
          <RuntimeRow label="Context" value={agent.compaction} />
        </dl>
        <div>
          <p className="m-0 mb-2 text-[12px] font-medium text-ink">Tools</p>
          <div className="flex flex-wrap gap-1.5">
            {agent.tools.map((tool) => (
              <span className="rounded-md bg-field px-2 py-1 font-mono text-[11px] leading-4 text-ink-2" key={tool}>
                {tool}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-canvas/60 px-3.5 py-3 lg:col-span-2">
        <span className="max-w-2xl text-[12.5px] leading-5 text-ink-2">{agent.management.note}</span>
        <Link className="secondary" to={agent.management.href}>
          {agent.management.label}
        </Link>
      </div>
    </div>
  )
}

function FactList({ items, title }: { items: readonly string[]; title: string }) {
  return (
    <div>
      <p className="m-0 mb-2 text-[12px] font-medium text-ink">{title}</p>
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {items.map((item) => (
          <li className="grid grid-cols-[8px_minmax(0,1fr)] gap-2 text-[12.5px] leading-5 text-ink-2" key={item}>
            <span aria-hidden className="mt-2 size-1 rounded-full bg-ink-3" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function RuntimeRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3">
      <dt className="text-[12px] leading-5 text-ink-3">{label}</dt>
      <dd className="m-0 text-[12.5px] leading-5 text-ink-2">{value}</dd>
    </div>
  )
}

function AgentPrompts({ agent }: { agent: IntelligenceAgentDefinition }) {
  return (
    <div className="grid gap-5">
      {agent.prompts.map((agentPrompt) => (
        <article className="grid gap-2.5" key={agentPrompt.name}>
          <header className="flex flex-wrap items-baseline gap-x-2">
            <h4 className="m-0 text-[13px] font-medium text-ink">{agentPrompt.name}</h4>
            <span className="text-[12px] text-ink-3">{agentPrompt.purpose}</span>
          </header>
          <div className="grid gap-2.5 rounded-lg bg-canvas/60 px-4 py-3.5">
            <PromptText prompt={agentPrompt} />
          </div>
        </article>
      ))}
      <p className="m-0 text-[12px] leading-5 text-ink-3">
        Prompts ship with the deployed code; identities, signed projections, and evidence are added
        at runtime. Policy controls stay editable in event setup.
      </p>
    </div>
  )
}

/** Prompt sections are joined with blank lines: `# ` headings, paragraphs, numbered procedures, and a bracketed runtime note. */
function PromptText({ prompt }: { prompt: IntelligenceAgentPrompt }) {
  return prompt.text.split('\n\n').map((section, index) => {
    if (section.startsWith('# ')) {
      return (
        <h5 className="m-0 mt-1.5 text-[12.5px] font-medium text-ink first:mt-0" key={index}>
          {section.slice(2)}
        </h5>
      )
    }
    if (section.startsWith('[') && section.endsWith(']')) {
      return (
        <p className="m-0 text-[12px] leading-5 text-ink-3 italic" key={index}>
          {section.slice(1, -1)}
        </p>
      )
    }
    const steps = section.split(/\s(?=\d+\.\s)/)
    if (steps.length > 1 && steps.every((step) => /^\d+\.\s/.test(step))) {
      return (
        <ol className="m-0 grid gap-1 pl-5 text-[12.5px] leading-6 text-ink-2" key={index}>
          {steps.map((step) => <li key={step}>{step.replace(/^\d+\.\s/, '')}</li>)}
        </ol>
      )
    }
    return (
      <p className="m-0 text-[12.5px] leading-6 text-ink-2" key={index}>
        {section}
      </p>
    )
  })
}

function AgentRunLedger({
  agent,
  history,
}: {
  agent: IntelligenceAgentDefinition
  history: AgentHistory
}) {
  return (
    <div className="grid gap-3">
      {history.status === 'LoadingFirstPage' ? (
        <>
          <LoadingLabel>{`Loading ${agent.name.toLowerCase()} runs`}</LoadingLabel>
          <SkeletonList rows={4} />
        </>
      ) : history.results.length === 0 ? (
        <p className="m-0 text-[13px] leading-6 text-ink-2">
          <strong className="font-medium text-ink">No runs yet.</strong>{' '}
          <span className="text-ink-3">Runs when: {agent.trigger.toLowerCase()}.</span>
        </p>
      ) : (
        <div className="grid">
          {history.results.map((run) => <AgentRunRow key={run.id} run={run} />)}
        </div>
      )}
      {history.status === 'CanLoadMore' ? (
        <button
          className="secondary"
          onClick={() => history.loadMore(runPageSize)}
          type="button"
        >
          Load older runs
        </button>
      ) : null}
      {history.status === 'LoadingMore' ? <LoadingLabel>Loading older runs</LoadingLabel> : null}
    </div>
  )
}

function AgentRunRow({ run }: { run: AgentRun }) {
  return (
    <details className="group border-b border-line last:border-b-0">
      <summary className="grid cursor-pointer list-none grid-cols-[8px_minmax(0,1fr)_auto] items-start gap-3 py-3 hover:bg-hover [&::-webkit-details-marker]:hidden">
        <RunTone tone={run.tone} />
        <span className="min-w-0">
          <strong className="block truncate text-[13px] font-medium text-ink">{run.title}</strong>
          <small className="mt-0.5 block line-clamp-2 text-[12px] leading-5 text-ink-3">{run.summary}</small>
          <small className="mt-0.5 block text-[12px] text-ink-3">{formatCompactDateTime(run.updatedAt)}</small>
        </span>
        <span className="inline-flex h-5.5 items-center rounded-full bg-field px-2 text-[11px] text-ink-2">{run.state.replaceAll('_', ' ')}</span>
      </summary>
      <div className="grid gap-3 pb-3 pl-5">
        <dl className="m-0 grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <RunDatum label="Run" value={run.id} />
          <RunDatum label="Created" value={formatCompactDateTime(run.createdAt)} />
          {run.instanceId === undefined ? null : <RunDatum label="Durable instance" value={run.instanceId} />}
          {run.operationId === undefined ? null : <RunDatum label="Operation" value={run.operationId} />}
          {run.agentVersion === undefined ? null : <RunDatum label="Agent release" value={run.agentVersion} />}
          {run.model === undefined ? null : <RunDatum label="Model" value={run.model} />}
          {run.startedAt === undefined ? null : <RunDatum label="Started" value={formatCompactDateTime(run.startedAt)} />}
          {run.completedAt === undefined ? null : <RunDatum label="Completed" value={formatCompactDateTime(run.completedAt)} />}
          {run.metadata.map((datum) => <RunDatum key={`${datum.label}:${datum.value}`} label={datum.label} value={datum.value} />)}
        </dl>
        {run.href === undefined ? null : (
          <Link className="inline-flex w-fit items-center gap-2 text-[12px] text-green no-underline hover:underline" to={run.href}>
            Open the record
            <Icon name="arrow" size={12} />
          </Link>
        )}
      </div>
    </details>
  )
}

function RunTone({ tone }: { tone: AgentRun['tone'] }) {
  const color = tone === 'live'
    ? 'bg-green shadow-[0_0_0_4px_rgb(143_185_159/0.08)]'
    : tone === 'success'
      ? 'bg-green/70'
      : tone === 'attention'
        ? 'bg-amber'
        : tone === 'failure'
          ? 'bg-red'
          : 'bg-ink-3'
  return <span aria-hidden className={`mt-1.5 size-1.5 rounded-full ${color}`} />
}

function RunDatum({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] leading-5 text-ink-3">{label}</dt>
      <dd className="m-0 [overflow-wrap:anywhere] font-mono text-[11.5px] leading-5 text-ink-2">{value}</dd>
    </div>
  )
}
