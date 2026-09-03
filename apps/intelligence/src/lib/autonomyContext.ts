import { AsyncLocalStorage } from "node:async_hooks";

import type { OperationsAutonomyInput } from "./autonomyProtocol.ts";

type AutonomyOperationContext = {
  runId: string;
  operationId: string;
};

export type AutonomyRunState = {
  input: OperationsAutonomyInput;
  authoritative:
    | {
        sequence: number;
      }
    | undefined;
};

const operationContext = new AsyncLocalStorage<AutonomyOperationContext>();
const activeStates = new Map<string, AutonomyRunState>();
const operationLocks = new Map<string, Promise<void>>();
const modelAuthorizations = new Map<string, Promise<number>>();

/**
 * Creates request-local execution state from durable, schema-parsed initial
 * data. The map is only a same-isolate optimization for provider-stream
 * callbacks; Convex receipts remain the authority after any isolate restart.
 */
export function autonomyRunState(input: OperationsAutonomyInput) {
  const current = activeStates.get(input.runId);
  if (
    current !== undefined &&
    current.input.policy.policyChecksum === input.policy.policyChecksum &&
    current.input.source.sourceChecksum === input.source.sourceChecksum
  ) {
    return current;
  }
  const state: AutonomyRunState = {
    input,
    authoritative: undefined,
  };
  activeStates.set(input.runId, state);
  return state;
}

export function applyAutonomyReceipt(state: AutonomyRunState, receipt: { sequence: number }) {
  if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) {
    throw new Error("The autonomy service returned an invalid sequence.");
  }
  // An old operation may be replayed after a later one during durable
  // recovery. Its stored receipt proves idempotency but must never rewind the
  // locally cached authoritative cursor.
  if (state.authoritative === undefined || receipt.sequence > state.authoritative.sequence) {
    state.authoritative = { sequence: receipt.sequence };
  }
}

export function runWithAutonomyOperation<T>(
  state: AutonomyRunState,
  operationId: string,
  operation: () => T,
) {
  return operationContext.run(
    {
      runId: state.input.runId,
      operationId,
    },
    operation,
  );
}

export async function runAutonomySerial<T>(runId: string, operation: () => Promise<T>) {
  const prior = operationLocks.get(runId) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prior.then(() => current);
  operationLocks.set(runId, tail);
  await prior;
  try {
    return await operation();
  } finally {
    release();
    if (operationLocks.get(runId) === tail) operationLocks.delete(runId);
  }
}

/** Avoids one signed replay for every iterator pull of the same Flue model turn. */
export function cachedModelAuthorization(
  runId: string,
  operationId: string,
  reserve: () => Promise<number>,
) {
  const key = `${runId}\u0000${operationId}`;
  const existing = modelAuthorizations.get(key);
  if (existing !== undefined) return existing;
  const pending = reserve();
  modelAuthorizations.set(key, pending);
  pending
    .finally(() => {
      if (modelAuthorizations.get(key) === pending) modelAuthorizations.delete(key);
    })
    .catch(() => {});
  return pending;
}

export function clearAutonomyRun(runId: string) {
  activeStates.delete(runId);
  operationLocks.delete(runId);
  for (const key of modelAuthorizations.keys()) {
    if (key.startsWith(`${runId}\u0000`)) modelAuthorizations.delete(key);
  }
}

export function clearAutonomyRunForTests(runId: string) {
  clearAutonomyRun(runId);
}
