import { useRef, useState } from 'react'

import { readableError } from './errors.ts'
import { useOperationRunner } from './operations.ts'

export type ConfigurationOperationDescriptor = {
  slot: string
  title: string
  action: string
}

export function useConfigurationOperations<Result>(
  descriptors: readonly ConfigurationOperationDescriptor[],
) {
  const runner = useOperationRunner<Result>()
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pendingOperation = descriptors.find(({ slot }) => runner.hasPending(slot)) ?? null
  const operationPending = pendingOperation !== null

  const execute = async (command: () => Promise<Result>, onSuccess?: () => void) => {
    if (inFlight.current) return false
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await command()
      onSuccess?.()
      return true
    } catch (caught) {
      setError(readableError(caught))
      return false
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const run = (
    slot: string,
    createCommand: (clientOperationId: string) => () => Promise<Result>,
    onSuccess?: () => void,
  ) => {
    if (descriptors.some(({ slot: pendingSlot }) => runner.hasPending(pendingSlot))) {
      return Promise.resolve(false)
    }
    return execute(() => runner.run(slot, createCommand), onSuccess)
  }

  const retryPending = (onSuccess?: () => void) => {
    if (pendingOperation === null) return Promise.resolve(false)
    return execute(() => runner.retryPending(pendingOperation.slot), onSuccess)
  }

  return {
    busy,
    error,
    hasPending: (slot: string) => runner.hasPending(slot),
    operationPending,
    pendingOperation,
    retryPending,
    run,
    setError,
  }
}
