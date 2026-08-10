import { api } from '@code2create/backend/api'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { randomUUID } from 'expo-crypto'
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import {
  Action,
  Body,
  Card,
  ChipRow,
  Field,
  Lead,
  Meta,
  Nothing,
  Problem,
  QuietAction,
  Section,
  Sheet,
  Shell,
} from '@/components/ui'
import { describeError } from '@/lib/errors'
import type { ReviewerRuntime } from '@/lib/runtime'
import { duty, palette } from '@/theme'

type ServiceKey = 'attendance_backend' | 'review_backend'
type ForService = FunctionReturnType<typeof api.incidents.forService>
type Incident = ForService['incidents'][number] & { service: ServiceKey }
type IncidentSeverity = Incident['severity']
type CreateArgs = FunctionArgs<typeof api.incidents.create>
type ApproveArgs = FunctionArgs<typeof api.incidents.approveManualMode>
type ResolveArgs = FunctionArgs<typeof api.incidents.resolve>

const serviceLabels: Record<ServiceKey, string> = {
  attendance_backend: 'Door scanning',
  review_backend: 'Judging',
}

const severityOptions = [
  ['service_disruption', 'Disruption'],
  ['major', 'Major'],
  ['critical', 'Critical'],
] as const

/**
 * Declared emergencies, from wherever the declarer is standing.
 *
 * The dashboard already runs the paper recovery that hangs off an incident —
 * sheets, manual records, imports. What it cannot do is be in the pocket of
 * the second approver while a scan queue stands still: paper fallback needs
 * two distinct people to say yes, and the second one is usually walking the
 * hall. Declaring, approving and resolving live here; the recovery work the
 * incident unlocks stays where the keyboards are.
 */
export function IncidentPanel({ runtime }: { runtime: ReviewerRuntime }) {
  const eventSlug = runtime.configuration.eventSlug
  const door = useQuery(api.incidents.forService, { eventSlug, affectedService: 'attendance_backend' })
  const judging = useQuery(api.incidents.forService, { eventSlug, affectedService: 'review_backend' })
  const [selectedId, setSelectedId] = useState<Incident['id'] | null>(null)
  const [declaring, setDeclaring] = useState(false)

  if (door === undefined || judging === undefined) return <Shell />

  const incidents: Incident[] = [
    ...door.incidents.map((incident) => ({ ...incident, service: 'attendance_backend' as const })),
    ...judging.incidents.map((incident) => ({ ...incident, service: 'review_backend' as const })),
  ].sort((left, right) => right.openedAt - left.openedAt)
  const live = incidents.filter((incident) => incident.state !== 'resolved')
  const settled = incidents.filter((incident) => incident.state === 'resolved').slice(0, 3)
  const selected = live.find((incident) => incident.id === selectedId)
  const canCreate = door.canCreate || judging.canCreate

  return (
    <>
      <Lead
        accent={live.length > 0 ? duty.incident.accent : palette.text}
        unit={live.length === 1 ? 'incident live' : 'incidents live'}
        value={String(live.length)}
      />

      {live.length === 0 ? (
        <Nothing>Nothing is declared broken.</Nothing>
      ) : (
        <Section title="Live">
          {live.map((incident) => (
            <Card
              accent={duty.incident.accent}
              key={incident.id}
              onPress={() => setSelectedId(incident.id)}
              selected={incident.severity === 'critical'}
            >
              <View style={styles.cardTop}>
                <Text style={styles.title}>{incident.title}</Text>
                <Text style={styles.severity}>{severityWord(incident.severity)}</Text>
              </View>
              <Body>{incident.summary}</Body>
              <Meta>{`${serviceLabels[incident.service]} · since ${formatTime(incident.openedAt)}`}</Meta>
              {paperLine(incident) ? <Meta>{paperLine(incident)}</Meta> : null}
            </Card>
          ))}
        </Section>
      )}

      {settled.length > 0 ? (
        <Section title="Settled">
          {settled.map((incident) => (
            <Card key={incident.id}>
              <View style={styles.cardTop}>
                <Text style={styles.title}>{incident.title}</Text>
                <Meta>
                  {incident.resolvedAt === undefined ? 'Resolved' : `Resolved ${formatTime(incident.resolvedAt)}`}
                </Meta>
              </View>
              <Meta>{serviceLabels[incident.service]}</Meta>
            </Card>
          ))}
        </Section>
      ) : null}

      {/* Declaring is a once-a-crisis act, so it hides in a sheet rather than
          standing armed on a screen people open to read. */}
      {canCreate ? <QuietAction label="Declare an incident" onPress={() => setDeclaring(true)} /> : null}

      <IncidentSheet
        eventSlug={eventSlug}
        incident={selected}
        onClose={() => setSelectedId(null)}
        visible={selectedId !== null}
      />
      {canCreate ? (
        <DeclareSheet eventSlug={eventSlug} onClose={() => setDeclaring(false)} visible={declaring} />
      ) : null}
    </>
  )
}

/**
 * One incident, held open. The primary action is whatever this person can move
 * forward: the second paper approval while it is wanted, resolution once the
 * paper is dealt with. Both ask for the reason the audit trail keeps.
 */
function IncidentSheet({
  eventSlug,
  incident,
  onClose,
  visible,
}: {
  eventSlug: string
  incident: Incident | undefined
  onClose: () => void
  visible: boolean
}) {
  const approve = useMutation(api.incidents.approveManualMode)
  const resolve = useMutation(api.incidents.resolve)
  const [step, setStep] = useState<'facts' | 'approve' | 'resolve'>('facts')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const approveRef = useRef<ApproveArgs | null>(null)
  const resolveRef = useRef<ResolveArgs | null>(null)

  // A retried command must carry the arguments of the first attempt, but a
  // command aimed at a version that no longer exists is not a retry — it is a
  // mistake the server would refuse forever.
  useEffect(() => {
    if (incident && approveRef.current && approveRef.current.expectedIncidentVersion !== incident.version) {
      approveRef.current = null
    }
    if (incident && resolveRef.current && resolveRef.current.expectedIncidentVersion !== incident.version) {
      resolveRef.current = null
    }
  }, [incident])

  const close = () => {
    setStep('facts')
    setReason('')
    setError(null)
    approveRef.current = null
    resolveRef.current = null
    onClose()
  }

  const submitApproval = async () => {
    const normalizedReason = reason.trim()
    if (busyRef.current || !incident || normalizedReason.length < 5) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    const args = approveRef.current ?? {
      eventSlug,
      incidentId: incident.id,
      expectedIncidentVersion: incident.version,
      reason: normalizedReason,
      clientOperationId: randomUUID(),
    }
    approveRef.current = args
    try {
      await approve(args)
      close()
    } catch (caught) {
      setError(describeError(caught, 'The approval could not be recorded.'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const submitResolution = async () => {
    const normalizedReason = reason.trim()
    if (busyRef.current || !incident || normalizedReason.length < 5) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    const args = resolveRef.current ?? {
      eventSlug,
      incidentId: incident.id,
      expectedIncidentVersion: incident.version,
      reason: normalizedReason,
      clientOperationId: randomUUID(),
    }
    resolveRef.current = args
    try {
      await resolve(args)
      close()
    } catch (caught) {
      setError(describeError(caught, 'The incident could not be resolved.'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <Sheet onClose={close} title={incident?.title ?? 'Incident'} visible={visible}>
      {!incident ? (
        <Nothing>This was resolved while you were reading.</Nothing>
      ) : (
        <>
          <Body>{incident.summary}</Body>
          <Meta>
            {`${serviceLabels[incident.service]} · ${severityWord(incident.severity)} · since ${formatTime(incident.openedAt)}`}
          </Meta>
          {paperLine(incident) ? <Meta>{paperLine(incident)}</Meta> : null}
          {incident.approvals.length > 0 ? (
            <Meta>
              {`Approved by ${incident.approvals.map((approval) => approval.displayName).join(' · ')}`}
            </Meta>
          ) : null}
          {error ? <Problem>{error}</Problem> : null}

          {step === 'approve' ? (
            <>
              <Field
                editable={!busy}
                label="Why paper is needed"
                maxLength={300}
                multiline
                onChangeText={(value) => {
                  approveRef.current = null
                  setReason(value)
                }}
                placeholder="What is down, as you can see it."
                value={reason}
              />
              <Action
                accent={duty.incident.accent}
                disabled={busy || reason.trim().length < 5}
                label={busy ? 'Approving…' : 'Approve paper fallback'}
                onPress={submitApproval}
              />
            </>
          ) : step === 'resolve' ? (
            <>
              <Field
                editable={!busy}
                label="How service recovered"
                maxLength={300}
                multiline
                onChangeText={(value) => {
                  resolveRef.current = null
                  setReason(value)
                }}
                placeholder="What came back, and how you know."
                value={reason}
              />
              <Action
                accent={duty.incident.accent}
                disabled={busy || reason.trim().length < 5}
                label={busy ? 'Resolving…' : 'Resolve it'}
                onPress={submitResolution}
              />
            </>
          ) : (
            <>
              {incident.canApproveManualMode ? (
                <Action
                  accent={duty.incident.accent}
                  label="Approve paper fallback"
                  onPress={() => {
                    setError(null)
                    setStep('approve')
                  }}
                />
              ) : null}
              {incident.canResolve ? (
                incident.canApproveManualMode ? (
                  <QuietAction
                    label="Resolve it"
                    onPress={() => {
                      setError(null)
                      setStep('resolve')
                    }}
                  />
                ) : (
                  <Action
                    accent={duty.incident.accent}
                    label="Resolve it"
                    onPress={() => {
                      setError(null)
                      setStep('resolve')
                    }}
                  />
                )
              ) : null}
            </>
          )}
        </>
      )}
    </Sheet>
  )
}

/**
 * Declaring names the service and how badly it is hurt, in the words the whole
 * platform uses for both. Everything an incident later unlocks — pauses, paper
 * sheets, manual records — hangs off getting these two right.
 */
function DeclareSheet({
  eventSlug,
  onClose,
  visible,
}: {
  eventSlug: string
  onClose: () => void
  visible: boolean
}) {
  const create = useMutation(api.incidents.create)
  const [service, setService] = useState<ServiceKey>('attendance_backend')
  const [severity, setSeverity] = useState<IncidentSeverity>('service_disruption')
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const operationRef = useRef<CreateArgs | null>(null)

  const ready = title.trim().length >= 3 && summary.trim().length >= 10

  const close = () => {
    operationRef.current = null
    setError(null)
    onClose()
  }

  const declare = async () => {
    if (busyRef.current || !ready) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    const args = operationRef.current ?? {
      eventSlug,
      title: title.trim(),
      summary: summary.trim(),
      severity,
      affectedService: service,
      clientOperationId: randomUUID(),
    }
    operationRef.current = args
    try {
      await create(args)
      operationRef.current = null
      setTitle('')
      setSummary('')
      close()
    } catch (caught) {
      setError(describeError(caught, 'The incident could not be declared.'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <Sheet onClose={close} title="Declare an incident" visible={visible}>
      <ChipRow
        accent={duty.incident.accent}
        onSelect={(value: ServiceKey) => {
          operationRef.current = null
          setService(value)
        }}
        options={[
          ['attendance_backend', serviceLabels.attendance_backend],
          ['review_backend', serviceLabels.review_backend],
        ]}
        selected={service}
      />
      <ChipRow
        accent={duty.incident.accent}
        onSelect={(value: IncidentSeverity) => {
          operationRef.current = null
          setSeverity(value)
        }}
        options={severityOptions}
        selected={severity}
      />
      <Field
        editable={!busy}
        label="What to call it"
        maxLength={100}
        onChangeText={(value) => {
          operationRef.current = null
          setTitle(value)
        }}
        placeholder="Scanners down at the main door"
        value={title}
      />
      <Field
        editable={!busy}
        label="What is happening"
        maxLength={500}
        multiline
        onChangeText={(value) => {
          operationRef.current = null
          setSummary(value)
        }}
        placeholder="Short and factual is enough."
        value={summary}
      />
      {error ? <Problem>{error}</Problem> : null}
      <Action
        accent={duty.incident.accent}
        disabled={busy || !ready}
        label={busy ? 'Declaring…' : 'Declare it'}
        onPress={declare}
      />
    </Sheet>
  )
}

function severityWord(severity: IncidentSeverity) {
  if (severity === 'critical') return 'Critical'
  if (severity === 'major') return 'Major'
  return 'Disruption'
}

/** Where the paper fallback stands, only while that is a live question. */
function paperLine(incident: Incident) {
  if (incident.manualModeState === 'pending') {
    return `Paper fallback: ${incident.manualModeApprovalCount} of 2 approvals`
  }
  if (incident.manualModeState === 'approved') return 'Paper fallback approved'
  return null
}

function formatTime(value: number) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const styles = StyleSheet.create({
  cardTop: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  title: { flexShrink: 1, color: palette.text, fontSize: 17, fontWeight: '600' },
  severity: { color: palette.urgent, fontSize: 15, fontWeight: '600' },
})
