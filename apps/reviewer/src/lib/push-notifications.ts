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
    importance: Notifications.AndroidImportance.MAX,
    sound: 'default',
    vibrationPattern: [0, 250, 200, 250],
    enableVibrate: true,
    showBadge: false,
  })
}

function allowsNotifications(permission: Notifications.NotificationPermissionsStatus) {
  return (
    permission.granted ||
    permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL
  )
}
