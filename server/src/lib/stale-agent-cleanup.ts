/** Return offline cartridges whose repository is known to be local and no longer exists. */
export function staleMissingRepoAgentIds<T extends { id: string; status: string }>(
  rows: readonly T[],
  isLocal: (row: T) => boolean,
  repoExists: (row: T) => boolean,
): string[] {
  return rows
    .filter((row) => row.status === 'offline' && isLocal(row) && !repoExists(row))
    .map((row) => row.id);
}
