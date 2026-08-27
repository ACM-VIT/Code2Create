import { ConvexError } from 'convex/values'
import { useState, useSyncExternalStore } from 'react'

import { isConvexErrorCode } from './errors.ts'
import {
  FreshAuthenticationCancelledError,
  requestFreshAuthentication,
} from './freshAuthentication.ts'

type PendingAttempt<Result> = {
  execute: () => Promise<Result>
}

function createRetriableAttemptStore<Result>(operationName: 'command' | 'mutation') {
  const pending = new Map<string, PendingAttempt<Result>>()
  const running = new Set<string>()
  const listeners = new Set<() => void>()
  let revision = 0

  const changed = () => {
    revision += 1
    for (const listener of listeners) listener()
  }

  const execute = async (slot: string, attempt: PendingAttempt<Result>) => {
    if (running.has(slot)) throw new Error(`This ${operationName} is already in progress.`)
    running.add(slot)
    try {
      const result = await executeWithFreshAuthentication(attempt)
      if (pending.get(slot) === attempt) {
        pending.delete(slot)
        changed()
      }
      return result
    } catch (caught) {
      if (
        (caught instanceof ConvexError || caught instanceof FreshAuthenticationCancelledError) &&
        pending.get(slot) === attempt
      ) {
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
    async run(slot: string, createAttempt: () => PendingAttempt<Result>): Promise<Result> {
      const existing = pending.get(slot)
      const attempt = existing ?? createAttempt()
      if (!existing) {
        pending.set(slot, attempt)
        changed()
      }
      return execute(slot, attempt)
    },
    async retryPending(slot: string): Promise<Result> {
      const attempt = pending.get(slot)
      if (!attempt) throw new Error(`This ${operationName} no longer needs confirmation.`)
      return execute(slot, attempt)
    },
  }
}

export function createOperationRunner<Result = unknown>() {
  const attempts = createRetriableAttemptStore<Result>('command')

  return {
    subscribe: attempts.subscribe,
    snapshot: attempts.snapshot,
    hasPending: attempts.hasPending,
    confirmExactObservation: attempts.confirmExactObservation,
    run(
      slot: string,
      createCommand: (clientOperationId: string) => () => Promise<Result>,
    ): Promise<Result> {
      return attempts.run(slot, () => newCommand(slot, createCommand))
    },
    retryPending: attempts.retryPending,
  }
}

export type OperationRunner<Result> = ReturnType<typeof createOperationRunner<Result>>

function newCommand<Result>(
  slot: string,
  createCommand: (clientOperationId: string) => () => Promise<Result>,
): PendingAttempt<Result> {
  const clientOperationId = `${slot}:${crypto.randomUUID()}`
  return { execute: createCommand(clientOperationId) }
}

export function useOperationRunner<Result = unknown>() {
  const [runner] = useState(createOperationRunner<Result>)
  useSyncExternalStore(runner.subscribe, runner.snapshot, runner.snapshot)
  return runner
}

export function createMutationAttempt<Result>() {
  const attempts = createRetriableAttemptStore<Result>('mutation')

  return {
    subscribe: attempts.subscribe,
    snapshot: attempts.snapshot,
    hasPending: attempts.hasPending,
    run(slot: string, createCommand: () => () => Promise<Result>): Promise<Result> {
      return attempts.run(slot, () => ({ execute: createCommand() }))
    },
    retryPending: attempts.retryPending,
  }
}

export function useMutationAttempt<Result>() {
  const [attempt] = useState(createMutationAttempt<Result>)
  useSyncExternalStore(attempt.subscribe, attempt.snapshot, attempt.snapshot)
  return attempt
}

async function executeWithFreshAuthentication<Result>(attempt: PendingAttempt<Result>) {
  try {
    return await attempt.execute()
  } catch (caught) {
    if (!isConvexErrorCode(caught, 'FRESH_AUTH_REQUIRED')) throw caught
    await requestFreshAuthentication()
    return attempt.execute()
  }
}
