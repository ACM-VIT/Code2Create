import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getFunctionName, type FunctionReturnType } from "convex/server";
import type { api } from "@code2create/backend/api";
import type { ReviewerRuntime } from "@/lib/runtime";
import { ReviewPanel } from "./ReviewPanel";

const mock = vi.hoisted(() => ({
  current: null as FunctionReturnType<typeof api.reviewer.now> | null,
}));
vi.mock("convex/react", () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) =>
    args === "skip"
      ? undefined
      : getFunctionName(ref) === "reviewer:now"
        ? mock.current
        : [],
  useMutation: () => vi.fn(),
}));
vi.mock("expo-router", () => ({
  useRouter: () => ({ navigate: vi.fn(), setParams: vi.fn() }),
  Stack: { Screen: "Screen" },
}));
vi.mock("expo-camera", () => ({ CameraView: "CameraView" }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "command" }));
vi.mock("react-native-svg", () => ({ default: "Svg", Path: "Path" }));
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  TextInput: "TextInput",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Platform: { OS: "ios" },
  Alert: { alert: vi.fn() },
  Animated: { createAnimatedComponent: (component: string) => component },
  AppState: { addEventListener: () => ({ remove: vi.fn() }) },
  StyleSheet: { create: (s: object) => s, hairlineWidth: 1 },
}));
vi.mock("@/components/ui", () =>
  Object.fromEntries(
    [
      "Action",
      "ChipRow",
      "ErrorSheet",
      "Field",
      "HeaderButton",
      "Meta",
      "Nothing",
      "Problem",
      "QuietAction",
      "ScoreRow",
      "Sheet",
    ].map((name) => [name, name]),
  ),
);
vi.mock("@/components/skeletons", () => ({
  JudgingSkeleton: "JudgingSkeleton",
}));
vi.mock("@/components/ReviewerSession", () => ({
  useReviewerSession: () => ({
    eventSlug: "event",
  }),
}));
vi.mock("@/components/PagingSetup", () => ({ PagingSetup: "PagingSetup" }));
vi.mock("@/components/ProjectEvidence", () => ({
  ProjectEvidence: "ProjectEvidence",
}));
vi.mock("@/components/ReviewQuestions", () => ({
  ReviewQuestions: "ReviewQuestions",
}));
vi.mock("@/components/ReviewerSetup", () => ({
  ReviewerSetup: "ReviewerSetup",
}));
vi.mock("@/lib/use-review-workspace", () => ({
  useReviewWorkspace: () => ({ workspace: null, error: null, retry: vi.fn() }),
}));
vi.mock("@/lib/use-camera-access", () => ({
  useCameraAccess: () => ({
    permission: { granted: true },
    requestPermission: vi.fn(),
    error: null,
  }),
}));
vi.mock("@/lib/use-reviewer-push", () => ({
  useReviewerPush: () => ({
    state: { status: "not_granted" },
    requestPermission: vi.fn(),
  }),
}));
vi.mock("@/lib/reviewer-device", () => ({
  loadReviewerDevice: async () => ({ installationId: "phone" }),
}));
vi.mock("@/lib/local-scorecard", () => ({
  checkEncryptedDraftStorage: async () => {},
}));
vi.mock("@/lib/local-coordinator-notes", () => ({}));
vi.mock("@/lib/client-operation-intents", () => ({
  confirmObservedClientOperation: async () => {},
}));
vi.mock("@/lib/errors", () => ({
  describeError: (_: unknown, message: string) => message,
}));

type Current = NonNullable<typeof mock.current>;
const runtime = {
  configuration: {
    eventSlug: "event",
    appBuild: 1,
    apnsEnvironment: "development",
  },
} as ReviewerRuntime;
const review = {
  id: "review-one",
  status: "awaiting_presence",
  assignment: {
    reviewerPresenceConfirmed: false,
    reviewerPresenceCount: 4,
    reviewerCount: 5,
    isCoordinator: true,
  },
} as NonNullable<Current["review"]>;
let view: ReturnType<typeof create>;
let errors: ReturnType<typeof vi.spyOn>;
const render = () => createElement(ReviewPanel, { runtime });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.current = {
    serverNow: Date.now(),
    device: {
      appBuild: 1,
      cameraReady: true,
      notificationsReady: false,
      encryptedDraftReady: true,
    },
    panel: {
      clockIn: { status: "present", version: 1 },
      round: { id: "round", name: "Review 1" },
    },
    reserve: null,
    review,
  } as Current;
});
afterEach(async () => {
  await act(async () => view?.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("arrival controls retain distinct identities and reset when the next team arrives", async () => {
  await act(async () => {
    view = create(render());
  });
  expect(view.root.findAllByProps({ label: "Paging settings" })).toHaveLength(
    0,
  );
  expect(
    view.root.findAllByProps({ label: "Change duty status" }),
  ).toHaveLength(0);
  await act(async () =>
    view.root.findByProps({ label: "Type code instead" }).props.onPress(),
  );
  expect(view.root.findByProps({ label: "Confirm team code" })).toBeDefined();
  if (!mock.current) throw Error("Current duty missing");
  mock.current = {
    ...mock.current,
    review: { ...review, id: "review-two" as typeof review.id },
  };
  await act(async () => view.update(render()));
  expect(view.root.findByProps({ label: "Type code instead" })).toBeDefined();
  expect(view.root.findAllByProps({ label: "Confirm team code" })).toHaveLength(
    0,
  );
  expect(
    errors.mock.calls
      .flat()
      .some(
        (value: unknown) =>
          typeof value === "string" &&
          /same key|order of Hooks|more hooks|fewer hooks/i.test(value),
      ),
  ).toBe(false);
});

