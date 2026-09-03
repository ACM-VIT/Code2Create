export type SettledAuthentication = boolean | null;

export type AuthProviderState = {
  isAuthenticated: boolean;
  isLoading: boolean;
};

/**
 * A background session check must not turn an already rendered application
 * back into its initial loading screen. Keep the last settled answer while the
 * check is pending, then apply the new answer as soon as it resolves.
 */
export function authProviderState(
  sessionPending: boolean,
  sessionAuthenticated: boolean,
  settledAuthentication: SettledAuthentication,
): AuthProviderState {
  if (!sessionPending) {
    return { isAuthenticated: sessionAuthenticated, isLoading: false };
  }
  if (settledAuthentication === null) {
    return { isAuthenticated: false, isLoading: true };
  }
  return { isAuthenticated: settledAuthentication, isLoading: false };
}
