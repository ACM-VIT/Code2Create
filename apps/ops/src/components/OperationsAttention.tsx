import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { ConvexError } from 'convex/values'
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { eventSlug } from '../lib/config'
import { formatClockTime } from '../lib/dateTime'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'
import { Icon, type IconName } from './Icon'
import { LoadingLabel, SkeletonList } from './Skeleton'

type AttentionRow = FunctionReturnType<typeof api.operationsAttention.overview>['rows'][number]

const overviewRowLimit = 3
const groupRowLimit = 3

const attentionGroupLabels: Record<AttentionRow['detectorKey'], string> = {
  panel_seat_empty: 'Empty panel seats',
  seat_at_risk: 'Reviewer devices at risk',
  review_overdue: 'Overdue reviews',
  review_presence_incomplete: 'Incomplete reviewer presence',
  team_below_minimum: 'Teams below minimum size',
  team_held: 'Held teams',
  team_call_overdue: 'Overdue team calls',
  team_waiting_long: 'Teams waiting too long',
  round_finish_forecast: 'Round finish risk',
  panel_bottleneck: 'Panel bottlenecks',
  scorecard_outstanding: 'Outstanding scorecards',
}

export function OperationsAttention({
  canManageAttention,
  compact,
}: {
  canManageAttention: boolean
  compact: boolean
}) {
  const attention = useQuery(api.operationsAttention.overview, { eventSlug })
  const acknowledge = useMutation(api.operationsAttention.acknowledge)
  const acknowledgeOperations = useOperationRunner<
    FunctionReturnType<typeof api.operationsAttention.acknowledge>
  >()
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedGroups, setExpandedGroups] = useState<AttentionRow['detectorKey'][]>([])
  const claimBusyRef = useRef(false)

  async function claim(row: AttentionRow) {
    if (claimBusyRef.current) return
    claimBusyRef.current = true
    setPending(row.id)
    setError(null)
    try {
      await acknowledgeOperations.run(
        attentionAcknowledgeSlot(row.id),
        (clientOperationId) => () => acknowledge({
          eventSlug,
          itemId: row.id,
          expectedVersion: row.version,
          clientOperationId,
        }),
      )
    } catch (caught) {
      setError(
        caught instanceof ConvexError
          ? readableError(caught)
          : 'This item could not be picked up. Check your connection and try again.',
      )
    } finally {
      claimBusyRef.current = false
      setPending(null)
    }
  }

  const rows = attention?.rows ?? []
  const visibleRows = compact ? rows.slice(0, overviewRowLimit) : rows
  const hiddenRowCount = rows.length - visibleRows.length
  const groups = compact ? [] : groupAttentionRows(rows)

  const rowView = (row: AttentionRow) => (
    <article
      className={`list-row ${row.severity}${row.acknowledged ? ' acknowledged' : ''}`}
      key={row.id}
    >
      <span className={`row-glyph ${row.severity}`}>
        <Icon name={severityIcon(row.severity)} />
      </span>
      <div className="row-text">
        <strong>{row.statement}</strong>
        <small>{rowMeta(row)}</small>
      </div>
      <span className="row-controls">
        {canManageAttention && !row.acknowledged ? (
          <button
            type="button"
            className="row-action"
            disabled={pending !== null}
            onClick={() => void claim(row)}
          >
            {pending === row.id
              ? 'Picking up'
              : acknowledgeOperations.hasPending(attentionAcknowledgeSlot(row.id))
                ? 'Confirm pickup'
                : 'Pick up'}
          </button>
        ) : null}
        <Link className="row-action" to={row.route}>
          {row.canAct ? row.actionLabel : 'Open'}
          <Icon name="arrow" size={13} />
        </Link>
      </span>
    </article>
  )

  return (
    <section className="attention-section" aria-labelledby={compact ? 'overview-now' : 'monitor-attention'}>
      <div className="section-heading">
        <h2 id={compact ? 'overview-now' : 'monitor-attention'}>{compact ? 'Now' : 'Needs attention'}</h2>
        {attention && rows.length > 0 ? (
          <span>
            {rows.length}{attention.summary.hasMore ? '+' : ''} open
            {attention.summary.acknowledgedCount > 0
              ? ` · ${attention.summary.acknowledgedCount} picked up`
              : ''}
          </span>
        ) : null}
      </div>
      {error ? <p className="notice error" role="alert">{error}</p> : null}
      {attention === undefined ? (
        <>
          <LoadingLabel>Loading current work</LoadingLabel>
          <SkeletonList rows={compact ? overviewRowLimit : 5} />
        </>
      ) : rows.length === 0 ? (
        <div className="health-empty">
          <strong>Nothing needs action.</strong>
          {compact ? null : <span>No panel is short, no review is overdue, and no team is stuck.</span>}
        </div>
      ) : (
        <>
          {compact ? (
            <div className="health-list">{visibleRows.map(rowView)}</div>
          ) : (
            <div className="attention-groups">
              {groups.map((group) => {
                const expanded = expandedGroups.includes(group.detectorKey)
                const groupRows = expanded ? group.rows : group.rows.slice(0, groupRowLimit)
                const hidden = group.rows.length - groupRows.length
                return (
                  <section className="attention-group" key={group.detectorKey}>
                    <div className="attention-group-heading">
                      <h3>{attentionGroupLabels[group.detectorKey]}</h3>
                      <span>{group.rows.length}</span>
                    </div>
                    <div className="health-list">{groupRows.map(rowView)}</div>
                    {group.rows.length > groupRowLimit ? (
                      <button
                        className="attention-group-toggle"
                        type="button"
                        onClick={() => setExpandedGroups((current) => (
                          expanded
                            ? current.filter((key) => key !== group.detectorKey)
                            : [...current, group.detectorKey]
                        ))}
                      >
                        {expanded ? 'Show fewer' : `Show ${hidden} more`}
                      </button>
                    ) : null}
                  </section>
                )
              })}
            </div>
          )}
          {compact && (hiddenRowCount > 0 || attention.summary.hasMore) ? (
            <Link className="attention-view-all" to="/event-monitor">
              View event monitor
              <span>{hiddenRowCount > 0 ? `${hiddenRowCount}${attention.summary.hasMore ? '+' : ''} more` : 'More open work'}</span>
            </Link>
          ) : null}
          {!compact && attention.summary.hasMore ? (
            <p className="notice">
              Showing the {attention.summary.limit} highest-priority items. More items remain.
            </p>
          ) : null}
        </>
      )}
    </section>
  )
}

function groupAttentionRows(rows: AttentionRow[]) {
  const grouped = new Map<AttentionRow['detectorKey'], AttentionRow[]>()
  for (const row of rows) {
    const current = grouped.get(row.detectorKey)
    if (current) current.push(row)
    else grouped.set(row.detectorKey, [row])
  }
  return [...grouped].map(([detectorKey, groupRows]) => ({ detectorKey, rows: groupRows }))
}

function attentionAcknowledgeSlot(itemId: string) {
  return `attention-acknowledge:${itemId}`
}

function rowMeta(row: {
  firstObservedAt: number
  recurrenceCount: number
  acknowledged: boolean
}) {
  const parts = [`Open since ${formatClockTime(row.firstObservedAt)}`]
  if (row.recurrenceCount > 1) parts.push(`${ordinal(row.recurrenceCount)} time today`)
  if (row.acknowledged) parts.push('Picked up')
  return parts.join(' · ')
}

function ordinal(value: number) {
  const remainderOfTen = value % 10
  const remainderOfHundred = value % 100
  if (remainderOfTen === 1 && remainderOfHundred !== 11) return `${value}st`
  if (remainderOfTen === 2 && remainderOfHundred !== 12) return `${value}nd`
  if (remainderOfTen === 3 && remainderOfHundred !== 13) return `${value}rd`
  return `${value}th`
}

function severityIcon(value: 'watch' | 'attention' | 'critical'): IconName {
  if (value === 'critical') return 'alert'
  if (value === 'attention') return 'clock'
  return 'pause'
}
