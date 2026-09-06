export type DirtyPathSnapshot = ReadonlyMap<string, number>;

export const dirtyPathsForRename = (
  cachedPaths: Iterable<string>,
  oldPath: string,
  newPath: string,
): Set<string> => {
  const paths = new Set([oldPath, newPath]);
  for (const path of cachedPaths) {
    if (path === oldPath || path.startsWith(`${oldPath}/`)) {
      paths.add(path);
      paths.add(`${newPath}${path.slice(oldPath.length)}`);
    }
  }
  return paths;
};

export class DirtyPathTracker {
  private readonly versions = new Map<string, number>();

  acknowledge(
    snapshot: DirtyPathSnapshot,
    retainedPaths: ReadonlySet<string> = new Set(),
  ): void {
    for (const [path, version] of snapshot) {
      if (
        !retainedPaths.has(path) &&
        this.versions.get(path) === version
      ) {
        this.versions.delete(path);
      }
    }
  }

  capture(): DirtyPathSnapshot {
    return new Map(this.versions);
  }

  mark(path: string): void {
    this.versions.set(path, (this.versions.get(path) ?? 0) + 1);
  }
}
