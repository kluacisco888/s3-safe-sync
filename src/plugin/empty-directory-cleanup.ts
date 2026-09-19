interface DirectoryState {
  dev: number;
  ino: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface EmptyDirectoryCleanupOptions {
  fullPath(relative: string): string;
  configDir: string;
  isInSyncScope?(relative: string): boolean;
  assertActive?(): void;
  fs: {
    lstat(path: string): Promise<DirectoryState>;
    readdir(path: string): Promise<string[]>;
    /** Must reject files and nonempty directories, like Node's nonrecursive rmdir. */
    rmdir(path: string): Promise<void>;
  };
}

/** The desktop caller holds the Vault mutation lock and reconciles removed paths. */
export const cleanupEmptyParents = async (
  retiredPaths: readonly string[],
  options: EmptyDirectoryCleanupOptions,
): Promise<string[]> => {
  options.assertActive?.();
  const candidates = new Set<string>();
  const configDir = options.configDir.toLowerCase();
  const isAllowed = (path: string): boolean =>
    !/[\\\0:]/u.test(path) &&
    !path.split("/").some((segment) =>
      !segment || segment.startsWith(".") || segment.startsWith("_") || segment.toLowerCase() === "node_modules",
    ) &&
    path.toLowerCase() !== configDir &&
    !path.toLowerCase().startsWith(`${configDir}/`) &&
    options.isInSyncScope?.(path) !== false;
  for (const path of retiredPaths) {
    const segments = path.split("/");
    if (segments.some((_, index) => !isAllowed(segments.slice(0, index + 1).join("/")))) {
      continue;
    }
    while (segments.length > 1) {
      segments.pop();
      candidates.add(segments.join("/"));
    }
  }
  const removed: string[] = [];
  const identities = new Map<string, { path: string; state: DirectoryState }>();
  for (const relative of [...candidates].sort((a, b) => b.split("/").length - a.split("/").length)) {
    const segments = relative.split("/");
    const ancestors = ["", ...segments.map((_, index) => segments.slice(0, index + 1).join("/"))];
    const verifyAncestors = async (): Promise<boolean> => {
      for (const ancestor of ancestors) {
        options.assertActive?.();
        const path = options.fullPath(ancestor);
        // A trailing separator can make lstat follow a directory symlink.
        if (/[\\/]$/u.test(path)) {
          return false;
        }
        const state = await options.fs.lstat(path).catch(() => undefined);
        options.assertActive?.();
        const previous = identities.get(ancestor);
        if (
          !state?.isDirectory() || state.isSymbolicLink() ||
          !Number.isSafeInteger(state.dev) || !Number.isSafeInteger(state.ino) || state.ino <= 0 ||
          (previous && (previous.path !== path || previous.state.dev !== state.dev || previous.state.ino !== state.ino))
        ) {
          return false;
        }
        identities.set(ancestor, { path, state });
      }
      return true;
    };
    if (!(await verifyAncestors())) {
      continue;
    }
    const path = options.fullPath(relative);
    const contents = await options.fs.readdir(path).catch(() => undefined);
    options.assertActive?.();
    if (contents?.length !== 0 || !(await verifyAncestors())) {
      continue;
    }
    options.assertActive?.();
    // External ancestor replacements after verification remain a filesystem race.
    if (await options.fs.rmdir(path).then(() => true, () => false)) {
      removed.push(relative);
    }
    options.assertActive?.();
  }
  return removed;
};
