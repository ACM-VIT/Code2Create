import { api } from '@code2create/backend/api'
import { useMutation } from 'convex/react'
import { randomUUID } from 'expo-crypto'

import { startPagerAlarm, stopPagerAlarm } from '@/lib/pager-alarm'
import type { FunctionReturnType } from 'convex/server'
import { useEffect, useRef, useState } from 'react'
import { Modal, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import Svg, { Circle } from 'react-native-svg'

import { Action, ErrorSheet, QuietAction } from '@/components/ui'
import { describeError } from '@/lib/errors'
import { useMutationAttempt } from '@/lib/mutation-attempt'
import { useEstimatedServerNow } from '@/lib/use-estimated-server-now'
import { palette, radius, type } from '@/theme'

export type SubstitutePage = NonNullable<
  FunctionReturnType<typeof api.reviewSubstitutions.currentPage>
>

export function PagerAlert({
  eventSlug,
  installationId,
  page,
}: {
  eventSlug: string
  installationId: string | undefined
  page: SubstitutePage
}) {
  const openPage = useMutation(api.reviewSubstitutions.openPage)
  const respondToPage = useMutation(api.reviewSubstitutions.respondToPage)
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openAttempt, setOpenAttempt] = useState(0)
  const responseAttempt = useMutationAttempt<FunctionReturnType<typeof api.reviewSubstitutions.respondToPage>>()
  const [pendingResponse, setPendingResponse] = useState<'accept' | 'decline' | null>(null)
  const responsePending = responseAttempt.hasPending(`page-response:${page.id}`)
  const openedPageRef = useRef<string | null>(null)
  const remaining = useSecondsRemaining(page.expiresAt, page.serverNow)

  const total = Math.max(1, Math.round((page.expiresAt - page.sentAt) / 1_000))
  const fraction = Math.max(0, Math.min(1, remaining / total))
  const urgent = remaining <= 15
  const accent = urgent ? palette.urgent : palette.judging
  const expired = remaining === 0

  useEffect(() => {
    if (expired) {
      stopPagerAlarm()
      return
    }
    startPagerAlarm()
    return stopPagerAlarm
  }, [expired])

  useEffect(() => {
    if (page.state !== 'sent' || openedPageRef.current === page.id) return
    openedPageRef.current = page.id
    void openPage({ eventSlug, pageId: page.id, expectedVersion: page.version }).catch((caught) => {
      openedPageRef.current = null
      setError(errorMessage(caught, 'The request could not be acknowledged.'))
    })
  }, [eventSlug, openAttempt, openPage, page.id, page.state, page.version])

  const respond = async (response: 'accept' | 'decline') => {
    if (page.state !== 'opened' || busy !== null || expired) return
    if (pendingResponse !== null && pendingResponse !== response) return
    if (response === 'decline' && reason.trim().length < 3) return
    if (installationId === undefined) {
      setError('Register this phone before answering.')
      return
    }
    setBusy(response)
    setError(null)
    if (!responsePending) setPendingResponse(response)
    try {
      await responseAttempt.run(`page-response:${page.id}`, () => {
        const args = {
          eventSlug,
          pageId: page.id,
          response,
          ...(response === 'decline' ? { reason } : {}),
          installationId,
          expectedVersion: page.version,
          clientOperationId: randomUUID(),
        }
        return () => respondToPage(args)
      })
      setPendingResponse(null)
      stopPagerAlarm()
    } catch (caught) {
      if (!responseAttempt.hasPending(`page-response:${page.id}`)) setPendingResponse(null)
      setError(errorMessage(caught, 'The answer could not be saved.'))
    } finally {
      setBusy(null)
    }
  }

  const answerable = page.state === 'opened' && !expired && busy === null && pendingResponse === null

  const destination = page.team?.tableLabel ?? page.team?.name ?? page.panel.name
  const beneath = page.team
    ? `${page.panel.name} · ${page.round.name}`
    : `A seat on ${page.panel.name} · ${page.round.name}`

  return (
    <Modal animationType="fade" statusBarTranslucent transparent={false} visible>
      <View style={styles.root}>
        <SafeAreaView edges={['top', 'bottom']} style={styles.safe}>
          <View style={styles.eyebrowRow}>
            <View style={[styles.eyebrowPill, { backgroundColor: `${accent}1F` }]}>
              <View style={[styles.eyebrowDot, { backgroundColor: accent }]} />
              <Text style={[styles.eyebrow, { color: accent }]}>
                {expired ? 'Request expired' : 'You are needed'}
              </Text>
            </View>
          </View>

          <ScrollView
            contentContainerStyle={styles.middleContent}
            showsVerticalScrollIndicator={false}
            style={styles.middle}
          >
          <CountdownRing accent={accent} fraction={fraction} label={countdownLabel(remaining)} />

          <Text numberOfLines={1} style={styles.table}>{destination}</Text>
          <Text numberOfLines={1} style={styles.where}>{beneath}</Text>

          <View style={styles.detail}>
            {page.team?.tableLabel ? (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Team</Text>
                <Text numberOfLines={1} style={styles.detailValue}>{page.team.name}</Text>
              </View>
            ) : null}
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Why</Text>
              <Text style={styles.detailValue}>{page.reason}</Text>
            </View>
            {page.criteria.length > 0 ? (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>You score</Text>
                <Text style={styles.detailValue}>
                  {page.criteria.map((criterion) => criterion.label).join(', ')}
                </Text>
              </View>
            ) : null}
          </View>

          </ScrollView>

          <View style={styles.answers}>
            {page.state === 'sent' && !expired ? (
              <QuietAction
                disabled={error === null}
                label={error ? 'Try again' : 'Connecting to the panel…'}
                onPress={() => {
                  setError(null)
                  setOpenAttempt((current) => current + 1)
                }}
              />
            ) : declining ? (
              <>
                <Text style={styles.label}>Why not? The coordinator sees this.</Text>
                <TextInput
                  autoFocus
                  editable={busy === null && !responsePending}
                  onChangeText={(value) => {
                    setReason(value)
                    setError(null)
                  }}
                  placeholder="Stepping away now"
                  placeholderTextColor={palette.faint}
                  style={styles.input}
                  value={reason}
                />
                <Action
                  destructive
                  disabled={busy !== null || reason.trim().length < 3 || pendingResponse === 'accept'}
                  label={busy === 'decline' ? 'Sending…' : pendingResponse === 'decline' ? 'Confirm earlier decline' : 'Send'}
                  onPress={() => respond('decline')}
                />
                <QuietAction
                  disabled={busy !== null || responsePending}
                  label="Back"
                  onPress={() => {
                    setDeclining(false)
                  }}
                />
              </>
            ) : (
              <>
                <Action
                  accent={palette.judging}
                  disabled={!answerable && pendingResponse !== 'accept'}
                  label={busy === 'accept' ? 'Accepting…' : pendingResponse === 'accept' ? 'Confirm earlier acceptance' : "I'll take it"}
                  onPress={() => respond('accept')}
                />
                <QuietAction
                  disabled={!answerable}
                  label={expired ? 'The panel has moved on' : "I can't"}
                  onPress={() => setDeclining(true)}
                />
              </>
            )}
          </View>
        </SafeAreaView>

        <ErrorSheet message={error} onClose={() => setError(null)} />
      </View>
    </Modal>
  )
}

function useSecondsRemaining(expiresAt: number, serverNow: number) {
  const estimated = useEstimatedServerNow(serverNow)
  return Math.max(0, Math.ceil((expiresAt - Math.max(estimated, serverNow)) / 1_000))
}

function countdownLabel(seconds: number) {
  if (seconds < 60) return String(seconds)
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds - minutes * 60).padStart(2, '0')}`
}

function errorMessage(caught: unknown, fallback: string) {
  return describeError(caught, fallback)
}

function CountdownRing({
  accent,
  fraction,
  label,
}: {
  accent: string
  fraction: number
  label: string
}) {
  const filled = Math.max(0, Math.min(1, fraction))
  const radiusPx = (ringSize - ringStroke) / 2
  const circumference = 2 * Math.PI * radiusPx
  return (
    <View style={styles.ring}>
      <Svg height={ringSize} width={ringSize}>
        <Circle
          cx={ringSize / 2}
          cy={ringSize / 2}
          fill="none"
          r={radiusPx}
          stroke={palette.strong}
          strokeWidth={ringStroke}
        />
        <Circle
          cx={ringSize / 2}
          cy={ringSize / 2}
          fill="none"
          r={radiusPx}
          stroke={accent}
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={circumference * (1 - filled)}
          strokeLinecap="round"
          strokeWidth={ringStroke}
          transform={`rotate(-90 ${ringSize / 2} ${ringSize / 2})`}
        />
      </Svg>
      <View style={styles.ringCentre} pointerEvents="none">
        <Text allowFontScaling={false} style={[styles.ringLabel, { color: accent }]}>
          {label}
        </Text>
      </View>
    </View>
  )
}

const screenPadding = 24
const ringSize = 176
const ringStroke = 12

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background },
  safe: { flex: 1, paddingHorizontal: screenPadding, alignItems: 'center' },

  eyebrowRow: { marginTop: 22, alignSelf: 'stretch', alignItems: 'center' },
  eyebrowPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderRadius: radius.control,
  },
  eyebrowDot: { width: 8, height: 8, borderRadius: 4 },
  eyebrow: { fontSize: 15, fontWeight: '600', letterSpacing: 0.2 },
  middle: { flex: 1, alignSelf: 'stretch' },
  middleContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 8 },
  ring: { width: ringSize, height: ringSize, alignItems: 'center', justifyContent: 'center' },
  ringCentre: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringLabel: { fontSize: 46, fontWeight: '600', letterSpacing: -1.5, fontVariant: ['tabular-nums'] },

  table: { marginTop: 24, color: palette.text, fontSize: 38, fontWeight: '700', letterSpacing: -1 },
  where: { marginTop: 6, color: palette.muted, fontSize: 16 },

  detail: {
    marginTop: 20,
    alignSelf: 'stretch',
    gap: 12,
    padding: 18,
    borderRadius: radius.tile,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  detailRow: { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  detailLabel: { width: 88, color: palette.faint, fontSize: 15 },
  detailValue: { flex: 1, color: palette.text, fontSize: 16, lineHeight: 22 },

  reason: {
    marginTop: 18,
    color: palette.text,
    fontSize: 17,
    lineHeight: 24,
    textAlign: 'center',
  },
  criteria: { marginTop: 8, color: palette.muted, fontSize: 15, textAlign: 'center' },

  answers: { alignSelf: 'stretch', paddingTop: 14, paddingBottom: 8 },
  control: { alignSelf: 'stretch', height: 66 },
  label: { color: palette.muted, ...type.small, marginBottom: 8 },
  input: {
    marginBottom: 12,
    paddingHorizontal: 14,
    height: 52,
    color: palette.text,
    fontSize: 17,
    backgroundColor: palette.tile,
    borderRadius: radius.tile,
  },
})
