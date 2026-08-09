import { api } from '@code2create/backend/api'
import { Button, Gauge, Host, Text as NativeText } from '@expo/ui/swift-ui'
import {
  buttonStyle,
  controlSize,
  font,
  disabled as disabledModifier,
  foregroundStyle,
  frame,
  gaugeStyle,
  scaleEffect,
  tint,
} from '@expo/ui/swift-ui/modifiers'
import { useMutation } from 'convex/react'
import { randomUUID } from 'expo-crypto'
import type { FunctionReturnType } from 'convex/server'
import { useEffect, useRef, useState } from 'react'
import { Dimensions, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { describeError } from '@/lib/errors'
import { palette, radius, type } from '@/theme'

export type SubstitutePage = NonNullable<
  FunctionReturnType<typeof api.reviewSubstitutions.currentPage>
>

/**
 * The pager.
 *
 * A substitute request is the one thing in this app that cannot wait for
 * someone to notice it. It takes the whole screen over whatever they were
 * doing, states the table and the clock, and offers two answers — because a
 * panel is sitting at a table unable to start until this person says yes or no.
 *
 * It deliberately looks like nothing else here: the rest of the app is calm and
 * dark, and this is not.
 */
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
  const operationRef = useRef<{ response: 'accept' | 'decline'; id: string } | null>(null)
  const openedPageRef = useRef<string | null>(null)
  const remaining = useSecondsRemaining(page.expiresAt, page.serverNow)

  const total = Math.max(1, Math.round((page.expiresAt - page.sentAt) / 1_000))
  const fraction = Math.max(0, Math.min(1, remaining / total))
  // The ring turns as the window closes, so the colour alone answers "how long
  // have I got" from across a room.
  const urgent = remaining <= 15
  const accent = urgent ? palette.urgent : palette.judging
  const expired = remaining === 0

  // Acknowledging arrival is the app's job, not the reviewer's — the panel
  // needs to know the phone woke up even if nobody has decided yet.
  useEffect(() => {
    if (page.state !== 'sent' || openedPageRef.current === page.id) return
    openedPageRef.current = page.id
    void openPage({ eventSlug, pageId: page.id, expectedVersion: page.version }).catch((caught) => {
      openedPageRef.current = null
      setError(errorMessage(caught, 'The request could not be acknowledged.'))
    })
  }, [eventSlug, openAttempt, openPage, page.id, page.state, page.version])

  const operationId = (response: 'accept' | 'decline') => {
    if (operationRef.current?.response === response) return operationRef.current.id
    const id = randomUUID()
    operationRef.current = { response, id }
    return id
  }

  const respond = async (response: 'accept' | 'decline') => {
    if (page.state !== 'opened' || busy !== null || expired) return
    if (response === 'decline' && reason.trim().length < 3) return
    if (installationId === undefined) {
      setError('Register this phone before answering.')
      return
    }
    setBusy(response)
    setError(null)
    try {
      await respondToPage({
        eventSlug,
        pageId: page.id,
        response,
        ...(response === 'decline' ? { reason } : {}),
        installationId,
        expectedVersion: page.version,
        clientOperationId: operationId(response),
      })
      operationRef.current = null
    } catch (caught) {
      setError(errorMessage(caught, 'The answer could not be saved.'))
    } finally {
      setBusy(null)
    }
  }

  const answerable = page.state === 'opened' && !expired && busy === null

  const destination = page.team?.tableLabel ?? page.team?.name ?? page.panel.name
  const beneath = page.team
    ? `${page.panel.name} · ${page.round.name}`
    : `A seat on ${page.panel.name} · ${page.round.name}`

  return (
    <Modal animationType="fade" statusBarTranslucent transparent={false} visible>
      <View style={styles.root}>
        <SafeAreaView edges={['top', 'bottom']} style={styles.safe}>
          <View style={[styles.stripe, { backgroundColor: accent }]} />

          <Text style={[styles.eyebrow, { color: accent }]}>
            {expired ? 'REQUEST EXPIRED' : 'YOU ARE NEEDED'}
          </Text>

          <View style={styles.middle}>
          {/* A native circular gauge: the ring drains, and the seconds sit in
              the middle of it, in the platform's own monospaced digits. */}
          <Host style={styles.ring}>
            <Gauge
              max={1}
              min={0}
              value={fraction}
              currentValueLabel={
                <NativeText
                  modifiers={[
                    font({ size: 64, weight: 'semibold', design: 'rounded' }),
                    foregroundStyle(accent),
                  ]}
                >
                  {countdownLabel(remaining)}
                </NativeText>
              }
              // The gauge draws at its label's size, so it is scaled up rather
              // than framed — a frame only crops it.
              modifiers={[gaugeStyle('circular'), tint(accent), scaleEffect(2.1)]}
            />
          </Host>

          {/* Largest is wherever the person has to walk. A panel walks to the
              team, so the team's table is the real destination; without one the
              team's name is the next most useful thing to shout, and a page
              raised before a session exists can only name the seat. */}
          <Text style={styles.table}>{destination}</Text>
          <Text style={styles.where}>{beneath}</Text>
          {page.team?.tableLabel ? <Text style={styles.team}>{page.team.name}</Text> : null}

          <Text style={styles.reason}>{page.reason}</Text>
          {page.criteria.length > 0 ? (
            <Text style={styles.criteria}>
              You would score {page.criteria.map((criterion) => criterion.label).join(', ')}
            </Text>
          ) : null}

          {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>

          <View style={styles.answers}>
            {page.state === 'sent' && !expired ? (
              <Pressable
                accessibilityRole="button"
                disabled={error === null}
                onPress={() => {
                  setError(null)
                  setOpenAttempt((current) => current + 1)
                }}
                style={styles.retry}
              >
                <Text style={styles.retryText}>
                  {error ? 'Try again' : 'Connecting to the panel…'}
                </Text>
              </Pressable>
            ) : declining ? (
              <>
                <Text style={styles.label}>Why not? The coordinator sees this.</Text>
                <TextInput
                  autoFocus
                  editable={busy === null}
                  onChangeText={(value) => {
                    setReason(value)
                    operationRef.current = null
                    setError(null)
                  }}
                  placeholder="Stepping away now"
                  placeholderTextColor={palette.faint}
                  style={styles.input}
                  value={reason}
                />
                <Host style={styles.control}>
                  <Button
                    modifiers={[
                      buttonStyle('borderedProminent'),
                      controlSize('extraLarge'),
                      tint(palette.urgent),
                      disabledModifier(busy !== null || reason.trim().length < 3),
                    ]}
                    role="destructive"
                    onPress={() => void respond('decline')}
                  >
                    <NativeText modifiers={[frame({ width: controlWidth, height: 30 }), font({ size: 19, weight: 'semibold' })]}>
                      {busy === 'decline' ? 'Sending…' : 'Send'}
                    </NativeText>
                  </Button>
                </Host>
                <Pressable
                  accessibilityRole="button"
                  disabled={busy !== null}
                  onPress={() => {
                    operationRef.current = null
                    setDeclining(false)
                  }}
                  style={styles.retry}
                >
                  <Text style={styles.retryText}>Back</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Host style={styles.control}>
                  <Button
                    modifiers={[
                      buttonStyle('borderedProminent'),
                      controlSize('extraLarge'),
                      tint(palette.judging),
                      disabledModifier(!answerable),
                    ]}
                    onPress={() => void respond('accept')}
                  >
                    <NativeText modifiers={[frame({ width: controlWidth, height: 30 }), font({ size: 19, weight: 'semibold' })]}>
                      {busy === 'accept' ? 'Accepting…' : "I'll take it"}
                    </NativeText>
                  </Button>
                </Host>
                <Pressable
                  accessibilityRole="button"
                  disabled={!answerable}
                  onPress={() => setDeclining(true)}
                  style={styles.retry}
                >
                  <Text style={styles.retryText}>
                    {expired ? 'The panel has moved on' : "I can't"}
                  </Text>
                </Pressable>
              </>
            )}
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  )
}

/**
 * Counts down against the server's clock, carried forward by the device's own
 * elapsed time between updates rather than its wall clock.
 */
function useSecondsRemaining(expiresAt: number, serverNow: number) {
  // The device's wall clock is only ever read as a delta between ticks, never
  // as an absolute, so a phone set to the wrong date still counts down right.
  // A newer server clock only ever moves the estimate forward.
  const [estimated, setEstimated] = useState(serverNow)
  useEffect(() => {
    const observedAt = Date.now()
    const timer = setInterval(() => setEstimated(serverNow + Date.now() - observedAt), 1_000)
    return () => clearInterval(timer)
  }, [serverNow])
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

const screenPadding = 24
const controlWidth = Dimensions.get('window').width - screenPadding * 2

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#121213' },
  safe: { flex: 1, paddingHorizontal: screenPadding, alignItems: 'center' },

  /* A colour bar across the very top. Peripheral vision catches it before
     anyone has read a word. */
  stripe: { height: 5, alignSelf: 'stretch', marginHorizontal: -screenPadding },

  eyebrow: { marginTop: 26, fontSize: 13, fontWeight: '700', letterSpacing: 1.6 },
  middle: { flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  ring: { height: 200, alignSelf: 'stretch' },

  table: { marginTop: 30, color: palette.text, fontSize: 40, fontWeight: '600', letterSpacing: -1 },
  where: { marginTop: 4, color: palette.muted, fontSize: 16 },
  team: { marginTop: 12, color: palette.text, fontSize: 20, fontWeight: '500' },

  reason: {
    marginTop: 18,
    color: palette.text,
    fontSize: 17,
    lineHeight: 24,
    textAlign: 'center',
  },
  criteria: { marginTop: 8, color: palette.muted, fontSize: 15, textAlign: 'center' },
  error: { marginTop: 14, color: palette.urgent, fontSize: 15, textAlign: 'center' },

  /* Answers sit on the bottom edge, where a thumb already is. */
  answers: { alignSelf: 'stretch', paddingBottom: 8 },
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
  retry: { marginTop: 14, alignItems: 'center', paddingVertical: 10 },
  retryText: { color: palette.muted, fontSize: 17 },
})
