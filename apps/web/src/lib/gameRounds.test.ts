import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoundRecorder } from "./gameRounds.ts";

/** A promise with its settle handles, to control when the run lands. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued promise callbacks run. */
const settle = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

test("a round records against the run opened for it", async () => {
  const recorded: { score: number; runId: string }[] = [];
  const recorder = createRoundRecorder<string>({
    openRun: () => Promise.resolve("run-1"),
    recordRound: async (round) => {
      recorded.push(round);
    },
    onError: (cause) => assert.fail(`unexpected failure: ${String(cause)}`),
  });

  recorder.start();
  await settle();
  recorder.end(400);
  await settle();

  assert.deepEqual(recorded, [{ score: 400, runId: "run-1" }]);
});

test("a round that ends before its run opens is still recorded", async () => {
  const opening = deferred<string>();
  const recorded: { score: number; runId: string }[] = [];
  const recorder = createRoundRecorder<string>({
    openRun: () => opening.promise,
    recordRound: async (round) => {
      recorded.push(round);
    },
    onError: (cause) => assert.fail(`unexpected failure: ${String(cause)}`),
  });

  // The whole round happens while the run is still in flight.
  recorder.start();
  recorder.end(120);
  await settle();
  assert.deepEqual(recorded, [], "nothing can be recorded until the run lands");

  opening.resolve("run-late");
  await settle();
  assert.deepEqual(
    recorded,
    [{ score: 120, runId: "run-late" }],
    "the waiting score reaches the run rather than being dropped",
  );
});

test("a run is spent once, so a second end records nothing", async () => {
  const recorded: unknown[] = [];
  const recorder = createRoundRecorder<string>({
    openRun: () => Promise.resolve("run-1"),
    recordRound: async (round) => {
      recorded.push(round);
    },
    onError: () => undefined,
  });

  recorder.start();
  await settle();
  recorder.end(10);
  recorder.end(999);
  await settle();

  assert.equal(recorded.length, 1);
});

test("a round with no run behind it records nothing", async () => {
  let opened = 0;
  const recorder = createRoundRecorder<string>({
    openRun: () => {
      opened += 1;
      return Promise.resolve("run-1");
    },
    recordRound: async () => assert.fail("nothing should be recorded"),
    onError: () => assert.fail("nothing should fail"),
  });

  recorder.end(500);
  await settle();
  assert.equal(opened, 0);
});

test("a run that fails to open reports the cause once the round ends", async () => {
  const failures: unknown[] = [];
  const recorder = createRoundRecorder<string>({
    openRun: () => Promise.reject(new Error("rate limited")),
    recordRound: async () => assert.fail("no run to record against"),
    onError: (cause) => failures.push(cause),
  });

  recorder.start();
  await settle();
  assert.deepEqual(failures, [], "the failure waits for a round to report it");

  recorder.end(300);
  await settle();
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /rate limited/u);
});

test("each round opens its own run", async () => {
  const runs = ["run-1", "run-2"];
  const recorded: { score: number; runId: string }[] = [];
  const recorder = createRoundRecorder<string>({
    openRun: () => Promise.resolve(runs.shift() ?? "exhausted"),
    recordRound: async (round) => {
      recorded.push(round);
    },
    onError: () => undefined,
  });

  recorder.start();
  await settle();
  recorder.end(100);
  recorder.start();
  await settle();
  recorder.end(200);
  await settle();

  assert.deepEqual(recorded, [
    { score: 100, runId: "run-1" },
    { score: 200, runId: "run-2" },
  ]);
});
