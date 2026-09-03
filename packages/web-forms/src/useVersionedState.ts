import { useCallback, useState } from "react";

type VersionedState<Value> = {
  sourceKey: string;
  value: Value;
};

export function useVersionedState<Value>(sourceKey: string, sourceValue: Value) {
  const [state, setState] = useState<VersionedState<Value>>(() => ({
    sourceKey,
    value: sourceValue,
  }));

  if (state.sourceKey !== sourceKey) {
    setState({ sourceKey, value: sourceValue });
  }

  const value = state.sourceKey === sourceKey ? state.value : sourceValue;

  const replace = useCallback(
    (nextValue: Value) => {
      setState({ sourceKey, value: nextValue });
    },
    [sourceKey],
  );

  const update = useCallback(
    (transform: (current: Value) => Value) => {
      setState((current) => ({
        sourceKey,
        value: transform(current.sourceKey === sourceKey ? current.value : sourceValue),
      }));
    },
    [sourceKey, sourceValue],
  );

  return { replace, update, value };
}
