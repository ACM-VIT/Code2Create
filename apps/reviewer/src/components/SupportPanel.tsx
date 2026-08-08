import { api } from '@code2create/backend/api'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { randomUUID } from 'expo-crypto'
import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

import type { ReviewerRuntime } from '@/lib/runtime'

type SupportCase = FunctionReturnType<typeof api.support.mine>[number]
type SupportCaseId = SupportCase['id']
type SupportCategory = SupportCase['category']
type CreateSelfArgs = FunctionArgs<typeof api.support.createSelf>
type ReplySelfArgs = FunctionArgs<typeof api.support.replySelf>

const categories = [
  ['reviewer_device', 'This phone'],
  ['queue', 'Review queue'],
  ['scorecard', 'Scorecard'],
  ['table_location', 'Hall location'],
  ['attendance_credential', 'Check-in'],
  ['integration', 'Evidence'],
  ['accessibility', 'Accessibility'],
  ['safety', 'Safety'],
] as const satisfies readonly (readonly [SupportCategory, string])[]

export function SupportPanel({ canCreate, runtime }: { canCreate: boolean; runtime: ReviewerRuntime }) {
  const eventSlug = runtime.configuration.eventSlug
  const cases = useQuery(api.support.mine, { eventSlug })
  const createCase = useMutation(api.support.createSelf)
  const [selectedId, setSelectedId] = useState<SupportCaseId | null>(null)
  const [category, setCategory] = useState<SupportCategory>('reviewer_device')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const operationRef = useRef<CreateSelfArgs | null>(null)

  const visibleSelectedId = selectedId ?? cases?.at(0)?.id ?? null

  const submit = async () => {
    const normalizedDescription = description.trim()
    if (busyRef.current || normalizedDescription.length < 10) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    const args = operationRef.current ?? {
      eventSlug,
      category,
      description: normalizedDescription,
      clientOperationId: randomUUID(),
    }
    operationRef.current = args
    try {
      const result = await createCase(args)
      operationRef.current = null
      setDescription('')
      setSelectedId(result.id)
    } catch (caught) {
      setError(errorMessage(caught, 'The support case could not be created.'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <View style={styles.panel}>
      <Text style={styles.eyebrow}>Help desk</Text>
      <Text style={styles.heading}>Support</Text>
      <Text style={styles.body}>Report a blocker without leaving the event app. A case never changes a score, attendance record, or permission by itself.</Text>

      {canCreate ? (
        <>
          <View style={styles.categoryRow}>
            {categories.map(([value, label]) => (
              <Pressable
                accessibilityRole="button"
                key={value}
                onPress={() => {
                  operationRef.current = null
                  setCategory(value)
                }}
                style={[styles.chip, category === value ? styles.chipSelected : null]}
              >
                <Text style={category === value ? styles.chipTextSelected : styles.chipText}>{label}</Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            editable={!busy}
            maxLength={2000}
            multiline
            onChangeText={(value) => {
              operationRef.current = null
              setDescription(value)
            }}
            placeholder="What happened? A short, factual description is enough."
            placeholderTextColor="#716d66"
            style={styles.input}
            value={description}
          />
          <Button disabled={busy || description.trim().length < 10} label={busy ? 'Sending…' : 'Create case'} onPress={submit} />
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </>
      ) : null}

      <View style={styles.rule} />
      <Text style={styles.label}>Your cases</Text>
      {cases === undefined ? <Text style={styles.body}>Loading cases…</Text> : null}
      {cases?.map((supportCase) => (
        <Pressable
          accessibilityRole="button"
          key={supportCase.id}
          onPress={() => setSelectedId(supportCase.id)}
          style={[styles.caseRow, visibleSelectedId === supportCase.id ? styles.caseRowSelected : null]}
        >
          <View style={styles.grow}>
            <Text style={styles.caseCode}>{supportCase.publicCode}</Text>
            <Text style={styles.caseMeta}>{categoryLabel(supportCase.category)}</Text>
          </View>
          <Text style={styles.caseState}>{stateLabel(supportCase.state)}</Text>
        </Pressable>
      ))}
      {cases?.length === 0 ? <Text style={styles.body}>No support cases yet.</Text> : null}

      {visibleSelectedId ? <SupportCaseDetail eventSlug={eventSlug} supportCaseId={visibleSelectedId} /> : null}
    </View>
  )
}

function SupportCaseDetail({ eventSlug, supportCaseId }: { eventSlug: string; supportCaseId: SupportCaseId }) {
  const detail = useQuery(api.support.detail, { eventSlug, supportCaseId })
  const reply = useMutation(api.support.replySelf)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const operationRef = useRef<ReplySelfArgs | null>(null)

  useEffect(() => {
    const pending = operationRef.current
    if (detail && pending && pending.expectedVersion !== detail.supportCase.version) {
      operationRef.current = null
    }
  }, [detail])

  if (detail === undefined) return <Text style={styles.body}>Loading case…</Text>

  const sendReply = async () => {
    const normalizedMessage = message.trim()
    if (busyRef.current || normalizedMessage.length < 2) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    const args = operationRef.current ?? {
      eventSlug,
      supportCaseId,
      expectedVersion: detail.supportCase.version,
      message: normalizedMessage,
      clientOperationId: randomUUID(),
    }
    operationRef.current = args
    try {
      await reply(args)
      operationRef.current = null
      setMessage('')
    } catch (caught) {
      setError(errorMessage(caught, 'The reply could not be sent.'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <View style={styles.detail}>
      <View style={styles.detailHeading}>
        <View style={styles.grow}>
          <Text style={styles.caseMeta}>{categoryLabel(detail.supportCase.category)}</Text>
          <Text style={styles.detailTitle}>{detail.supportCase.publicCode}</Text>
        </View>
        <Text style={styles.caseState}>{stateLabel(detail.supportCase.state)}</Text>
      </View>
      <Text style={styles.description}>{detail.supportCase.description}</Text>
      {detail.actions.map((action) => (
        <View key={action.id} style={styles.actionRow}>
          <View style={styles.detailHeading}>
            <Text style={styles.actionActor}>{action.actorName}</Text>
            <Text style={styles.actionTime}>{formatTime(action.createdAt)}</Text>
          </View>
          <Text style={styles.caseMeta}>{actionLabel(action.kind, action.nextState)}</Text>
          {action.body && action.kind !== 'opened' ? <Text style={styles.actionBody}>{action.body}</Text> : null}
        </View>
      ))}
      {detail.supportCase.canReply ? (
        <>
          <TextInput
            editable={!busy}
            maxLength={2000}
            multiline
            onChangeText={(value) => {
              operationRef.current = null
              setMessage(value)
            }}
            placeholder="Reply"
            placeholderTextColor="#716d66"
            style={styles.input}
            value={message}
          />
          <Button disabled={busy || message.trim().length < 2} label={busy ? 'Sending…' : 'Send reply'} onPress={sendReply} secondary />
        </>
      ) : <Text style={styles.body}>This case is closed. Create a new case if the issue returns.</Text>}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  )
}

function Button({ label, onPress, disabled = false, secondary = false }: {
  label: string
  onPress: () => void | Promise<void>
  disabled?: boolean
  secondary?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={() => void onPress()}
      style={[styles.button, secondary ? styles.buttonSecondary : null, disabled ? styles.disabled : null]}
    >
      <Text style={[styles.buttonText, secondary ? styles.buttonTextSecondary : null]}>{label}</Text>
    </Pressable>
  )
}

function categoryLabel(value: SupportCategory) {
  return categories.find(([category]) => category === value)?.[1] ?? value.replaceAll('_', ' ')
}

function stateLabel(value: SupportCase['state']) {
  if (value === 'investigating') return 'Investigating'
  if (value === 'waiting') return 'Waiting for you'
  if (value === 'resolved') return 'Resolved'
  if (value === 'closed') return 'Closed'
  return 'Open'
}

function actionLabel(kind: FunctionReturnType<typeof api.support.detail>['actions'][number]['kind'], nextState?: SupportCase['state']) {
  if (kind === 'opened') return 'Case opened'
  if (kind === 'reporter_reply') return 'You replied'
  if (kind === 'public_note') return 'Support replied'
  if (kind === 'state_changed') return `Status changed to ${stateLabel(nextState ?? 'open').toLowerCase()}`
  return 'Case updated'
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value)
}

function errorMessage(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback
}

const styles = StyleSheet.create({
  panel: { marginTop: 12, borderWidth: 1, borderColor: '#2c2a27', borderRadius: 8, padding: 18, gap: 14 },
  eyebrow: { color: '#d6a0aa', fontSize: 12 },
  heading: { color: '#f1eee8', fontFamily: 'Georgia', fontSize: 27 },
  body: { color: '#aaa69f', fontSize: 15, lineHeight: 22 },
  label: { color: '#77736d', fontSize: 12 },
  categoryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  chip: { borderWidth: 1, borderColor: '#34322f', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8 },
  chipSelected: { backgroundColor: '#eee9e0', borderColor: '#eee9e0' },
  chipText: { color: '#aaa69f', fontSize: 12 },
  chipTextSelected: { color: '#11110f', fontSize: 12 },
  input: { minHeight: 92, borderWidth: 1, borderColor: '#34322f', borderRadius: 6, color: '#f1eee8', padding: 12, textAlignVertical: 'top' },
  button: { minHeight: 46, borderRadius: 6, backgroundColor: '#eee9e0', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  buttonSecondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#34322f' },
  buttonText: { color: '#11110f', fontSize: 15, fontWeight: '600' },
  buttonTextSecondary: { color: '#f1eee8' },
  disabled: { opacity: 0.5 },
  error: { color: '#e3a4a4', fontSize: 14, lineHeight: 20 },
  rule: { height: 1, marginTop: 10, backgroundColor: '#2c2a27' },
  caseRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#2c2a27' },
  caseRowSelected: { borderBottomColor: '#d6a0aa' },
  grow: { flex: 1 },
  caseCode: { color: '#f1eee8', fontSize: 15, fontWeight: '600' },
  caseMeta: { color: '#77736d', fontSize: 12, marginTop: 3 },
  caseState: { color: '#aaa69f', fontSize: 12 },
  detail: { marginTop: 10, gap: 13, borderTopWidth: 1, borderTopColor: '#2c2a27', paddingTop: 18 },
  detailHeading: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  detailTitle: { color: '#f1eee8', fontFamily: 'Georgia', fontSize: 21, marginTop: 3 },
  description: { color: '#d7d2c9', fontSize: 15, lineHeight: 22 },
  actionRow: { borderTopWidth: 1, borderTopColor: '#2c2a27', paddingTop: 12 },
  actionActor: { flex: 1, color: '#d7d2c9', fontSize: 12, fontWeight: '600' },
  actionTime: { color: '#77736d', fontSize: 11 },
  actionBody: { color: '#d7d2c9', fontSize: 14, lineHeight: 20, marginTop: 8 },
})
