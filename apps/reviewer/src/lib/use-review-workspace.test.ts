import { createElement, StrictMode, useEffect } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { api } from "@code2create/backend/api";
import { useReviewWorkspace } from "./use-review-workspace";

type Workspace = FunctionReturnType<typeof api.reviewer.reviewWorkspace>;
type ReviewId = FunctionArgs<
  typeof api.reviewer.reviewWorkspace
>["reviewSessionId"];
const mock = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@code2create/backend/api", () => ({
  api: { reviewer: { reviewWorkspace: "workspace" } },
}));
vi.mock("convex/react", () => ({ useAction: () => mock.load }));
vi.mock("./errors", () => ({
  describeError: (_error: unknown, fallback: string) => fallback,
}));
const firstId = "review-one" as ReviewId;
const nextId = "review-two" as ReviewId;
const loadedWorkspace: Workspace = {
  id: firstId,
  criteria: [],
  evidence: {
    id: "evidence" as Workspace["evidence"]["id"],
    capturedResourceCount: 0,
    expectedResourceCount: 0,
    completeness: "complete",
    github: [],
  },
  project: {
    initialIdea: "A local project",
    intakeResponses: [],
    latestCheckpoint: null,
    submittedAt: 123,
  },
  teamContext: {
    priorReviews: [],
    team: {
      id: "team" as Workspace["teamContext"]["team"]["id"],
      name: "Team",
      memberCount: 3,
      projectSubmittedAt: 123,
      projectVersion: 1,
      publicCode: "TEAM",
    },
  },
};
let view: ReturnType<typeof create>;
let result: ReturnType<typeof useReviewWorkspace>;
function Screen({
  id = firstId,
  startedAt,
}: {
  id?: ReviewId;
  startedAt?: number;
}) {
  const workspace = useReviewWorkspace("event", {
    id,
    ...(startedAt === undefined ? {} : { startedAt }),
  });
  useEffect(() => {
    result = workspace;
  });
  return null;
}
function pending() {
  let reject!: (error: Error) => void;
  let resolve!: (value: Workspace) => void;
  const promise = new Promise<Workspace>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mock.load.mockReset();
});
afterEach(async () => {
  await act(async () => view?.unmount());
  vi.unstubAllGlobals();
});

test("Strict Mode cleanup does not strand a review in loading", async () => {
  const abandoned = pending();
  const current = pending();
  mock.load
    .mockReturnValueOnce(abandoned.promise)
    .mockReturnValueOnce(current.promise);
  await act(async () => {
    view = create(createElement(StrictMode, null, createElement(Screen)));
  });
  expect(mock.load).toHaveBeenCalledTimes(2);
  await act(async () => abandoned.reject(new Error("Obsolete request")));
  expect(result.error).toBeNull();
  await act(async () => current.reject(new Error("Network unavailable")));
  expect(result.error).toBe("Project details could not be loaded.");
});

test("retry starts a new request even when the review has not changed", async () => {
  mock.load.mockRejectedValue(new Error("Offline"));
  await act(async () => {
    view = create(createElement(Screen));
  });
  const retry = pending();
  mock.load.mockReturnValueOnce(retry.promise);
  await act(async () => result.retry());
  expect(mock.load).toHaveBeenCalledTimes(2);
  expect(result.error).toBeNull();
  await act(async () => retry.resolve(loadedWorkspace));
  expect(result.error).toBeNull();
  expect(result.workspace).toEqual(loadedWorkspace);
});

test("review start and a new team discard late results from earlier evidence", async () => {
  const preparation = pending();
  const started = pending();
  const next = pending();
  mock.load
    .mockReturnValueOnce(preparation.promise)
    .mockReturnValueOnce(started.promise)
    .mockReturnValueOnce(next.promise);
  await act(async () => {
    view = create(createElement(Screen));
  });
  await act(async () => view.update(createElement(Screen, { startedAt: 123 })));
  await act(async () =>
    view.update(createElement(Screen, { id: nextId, startedAt: 456 })),
  );
  await act(async () => {
    preparation.reject(new Error("Old preparation"));
    started.reject(new Error("Old review"));
  });
  expect(result.error).toBeNull();
  expect(mock.load).toHaveBeenLastCalledWith({
    eventSlug: "event",
    reviewSessionId: nextId,
  });
  await act(async () => next.reject(new Error("Current review")));
  expect(result.error).toBe("Project details could not be loaded.");
});
