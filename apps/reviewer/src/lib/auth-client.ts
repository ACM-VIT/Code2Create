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
        storage: SecureStore,
      }),
      convexClient(),
    ],
  });
}

export type ReviewerAuthClient = ReturnType<typeof createReviewerAuthClient>;
