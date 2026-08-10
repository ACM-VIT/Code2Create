import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'

export type ReviewerPushRegistration =
  | { status: 'not_granted' }
  | { status: 'unavailable'; message: string }
  | {
      status: 'ready'
      token: string
      provider: 'fcm' | 'apns'
      environment: 'development' | 'production'
      fingerprint: string
    }

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
})

/**
 * What still stands between this phone and a page it would actually notice.
 *
 * A page that only exists as pixels needs somebody to already be looking at
 * the screen, which is the one moment they do not need paging. These are the
 * settings that decide whether a locked, pocketed, silenced phone makes a
 * noise, and each one is somewhere different on each platform — so the app
 * has to check them and say where to go rather than hope.
 */
export type PagingReadinessCheck = {
  key: 'permission' | 'critical' | 'full_screen' | 'battery'
  title: string
  /** What a reviewer loses while this is unmet. Never a description of itself. */
  consequence: string
  met: boolean
  /** Absent when nothing can be opened, as with an entitlement Apple owns. */
  fix?: 'app_settings' | 'notification_settings' | 'full_screen_settings' | 'battery_settings'
}

export async function pagingReadiness(): Promise<PagingReadinessCheck[]> {
  const permission = await Notifications.getPermissionsAsync()
  const granted = allowsNotifications(permission)
  const checks: PagingReadinessCheck[] = [
    {
      key: 'permission',
      title: 'Notifications',
      consequence: 'Pages will not reach you with the app closed',
      met: granted,
      fix: 'notification_settings',
    },
  ]

  if (Platform.OS === 'ios') {
    checks.push({
      key: 'critical',
      title: 'Critical alerts',
      consequence: 'A page will stay silent while your phone is on silent',
      /* Apple grants this entitlement by hand for life-safety apps. Until it
         is granted the switch does not exist, so this reports honestly rather
         than sending somebody to look for a setting that is not there. */
      met: permission.ios?.allowsCriticalAlerts === true,
    })
  }

  if (Platform.OS === 'android') {
    checks.push(
      {
        key: 'full_screen',
        title: 'Full-screen alerts',
        consequence: 'A page will sit in the shade instead of taking the screen',
        /* Android 14 moved this behind its own switch. There is no read API,
           so it is offered rather than asserted. */
        met: false,
        fix: 'full_screen_settings',
      },
      {
        key: 'battery',
        title: 'Battery optimisation',
        consequence: 'Android may hold a page back for minutes',
        met: false,
        fix: 'battery_settings',
      },
    )
  }

  return checks
}

export async function currentReviewerPushRegistration(
  apnsEnvironment: 'development' | 'production',
) {
  try {
    await prepareAndroidChannel()
    const permission = await Notifications.getPermissionsAsync()
    return registrationForPermission(permission, apnsEnvironment)
  } catch {
    return {
      status: 'unavailable' as const,
      message: 'This phone could not reach the notification service. Try again while online.',
    }
  }
}

export async function requestReviewerPushRegistration(
  apnsEnvironment: 'development' | 'production',
) {
  try {
    await prepareAndroidChannel()
    const permission = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: true },
    })
    return registrationForPermission(permission, apnsEnvironment)
  } catch {
    return {
      status: 'unavailable' as const,
      message: 'Notification setup could not be completed. Check the connection and try again.',
    }
  }
}

export function subscribeToReviewerPushTokenChanges(
  apnsEnvironment: 'development' | 'production',
  onChange: (registration: ReviewerPushRegistration) => void,
) {
  const subscription = Notifications.addPushTokenListener((devicePushToken) => {
    void nativeRegistration(apnsEnvironment, devicePushToken).then(onChange)
  })
  return () => subscription.remove()
}

async function registrationForPermission(
  permission: Notifications.NotificationPermissionsStatus,
  apnsEnvironment: 'development' | 'production',
): Promise<ReviewerPushRegistration> {
  if (!allowsNotifications(permission)) return { status: 'not_granted' }
  return nativeRegistration(apnsEnvironment)
}

async function nativeRegistration(
  apnsEnvironment: 'development' | 'production',
  devicePushToken?: Notifications.DevicePushToken,
): Promise<ReviewerPushRegistration> {
  try {
    const result = devicePushToken ?? await Notifications.getDevicePushTokenAsync()
    if (typeof result.data !== 'string') {
      return {
        status: 'unavailable',
        message: 'This phone returned an unsupported notification token.',
      }
    }
    const token = result.data.trim()
    const provider = Platform.OS === 'ios' ? 'apns' : 'fcm'
    if (!validNativeToken(provider, token)) {
      return {
        status: 'unavailable',
        message: 'The notification provider returned an invalid phone token.',
      }
    }
    return {
      status: 'ready',
      token,
      provider,
      environment: provider === 'apns' ? apnsEnvironment : 'production',
      fingerprint: await digestStringAsync(CryptoDigestAlgorithm.SHA256, token),
    }
  } catch {
    return {
      status: 'unavailable',
      message: 'Notification permission is allowed, but this phone is not registered for push yet. Try again while online.',
    }
  }
}

function validNativeToken(provider: 'fcm' | 'apns', token: string) {
  if (provider === 'apns') return /^[A-Fa-f0-9]{32,512}$/u.test(token)
  return token.length >= 20 && token.length <= 4_096 && /^[A-Za-z0-9:_-]+$/u.test(token)
}

async function prepareAndroidChannel() {
  if (Platform.OS !== 'android') return
  await Notifications.setNotificationChannelAsync('reviewer-pages', {
    name: 'Reviewer pages',
    /* MAX is what lets Android put a page over the lock screen rather than
       into the shade. Everything else the app might ever send belongs on a
       quieter channel than this one. */
    importance: Notifications.AndroidImportance.MAX,
    sound: 'default',
    vibrationPattern: [0, 250, 200, 250],
    enableVibrate: true,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    bypassDnd: true,
    showBadge: false,
  })
}

function allowsNotifications(permission: Notifications.NotificationPermissionsStatus) {
  return (
    permission.granted ||
    permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL
  )
}
