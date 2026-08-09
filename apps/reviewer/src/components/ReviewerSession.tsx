import { api } from '@code2create/backend/api'
import { useAction, useConvexAuth, useQuery } from 'convex/react'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { BrandBackdrop, BrandMark } from '@/components/Brand'
import { PagerAlert } from '@/components/PagerAlert'
import { useReviewerInstallationId } from '@/lib/duty-status'
import { describeError } from '@/lib/errors'
import type { ReviewerRuntime } from '@/lib/runtime'
import { palette, radius, type } from '@/theme'

/**
 * The duties this account can actually do. Everything downstream — which tabs
 * exist, which cards the grid shows, which routes resolve — is derived from
 * this one list, so a person is never shown a door they cannot open.
 */
export type Surface = 'reviews' | 'attendance' | 'floor' | 'support'

type ReviewerSession = {
  runtime: ReviewerRuntime
  eventSlug: string
  who: string
  email: string
  surfaces: Surface[]
  canCreateSupport: boolean
  signOut: () => void
}

const SessionContext = createContext<ReviewerSession | null>(null)

/**
 * Reads the session and this account's grants once, and refuses to render the
 * app until both are known. Screens below can therefore assume they exist,
 * instead of each re-deriving them and rendering their own spinner.
 */
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
  const publicState = useQuery(api.system.getPublicState, { eventSlug })
  const access = useQuery(api.access.mine, isAuthenticated ? { eventSlug } : 'skip')
  const createNativeSession = useAction(api.localDevelopment.createNativeSession)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authBusy, setAuthBusy] = useState(false)

  const grants = access?.grants ?? []
  const has = (...keys: string[]) =>
    grants.some((grant) => keys.includes(grant.permissionKey))
  const hasReview = has('reviewer.device.register', 'reviewer.clock_in', 'panel.read', 'review.read')
  const hasAttendance = has(
    'attendance.station.manage',
    'attendance.station.read',
    'attendance.scan.execute',
  )
  const hasFloor = has('floor.location.map', 'floor.location.override')
  const scopedToSelfOrEvent = (key: string) =>
    grants.some(
      (grant) =>
        grant.permissionKey === key &&
        (grant.scopeType === 'self' || grant.scopeType === 'event'),
    )
  const hasSupport = scopedToSelfOrEvent('support.case.read')

  // A page is answered from wherever the person is standing, so it is read here
  // rather than inside the judging duty. Someone mid-scan at the door still
  // gets it, and it covers the tab bar with it.
  const substitutePage = useQuery(
    api.reviewSubstitutions.currentPage,
    hasReview ? { eventSlug } : 'skip',
  )
  const reviewerInstallationId = useReviewerInstallationId(eventSlug)

  if (sessionPending || authLoading || publicState === undefined) return <Booting />
  if (isAuthenticated && access === undefined) return <Booting />

  if (!session?.session || !isAuthenticated) {
    const signIn = async () => {
      setAuthBusy(true)
      setAuthError(null)
      const result = await runtime.authClient.signIn.social({
        provider: 'google',
        callbackURL: '/',
      })
      if (result.error) setAuthError(result.error.message || 'Google sign-in could not be completed.')
      setAuthBusy(false)
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
          setAuthError(result.error.message || 'The local event operator could not sign in.')
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
          <Text style={styles.error}>Google sign-in is not configured for this environment.</Text>
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
        canCreateSupport: scopedToSelfOrEvent('support.case.create'),
        signOut,
      }}
    >
      {children}
      {/* Nothing outranks a panel waiting at a table for an answer. */}
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
    <View style={[styles.gate, styles.centred]}>
      <ActivityIndicator color={palette.muted} />
    </View>
  )
}

/**
 * Every pre-duty screen — signing in, no access, nothing assigned — has the
 * same shape: one sentence of why, then the only thing you can do about it.
 *
 * It is also the one screen somebody sees before this app has given them
 * anything to do, so it carries the event's own marks rather than looking like
 * a login form that happens to be dark.
 */
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
          <Text style={styles.wordmark}>
            Code2Creat
            <Text style={styles.wordmarkAccent}>e</Text>
          </Text>
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
  /* Pushed below the canopy: the tree owns the top third of the screen. */
  gateBody: { flex: 1, justifyContent: 'flex-end', paddingBottom: 40 },
  wordmark: {
    marginTop: 22,
    color: palette.text,
    fontSize: 40,
    fontWeight: '700',
    letterSpacing: -1.2,
  },
  /* The wordmark ends on a blossom; here that is one blossom-coloured letter. */
  wordmarkAccent: { color: '#E3A9BF' },
  title: { marginTop: 20, color: palette.text, fontSize: 26, fontWeight: '600', letterSpacing: -0.5 },
  who: { marginTop: 8, color: '#B9A3AC', fontSize: 16 },
  error: { color: palette.urgent, fontSize: 15, lineHeight: 21, marginBottom: 12 },

  actions: { paddingBottom: 12, gap: 10 },
  action: {
    height: 56,
    borderRadius: radius.control,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.text,
  },
  actionSecondary: { backgroundColor: 'rgba(250,251,251,0.12)' },
  actionPressed: { opacity: 0.8 },
  actionDisabled: { opacity: 0.4 },
  actionText: { color: palette.background, fontSize: 17, fontWeight: '600' },
  actionTextSecondary: { color: palette.text },
  small: { ...type.small },
})
