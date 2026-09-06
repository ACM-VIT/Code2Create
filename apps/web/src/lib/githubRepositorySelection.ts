type Connection = { id: string; state: string; canBrowse: boolean };

/** An explicit callback connection must never resolve to a different account. */
export function githubRepositorySelectionConnection<T extends Connection>(
  connections: readonly T[],
  connectionId: string | null | undefined,
  repositoryId: string | null | undefined,
): T | undefined {
  if (!connectionId && !repositoryId) return undefined;
  return connections.find(
    (connection) =>
      connection.state === "active" && connection.canBrowse && (!connectionId || connection.id === connectionId),
  );
}

export function githubRepositoryAddBlocker(input: {
  eventStatus: string;
  canManage: boolean;
  repositoryCount: number;
  maximumRepositories: number;
  freezeAt?: number | undefined;
  now: number;
}): string | null {
  if (!input.canManage) return "Only a team member with repository management access can add repositories.";
  if (input.freezeAt !== undefined && input.now >= input.freezeAt) return "Repository changes are frozen for this event.";
  if (input.eventStatus === "complete") return "Repository changes are closed because the event has ended.";
  if (input.repositoryCount >= input.maximumRepositories) return "Your team has reached its repository limit. Archive a repository before adding another.";
  return null;
}
