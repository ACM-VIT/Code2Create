const readablePermissionLevels = new Set(["read", "write", "admin"]);

export const requiredGitHubInstallationPermissions = ["contents", "metadata"] as const;
export const requiredGitHubInstallationEvents = ["push"] as const;

type GitHubInstallationPermissions = {
  contents?: string;
  metadata?: string;
};

type GitHubInstallationContractInput = {
  permissions: GitHubInstallationPermissions;
  events: readonly string[];
};

export type GitHubInstallationContractResult = {
  missingPermissions: string[];
  missingEvents: string[];
};

function grantsReadAccess(level: string | undefined) {
  return level !== undefined && readablePermissionLevels.has(level);
}

export function githubInstallationContract({
  permissions,
  events,
}: GitHubInstallationContractInput): GitHubInstallationContractResult {
  const missingPermissions = [
    ...(grantsReadAccess(permissions.contents) ? [] : ["contents"]),
    ...(grantsReadAccess(permissions.metadata) ? [] : ["metadata"]),
  ];
  const grantedEvents = new Set(events);
  const missingEvents = requiredGitHubInstallationEvents.filter(
    (event) => !grantedEvents.has(event),
  );

  return {
    missingPermissions,
    missingEvents: [...missingEvents],
  };
}
