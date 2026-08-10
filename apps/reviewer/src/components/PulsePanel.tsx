import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import {
  Action,
  Body,
  Card,
  Field,
  Meta,
  Nothing,
  QuietAction,
  Section,
  Sheet,
  Shell,
  Lead,
  Problem,
} from '@/components/ui'
import { describeError } from '@/lib/errors'
import type { ReviewerRuntime } from '@/lib/runtime'
import { duty, palette } from '@/theme'

type AttentionRow = FunctionReturnType<typeof api.operationsAttention.overview>['rows'][number]
type AttentionSeverity = AttentionRow['severity']

/**
 * The health query is pure, so Convex would happily serve it forever from the
 * moment it was first read; the changing bucket is what makes it re-run. The
 * dashboard ticks every thirty seconds because somebody is watching it — a
 * phone is glanced at, so a minute is enough.
 */
const healthRefreshMs = 60_000

/**
 * The event's vitals, for the person whose duty is the whole event.
 *
 * The attention ledger leads because its rows are the walking work: each one
 * names a table, a team or a seat that needs a person, and picking one up from
 * wherever you are standing is exactly what a phone is for. Following a row to
 * its workspace — the round board, the queue — stays on the dashboard; what
 * belongs here is claiming the job and silencing the false alarms.
 */
export function PulsePanel({ canManage, runtime }: { canManage: boolean; runtime: ReviewerRuntime }) {
  const eventSlug = runtime.configuration.eventSlug
  const attention = useQuery(api.operationsAttention.overview, { eventSlug })
  const [refreshBucket, setRefreshBucket] = useState(() => Math.floor(Date.now() / healthRefreshMs))
  useEffect(() => {
    const interval = setInterval(
      () => setRefreshBucket(Math.floor(Date.now() / healthRefreshMs)),
      healthRefreshMs,
    )
    return () => clearInterval(interval)
  }, [])
  const health = useQuery(api.operationsHealth.overview, { eventSlug, refreshBucket })

  // The sheet holds an id, not a copy of the row: the ledger keeps moving
  // underneath it, and acting on a stale version is exactly what the server's
  // version check exists to refuse.
  const [selectedId, setSelectedId] = useState<AttentionRow['id'] | null>(null)

  if (attention === undefined) return <Shell />

  const rows = attention.rows
  const unclaimed = rows.filter((row) => !row.acknowledged).length
  const selected = rows.find((row) => row.id === selectedId)

  return (
    <>
      <Lead
        accent={unclaimed > 0 ? duty.pulse.accent : palette.text}
        {...(health === undefined ? {} : { detail: systemLine(health.summary.status) })}
        unit={unclaimed === 1 ? 'needs someone' : 'need someone'}
        value={String(unclaimed)}
      />

      {rows.length === 0 ? (
        <Nothing>No panel is short, no review is overdue, and no team is stuck.</Nothing>
      ) : (
        <Section title="Needs someone">
          {rows.map((row) => (
            <Card
              accent={severityColour(row.severity)}
              key={row.id}
              onPress={() => setSelectedId(row.id)}
              selected={row.severity === 'critical' && !row.acknowledged}
            >
              <View style={styles.cardTop}>
                <Text style={[styles.severity, { color: severityColour(row.severity) }]}>
                  {severityWord(row.severity)}
                </Text>
                <Meta>{sinceLine(row)}</Meta>
              </View>
              <Body>{row.statement}</Body>
              {row.acknowledged ? <Meta>Someone has picked this up</Meta> : null}
            </Card>
          ))}
        </Section>
      )}

      {health !== undefined && health.signals.length > 0 ? (
        <Section title="System checks">
          {health.signals.map((signal) => (
            <Card key={signal.key}>
              <View style={styles.cardTop}>
                <Text style={styles.signalTitle}>{signal.title}</Text>
                <Text style={[styles.signalCount, { color: severityColour(signal.severity) }]}>
                  {signal.count}
                  {signal.atLeast ? '+' : ''}
                </Text>
              </View>
              <Meta>{`${signal.detail} ${signal.owner} handles this.`}</Meta>
            </Card>
          ))}
        </Section>
      ) : null}

      <AttentionSheet
        canManage={canManage}
        eventSlug={eventSlug}
        onClose={() => setSelectedId(null)}
        row={selected}
        visible={selectedId !== null}
      />
    </>
  )
}

/**
 * One row, held open. Picking it up is one press; dismissing asks why first,
 * because a dismissal tells every other operator to stop looking at it.
 */
function AttentionSheet({
  canManage,
  eventSlug,
  onClose,
  row,
  visible,
}: {
  canManage: boolean
  eventSlug: string
  onClose: () => void
  row: AttentionRow | undefined
  visible: boolean
}) {
  const acknowledge = useMutation(api.operationsAttention.acknowledge)
  const dismiss = useMutation(api.operationsAttention.dismiss)
  const [dismissing, setDismissing] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)

  const close = () => {
    setDismissing(false)
    setReason('')
    setError(null)
    onClose()
  }

  const pickUp = async () => {
    if (busyRef.current || !row) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await acknowledge({ eventSlug, itemId: row.id, expectedVersion: row.version })
      close()
    } catch (caught) {
      setError(describeError(caught, 'That could not be picked up.'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const notAProblem = async () => {
    const normalizedReason = reason.trim()
    if (busyRef.current || !row || normalizedReason.length < 5) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await dismiss({
        eventSlug,
        itemId: row.id,
        expectedVersion: row.version,
        reason: normalizedReason,
      })
      close()
    } catch (caught) {
      setError(describeError(caught, 'That could not be dismissed.'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <Sheet onClose={close} title={row ? severityWord(row.severity) : 'Attention'} visible={visible}>
      {/* The sweep may resolve the row while this sheet is open. That is good
          news, and the sheet says so instead of acting on a ghost. */}
      {!row ? (
        <Nothing>This cleared while you were reading.</Nothing>
      ) : (
        <>
          <Body>{row.statement}</Body>
          <Meta>{sinceLine(row)}</Meta>
          {row.acknowledged ? <Meta>Someone has picked this up</Meta> : null}
          {error ? <Problem>{error}</Problem> : null}
          {canManage && dismissing ? (
            <>
              <Field
                editable={!busy}
                label="Why this is not a problem"
                maxLength={500}
                multiline
                onChangeText={setReason}
                placeholder="Why nobody needs to act on it."
                value={reason}
              />
              <Action
                destructive
                disabled={busy || reason.trim().length < 5}
                label={busy ? 'Dismissing…' : 'Dismiss it'}
                onPress={notAProblem}
              />
            </>
          ) : canManage ? (
            <>
              {!row.acknowledged ? (
                <Action
                  accent={duty.pulse.accent}
                  disabled={busy}
                  label={busy ? 'Picking up…' : 'Pick it up'}
                  onPress={pickUp}
                />
              ) : null}
              <QuietAction disabled={busy} label="Not a problem" onPress={() => setDismissing(true)} />
            </>
          ) : null}
        </>
      )}
    </Sheet>
  )
}

function severityWord(severity: AttentionSeverity) {
  if (severity === 'critical') return 'Critical'
  if (severity === 'attention') return 'Needs someone'
  return 'Watch'
}

function severityColour(severity: AttentionSeverity) {
  if (severity === 'critical') return palette.urgent
  if (severity === 'attention') return duty.pulse.accent
  return palette.muted
}

function systemLine(status: 'healthy' | 'watch' | 'attention' | 'critical') {
  if (status === 'healthy') return 'Systems clear'
  if (status === 'watch') return 'Systems on watch'
  if (status === 'attention') return 'Systems need attention'
  return 'Systems critical'
}

/** How long it has been open and whether tonight has seen it before. */
function sinceLine(row: { firstObservedAt: number; recurrenceCount: number }) {
  const since = new Date(row.firstObservedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
  if (row.recurrenceCount > 1) return `Since ${since} · ${ordinal(row.recurrenceCount)} time today`
  return `Since ${since}`
}

function ordinal(value: number) {
  const tens = value % 10
  const hundreds = value % 100
  if (tens === 1 && hundreds !== 11) return `${value}st`
  if (tens === 2 && hundreds !== 12) return `${value}nd`
  if (tens === 3 && hundreds !== 13) return `${value}rd`
  return `${value}th`
}

const styles = StyleSheet.create({
  cardTop: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  severity: { fontSize: 15, fontWeight: '600' },
  signalTitle: { flexShrink: 1, color: palette.text, fontSize: 17 },
  signalCount: { fontSize: 17, fontWeight: '600' },
})
