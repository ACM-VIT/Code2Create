import { applicationId } from "expo-application";
import { Linking, Platform } from "react-native";

import type { PagingReadinessCheck } from "@/lib/push-notifications";

export async function openPagingSetting(fix: NonNullable<PagingReadinessCheck["fix"]>) {
  if (Platform.OS !== "android") {
    await Linking.openSettings();
    return;
  }

  // Android settings intents require the active application package.
  const packageName = applicationId;
  if (!packageName) {
    await Linking.openSettings();
    return;
  }
  const intents: Record<
    NonNullable<PagingReadinessCheck["fix"]>,
    {
      action: string;
      params?: Record<string, unknown>;
    }
  > = {
    app_settings: {
      action: "android.settings.APPLICATION_DETAILS_SETTINGS",
      params: { data: `package:${packageName}` },
    },
    notification_settings: {
      action: "android.settings.APP_NOTIFICATION_SETTINGS",
      params: { extra: { "android.provider.extra.APP_PACKAGE": packageName } },
    },
    // Older Android versions fall back when this Android 14 action throws.
    full_screen_settings: {
      action: "android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT",
      params: { data: `package:${packageName}` },
    },
    battery_settings: {
      action: "android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS",
    },
  };

  const intent = intents[fix];
  try {
    // Android-only module loading can also fail; keep it inside the settings fallback.
    const IntentLauncher = await import("expo-intent-launcher");
    await IntentLauncher.startActivityAsync(intent.action, intent.params ?? {});
  } catch {
    await Linking.openSettings();
  }
}
