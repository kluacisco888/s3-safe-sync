export interface PersistedPathRename {
  entryId: string;
  toPath: string;
}

export interface PathRenameVersion extends PersistedPathRename {
  version: number;
}

export type PathRenameSnapshot = ReadonlyMap<string, PathRenameVersion>;
export type PersistedPathRenames = Record<string, PersistedPathRename>;

const pathIsWithin = (path: string, parent: string): boolean =>
  path === parent || path.startsWith(`${parent}/`);

export class PathRenameTracker {
  private nextVersion = 0;
  private readonly renames = new Map<string, PathRenameVersion>();

  constructor(initial: Readonly<PersistedPathRenames> = {}) {
    for (const [fromPath, rename] of Object.entries(initial)) {
      if (
        typeof rename?.entryId === "string" &&
        typeof rename.toPath === "string" &&
        fromPath !== rename.toPath
      ) {
        this.renames.set(fromPath, {
          ...rename,
          version: ++this.nextVersion,
        });
      }
    }
  }

  acknowledge(
    snapshot: PathRenameSnapshot,
    retainedPaths: ReadonlySet<string> = new Set(),
  ): void {
    for (const [fromPath, captured] of snapshot) {
      const current = this.renames.get(fromPath);
      if (
        !retainedPaths.has(fromPath) &&
        !retainedPaths.has(captured.toPath) &&
        current?.version === captured.version &&
        current.toPath === captured.toPath
      ) {
        this.renames.delete(fromPath);
      }
    }
  }

  capture(): PathRenameSnapshot {
    return new Map(
      [...this.renames].map(([fromPath, state]) => [
        fromPath,
        { ...state },
      ]),
    );
  }

  record(
    cachedFiles: Iterable<{ entryId: string; path: string }>,
    oldPath: string,
    newPath: string,
  ): Set<string> {
    const dirtyPaths = new Set([oldPath, newPath]);
    for (const [fromPath, current] of [...this.renames]) {
      if (!pathIsWithin(current.toPath, oldPath)) {
        continue;
      }
      const toPath = `${newPath}${current.toPath.slice(oldPath.length)}`;
      dirtyPaths.add(fromPath);
      dirtyPaths.add(current.toPath);
      dirtyPaths.add(toPath);
      if (fromPath === toPath) {
        this.renames.delete(fromPath);
      } else {
        this.renames.set(fromPath, {
          entryId: current.entryId,
          toPath,
          version: ++this.nextVersion,
        });
      }
    }
    const mappedEntryIds = new Set(
      [...this.renames.values()].map((rename) => rename.entryId),
    );
    for (const cachedFile of cachedFiles) {
      const { entryId, path: fromPath } = cachedFile;
      if (
        !pathIsWithin(fromPath, oldPath) ||
        this.renames.has(fromPath) ||
        mappedEntryIds.has(entryId)
      ) {
        continue;
      }
      const toPath = `${newPath}${fromPath.slice(oldPath.length)}`;
      dirtyPaths.add(fromPath);
      dirtyPaths.add(toPath);
      if (fromPath !== toPath) {
        this.renames.set(fromPath, {
          entryId,
          toPath,
          version: ++this.nextVersion,
        });
        mappedEntryIds.add(entryId);
      }
    }
    return dirtyPaths;
  }

  serialize(): PersistedPathRenames {
    return Object.fromEntries(
      [...this.renames].map(([fromPath, state]) => [
        fromPath,
        { entryId: state.entryId, toPath: state.toPath },
      ]),
    );
  }

  toPathMap(snapshot: PathRenameSnapshot): Map<string, PersistedPathRename> {
    return new Map(
      [...snapshot].map(([fromPath, state]) => [
        fromPath,
        { entryId: state.entryId, toPath: state.toPath },
      ]),
    );
  }
}
