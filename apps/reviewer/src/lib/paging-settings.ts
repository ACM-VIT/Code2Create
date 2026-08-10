import Constants from 'expo-constants'
import { Linking, Platform } from 'react-native'

import type { PagingReadinessCheck } from '@/lib/push-notifications'

/**
 * Opens the exact page of the phone's settings a paging check is about.
 *
 * Telling somebody to "enable notifications in Settings" at three in the
 * morning in a loud hall is telling them to go and lose. Every fix here lands
 * on the screen with the switch on it.
 *
 * iOS has no public URL for a sub-page of an app's settings — `app-settings:`
 * opens the app's own pane and nothing narrower is sanctioned — so both of the
 * iOS fixes land there, which is one tap from the notification switches.
 * Android exposes each screen as its own intent, so each fix goes straight to
 * the one it means.
 */
export async function openPagingSetting(fix: NonNullable<PagingReadinessCheck['fix']>) {
  if (Platform.OS !== 'android') {
    await Linking.openSettings()
    return
  }

  /* The package is set per environment, so a literal here would send a
     production reviewer to the settings of an app that is not installed. */
  const packageName = Constants.expoConfig?.android?.package
  if (!packageName) {
    await Linking.openSettings()
    return
  }
  /* Loaded here rather than at the top of the file: it is a native module
     that only Android ever reaches, and importing it on iOS ties this screen
     to whether the current build happens to contain it. */
  const IntentLauncher = await import('expo-intent-launcher')

  const intents: Record<NonNullable<PagingReadinessCheck['fix']>, {
    action: string
    params?: Record<string, unknown>
  }> = {
    app_settings: {
      action: 'android.settings.APPLICATION_DETAILS_SETTINGS',
      params: { data: `package:${packageName}` },
    },
    notification_settings: {
      action: 'android.settings.APP_NOTIFICATION_SETTINGS',
      params: { extra: { 'android.provider.extra.APP_PACKAGE': packageName } },
    },
    /* Android 14 and up. On older versions the screen does not exist and the
       launcher throws, so the caller falls back to the app's own settings. */
    full_screen_settings: {
      action: 'android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT',
      params: { data: `package:${packageName}` },
    },
    battery_settings: {
      action: 'android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS',
    },
  }

  const intent = intents[fix]
  try {
    await IntentLauncher.startActivityAsync(intent.action, intent.params ?? {})
  } catch {
    await Linking.openSettings()
  }
}
