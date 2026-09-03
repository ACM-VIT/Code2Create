import { ConvexError } from "convex/values";
import { useState, useSyncExternalStore } from "react";

type PendingMutation<Result> = {
  execute: () => Promise<Result>;
};

export function createMutationAttempt<Result>() {
  const pending = new Map<string, PendingMutation<Result>>();
  const running = new Set<string>();
  const listeners = new Set<() => void>();
  let revision = 0;

  const changed = () => {
    revision += 1;
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot() {
      return revision;
    },
    hasPending(slot: string) {
      return pending.has(slot);
    },
    async run(slot: string, createCommand: () => () => Promise<Result>): Promise<Result> {
      if (running.has(slot)) throw new Error("This mutation is already in progress.");
      const existing = pending.get(slot);
      const attempt = existing ?? { execute: createCommand() };
      if (!existing) {
        pending.set(slot, attempt);
        changed();
      }
      running.add(slot);
      try {
        const result = await attempt.execute();
        if (pending.get(slot) === attempt) {
          pending.delete(slot);
          changed();
        }
        return result;
      } catch (caught) {
        if (caught instanceof ConvexError && pending.get(slot) === attempt) {
          pending.delete(slot);
          changed();
        }
        throw caught;
      } finally {
        running.delete(slot);
      }
    },
  };
}

export function useMutationAttempt<Result>() {
  const [attempt] = useState(createMutationAttempt<Result>);
  useSyncExternalStore(attempt.subscribe, attempt.snapshot, attempt.snapshot);
  return attempt;
}
