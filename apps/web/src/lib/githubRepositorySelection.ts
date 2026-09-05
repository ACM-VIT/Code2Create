type Connection = { id: string; state: string };

/** An explicit callback connection must never resolve to a different account. */
export function githubRepositorySelectionConnection<T extends Connection>(
  connections: readonly T[],
  connectionId: string | null | undefined,
  repositoryId: string | null | undefined,
): T | undefined {
  if (!connectionId && !repositoryId) return undefined;
  return connections.find(
    (connection) =>
      connection.state === "active" && (!connectionId || connection.id === connectionId),
  );
}
