import { createElement, useEffect } from "react";
import { act, create } from "react-test-renderer";
import { TextInput } from "react-native";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Sheet } from "@/components/ui";
import { ReviewDutyStatus } from "./ReviewDutyStatus";
import type { ComponentProps } from "react";

const mock = vi.hoisted(() => ({ mutate: vi.fn(), unmount: vi.fn() }));
vi.mock("@code2create/backend/api", () => ({
  api: { reviewer: { setAvailability: "availability" } },
}));
vi.mock("convex/react", () => ({ useMutation: () => mock.mutate }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "duty-command" }));
vi.mock("react-native", () => ({
  Text: "Text",
  TextInput: "TextInput",
  StyleSheet: { create: (s: object) => s },
}));
vi.mock("@/lib/errors", () => ({
  describeError: (_: unknown, message: string) => message,
}));
vi.mock("@/components/ui", () => ({
  Action: "Action",
  ChipRow: "ChipRow",
  QuietAction: "QuietAction",
  Sheet: (props: { children: React.ReactNode; visible: boolean }) => {
    useEffect(() => () => mock.unmount(), []);
    return createElement("Sheet", props, props.children);
  },
}));

type Props = ComponentProps<typeof ReviewDutyStatus>;
// Only fields used by this control; the backend owns the full assignment projection.
const assignment = {
  clockIn: { status: "present", version: 1 },
  round: { id: "round" },
} as NonNullable<Props["assignment"]>;
let view: ReturnType<typeof create>;
const render = (overrides: Partial<Props> = {}) =>
  createElement(ReviewDutyStatus, {
    eventSlug: "event",
    installationId: "phone",
    assignment,
    canChangeDuty: true,
    ...overrides,
  });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
});
afterEach(async () => {
  await act(async () => view?.unmount());
  vi.unstubAllGlobals();
});

const open = async () => {
  await act(async () => {
    view = create(render());
  });
  await act(async () =>
    view.root.findByProps({ label: "Change duty status" }).props.onPress(),
  );
  await act(async () =>
    view.root.findByType(TextInput).props.onChangeText("Lunch break"),
  );
};

test("a live break transition dismisses the same sheet before the mutation response arrives", async () => {
  let finish!: (value: { version: number }) => void;
  mock.mutate.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await open();
  let saving!: Promise<void>;
  await act(async () => {
    saving = view.root
      .findByProps({ label: "Confirm step away" })
      .props.onPress();
  });
  expect(mock.mutate).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "temporarily_unavailable",
      expectedReturnMinutes: 10,
      reason: "Lunch break",
    }),
  );
  await act(async () => view.update(render({ canChangeDuty: false })));
  expect(view.root.findByType(Sheet).props.visible).toBe(false);
  expect(mock.unmount).not.toHaveBeenCalled();
  await act(async () => {
    finish({ version: 2 });
    await saving;
  });
  await act(async () => view.update(render()));
  expect(view.root.findByType(Sheet).props.visible).toBe(false);
});

test.each(["review starts", "assignment removed"])(
  "closes the sheet when %s without unmounting its owner",
  async (reason) => {
    await open();
    await act(async () =>
      view.update(
        render({
          canChangeDuty: false,
          ...(reason === "assignment removed" ? { assignment: null } : {}),
        }),
      ),
    );
    expect(view.root.findByType(Sheet).props.visible).toBe(false);
    expect(
      view.root.findAllByProps({ label: "Change duty status" }),
    ).toHaveLength(0);
    expect(mock.unmount).not.toHaveBeenCalled();
    await act(async () =>
      view.root.findByProps({ label: "Confirm step away" }).props.onPress(),
    );
    expect(mock.mutate).not.toHaveBeenCalled();
  },
);
