export type DirtyPathSnapshot = ReadonlyMap<string, number>;

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

  changedPathSince(snapshot: DirtyPathSnapshot): string | undefined {
    for (const [path, version] of this.versions) {
      if (snapshot.get(path) !== version) {
        return path;
      }
    }
    for (const path of snapshot.keys()) {
      if (!this.versions.has(path)) {
        return path;
      }
    }
    return undefined;
  }

  mark(path: string): void {
    this.versions.set(path, (this.versions.get(path) ?? 0) + 1);
  }
}
