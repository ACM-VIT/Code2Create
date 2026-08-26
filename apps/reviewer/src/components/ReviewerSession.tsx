import { api } from '@code2create/backend/api'
import { useAction, useConvexAuth, useMutation, useQuery } from 'convex/react'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { AcmMark, BrandBackdrop, BrandMark, BrandWordmark } from '@/components/Brand'
import { PagerAlert } from '@/components/PagerAlert'
import {
  type DutyStatus,
  useReviewerInstallationId,
} from '@/lib/duty-status'
import { judgingStatus } from '@/lib/judging-status'
import { describeError } from '@/lib/errors'
import type { ReviewerRuntime } from '@/lib/runtime'
import { palette, radius, type } from '@/theme'

// Derive duties from grants, never role labels.
export type Surface = 'reviews' | 'attendance' | 'floor' | 'support' | 'operations' | 'incidents'

type ReviewerSession = {
  runtime: ReviewerRuntime
  eventSlug: string
  who: string
  email: string
  surfaces: Surface[]
  canCreateSupport: boolean
  canManageAttention: boolean
  localReviewerFixturesEnabled: boolean
  judgingStatus: DutyStatus
  reviewHeartbeatIssue: string | null
  signOut: () => void
}

const SessionContext = createContext<ReviewerSession | null>(null)
const localReviewerFixtureEmail = 'supreme@example.test'

export function useReviewerSession() {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useReviewerSession used outside the reviewer session provider.')
  return session
}

export function ReviewerSessionProvider({
  children,
  runtime,
}: {
  children: ReactNode
  runtime: ReviewerRuntime
}) {
  const eventSlug = runtime.configuration.eventSlug
  const { data: session, isPending: sessionPending } = runtime.authClient.useSession()
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth()
  const publicState = useQuery(api.system.getPublicShellState, { eventSlug })
  const access = useQuery(
    api.access.reviewerCapabilities,
    isAuthenticated ? { eventSlug } : 'skip',
  )
  const createNativeSession = useAction(api.localDevelopment.createNativeSession)
  const heartbeat = useMutation(api.reviewer.heartbeat)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [reviewHeartbeatIssue, setReviewHeartbeatIssue] = useState<string | null>(null)

  const capabilities = access
  const hasReview = capabilities?.reviews ?? false
  const hasAttendance = capabilities?.attendance ?? false
  const hasFloor = capabilities?.floor ?? false
  const hasOperations = capabilities?.operations ?? false
  const hasIncidents = capabilities?.incidents ?? false
  const hasSupport = capabilities?.support ?? false

  // Mount paging above duty routes so it can interrupt any screen.
  const substitutePage = useQuery(
    api.reviewSubstitutions.currentPage,
    hasReview ? { eventSlug } : 'skip',
  )
  const reviewerInstallationId = useReviewerInstallationId(eventSlug)
  const reviewerDuty = useQuery(
    api.reviewer.dutyStatus,
    hasReview && reviewerInstallationId
      ? { eventSlug, installationId: reviewerInstallationId }
      : 'skip',
  )
  const currentJudgingStatus = judgingStatus(
    reviewerDuty,
    substitutePage !== undefined && substitutePage !== null,
    hasReview,
  )
  const heartbeatRoundId = reviewerDuty?.heartbeat?.roundId
  const heartbeatStatus = reviewerDuty?.heartbeat?.status

  useEffect(() => {
    if (!reviewerInstallationId || !heartbeatRoundId || !heartbeatStatus) {
      return
    }
    let active = true
    const send = async () => {
      if (AppState.currentState !== 'active') return
      try {
        await heartbeat({
          eventSlug,
          roundId: heartbeatRoundId,
          installationId: reviewerInstallationId,
        })
        if (active) setReviewHeartbeatIssue(null)
      } catch {
        if (active) {
          setReviewHeartbeatIssue(
            'Live panel updates are interrupted. Reconnect before taking an action.',
          )
        }
      }
    }
    void send()
    const timer = setInterval(() => void send(), 45_000)
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void send()
    })
    return () => {
      active = false
      clearInterval(timer)
      appStateSubscription.remove()
    }
  }, [eventSlug, heartbeat, heartbeatRoundId, heartbeatStatus, reviewerInstallationId])

  if (sessionPending || authLoading || publicState === undefined) return <Booting />
  if (isAuthenticated && access === undefined) return <Booting />

  if (!session?.session || !isAuthenticated) {
    const signIn = async () => {
      setAuthBusy(true)
      setAuthError(null)
      try {
        const result = await runtime.authClient.signIn.social({
          provider: 'google',
          callbackURL: '/',
        })
        if (result.error) {
          setAuthError('Google sign-in could not be completed. Try again.')
        }
      } catch (caught) {
        setAuthError(errorMessage(caught, 'Google sign-in could not be completed.'))
      } finally {
        setAuthBusy(false)
      }
    }
    const signInLocally = async () => {
      setAuthBusy(true)
      setAuthError(null)
      try {
        const local = await createNativeSession({
          confirmation: 'create-code2create-local-native-session',
          surface: 'reviewer',
        })
        const result = await runtime.authClient.crossDomain.oneTimeToken.verify({
          token: local.token,
        })
        if (result.error) {
          setAuthError('The local event operator could not sign in. Try again.')
          return
        }
        runtime.authClient.updateSession()
      } catch (caught) {
        setAuthError(errorMessage(caught, 'The local event operator could not sign in.'))
      } finally {
        setAuthBusy(false)
      }
    }

    return (
      <Gate
        error={authError}
        title="Sign in to work this event"
      >
        <PrimaryAction
          disabled={authBusy || !publicState.auth.googleConfigured}
          label={authBusy ? 'Opening…' : 'Continue with Google'}
          onPress={signIn}
        />
        {publicState.auth.localDevelopmentFixturesEnabled ? (
          <PrimaryAction
            disabled={authBusy}
            label="Use the local event operator"
            onPress={signInLocally}
            secondary
          />
        ) : null}
        {!publicState.auth.googleConfigured && !publicState.auth.localDevelopmentFixturesEnabled ? (
          <Text style={styles.error}>Google sign-in is unavailable. Ask an organizer to check event access.</Text>
        ) : null}
      </Gate>
    )
  }

  const signOut = () => void runtime.authClient.signOut()

  if (!access) {
    return (
      <Gate
        error={null}
        title="No access yet"
        who={session.user.email}
      >
        <PrimaryAction label="Sign out" onPress={signOut} secondary />
      </Gate>
    )
  }

  const surfaces: Surface[] = [
    ...(hasReview ? (['reviews'] as const) : []),
    ...(hasAttendance ? (['attendance'] as const) : []),
    ...(hasFloor ? (['floor'] as const) : []),
    ...(hasSupport ? (['support'] as const) : []),
    ...(hasOperations ? (['operations'] as const) : []),
    ...(hasIncidents ? (['incidents'] as const) : []),
  ]

  if (surfaces.length === 0) {
    return (
      <Gate
        error={null}
        title="Nothing assigned yet"
        who={session.user.email}
      >
        <PrimaryAction label="Sign out" onPress={signOut} secondary />
      </Gate>
    )
  }

  return (
    <SessionContext.Provider
      value={{
        runtime,
        eventSlug,
        who: session.user.name || session.user.email,
        email: session.user.email,
        surfaces,
        canCreateSupport: capabilities?.supportCreate ?? false,
        canManageAttention: capabilities?.attentionManage ?? false,
        localReviewerFixturesEnabled:
          publicState.auth.localDevelopmentFixturesEnabled
          && session.user.email === localReviewerFixtureEmail,
        judgingStatus: currentJudgingStatus,
        reviewHeartbeatIssue: heartbeatRoundId ? reviewHeartbeatIssue : null,
        signOut,
      }}
    >
      {children}
      {substitutePage ? (
        <PagerAlert
          eventSlug={eventSlug}
          installationId={reviewerInstallationId}
          page={substitutePage}
        />
      ) : null}
    </SessionContext.Provider>
  )
}

function Booting() {
  return (
    <BrandBackdrop>
      <View style={[styles.gate, styles.centred]}>
        <View>
          <BrandMark size={112} />
        </View>
        <View style={styles.bootWordmark}>
          <BrandWordmark width={252} />
        </View>
        <View style={styles.bootFoot}>
          <AcmMark size={40} />
        </View>
      </View>
    </BrandBackdrop>
  )
}

function Gate({
  children,
  error,
  title,
  who,
}: {
  children: ReactNode
  error: string | null
  title: string
  who?: string
}) {
  return (
    <BrandBackdrop>
      <SafeAreaView edges={['top', 'bottom']} style={styles.gate}>
        <View style={styles.gateBody}>
          <BrandMark size={104} />
          <View style={styles.gateWordmark}>
            <BrandWordmark width={228} />
          </View>
          <Text style={styles.title}>{title}</Text>
          {who ? <Text style={styles.who}>{who}</Text> : null}
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.actions}>{children}</View>
      </SafeAreaView>
    </BrandBackdrop>
  )
}

export function PrimaryAction({
  disabled = false,
  label,
  onPress,
  secondary = false,
}: {
  disabled?: boolean
  label: string
  onPress: () => void | Promise<void>
  secondary?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        secondary ? styles.actionSecondary : null,
        disabled ? styles.actionDisabled : null,
        pressed ? styles.actionPressed : null,
      ]}
    >
      <Text style={[styles.actionText, secondary ? styles.actionTextSecondary : null]}>{label}</Text>
    </Pressable>
  )
}

function errorMessage(caught: unknown, fallback: string) {
  return describeError(caught, fallback)
}

const styles = StyleSheet.create({
  gate: { flex: 1, paddingHorizontal: 24 },
  centred: { alignItems: 'center', justifyContent: 'center' },
  gateBody: { flex: 1, justifyContent: 'flex-end', paddingBottom: 40 },
  bootWordmark: { marginTop: 26 },
  bootFoot: { position: 'absolute', bottom: 34, alignSelf: 'center' },
  gateWordmark: { marginTop: 22 },
  title: { marginTop: 20, color: palette.text, fontSize: 26, fontWeight: '600', letterSpacing: -0.5 },
  who: { marginTop: 8, color: palette.muted, fontSize: 16 },
  error: { color: palette.urgent, fontSize: 15, lineHeight: 21, marginBottom: 12 },

  actions: { paddingBottom: 12, gap: 10 },
  action: {
    height: 56,
    borderRadius: radius.control,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.text,
  },
  actionSecondary: { backgroundColor: palette.tile },
  actionPressed: { opacity: 0.8 },
  actionDisabled: { opacity: 0.4 },
  actionText: { color: palette.background, fontSize: 17, fontWeight: '600' },
  actionTextSecondary: { color: palette.text },
  small: { ...type.small },
})
