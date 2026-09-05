import { TrueSheet } from "@lodev09/react-native-true-sheet";
import { ScrollView, TextInput } from "react-native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { Sheet } from "../components/ui";
import { DutyScreen } from "../components/DutyScreen";

vi.mock("@lodev09/react-native-true-sheet", () => ({ TrueSheet: "TrueSheet" }));
vi.mock("react-native-svg", () => ({ default: "Svg", Path: "Path" }));
vi.mock("expo-router", () => ({ Stack: { Screen: "Screen" } }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 24 }),
}));
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
  RefreshControl: "RefreshControl",
  Platform: { OS: "android" },
}));

let renderer: ReactTestRenderer;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => renderer?.unmount());
});

test.each([{ detents: undefined }, { detents: [0.45, 0.92] }, { detents: [0.72] }])(
  "long forms use native keyboard-aware scrolling with detents $detents",
  async ({ detents }) => {
    await act(async () => {
      renderer = create(
        <DutyScreen title="Help">
          <Sheet {...(detents ? { detents } : {})} onClose={vi.fn()} title="Report a problem" visible>
            <TextInput testID="last-field" />
          </Sheet>
        </DutyScreen>,
      );
    });
    const nativeSheet = renderer.root.findByType(TrueSheet);
    expect(nativeSheet.props.scrollable).toBe(true);
    expect(nativeSheet.props.scrollableOptions.keyboardScrollOffset).toBeGreaterThan(0);
    expect(nativeSheet.props.detents).toEqual(detents ?? [0.85]);
    expect(nativeSheet.props.detents.every((height: number) =>
      typeof height === "number" && height > 0 && height < 1,
    )).toBe(true);
    const scroll = nativeSheet.findByType(ScrollView);
    // Every ancestor must let the button handle the first tap. An outer
    // ScrollView with the default policy captures it just to hide the IME.
    const scrollViews = renderer.root.findAllByType(ScrollView);
    expect(scrollViews).toHaveLength(2);
    for (const view of scrollViews) expect(view.props.keyboardShouldPersistTaps).toBe("handled");
    expect(scroll.findByProps({ testID: "last-field" })).toBeDefined();
  },
);

test("dismissal removes the native overlay and reopening mounts a fresh sheet", async () => {
  const onClose = vi.fn();
  const render = (visible: boolean) => (
    <Sheet onClose={onClose} title="Getting paged" visible={visible}>Content</Sheet>
  );
  await act(async () => { renderer = create(render(false)); });
  expect(renderer.toJSON()).toBeNull();
  await act(async () => { renderer.update(render(true)); });
  await act(async () => {
    renderer.root.findByType(TrueSheet).props.onDidDismiss();
    renderer.update(render(false));
  });
  expect(onClose).toHaveBeenCalledOnce();
  expect(renderer.toJSON()).toBeNull();
  await act(async () => { renderer.update(render(true)); });
  expect(renderer.root.findByType(TrueSheet).props.initialDetentIndex).toBe(0);
});
