import { createElement, useCallback } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useDeviceCheck } from "./use-device-check";
import { useCameraAccess } from "./use-camera-access";
import { useReviewerPush } from "./use-reviewer-push";

const native = vi.hoisted(() => ({
  listeners: new Set<(state: string) => void>(),
  permission: { granted: false, canAskAgain: true },
  getCamera: vi.fn(),
  requestCamera: vi.fn(),
  openSettings: vi.fn(),
  platform: { OS: "android" },
  currentPush: vi.fn(),
  requestPush: vi.fn(),
  pushListener: null as (() => void) | null,
}));
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_: string, listener: (state: string) => void) => {
      native.listeners.add(listener);
      return { remove: () => native.listeners.delete(listener) };
    },
  },
  Linking: { openSettings: native.openSettings },
  Platform: native.platform,
}));
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return {
    useFocusEffect: (effect: () => void | (() => void)) =>
      useEffect(effect, [effect]),
  };
});
vi.mock("expo-camera", () => ({
  Camera: {
    getCameraPermissionsAsync: native.getCamera,
    requestCameraPermissionsAsync: native.requestCamera,
  },
}));
vi.mock("./push-notifications", () => ({
  currentReviewerPushRegistration: native.currentPush,
  requestReviewerPushRegistration: native.requestPush,
  subscribeToReviewerPushTokenChanges: (callback: () => void) => {
    native.pushListener = callback;
    return () => {
      native.pushListener = null;
    };
  },
}));

let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  native.permission = { granted: false, canAskAgain: true };
  native.getCamera.mockImplementation(async () => ({ ...native.permission }));
  native.requestCamera.mockImplementation(async () => {
    native.permission.granted = true;
    return { ...native.permission };
  });
  vi.clearAllMocks();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  expect(native.listeners.size).toBe(0);
  expect(native.pushListener).toBeNull();
});

test.each(["android", "ios"])(
  "%s parent paging readiness refreshes after Settings and token rotation",
  async (platform) => {
    native.platform.OS = platform;
    const registration = {
      status: "ready",
      token: "device-token",
      provider: platform === "ios" ? "apns" : "fcm",
      environment: "production",
      fingerprint: "new",
    };
    native.currentPush.mockResolvedValue({ status: "not_granted" });
    native.requestPush.mockResolvedValue(registration);
    let push!: ReturnType<typeof useReviewerPush>;
    function Screen() {
      push = useReviewerPush("production");
      return null;
    }
    await act(async () => {
      renderer = create(createElement(Screen));
    });
    expect(push.state.status).toBe("not_granted");
    await act(async () => {
      await push.requestPermission();
    });
    expect(push.state.status).toBe("ready");
    await resume();
    expect(push.state.status).toBe("not_granted");
    native.currentPush.mockResolvedValue(registration);
    await resume();
    expect(push.state.status).toBe("ready");
    native.currentPush.mockResolvedValue({ status: "not_granted" });
    await act(async () => {
      native.pushListener?.();
    });
    expect(push.state.status).toBe("not_granted");
  },
);
async function resume() {
  await act(async () => {
    for (const listener of native.listeners) listener("active");
  });
}

describe.each(["android", "ios"])("%s camera permissions", (platform) => {
  test("updates immediately after a grant and re-reads Settings grants/revocations", async () => {
    native.platform.OS = platform;
    let camera!: ReturnType<typeof useCameraAccess>;
    function Screen() {
      camera = useCameraAccess();
      return null;
    }
    await act(async () => {
      renderer = create(createElement(Screen));
    });
    expect(camera.permission?.granted).toBe(false);
    await act(async () => {
      await camera.requestPermission();
    });
    expect(camera.permission?.granted).toBe(true);
    native.permission.granted = false;
    await resume();
    expect(camera.permission?.granted).toBe(false);
    native.permission.granted = true;
    await resume();
    expect(camera.permission?.granted).toBe(true);
  });

  test("opens Settings for permanent denial and recognizes the later grant", async () => {
    native.permission.canAskAgain = false;
    let camera!: ReturnType<typeof useCameraAccess>;
    function Screen() {
      camera = useCameraAccess();
      return null;
    }
    await act(async () => {
      renderer = create(createElement(Screen));
    });
    await act(async () => {
      await camera.requestPermission();
    });
    expect(native.openSettings).toHaveBeenCalledOnce();
    expect(native.requestCamera).not.toHaveBeenCalled();
    native.permission.granted = true;
    await resume();
    expect(camera.permission?.granted).toBe(true);
  });
});

test("a slow pre-grant read cannot undo a newer permission request", async () => {
  const oldRead = Promise.withResolvers<boolean>();
  let check!: ReturnType<typeof useDeviceCheck<boolean>>;
  function Screen() {
    check = useDeviceCheck(
      useCallback(() => oldRead.promise, []),
      "Cannot check",
    );
    return null;
  }
  await act(async () => {
    renderer = create(createElement(Screen));
  });
  await act(async () => {
    await check.request(async () => true);
  });
  expect(check.value).toBe(true);
  await act(async () => oldRead.resolve(false));
  expect(check.value).toBe(true);
});

test("resume during a permission prompt cannot replace its result with a stale read", async () => {
  const prompt = Promise.withResolvers<boolean>();
  const read = vi.fn(async () => false);
  let check!: ReturnType<typeof useDeviceCheck<boolean>>;
  function Screen() {
    check = useDeviceCheck(read, "Cannot check");
    return null;
  }
  await act(async () => {
    renderer = create(createElement(Screen));
  });
  let requested!: Promise<void>;
  await act(async () => {
    requested = check.request(() => prompt.promise);
  });
  await resume();
  expect(read).toHaveBeenCalledOnce();
  await act(async () => {
    prompt.resolve(true);
    await requested;
  });
  expect(check.value).toBe(true);
});

test("a failed native check becomes a recoverable error and a later resume clears it", async () => {
  const read = vi
    .fn<() => Promise<boolean>>()
    .mockRejectedValueOnce(new Error("OS failed"))
    .mockResolvedValue(true);
  let check!: ReturnType<typeof useDeviceCheck<boolean>>;
  function Screen() {
    check = useDeviceCheck(read, "Cannot check");
    return null;
  }
  await act(async () => {
    renderer = create(createElement(Screen));
  });
  expect(check.error).toBe("Cannot check");
  await resume();
  expect(check.value).toBe(true);
  expect(check.error).toBeNull();
});
