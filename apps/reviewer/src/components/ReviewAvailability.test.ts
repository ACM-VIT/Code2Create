import { createElement, useEffect } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@code2create/backend/api";
import { Sheet } from "@/components/ui";
import { ReviewAvailability } from "./ReviewAvailability";

type Confirmation = FunctionReturnType<
  typeof api.reviewConfirmations.mine
>[number];
const mock = vi.hoisted(() => ({
  rounds: [] as Confirmation[],
  respond: vi.fn(),
  unmount: vi.fn(),
}));
vi.mock("@code2create/backend/api", () => ({
  api: { reviewConfirmations: { mine: "mine", respond: "respond" } },
}));
vi.mock("convex/react", () => ({
  useQuery: () => mock.rounds,
  useMutation: () => mock.respond,
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "confirmation-command" }));
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
}));
vi.mock("@/components/ui", () => ({
  Action: "Action",
  QuietAction: "QuietAction",
  Problem: "Problem",
  Sheet: (props: { children: React.ReactNode; visible: boolean }) => {
    useEffect(() => () => mock.unmount(), []);
    return createElement("Sheet", props, props.children);
  },
}));
vi.mock("@/lib/errors", () => ({
  describeError: (_: unknown, message: string) => message,
}));
vi.mock("@/lib/mutation-attempt", () => ({
  useMutationAttempt: () => ({
    hasPending: () => false,
    run: (_key: string, prepare: () => () => Promise<unknown>) => prepare()(),
  }),
}));
let view: ReturnType<typeof create>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mock.unmount.mockClear();
  mock.respond.mockReset();
  mock.rounds = [
    {
      roundId: "round" as Confirmation["roundId"],
      name: "Review 1",
      startsAt: 1_800_000_000_000,
      endsAt: 1_800_086_400_000,
      opensAt: 1_799_999_000_000,
      closesAt: 1_800_000_000_000,
      reviewDurationSeconds: 420,
      assignmentReminderSeconds: 300,
      state: "open",
      response: { status: "pending", version: 1, windows: [] },
    },
  ];
});
afterEach(async () => {
  await act(async () => view?.unmount());
  vi.unstubAllGlobals();
});

test("a live confirmation response keeps its native sheet mounted until it dismisses", async () => {
  let finish!: (value: { version: number }) => void;
  mock.respond.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => {
    view = create(createElement(ReviewAvailability, { eventSlug: "event" }));
  });
  await act(async () =>
    view.root.findByProps({ label: "Confirm availability" }).props.onPress(),
  );
  let saving!: Promise<void>;
  await act(async () => {
    saving = view.root
      .findByProps({ label: "The whole round" })
      .props.onPress();
  });
  const round = mock.rounds[0]!;
  expect(mock.respond).toHaveBeenCalledWith(
    expect.objectContaining({
      windows: [{ startsAt: round.startsAt, endsAt: round.endsAt }],
      expectedVersion: 1,
    }),
  );
  mock.rounds = [
    {
      ...round,
      response: {
        status: "confirmed",
        version: 2,
        windows: [{ startsAt: round.startsAt, endsAt: round.endsAt }],
      },
    },
  ];
  await act(async () =>
    view.update(createElement(ReviewAvailability, { eventSlug: "event" })),
  );
  expect(mock.unmount).not.toHaveBeenCalled();
  await act(async () => {
    finish({ version: 2 });
    await saving;
  });
  expect(view.root.findByType(Sheet).props.visible).toBe(false);
  expect(mock.unmount).not.toHaveBeenCalled();
});
