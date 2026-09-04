const readablePermissionLevels = new Set(["read", "write", "admin"]);

export const requiredGitHubInstallationPermissions = ["contents", "metadata"] as const;
export const requiredGitHubInstallationEvents = ["push"] as const;

type GitHubInstallationContractInput = {
  permissions: object;
  events: readonly string[];
};

export type GitHubInstallationContractResult = {
  missingPermissions: string[];
  missingEvents: string[];
};

function grantsReadAccess(permissions: object, permission: string) {
  const granted = Reflect.get(permissions, permission);
  return typeof granted === "string" && readablePermissionLevels.has(granted);
}

export function githubInstallationContract({
  permissions,
  events,
}: GitHubInstallationContractInput): GitHubInstallationContractResult {
  const missingPermissions = requiredGitHubInstallationPermissions.filter(
    (permission) => !grantsReadAccess(permissions, permission),
  );
  const grantedEvents = new Set(events);
  const missingEvents = requiredGitHubInstallationEvents.filter(
    (event) => !grantedEvents.has(event),
  );

  return {
    missingPermissions: [...missingPermissions],
    missingEvents: [...missingEvents],
  };
}
