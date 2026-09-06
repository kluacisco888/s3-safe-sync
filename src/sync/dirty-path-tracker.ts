export type DirtyPathSnapshot = ReadonlyMap<string, number>;

export class DirtyPathTracker {
  private readonly versions = new Map<string, number>();

  acknowledge(snapshot: DirtyPathSnapshot): void {
    for (const [path, version] of snapshot) {
      if (this.versions.get(path) === version) {
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
