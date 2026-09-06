import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { Modal } from "react-native";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PagerAlert, type SubstitutePage } from "./PagerAlert";

const mock = vi.hoisted(() => ({
  navigate: vi.fn(),
  open: vi.fn(),
  respond: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("@code2create/backend/api", () => ({
  api: { reviewSubstitutions: { openPage: "open", respondToPage: "respond" } },
}));
vi.mock("convex/react", () => ({
  useMutation: (name: string) => (name === "open" ? mock.open : mock.respond),
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "page-command" }));
vi.mock("expo-router", () => ({
  useRouter: () => ({ navigate: mock.navigate }),
}));
vi.mock("react-native", () => ({
  Modal: "Modal",
  ScrollView: "ScrollView",
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
  StyleSheet: { create: (s: object) => s },
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: "SafeAreaView",
}));
vi.mock("react-native-svg", () => ({ default: "Svg", Circle: "Circle" }));
vi.mock("@/components/ui", () => ({
  Action: "Action",
  QuietAction: "QuietAction",
  ErrorSheet: "ErrorSheet",
}));
vi.mock("@/lib/pager-alarm", () => ({
  startPagerAlarm: () => mock.start(),
  stopPagerAlarm: () => mock.stop(),
}));
vi.mock("@/lib/errors", () => ({
  describeError: (_: unknown, message: string) => message,
}));

const page: SubstitutePage = {
  id: "page" as SubstitutePage["id"],
  version: 2,
  state: "opened",
  sentAt: 1_000,
  serverNow: 1_000,
  expiresAt: 3_000,
  reason: "Cover an empty seat",
  panel: { id: "panel" as SubstitutePage["panel"]["id"], name: "Panel 2" },
  round: { id: "round" as SubstitutePage["round"]["id"], name: "Review 1" },
  team: null,
  criteria: [],
};
let view: ReturnType<typeof create>;
const render = (p = page) =>
  createElement(PagerAlert, {
    key: p.id,
    eventSlug: "event",
    installationId: "phone",
    page: p,
  });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.clearAllMocks();
  mock.open.mockResolvedValue({});
});
afterEach(async () => {
  await act(async () => view?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const expire = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });

test("an expired page can be dismissed offline without accepting or declining it", async () => {
  await act(async () => {
    view = create(render());
  });
  expect(mock.start).toHaveBeenCalled();
  await expire();
  expect(mock.stop).toHaveBeenCalled();
  await act(async () =>
    view.root.findByProps({ label: "Back to duties" }).props.onPress(),
  );
  expect(view.toJSON()).toBeNull();
  expect(mock.respond).not.toHaveBeenCalled();
  await act(async () =>
    view.update(
      render({
        ...page,
        id: "next-page" as SubstitutePage["id"],
        serverNow: 4_000,
        expiresAt: 8_000,
      }),
    ),
  );
  expect(view.root.findByProps({ label: "I'll take it" }).props.disabled).toBe(
    false,
  );
});

test("expiry replaces an unfinished decline with a working exit", async () => {
  await act(async () => {
    view = create(render());
  });
  await act(async () =>
    view.root.findByProps({ label: "I can't" }).props.onPress(),
  );
  await expire();
  expect(view.root.findAllByProps({ label: "Send" })).toHaveLength(0);
  await act(async () => view.root.findByType(Modal).props.onRequestClose());
  expect(view.toJSON()).toBeNull();
});

test("expiry permits exit when acceptance is still waiting for a connection", async () => {
  mock.respond.mockReturnValue(new Promise(() => {}));
  await act(async () => {
    view = create(render());
  });
  await act(async () => {
    void view.root.findByProps({ label: "I'll take it" }).props.onPress();
  });
  await expire();
  await act(async () =>
    view.root.findByProps({ label: "Back to duties" }).props.onPress(),
  );
  expect(view.toJSON()).toBeNull();
  expect(mock.respond).toHaveBeenCalledTimes(1);
});

test("an expired cached sent page is never acknowledged or answered", async () => {
  await act(async () => {
    view = create(render({ ...page, state: "sent", serverNow: 4_000 }));
  });
  expect(mock.open).not.toHaveBeenCalled();
  expect(mock.respond).not.toHaveBeenCalled();
  expect(view.root.findByProps({ label: "Back to duties" })).toBeDefined();
});

test.each(["accepted", "declined", "expired"])(
  "only a confirmed acceptance opens the review destination (%s)",
  async (state) => {
    mock.respond.mockResolvedValue({ state });
    await act(async () => {
      view = create(render());
    });
    await act(async () =>
      view.root.findByProps({ label: "I'll take it" }).props.onPress(),
    );
    expect(mock.navigate.mock.calls).toEqual(
      state === "accepted" ? [["/duty/reviews"]] : [],
    );
  },
);
