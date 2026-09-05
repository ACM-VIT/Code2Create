import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { PagingSetup } from "../components/PagingSetup";

const native = vi.hoisted(() => ({
  consent: undefined as Error | undefined,
  readiness: vi.fn(),
  openSettings: vi.fn(),
  listeners: new Set<(state: string) => void>(),
}));
vi.mock("@code2create/backend/api", () => ({
  api: { outboundCallConsents: { mine: "mine", saveReviewerConsent: "save" } },
}));
vi.mock("convex/react", () => ({
  useQueries: () => ({ consent: native.consent }),
  useMutation: () => vi.fn(),
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "test-id" }));
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return {
    useFocusEffect: (effect: () => void | (() => void)) =>
      useEffect(effect, [effect]),
  };
});
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_: string, callback: (state: string) => void) => {
      native.listeners.add(callback);
      return { remove: () => native.listeners.delete(callback) };
    },
  },
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
  View: "View",
  Text: "Text",
  TextInput: "TextInput",
}));
vi.mock("@/components/ui", () => ({
  Action: "Action",
  CheckRow: "CheckRow",
  QuietAction: "QuietAction",
}));
vi.mock("@/lib/paging-settings", () => ({
  openPagingSetting: native.openSettings,
}));
vi.mock("@/lib/push-notifications", () => ({
  pagingReadiness: native.readiness,
}));

let renderer: ReturnType<typeof create>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  native.consent = undefined;
  native.readiness.mockResolvedValue([
    {
      key: "permission",
      title: "Notifications",
      met: false,
      fix: "notification_settings",
      consequence: "Allow pages",
    },
  ]);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
});

test("a call-consent access denial does not crash the paging screen or prevent granting notifications", async () => {
  native.consent = new ConvexError({
    code: "PERMISSION_DENIED",
    message: "Ask the review desk to enable review calls.",
  });
  const request = vi.fn(async () => {
    native.readiness.mockResolvedValue([
      { key: "permission", title: "Notifications", met: true },
    ]);
  });
  await act(async () => {
    renderer = create(
      createElement(PagingSetup, {
        eventSlug: "event",
        requestPermission: request,
      }),
    );
  });
  expect(JSON.stringify(renderer.toJSON())).toContain(
    "Ask the review desk to enable review calls.",
  );
  await act(async () => {
    await renderer.root
      .findByProps({ label: "Allow notifications" })
      .props.onPress();
  });
  expect(request).toHaveBeenCalledOnce();
  expect(renderer.root.findByProps({ title: "Notifications" }).props.met).toBe(
    true,
  );
});

test("a native readiness failure is caught and can be retried inside the screen", async () => {
  native.readiness.mockRejectedValueOnce(new Error("native unavailable"));
  await act(async () => {
    renderer = create(
      createElement(PagingSetup, {
        eventSlug: "event",
        requestPermission: async () => {},
      }),
    );
  });
  expect(JSON.stringify(renderer.toJSON())).toContain(
    "Paging settings could not be checked",
  );
  await act(async () => {
    renderer.root.findByProps({ label: "Check again" }).props.onPress();
  });
  expect(renderer.root.findByProps({ title: "Notifications" }).props.met).toBe(
    false,
  );
});

test("returning from Android or iPhone Settings updates the visible check", async () => {
  await act(async () => {
    renderer = create(
      createElement(PagingSetup, {
        eventSlug: "event",
        requestPermission: async () => {},
      }),
    );
  });
  native.readiness.mockResolvedValue([
    { key: "permission", title: "Notifications", met: true },
  ]);
  await act(async () => {
    native.listeners.forEach((listener) => listener("active"));
  });
  expect(renderer.root.findByProps({ title: "Notifications" }).props.met).toBe(
    true,
  );
});

test("a failed Settings intent stays inside setup and does not produce an unhandled rejection", async () => {
  native.openSettings.mockRejectedValue(new Error("no activity"));
  await act(async () => {
    renderer = create(
      createElement(PagingSetup, {
        eventSlug: "event",
        requestPermission: async () => {},
      }),
    );
  });
  await act(async () => {
    await renderer.root.findByProps({ title: "Notifications" }).props.onPress();
  });
  expect(JSON.stringify(renderer.toJSON())).toContain(
    "Settings could not be opened",
  );
});

test("a phone with permission but no token can retry push registration", async () => {
  native.readiness.mockResolvedValue([
    { key: "permission", title: "Notifications", met: true },
  ]);
  const request = vi.fn(async () => {});
  await act(async () => {
    renderer = create(
      createElement(PagingSetup, {
        eventSlug: "event",
        requestPermission: request,
        tokenMissing: true,
      }),
    );
  });
  await act(async () => {
    await renderer.root
      .findByProps({ label: "Register notifications" })
      .props.onPress();
  });
  expect(request).toHaveBeenCalledOnce();
});

test("shows the permission grant while push registration is still pending", async () => {
  const token = Promise.withResolvers<void>();
  const request = async (onPermissionChecked?: () => void) => {
    native.readiness.mockResolvedValue([
      { key: "permission", title: "Notifications", met: true },
    ]);
    onPermissionChecked?.();
    await token.promise;
  };
  await act(async () => {
    renderer = create(
      createElement(PagingSetup, {
        eventSlug: "event",
        requestPermission: request,
        tokenMissing: true,
      }),
    );
  });
  let pending!: Promise<void>;
  await act(async () => {
    pending = renderer.root
      .findByProps({ label: "Allow notifications" })
      .props.onPress();
  });
  expect(renderer.root.findByProps({ title: "Notifications" }).props.met).toBe(
    true,
  );
  await act(async () => {
    token.resolve();
    await pending;
  });
});
