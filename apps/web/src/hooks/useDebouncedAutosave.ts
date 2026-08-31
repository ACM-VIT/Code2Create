import { useCallback, useEffect, useRef, useState } from 'react'

export type AutosaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

type SaveRecord = {
  failedValue: string | null
  lastSavedValue: string
  resetKey: string
  state: AutosaveState
}

export function useDebouncedAutosave<Result>({
  delayMs = 850,
  enabled,
  initialSavedValue,
  onError,
  onSaved,
  resetKey,
  save,
  value,
}: {
  delayMs?: number
  enabled: boolean
  initialSavedValue: string
  onError: (error: Error) => void
  onSaved: (result: Result, savedValue: string) => void
  resetKey: string
  save: (value: string) => Promise<Result>
  value: string
}) {
  const [record, setRecord] = useState<SaveRecord>({
    failedValue: null,
    lastSavedValue: initialSavedValue,
    resetKey,
    state: 'idle',
  })
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const onErrorRef = useRef(onError)
  const onSavedRef = useRef(onSaved)
  const saveRef = useRef(save)

  useEffect(() => {
    onErrorRef.current = onError
    onSavedRef.current = onSaved
    saveRef.current = save
  }, [onError, onSaved, save])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const current = record.resetKey === resetKey
    ? record
    : {
        failedValue: null,
        lastSavedValue: initialSavedValue,
        resetKey,
        state: 'idle' as const,
      }
  const currentFailedValue = current.failedValue
  const currentLastSavedValue = current.lastSavedValue
  const currentResetKey = current.resetKey
  const currentState = current.state
  const state: AutosaveState = !enabled
    ? 'idle'
    : value === currentLastSavedValue
      ? value ? 'saved' : 'idle'
      : currentFailedValue === value
        ? 'error'
        : currentState === 'saving'
          ? 'saving'
          : 'dirty'

  useEffect(() => {
    if (
      !enabled ||
      value === currentLastSavedValue ||
      currentFailedValue === value
    ) return
    const timer = window.setTimeout(() => {
      if (inFlight.current) return
      const valueToSave = value
      inFlight.current = true
      setRecord({
        failedValue: currentFailedValue,
        lastSavedValue: currentLastSavedValue,
        resetKey: currentResetKey,
        state: 'saving',
      })
      void saveRef.current(valueToSave)
        .then((result) => {
          if (!mounted.current) return
          setRecord({
            failedValue: null,
            lastSavedValue: valueToSave,
            resetKey,
            state: 'saved',
          })
          onSavedRef.current(result, valueToSave)
        })
        .catch((caught: unknown) => {
          if (!mounted.current) return
          setRecord({
            failedValue: valueToSave,
            lastSavedValue: currentLastSavedValue,
            resetKey: currentResetKey,
            state: 'error',
          })
          onErrorRef.current(
            caught instanceof Error ? caught : new Error('Autosave failed.'),
          )
        })
        .finally(() => {
          inFlight.current = false
        })
    }, delayMs)
    return () => window.clearTimeout(timer)
  }, [
    currentFailedValue,
    currentLastSavedValue,
    currentResetKey,
    delayMs,
    enabled,
    resetKey,
    value,
  ])

  const retry = useCallback(() => {
    setRecord((prior) => ({
      ...(prior.resetKey === resetKey
        ? prior
        : {
            lastSavedValue: initialSavedValue,
            resetKey,
            state: 'idle' as const,
          }),
      failedValue: null,
      state: 'dirty',
    }))
  }, [initialSavedValue, resetKey])

  return { retry, state }
}

export function autosaveLabel(state: AutosaveState) {
  switch (state) {
    case 'dirty':
      return 'Saving soon…'
    case 'saving':
      return 'Saving…'
    case 'saved':
      return 'Saved'
    case 'error':
      return 'Not saved'
    case 'idle':
      return ''
  }
}
