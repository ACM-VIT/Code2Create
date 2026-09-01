import { useCallback, useState } from 'react'

type VersionedState<Value> = {
  sourceKey: string
  value: Value
}

/**
 * Keeps local edits until the authoritative source version changes.
 *
 * Query results can update while an editor is open. A plain effect that copies
 * every result into local state either clobbers in-progress edits or needs a
 * second "loaded version" state. This hook makes the source version part of
 * the draft itself: renders immediately project a new authoritative value,
 * while later edits continue from that projected value.
 */
export function useVersionedState<Value>(sourceKey: string, sourceValue: Value) {
  const [state, setState] = useState<VersionedState<Value>>(() => ({
    sourceKey,
    value: sourceValue,
  }))

  if (state.sourceKey !== sourceKey) {
    setState({ sourceKey, value: sourceValue })
  }

  const value = state.sourceKey === sourceKey ? state.value : sourceValue

  const replace = useCallback((nextValue: Value) => {
    setState({ sourceKey, value: nextValue })
  }, [sourceKey])

  const update = useCallback((transform: (current: Value) => Value) => {
    setState((current) => ({
      sourceKey,
      value: transform(current.sourceKey === sourceKey ? current.value : sourceValue),
    }))
  }, [sourceKey, sourceValue])

  return { replace, update, value }
}
