import { expoClient } from "@better-auth/expo/client";
import { convexClient } from "@convex-dev/better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";

export function createReviewerAuthClient(baseURL: string, scheme: string) {
  return createAuthClient({
    baseURL,
    plugins: [
      expoClient({
        scheme,
        storagePrefix: scheme,
        storage: {
          getItem: (key) => SecureStore.getItem(key),
          // Background location must be able to refresh auth while the phone is locked.
          // Keep these credentials on this device when restoring a backup.
          setItem: (key, value) =>
            SecureStore.setItem(key, value, {
              keychainAccessible:
                SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
            }),
        },
      }),
      convexClient(),
    ],
  });
}

export type ReviewerAuthClient = ReturnType<typeof createReviewerAuthClient>;
