import { beforeEach, describe, expect, test, vi } from "vitest";

import { createReviewerAuthClient } from "./auth-client";
import * as SecureStore from "expo-secure-store";

const { convexClient, convexPlugin, createAuthClient, expoClient, expoPlugin } =
  vi.hoisted(() => {
    const expoAuthPlugin = { id: "expo", getActions: vi.fn() };
    const convexAuthPlugin = { id: "convex" };

    return {
      expoPlugin: expoAuthPlugin,
      convexPlugin: convexAuthPlugin,
      expoClient: vi.fn(
        (_configuration: {
          storage: {
            getItem: (key: string) => string | null;
            setItem: (key: string, value: string) => void;
          };
        }) => expoAuthPlugin,
      ),
      convexClient: vi.fn(() => convexAuthPlugin),
      createAuthClient: vi.fn((configuration: object) => configuration),
    };
  });

vi.mock("@better-auth/expo/client", () => ({ expoClient }));
vi.mock("@convex-dev/better-auth/client/plugins", () => ({ convexClient }));
vi.mock("better-auth/react", () => ({ createAuthClient }));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 2,
  getItem: vi.fn(),
  getItemAsync: vi.fn(),
  setItem: vi.fn(),
  setItemAsync: vi.fn(),
}));

describe("reviewer auth client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("uses only the native Expo session transport with the Convex token plugin", () => {
    const client = createReviewerAuthClient(
      "https://example.convex.site",
      "code2create-ops",
    );

    expect(expoClient).toHaveBeenCalledWith({
      scheme: "code2create-ops",
      storagePrefix: "code2create-ops",
      storage: expect.objectContaining({
        getItem: expect.any(Function),
        setItem: expect.any(Function),
      }),
    });
    expect(convexClient).toHaveBeenCalledOnce();
    expect(client).toEqual({
      baseURL: "https://example.convex.site",
      plugins: [expoPlugin, convexPlugin],
    });
  });

  test("persists auth credentials for locked-screen token refresh without device-backup transfer", () => {
    createReviewerAuthClient("https://example.convex.site", "code2create-ops");
    const storage = expoClient.mock.calls[0]?.[0].storage;
    if (!storage) throw new Error("Missing native auth storage");
    storage.setItem("session-cookie", "fixture-session");
    expect(SecureStore.setItem).toHaveBeenCalledWith(
      "session-cookie",
      "fixture-session",
      {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      },
    );
    storage.getItem("session-cookie");
    expect(SecureStore.getItem).toHaveBeenCalledWith("session-cookie");
  });
});
