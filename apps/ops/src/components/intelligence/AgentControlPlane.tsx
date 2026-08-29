import { api } from '@code2create/backend/api'
import {
  intelligenceAgentDefinitions,
  intelligenceAgentDefinition,
  type IntelligenceAgentDefinition,
  type IntelligenceAgentId,
} from '@code2create/domain'
import { usePaginatedQuery, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { eventSlug } from '../../lib/config'
import { formatCompactDateTime } from '../../lib/dateTime'
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

const agentIcons: Record<IntelligenceAgentId, IconName> = {
  'idea-submission': 'notes',
  'operations-episode': 'pulse',
  'operations-brief': 'inbox',
  'operations-copilot': 'users',
  'operations-autopilot': 'shield',
}

export function AgentControlPlane() {
  const [selectedAgentId, setSelectedAgentId] = useState<IntelligenceAgentId>('idea-submission')
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
    <section className="mx-auto grid w-full max-w-[1072px] content-start gap-7">
      <header className="flex flex-wrap items-end justify-between gap-5">
        <div className="max-w-[680px]">
          <p className="mb-1.5 text-[12px] font-medium text-ink-2">Operations intelligence</p>
          <h2 className="mb-1.5 text-[21px] font-medium tracking-[-0.015em] text-ink">Agents</h2>
          <p className="m-0 text-[13px] leading-5 text-ink-2">
            Inspect what each agent can do, the prompt it is running, and every durable run.
          </p>
        </div>
        <FleetSummary fleet={fleet} />
      </header>

      <section aria-labelledby="deployed-agents-heading">
        <div className="mb-2 flex items-baseline justify-between gap-4 px-0.5">
          <h3 className="m-0 text-[12px] font-medium text-ink-2" id="deployed-agents-heading">
            Deployed agents
          </h3>
          <span className="text-[12px] text-ink-3">{intelligenceAgentDefinitions.length}</span>
        </div>
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
      </section>

      <section aria-labelledby="selected-agent-heading" className="grid content-start gap-7">
        <AgentHeader agent={selectedAgent} status={fleetByAgent.get(selectedAgent.id)} />
        <AgentConfiguration agent={selectedAgent} />
        <AgentPrompts agent={selectedAgent} />
        <AgentRunLedger agent={selectedAgent} history={history} />
      </section>
    </section>
  )
}

function FleetSummary({ fleet }: { fleet: FleetStatus[] | undefined }) {
  const active = fleet?.reduce((sum, agent) => sum + agent.activeRuns, 0) ?? 0
  const activeAtLeast = fleet?.some((agent) => agent.activeRunsAtLeast) ?? false
  const attention = fleet?.filter((agent) => agent.state === 'attention').length ?? 0
  return (
    <dl className="m-0 grid grid-cols-3 overflow-hidden rounded-xl bg-surface">
      <SummaryMetric label="Deployed" value={String(intelligenceAgentDefinitions.length)} />
      <SummaryMetric label="Active" value={fleet === undefined ? '—' : `${active}${activeAtLeast ? '+' : ''}`} />
      <SummaryMetric label="Attention" value={fleet === undefined ? '—' : String(attention)} tone={attention > 0 ? 'attention' : 'normal'} />
    </dl>
  )
}

function SummaryMetric({
  label,
  value,
  tone = 'normal',
}: {
  label: string
  value: string
  tone?: 'normal' | 'attention'
}) {
  return (
    <div className="grid min-w-[88px] gap-1 border-l border-line px-3 py-2.5 first:border-l-0">
      <dt className="text-[10px] uppercase tracking-[0.1em] text-ink-3">{label}</dt>
      <dd className={`m-0 text-[15px] font-medium tabular-nums ${tone === 'attention' ? 'text-amber' : 'text-ink'}`}>
        {value}
      </dd>
    </div>
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
      aria-current={selected ? 'page' : undefined}
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
      <span className="flex items-center gap-3">
        <span className="hidden font-mono text-[10px] text-ink-3 sm:inline">{agent.version}</span>
        <StatusDot status={status} />
      </span>
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
    <span className="flex min-w-20 items-center justify-end gap-2 text-[11px] text-ink-3" title={status?.stateLabel ?? 'Loading status'}>
      <span className={`size-1.5 rounded-full ${tone}`} />
      <span>{status?.stateLabel ?? 'Loading'}</span>
    </span>
  )
}

function AgentHeader({ agent, status }: { agent: IntelligenceAgentDefinition; status: FleetStatus | undefined }) {
  return (
    <header className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
      <div className="min-w-0">
        <p className="mb-1 text-[11px] font-medium text-ink-3">Selected agent</p>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="m-0 text-[18px] font-medium tracking-[-0.02em] text-ink" id="selected-agent-heading">{agent.name}</h3>
          <span className="rounded bg-hover px-2 py-0.5 font-mono text-[10px] text-ink-3">{agent.version}</span>
          <span className="rounded bg-hover px-2 py-0.5 text-[10px] capitalize text-ink-3">{agent.operation}</span>
        </div>
        <p className="m-0 max-w-3xl text-[13px] leading-6 text-ink-2">{agent.description}</p>
      </div>
      <div className="flex items-center gap-2">
        <span className={`size-2 rounded-full ${status?.state === 'running' ? 'bg-green' : status?.state === 'attention' ? 'bg-amber' : 'bg-ink-3'}`} />
        <span className="text-[12px] text-ink-2">{status?.stateLabel ?? 'Loading status'}</span>
        {status?.lastActivityAt === undefined ? null : (
          <span className="text-[11px] text-ink-3">· {formatCompactDateTime(status.lastActivityAt)}</span>
        )}
      </div>
    </header>
  )
}

function AgentConfiguration({ agent }: { agent: IntelligenceAgentDefinition }) {
  return (
    <section aria-labelledby="agent-configuration-heading" className="grid gap-4">
      <SectionHeading
        eyebrow="Deployed configuration"
        heading="Runtime contract"
        id="agent-configuration-heading"
      />
      <dl className="m-0 grid overflow-hidden rounded-xl bg-surface sm:grid-cols-2">
        <ConfigValue label="Model" value={agent.model} />
        <ConfigValue label="Reasoning" value={agent.thinking} />
        <ConfigValue label="Trigger" value={agent.trigger} />
        <ConfigValue label="Durability" value={agent.durability} />
        <ConfigValue label="Durable identity" value={agent.identity} wide />
        <ConfigValue label="Context / compaction" value={agent.compaction} wide />
      </dl>

      <div className="grid gap-3 sm:grid-cols-2">
        <ContractList title="Authority boundary" icon="shield" items={agent.authority} />
        <ContractList title="Durable memory" icon="code" items={agent.memory} />
      </div>

      <div className="rounded-xl bg-surface p-4">
        <div className="mb-3 flex items-center gap-2 text-ink-2">
          <Icon name="sliders" size={14} />
          <h4 className="m-0 text-[12px] font-medium text-ink">Mounted capabilities</h4>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {agent.tools.map((tool) => (
            <span className="rounded-md bg-hover px-2 py-1 font-mono text-[10px] leading-4 text-ink-2" key={tool}>
              {tool}
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-surface p-4">
        <div className="max-w-2xl">
          <strong className="block text-[12px] font-medium text-ink">Management boundary</strong>
          <span className="mt-1 block text-[11px] leading-5 text-ink-3">{agent.management.note}</span>
        </div>
        <Link className="inline-flex h-8 items-center gap-2 rounded-md bg-ink px-3 text-[12px] font-medium text-canvas no-underline hover:opacity-90" to={agent.management.href}>
          {agent.management.label}
          <Icon name="arrow" size={13} />
        </Link>
      </div>
    </section>
  )
}

function ConfigValue({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={`grid gap-1 border-b border-line p-3.5 last:border-b-0 sm:border-r sm:[&:nth-last-child(-n+2)]:border-b-0 sm:[&:nth-child(2n)]:border-r-0 ${wide ? 'sm:col-span-2 sm:border-r-0' : ''}`}>
      <dt className="text-[10px] uppercase tracking-[0.1em] text-ink-3">{label}</dt>
      <dd className="m-0 text-[12px] leading-5 text-ink-2">{value}</dd>
    </div>
  )
}

function ContractList({ title, icon, items }: { title: string; icon: IconName; items: readonly string[] }) {
  return (
    <section className="rounded-xl bg-surface p-4">
      <div className="mb-3 flex items-center gap-2 text-ink-2">
        <Icon name={icon} size={14} />
        <h4 className="m-0 text-[12px] font-medium text-ink">{title}</h4>
      </div>
      <ul className="m-0 grid list-none gap-2 p-0">
        {items.map((item) => (
          <li className="grid grid-cols-[8px_minmax(0,1fr)] gap-2 text-[11px] leading-5 text-ink-2" key={item}>
            <span className="mt-2 size-1 rounded-full bg-ink-3" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function AgentPrompts({ agent }: { agent: IntelligenceAgentDefinition }) {
  return (
    <section aria-labelledby="agent-prompts-heading" className="grid gap-4">
      <SectionHeading
        eyebrow="Code-owned release"
        heading={agent.prompts.length === 1 ? 'Prompt' : 'Prompts'}
        id="agent-prompts-heading"
      />
      <div className="grid gap-2">
        {agent.prompts.map((agentPrompt, index) => (
          <details className="group overflow-hidden rounded-xl bg-surface" key={agentPrompt.name} open={index === 0}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 hover:bg-hover [&::-webkit-details-marker]:hidden">
              <span>
                <strong className="block text-[12px] font-medium text-ink">{agentPrompt.name}</strong>
                <small className="mt-1 block text-[10px] text-ink-3">{agentPrompt.purpose}</small>
              </span>
              <span className="font-mono text-[14px] text-ink-3 transition-transform group-open:rotate-45">+</span>
            </summary>
            <pre className="m-0 max-h-[520px] overflow-auto whitespace-pre-wrap border-t border-line bg-canvas/50 p-4 font-mono text-[11px] leading-5 text-ink-2">
              {agentPrompt.text}
            </pre>
          </details>
        ))}
      </div>
      <p className="m-0 text-[10px] leading-5 text-ink-3">
        Prompt text is inspectable here and imported by the deployed agent code. Dynamic identities,
        signed projections, and frozen evidence are appended only at runtime. Publishing prompt code
        requires a deployment; policy controls remain editable through the management surface above.
      </p>
    </section>
  )
}

function AgentRunLedger({
  agent,
  history,
}: {
  agent: IntelligenceAgentDefinition
  history: AgentHistory
}) {
  return (
    <section aria-labelledby="agent-runs-heading" className="grid content-start gap-4">
      <SectionHeading
        eyebrow="Authoritative ledger"
        heading="Runs"
        id="agent-runs-heading"
        {...history.status === 'LoadingFirstPage' ? {} : { aside: `${history.results.length} loaded` }}
      />
      {history.status === 'LoadingFirstPage' ? (
        <div className="grid gap-3 rounded-xl bg-surface p-4">
          <LoadingLabel>{`Loading ${agent.name.toLowerCase()} runs`}</LoadingLabel>
          <SkeletonList rows={5} />
        </div>
      ) : history.results.length === 0 ? (
        <div className="grid min-h-40 place-items-center rounded-xl bg-surface p-6 text-center">
          <div>
            <Icon name={agentIcons[agent.id]} size={18} />
            <strong className="mt-3 block text-[12px] font-medium text-ink">No runs recorded yet</strong>
            <span className="mt-1 block text-[11px] leading-5 text-ink-3">{agent.trigger}</span>
          </div>
        </div>
      ) : (
        <div className="grid overflow-hidden rounded-xl bg-surface">
          {history.results.map((run) => <AgentRunRow key={run.id} run={run} />)}
        </div>
      )}
      {history.status === 'CanLoadMore' ? (
        <button
          className="h-8 cursor-pointer rounded-md border border-line-strong bg-transparent px-3 text-[11px] text-ink-2 hover:bg-hover hover:text-ink"
          onClick={() => history.loadMore(runPageSize)}
          type="button"
        >
          Load older runs
        </button>
      ) : null}
      {history.status === 'LoadingMore' ? <LoadingLabel>Loading older runs</LoadingLabel> : null}
    </section>
  )
}

function AgentRunRow({ run }: { run: AgentRun }) {
  return (
    <details className="group overflow-hidden border-b border-line bg-surface last:border-b-0">
      <summary className="grid cursor-pointer list-none grid-cols-[8px_minmax(0,1fr)_auto] items-start gap-3 p-3.5 hover:bg-hover [&::-webkit-details-marker]:hidden">
        <RunTone tone={run.tone} />
        <span className="min-w-0">
          <strong className="block truncate text-[13px] font-medium text-ink">{run.title}</strong>
          <small className="mt-1 block line-clamp-2 text-[12px] leading-4 text-ink-3">{run.summary}</small>
          <small className="mt-2 block font-mono text-[10px] text-ink-3">{formatCompactDateTime(run.updatedAt)}</small>
        </span>
        <span className="rounded bg-hover px-2 py-0.5 text-[9px] uppercase tracking-[0.08em] text-ink-3">{run.state.replaceAll('_', ' ')}</span>
      </summary>
      <div className="grid gap-3 border-t border-line p-3.5">
        <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-3">
          <RunDatum label="Run ID" value={run.id} />
          <RunDatum label="Created" value={formatCompactDateTime(run.createdAt)} />
          {run.instanceId === undefined ? null : <RunDatum label="Durable instance" value={run.instanceId} />}
          {run.operationId === undefined ? null : <RunDatum label="Operation" value={run.operationId} />}
          {run.agentVersion === undefined ? null : <RunDatum label="Agent release" value={run.agentVersion} />}
          {run.model === undefined ? null : <RunDatum label="Model" value={run.model} />}
          {run.startedAt === undefined ? null : <RunDatum label="Accepted / started" value={formatCompactDateTime(run.startedAt)} />}
          {run.completedAt === undefined ? null : <RunDatum label="Completed" value={formatCompactDateTime(run.completedAt)} />}
          {run.metadata.map((datum) => <RunDatum key={`${datum.label}:${datum.value}`} label={datum.label} value={datum.value} />)}
        </dl>
        {run.href === undefined ? null : (
          <Link className="inline-flex w-fit items-center gap-2 text-[11px] text-green no-underline hover:underline" to={run.href}>
            Open authoritative record
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
  return <span className={`mt-1.5 size-1.5 rounded-full ${color}`} />
}

function RunDatum({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[9px] uppercase tracking-[0.08em] text-ink-3">{label}</dt>
      <dd className="mt-1 [overflow-wrap:anywhere] font-mono text-[10px] leading-4 text-ink-2">{value}</dd>
    </div>
  )
}

function SectionHeading({
  aside,
  eyebrow,
  heading,
  id,
}: {
  aside?: string
  eyebrow: string
  heading: string
  id: string
}) {
  return (
    <header className="flex items-end justify-between gap-4">
      <div>
        <p className="mb-1 text-[12px] font-medium text-ink-3">{eyebrow}</p>
        <h3 className="m-0 text-[16px] font-medium text-ink" id={id}>{heading}</h3>
      </div>
      {aside === undefined ? null : <span className="text-[12px] text-ink-3">{aside}</span>}
    </header>
  )
}
