import { createElement } from "react";
import type { NotificationHandler } from "expo-notifications";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ReviewNotificationRoute } from "./ReviewNotificationRoute";

const native = vi.hoisted(() => ({
  ready: false,
  allowed: true,
  kind: "reviewer_shift_reminder",
  action: "default",
  navigate: vi.fn(),
  clear: vi.fn(),
  remove: vi.fn(),
  listen: vi.fn(),
  handlers: new Array<NotificationHandler>(),
}));
vi.mock("expo-router", () => ({
  useRouter: () => ({ navigate: native.navigate }),
  useRootNavigationState: () => (native.ready ? { key: "root" } : undefined),
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "sha256" },
  digestStringAsync: vi.fn(),
}));
vi.mock("@/lib/pager-alarm", () => ({ androidPagingReadiness: vi.fn() }));
vi.mock("@/components/ReviewerSession", () => ({
  useReviewerSession: () => ({ surfaces: native.allowed ? ["reviews"] : [] }),
}));
vi.mock("expo-notifications", () => ({
  setNotificationHandler: (handler: NotificationHandler) => native.handlers.push(handler),
  DEFAULT_ACTION_IDENTIFIER: "default",
  getLastNotificationResponse: () => ({
    actionIdentifier: native.action,
    notification: { request: { content: { data: { kind: native.kind } } } },
  }),
  clearLastNotificationResponse: native.clear,
  addNotificationResponseReceivedListener: () => {
    native.listen();
    return { remove: native.remove };
  },
}));
let view: ReturnType<typeof create>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  native.ready = false;
  native.allowed = true;
  native.kind = "reviewer_shift_reminder";
  native.action = "default";
});
afterEach(async () => {
  await act(async () => view?.unmount());
  vi.unstubAllGlobals();
});

test("installs foreground notification handling before navigation is ready", async () => {
  await act(async () => {
    view = create(createElement(ReviewNotificationRoute));
  });
  expect(native.listen).not.toHaveBeenCalled();
  expect(native.handlers).toHaveLength(1);
  expect(native.handlers[0]?.handleNotification).toBeTypeOf("function");
});

test.each([
  ["reviewer_availability_confirmation", "/duty/reviews"],
  ["reviewer_shift_reminder", "/duty/reviews"],
])("cold-start %s waits for navigation", async (kind, destination) => {
  native.kind = kind;
  await act(async () => {
    view = create(createElement(ReviewNotificationRoute));
  });
  expect(native.navigate).not.toHaveBeenCalled();
  expect(native.clear).not.toHaveBeenCalled();
  native.ready = true;
  await act(async () => view.update(createElement(ReviewNotificationRoute)));
  expect(native.navigate).toHaveBeenCalledExactlyOnceWith(destination);
  expect(native.clear).toHaveBeenCalledOnce();
});

test.each(["unrelated", "dismissed", "no_access"])(
  "ignores %s notifications",
  async (caseName) => {
    native.ready = true;
    if (caseName === "unrelated") native.kind = "another_event";
    if (caseName === "dismissed") native.action = "dismiss";
    if (caseName === "no_access") native.allowed = false;
    await act(async () => {
      view = create(createElement(ReviewNotificationRoute));
    });
    expect(native.navigate).not.toHaveBeenCalled();
    expect(native.clear).not.toHaveBeenCalled();
  },
);
