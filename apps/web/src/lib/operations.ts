import { ConvexError } from 'convex/values'
import { useState, useSyncExternalStore } from 'react'

type PendingCommand<Result> = {
  execute: () => Promise<Result>
}

type PendingMutation<Result> = {
  execute: () => Promise<Result>
}

export function createOperationRunner<Result = unknown>() {
  const pending = new Map<string, PendingCommand<Result>>()
  const running = new Set<string>()
  const listeners = new Set<() => void>()
  let revision = 0

  const changed = () => {
    revision += 1
    for (const listener of listeners) listener()
  }

  const execute = async (slot: string, attempt: PendingCommand<Result>) => {
    if (running.has(slot)) throw new Error('This command is already in progress.')
    running.add(slot)
    try {
      const result = await attempt.execute()
      if (pending.get(slot) === attempt) {
        pending.delete(slot)
        changed()
      }
      return result
    } catch (caught) {
      if (caught instanceof ConvexError && pending.get(slot) === attempt) {
        pending.delete(slot)
        changed()
      }
      throw caught
    } finally {
      running.delete(slot)
    }
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    snapshot() {
      return revision
    },
    hasPending(slot: string) {
      return pending.has(slot)
    },
    confirmExactObservation(slot: string) {
      if (!pending.delete(slot)) return
      changed()
    },
    async run(
      slot: string,
      createCommand: (clientOperationId: string) => () => Promise<Result>,
    ): Promise<Result> {
      const existing = pending.get(slot)
      const attempt = existing ?? newCommand(slot, createCommand)
      if (!existing) {
        pending.set(slot, attempt)
        changed()
      }
      return execute(slot, attempt)
    },
    async retryPending(slot: string): Promise<Result> {
      const attempt = pending.get(slot)
      if (!attempt) throw new Error('This command no longer needs confirmation.')
      return execute(slot, attempt)
    },
  }
}

function newCommand<Result>(
  slot: string,
  createCommand: (clientOperationId: string) => () => Promise<Result>,
): PendingCommand<Result> {
  const clientOperationId = `${slot}:${crypto.randomUUID()}`
  return { execute: createCommand(clientOperationId) }
}

export function useOperationRunner<Result = unknown>() {
  const [runner] = useState(createOperationRunner<Result>)
  useSyncExternalStore(runner.subscribe, runner.snapshot, runner.snapshot)
  return runner
}

export function createMutationAttempt<Result>() {
  const pending = new Map<string, PendingMutation<Result>>()
  const running = new Set<string>()
  const listeners = new Set<() => void>()
  let revision = 0

  const changed = () => {
    revision += 1
    for (const listener of listeners) listener()
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    snapshot() {
      return revision
    },
    hasPending(slot: string) {
      return pending.has(slot)
    },
    async run(slot: string, createCommand: () => () => Promise<Result>): Promise<Result> {
      if (running.has(slot)) throw new Error('This mutation is already in progress.')
      const existing = pending.get(slot)
      const attempt = existing ?? { execute: createCommand() }
      if (!existing) {
        pending.set(slot, attempt)
        changed()
      }
      running.add(slot)
      try {
        const result = await attempt.execute()
        if (pending.get(slot) === attempt) {
          pending.delete(slot)
          changed()
        }
        return result
      } catch (caught) {
        if (caught instanceof ConvexError && pending.get(slot) === attempt) {
          pending.delete(slot)
          changed()
        }
        throw caught
      } finally {
        running.delete(slot)
      }
    },
  }
}

export function useMutationAttempt<Result>() {
  const [attempt] = useState(createMutationAttempt<Result>)
  useSyncExternalStore(attempt.subscribe, attempt.snapshot, attempt.snapshot)
  return attempt
}
