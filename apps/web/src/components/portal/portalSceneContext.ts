import { createContext, useContext } from "react";

export const PortalSceneContext = createContext<{ onSignOut: (() => void) | null }>({
  onSignOut: null,
});

export function usePortalSignOut() {
  return useContext(PortalSceneContext).onSignOut;
}
