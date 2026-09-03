import { expoClient } from "@better-auth/expo/client";
import { convexClient, crossDomainClient } from "@convex-dev/better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";

export function createReviewerAuthClient(baseURL: string, scheme: string) {
  const expoSession = expoClient({
    scheme,
    storagePrefix: scheme,
    storage: SecureStore,
  });
  return createAuthClient({
    baseURL,
    plugins: [
      {
        id: expoSession.id,
        version: expoSession.version,
        fetchPlugins: expoSession.fetchPlugins,
      },
      convexClient(),
      crossDomainClient({
        storage: SecureStore,
        storagePrefix: scheme,
        disableCache: true,
      }),
    ],
  });
}

export type ReviewerAuthClient = ReturnType<typeof createReviewerAuthClient>;
