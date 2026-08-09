import { api } from '@code2create/backend/api'
import {
  supportCaseCategoryLabels,
  supportCaseCategoryOrder,
  supportCaseStateLabels,
} from '@code2create/domain'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { randomUUID } from 'expo-crypto'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import { StyleSheet, Text, View } from 'react-native'

import {
  Action,
  Body,
  Card,
  ChipRow,
  Field,
  Meta,
  Nothing,
  Problem,
  QuietAction,
  Section,
} from '@/components/ui'
import type { ReviewerRuntime } from '@/lib/runtime'
import { palette } from '@/theme'

type SupportCase = FunctionReturnType<typeof api.support.mine>[number]
type SupportCaseId = SupportCase['id']
type SupportCategory = SupportCase['category']
type SupportState = SupportCase['state']
type CreateSelfArgs = FunctionArgs<typeof api.support.createSelf>
type ReplySelfArgs = FunctionArgs<typeof api.support.replySelf>

const categories = supportCaseCategoryOrder.map(
  (category) => [category, supportCaseCategoryLabels[category]] as const,
)

/** Cases the desk owes you an answer on come first; settled ones sink. */
const stateRank: Record<SupportState, number> = {
  waiting: 0,
  open: 1,
  investigating: 2,
  resolved: 3,
  closed: 4,
}

export function SupportPanel({ canCreate, runtime }: { canCreate: boolean; runtime: ReviewerRuntime }) {
  const eventSlug = runtime.configuration.eventSlug
  const cases = useQuery(api.support.mine, { eventSlug })
  const createCase = useMutation(api.support.createSelf)
  const router = useRouter()
  const [reporting, setReporting] = useState(false)
  const [category, setCategory] = useState<SupportCategory>('reviewer_device')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const operationRef = useRef<CreateSelfArgs | null>(null)

  const sorted = cases
    ? [...cases].sort((left, right) => stateRank[left.state] - stateRank[right.state])
    : undefined
  const open = sorted?.filter((row) => row.state !== 'resolved' && row.state !== 'closed') ?? []
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
      setReporting(false)
      router.push(`/help/${result.id}`)
    } catch (caught) {
      setError(errorMessage(caught, 'The case could not be created.'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  if (sorted === undefined) return <Meta>Checking your cases…</Meta>

  return (
    <>
      <Body>
        {open.length === 0
          ? 'Nothing of yours is open.'
          : `${open.length} of your ${open.length === 1 ? 'case is' : 'cases are'} still open.`}
      </Body>

      {sorted.length > 0 ? (
        <Section title="Your cases">
          {sorted.map((supportCase) => (
            <Card
              accent={palette.setup}
              key={supportCase.id}
              onPress={() => router.push(`/help/${supportCase.id}`)}
            >
              <View style={styles.row}>
                <Text style={styles.code}>{supportCase.publicCode}</Text>
                <Text style={styles.state}>{supportCaseStateLabels[supportCase.state]}</Text>
              </View>
              <Meta>{supportCaseCategoryLabels[supportCase.category]}</Meta>
            </Card>
          ))}
        </Section>
      ) : (
        <Nothing>You have not reported anything.</Nothing>
      )}

      {/* Reporting is a one-in-a-shift act, so it stays folded away until it is
          wanted rather than sitting above the cases you came here to read. */}
      {canCreate && !reporting ? (
        <QuietAction label="Report a problem" onPress={() => setReporting(true)} />
      ) : null}

      {canCreate && reporting ? (
        <Section title="Report a problem">
          <ChipRow
            accent={palette.setup}
            onSelect={(value: SupportCategory) => {
              operationRef.current = null
              setCategory(value)
            }}
            options={categories}
            selected={category}
          />
          <Field
            editable={!busy}
            label="What happened"
            maxLength={2000}
            multiline
            onChangeText={(value) => {
              operationRef.current = null
              setDescription(value)
            }}
            placeholder="Short and factual is enough."
            value={description}
          />
          {error ? <Problem>{error}</Problem> : null}
          <Action
            accent={palette.setup}
            disabled={busy || description.trim().length < 10}
            label={busy ? 'Sending…' : 'Send to the help desk'}
            onPress={submit}
          />
          <QuietAction
            disabled={busy}
            label="Cancel"
            onPress={() => {
              operationRef.current = null
              setReporting(false)
            }}
          />
        </Section>
      ) : null}
    </>
  )
}

export function SupportCaseDetail({ eventSlug, supportCaseId }: { eventSlug: string; supportCaseId: SupportCaseId }) {
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

  if (detail === undefined) return <Meta>Opening the case…</Meta>

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
    <>
      <Card>
        <View style={styles.row}>
          <Meta>{supportCaseCategoryLabels[detail.supportCase.category]}</Meta>
          <Text style={styles.state}>{supportCaseStateLabels[detail.supportCase.state]}</Text>
        </View>
        <Body>{detail.supportCase.description}</Body>
      </Card>

      {/* The case as a conversation, oldest first, so the last thing you read
          is the last thing that happened. */}
      {detail.actions.map((action) => (
        <Card key={action.id}>
          <View style={styles.row}>
            <Text style={styles.actor}>{action.actorName}</Text>
            <Meta>{formatTime(action.createdAt)}</Meta>
          </View>
          <Meta>{actionLabel(action.kind, action.nextState)}</Meta>
          {action.body && action.kind !== 'opened' ? <Body>{action.body}</Body> : null}
        </Card>
      ))}

      {detail.supportCase.canReply ? (
        <>
          <Field
            editable={!busy}
            label="Reply"
            maxLength={2000}
            multiline
            onChangeText={(value) => {
              operationRef.current = null
              setMessage(value)
            }}
            placeholder="Add anything that would help."
            value={message}
          />
          {error ? <Problem>{error}</Problem> : null}
          <Action
            accent={palette.setup}
            disabled={busy || message.trim().length < 2}
            label={busy ? 'Sending…' : 'Send reply'}
            onPress={sendReply}
          />
        </>
      ) : (
        <Meta>This case is closed. Report a new one if it comes back.</Meta>
      )}
    </>
  )
}

function actionLabel(
  kind: FunctionReturnType<typeof api.support.detail>['actions'][number]['kind'],
  nextState?: SupportState,
) {
  if (kind === 'opened') return 'Case opened'
  if (kind === 'reporter_reply') return 'You replied'
  if (kind === 'public_note') return 'The help desk replied'
  if (kind === 'state_changed') {
    return `Now ${supportCaseStateLabels[nextState ?? 'open'].toLowerCase()}`
  }
  return 'Case updated'
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value)
}

function errorMessage(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  code: { color: palette.text, fontSize: 17, fontWeight: '600' },
  state: { color: palette.muted, fontSize: 15 },
  actor: { color: palette.text, fontSize: 15, fontWeight: '600' },
})
