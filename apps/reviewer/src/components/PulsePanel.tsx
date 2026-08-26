import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { randomUUID } from 'expo-crypto'
import { useRef, useState } from 'react'
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
  Lead,
  Problem,
} from '@/components/ui'
import { describeError } from '@/lib/errors'
import { useMutationAttempt } from '@/lib/mutation-attempt'
import type { ReviewerRuntime } from '@/lib/runtime'
import { duty, palette } from '@/theme'
import { PulseSkeleton } from '@/components/skeletons'

type AttentionRow = FunctionReturnType<typeof api.operationsAttention.overview>['rows'][number]
type AttentionSeverity = AttentionRow['severity']

export function PulsePanel({ canManage, runtime }: { canManage: boolean; runtime: ReviewerRuntime }) {
  const eventSlug = runtime.configuration.eventSlug
  const attention = useQuery(api.operationsAttention.overview, { eventSlug })
  const healthState = useQuery(api.operationsHealth.overview, { eventSlug })
  const health = healthState?.state === 'ready' ? healthState.snapshot : undefined

  // Resolve the current ledger row by ID before acting on its version.
  const [selectedId, setSelectedId] = useState<AttentionRow['id'] | null>(null)

  if (attention === undefined) return <PulseSkeleton />

  const rows = attention.rows
  const unclaimed = rows.filter((row) => !row.acknowledged).length
  const selected = rows.find((row) => row.id === selectedId)

  return (
    <>
      <Lead
        accent={unclaimed > 0 ? duty.pulse.accent : palette.text}
        {...(healthState === undefined
          ? {}
          : healthState.state === 'ready'
            ? { detail: systemLine(healthState.snapshot.summary.status) }
            : {
                detail:
                  healthState.state === 'missing'
                    ? 'System checks are starting'
                    : 'System checks are delayed',
              })}
        unit={unclaimed === 1 ? 'needs someone' : 'need someone'}
        value={String(unclaimed)}
      />

      {rows.length === 0 ? (
        <Nothing>No panel is short, no review is overdue, and no team is stuck.</Nothing>
      ) : (
        <Section title="Needs someone">
          {rows.map((row) => (
            <Card
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
          {attention.summary.hasMore ? (
            <Meta>{`Showing the ${attention.summary.limit} highest-priority items. More items remain.`}</Meta>
          ) : null}
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
  const acknowledgeAttempt = useMutationAttempt<
    FunctionReturnType<typeof api.operationsAttention.acknowledge>
  >()
  const dismissAttempt = useMutationAttempt<
    FunctionReturnType<typeof api.operationsAttention.dismiss>
  >()
  const [dismissing, setDismissing] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const acknowledgeSlot = row ? `attention-acknowledge:${row.id}` : 'attention-acknowledge'
  const dismissSlot = row ? `attention-dismiss:${row.id}` : 'attention-dismiss'
  const acknowledgePending = acknowledgeAttempt.hasPending(acknowledgeSlot)
  const dismissPending = dismissAttempt.hasPending(dismissSlot)

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
      await acknowledgeAttempt.run(acknowledgeSlot, () => {
        const args = {
          eventSlug,
          itemId: row.id,
          expectedVersion: row.version,
          clientOperationId: randomUUID(),
        }
        return () => acknowledge(args)
      })
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
      await dismissAttempt.run(dismissSlot, () => {
        const args = {
          eventSlug,
          itemId: row.id,
          expectedVersion: row.version,
          reason: normalizedReason,
          clientOperationId: randomUUID(),
        }
        return () => dismiss(args)
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
                disabled={busy || (!dismissPending && reason.trim().length < 5)}
                label={busy ? 'Dismissing…' : dismissPending ? 'Confirm dismissal' : 'Dismiss it'}
                onPress={notAProblem}
              />
            </>
          ) : canManage ? (
            <>
              {!row.acknowledged ? (
                <Action
                  accent={duty.pulse.accent}
                  disabled={busy}
                  label={busy ? 'Picking up…' : acknowledgePending ? 'Confirm pickup' : 'Pick it up'}
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
