import { api } from '@code2create/backend/api'
import { useAction, useConvexAuth, useQuery } from 'convex/react'
import { useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { ScannerPanel } from '@/components/ScannerPanel'
import { ReviewPanel } from '@/components/ReviewPanel'
import { FloorMappingPanel } from '@/components/FloorMappingPanel'
import { SupportPanel } from '@/components/SupportPanel'
import { reviewerRuntime, type ReviewerRuntime } from '@/lib/runtime'

export default function HomeScreen() {
  if (!reviewerRuntime) return <ConfigurationNeeded />
  return <ConfiguredHome runtime={reviewerRuntime} />
}

function ConfiguredHome({ runtime }: { runtime: ReviewerRuntime }) {
  const eventSlug = runtime.configuration.eventSlug
  const { data: session, isPending: sessionPending } = runtime.authClient.useSession()
  const { isAuthenticated, isLoading: convexAuthLoading } = useConvexAuth()
  const publicState = useQuery(api.system.getPublicState, { eventSlug })
  const access = useQuery(
    api.access.mine,
    isAuthenticated ? { eventSlug } : 'skip',
  )
  const createNativeSession = useAction(api.localDevelopment.createNativeSession)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [surface, setSurface] = useState<'reviews' | 'attendance' | 'floor' | 'support'>('reviews')
  const grants = access?.grants ?? []
  const hasAttendanceAccess = grants.some(
    (grant) =>
      grant.permissionKey === 'attendance.station.manage' ||
      grant.permissionKey === 'attendance.station.read' ||
      grant.permissionKey === 'attendance.scan.execute',
  )
  const hasReviewAccess = grants.some(
    (grant) =>
      grant.permissionKey === 'reviewer.device.register' ||
      grant.permissionKey === 'reviewer.clock_in' ||
      grant.permissionKey === 'panel.read' ||
      grant.permissionKey === 'review.read',
  )
  const hasFloorMappingAccess = grants.some(
    (grant) =>
      grant.permissionKey === 'floor.location.map' ||
      grant.permissionKey === 'floor.location.override',
  )
  const hasSupportAccess = grants.some(
    (grant) =>
      grant.permissionKey === 'support.case.read' &&
      (grant.scopeType === 'self' || grant.scopeType === 'event'),
  )
  const canCreateSupport = grants.some(
    (grant) =>
      grant.permissionKey === 'support.case.create' &&
      (grant.scopeType === 'self' || grant.scopeType === 'event'),
  )
  const availableSurfaces = [
    ...(hasReviewAccess ? ['reviews' as const] : []),
    ...(hasAttendanceAccess ? ['attendance' as const] : []),
    ...(hasFloorMappingAccess ? ['floor' as const] : []),
    ...(hasSupportAccess ? ['support' as const] : []),
  ]

  const visibleSurface = availableSurfaces.includes(surface)
    ? surface
    : availableSurfaces[0] ?? surface

  if (
    sessionPending ||
    convexAuthLoading ||
    publicState === undefined ||
    (isAuthenticated && access === undefined)
  ) {
    return <Loading />
  }

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
        const localSession = await createNativeSession({
          confirmation: 'create-code2create-local-native-session',
          surface: 'reviewer',
        })
        const result = await runtime.authClient.crossDomain.oneTimeToken.verify({
          token: localSession.token,
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
      <Page>
        <View style={styles.hero}>
          <Text style={styles.kicker}>Code2Create</Text>
          <Text style={styles.title}>Operator access</Text>
          <Text style={styles.body}>Sign in with the Google account assigned to this event.</Text>
        </View>
        {authError ? <Text style={styles.error}>{authError}</Text> : null}
        <Action
          label={authBusy ? 'Opening…' : 'Continue with Google'}
          disabled={authBusy || !publicState.auth.googleConfigured}
          onPress={signIn}
        />
        {publicState.auth.localDevelopmentFixturesEnabled ? (
          <Action
            label={authBusy ? 'Opening…' : 'Use local event operator'}
            disabled={authBusy}
            onPress={signInLocally}
            secondary
          />
        ) : null}
        {!publicState.auth.googleConfigured && !publicState.auth.localDevelopmentFixturesEnabled ? (
          <Text style={styles.error}>Google sign-in is not configured for this environment.</Text>
        ) : null}
      </Page>
    )
  }

  const signOut = () => void runtime.authClient.signOut()
  if (!access) {
    return (
      <Page>
        <View style={styles.hero}>
          <Text style={styles.kicker}>Code2Create</Text>
          <Text style={styles.title}>No event access</Text>
          <Text style={styles.body}>{session.user.email}</Text>
          <Text style={styles.body}>Ask the operations board to grant this account an event permission.</Text>
        </View>
        <Action label="Sign out" onPress={signOut} secondary />
      </Page>
    )
  }

  return (
    <Page>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.kicker}>Code2Create</Text>
          <Text style={styles.title}>
            {availableSurfaces.length > 0 ? surfaceName(visibleSurface) : 'No tasks assigned'}
          </Text>
          <Text style={styles.meta}>
            {session.user.name || session.user.email}
            {' · '}
            {access.role ? roleName(access.role) : 'Scoped access'}
          </Text>
        </View>
        <Pressable accessibilityRole="button" onPress={signOut} hitSlop={12}>
          <Text style={styles.textButton}>Sign out</Text>
        </Pressable>
      </View>
      {availableSurfaces.length > 1 ? (
        <View style={styles.surfaceTabs}>
          {availableSurfaces.map((option) => (
            <Pressable
              accessibilityRole="button"
              key={option}
              onPress={() => setSurface(option)}
              style={[styles.surfaceTab, visibleSurface === option ? styles.surfaceTabSelected : null]}
            >
              <Text style={visibleSurface === option ? styles.surfaceTabTextSelected : styles.surfaceTabText}>
                {surfaceName(option)}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {availableSurfaces.length === 0 ? (
        <Text style={styles.body}>Your account is signed in, but no event work is assigned to it.</Text>
      ) : null}
      {visibleSurface === 'reviews' && hasReviewAccess ? <ReviewPanel runtime={runtime} /> : null}
      {visibleSurface === 'attendance' && hasAttendanceAccess ? <ScannerPanel runtime={runtime} /> : null}
      {visibleSurface === 'floor' && hasFloorMappingAccess ? <FloorMappingPanel runtime={runtime} /> : null}
      {visibleSurface === 'support' && hasSupportAccess ? <SupportPanel canCreate={canCreateSupport} runtime={runtime} /> : null}
    </Page>
  )
}

function surfaceName(surface: 'reviews' | 'attendance' | 'floor' | 'support') {
  if (surface === 'reviews') return 'Reviews'
  if (surface === 'attendance') return 'Attendance'
  if (surface === 'floor') return 'Hall map'
  return 'Support'
}

function roleName(role: string) {
  switch (role) {
    case 'sc':
      return 'Senior committee'
    case 'jc':
      return 'Junior committee'
    case 'external_judge':
      return 'External judge'
    case 'supreme':
      return 'Supreme'
    case 'board':
      return 'Board'
    default:
      return 'Scoped access'
  }
}

function errorMessage(value: unknown, fallback: string) {
  return value instanceof Error && value.message.trim() ? value.message : fallback
}

function ConfigurationNeeded() {
  return (
    <Page>
      <Text style={styles.kicker}>Code2Create</Text>
      <Text style={styles.title}>Configuration needed</Text>
      <Text style={styles.body}>
        Set the Convex URLs and a positive EXPO_PUBLIC_APP_BUILD.
      </Text>
    </Page>
  )
}

function Loading() {
  return (
    <Page centered>
      <ActivityIndicator color="#d6a0aa" />
      <Text style={styles.body}>Checking access…</Text>
    </Page>
  )
}

function Page({ children, centered = false }: { children: React.ReactNode; centered?: boolean }) {
  if (!centered) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.page}>{children}</ScrollView>
      </SafeAreaView>
    )
  }
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={[styles.page, styles.centered]}>{children}</View>
    </SafeAreaView>
  )
}

function Action({
  label,
  onPress,
  disabled = false,
  secondary = false,
}: {
  label: string
  onPress: () => void | Promise<void>
  disabled?: boolean
  secondary?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.action, secondary ? styles.secondaryAction : null, disabled ? styles.disabled : null]}
    >
      <Text style={[styles.actionText, secondary ? styles.secondaryActionText : null]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0a0a09',
  },
  page: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingVertical: 28,
    gap: 18,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  hero: { flex: 1, justifyContent: 'center', gap: 12 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  kicker: { color: '#d6a0aa', fontSize: 13, letterSpacing: 0.4 },
  title: {
    color: '#f1eee8',
    fontFamily: 'Georgia',
    fontSize: 34,
    lineHeight: 40,
  },
  body: { color: '#aaa69f', fontSize: 16, lineHeight: 24, maxWidth: 480 },
  error: { color: '#e3a4a4', fontSize: 14, lineHeight: 20 },
  action: {
    minHeight: 50,
    borderRadius: 8,
    backgroundColor: '#eee9e0',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 18,
  },
  actionText: { color: '#11110f', fontSize: 16, fontWeight: '600' },
  secondaryAction: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#34322f' },
  secondaryActionText: { color: '#f1eee8' },
  disabled: { opacity: 0.55 },
  textButton: { color: '#c9c4bb', fontSize: 15 },
  meta: { color: '#77736d', fontSize: 13, marginTop: 6 },
  surfaceTabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  surfaceTab: { paddingHorizontal: 12, paddingVertical: 9, borderWidth: 1, borderColor: '#34322e', borderRadius: 6 },
  surfaceTabSelected: { backgroundColor: '#eee9e0', borderColor: '#eee9e0' },
  surfaceTabText: { color: '#aaa69f', fontSize: 13 },
  surfaceTabTextSelected: { color: '#11110f', fontSize: 13 },
})
