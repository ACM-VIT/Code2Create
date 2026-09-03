import { ConvexError } from "convex/values";
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import { z } from "zod";

import { OperatorError } from "./errors";

const recoverySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("floor_assignment_v1"),
      claimId: z.string().min(1),
      x: z.number().finite(),
      y: z.number().finite(),
      expectedClaimVersion: z.number().int().nonnegative(),
      requiresReason: z.boolean(),
    })
    .strict(),
]);

const operationRecordSchema = z
  .object({
    version: z.literal(2),
    operationId: z.uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    recovery: recoverySchema.optional(),
  })
  .strict();

const slotLocks = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

export type PersistentOperationRecovery = z.infer<typeof recoverySchema>;

export async function runPersistentClientOperation<Result>(args: {
  eventSlug: string;
  slot: string;
  fingerprint: string;
  recovery?: PersistentOperationRecovery;
  execute: (clientOperationId: string) => Promise<Result>;
}) {
  const key = operationStorageKey(args.eventSlug, args.slot);
  return withSlotLock(key, async () => {
    const fingerprint = await digestStringAsync(CryptoDigestAlgorithm.SHA256, args.fingerprint);
    const stored = await readOperation(key);
    if (stored && stored.fingerprint !== fingerprint) {
      throw new OperatorError(
        "An earlier operation is still waiting for a definite response. Return to it and retry the exact same action before starting another.",
      );
    }
    const operationId = stored?.operationId ?? randomUUID();
    if (!stored) {
      await SecureStore.setItemAsync(
        key,
        JSON.stringify({
          version: 2,
          operationId,
          fingerprint,
          ...(args.recovery ? { recovery: args.recovery } : {}),
        }),
        { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
      );
      notifyListeners();
    }
    try {
      const result = await args.execute(operationId);
      await clearOperation(key, operationId);
      return result;
    } catch (caught) {
      if (caught instanceof ConvexError) await clearOperation(key, operationId);
      throw caught;
    }
  });
}

export async function confirmObservedClientOperation(args: { eventSlug: string; slot: string }) {
  const key = operationStorageKey(args.eventSlug, args.slot);
  await withSlotLock(key, async () => {
    const current = await readOperation(key);
    if (!current) return;
    await SecureStore.deleteItemAsync(key);
    notifyListeners();
  });
}

async function readOperation(key: string) {
  const stored = await SecureStore.getItemAsync(key);
  if (!stored) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(stored);
  } catch {
    throw unreadableOperationError();
  }
  const parsed = operationRecordSchema.safeParse(decoded);
  if (!parsed.success) {
    throw unreadableOperationError();
  }
  return parsed.data;
}

async function clearOperation(key: string, operationId: string) {
  const current = await readOperation(key);
  if (current?.operationId === operationId) {
    await SecureStore.deleteItemAsync(key);
    notifyListeners();
  }
}

export function usePersistentClientOperations(eventSlug: string, slots: readonly string[]) {
  const slotKey = slots.join("\u0000");
  const [state, setState] = useState<{
    loading: boolean;
    records: ReadonlyMap<string, z.infer<typeof operationRecordSchema>>;
    error: string | null;
  }>({ loading: true, records: new Map(), error: null });

  useEffect(() => {
    let active = true;
    const requestedSlots = slotKey ? slotKey.split("\u0000") : [];
    const load = async () => {
      const records = new Map<string, z.infer<typeof operationRecordSchema>>();
      try {
        for (const slot of requestedSlots) {
          const record = await readOperation(operationStorageKey(eventSlug, slot));
          if (record) records.set(slot, record);
        }
        if (active) setState({ loading: false, records, error: null });
      } catch (caught) {
        if (active) {
          setState({ loading: false, records, error: operationReadError(caught) });
        }
      }
    };
    const refresh = () => void load();
    listeners.add(refresh);
    void load();
    return () => {
      active = false;
      listeners.delete(refresh);
    };
  }, [eventSlug, slotKey]);

  return state;
}

async function withSlotLock<Result>(key: string, operation: () => Promise<Result>) {
  const prior = slotLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = prior.catch(() => undefined).then(() => current);
  slotLocks.set(key, chain);
  await prior.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (slotLocks.get(key) === chain) slotLocks.delete(key);
  }
}

function operationStorageKey(eventSlug: string, slot: string) {
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u.test(eventSlug)) {
    throw new Error("The event key cannot own a client operation.");
  }
  if (!/^[a-z][a-z0-9_.-]{0,79}$/u.test(slot)) {
    throw new Error("The client-operation slot is invalid.");
  }
  return `c2c.operation.${eventSlug}.${slot}`;
}

function notifyListeners() {
  for (const listener of listeners) listener();
}

function unreadableOperationError() {
  return new OperatorError(
    "A saved action cannot be verified. Do not repeat it. Ask an administrator to check whether it completed.",
  );
}

function operationReadError(caught: unknown) {
  return caught instanceof Error
    ? caught.message
    : "A saved action cannot be verified. Do not repeat it.";
}
