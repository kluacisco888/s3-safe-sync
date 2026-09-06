import { LocalStateChangedError } from "../sync/errors";
import {
  sha256Content as sha256,
  toArrayBuffer,
} from "../sync/content-hash";

const STAGING_DIRECTORY = ".obsidian/plugins/s3-vault-sync/staging";

export interface SafeWriteAdapter {
  copy(fromPath: string, toPath: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<ArrayBuffer>;
  remove(path: string): Promise<void>;
  rename(fromPath: string, toPath: string): Promise<void>;
  stat(path: string): Promise<{ type: string } | null>;
  trashLocal(path: string): Promise<void>;
  write(path: string, body: string): Promise<void>;
  writeBinary(path: string, body: ArrayBuffer): Promise<void>;
}

interface WriteJournal {
  backupPath: string;
  expectedHash: string;
  hadOriginal: boolean;
  journalPath: string;
  originalHash?: string | null;
  targetPath: string;
  temporaryPath: string;
}

const mutationTails = new WeakMap<object, Promise<void>>();

export const withVaultMutationLock = async <T>(
  adapter: object,
  action: () => Promise<T>,
): Promise<T> => {
  const previous = mutationTails.get(adapter) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  mutationTails.set(adapter, tail);
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (mutationTails.get(adapter) === tail) {
      mutationTails.delete(adapter);
    }
  }
};

const isSafeStagingPath = (path: string): boolean => {
  if (!path.startsWith(`${STAGING_DIRECTORY}/`)) {
    return false;
  }
  const basename = path.slice(STAGING_DIRECTORY.length + 1);
  return basename.length > 0 && !basename.includes("/") && basename !== "..";
};

export const isSafeTargetPath = (path: string): boolean =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !path.startsWith(".obsidian/") &&
  !path.split("/").some((segment) => segment === "." || segment === "..");

const readHash = async (
  adapter: SafeWriteAdapter,
  path: string,
): Promise<string | undefined> => {
  if (!(await adapter.exists(path))) {
    return undefined;
  }
  const stat = await adapter.stat(path);
  if (stat?.type !== "file") {
    throw new Error(`Refusing to replace a non-file path: ${path}`);
  }
  return sha256(new Uint8Array(await adapter.readBinary(path)));
};

const removeFileIfPresent = async (
  adapter: SafeWriteAdapter,
  path: string,
): Promise<void> => {
  if (!(await adapter.exists(path))) {
    return;
  }
  if ((await adapter.stat(path))?.type !== "file") {
    throw new Error(`Refusing to remove a non-file staging path: ${path}`);
  }
  await adapter.remove(path);
};

const trashFileIfPresent = async (
  adapter: SafeWriteAdapter,
  path: string,
): Promise<void> => {
  if (!(await adapter.exists(path))) {
    return;
  }
  if ((await adapter.stat(path))?.type !== "file") {
    throw new Error(`Refusing to trash a non-file staging path: ${path}`);
  }
  await adapter.trashLocal(path);
  if (await adapter.exists(path)) {
    throw new Error(`Local trash failed; preserving staged backup: ${path}`);
  }
};

const recoverJournal = async (
  adapter: SafeWriteAdapter,
  journal: WriteJournal,
  allowUnknownTarget = false,
): Promise<void> => {
  const backupExists = await adapter.exists(journal.backupPath);
  const targetHash = await readHash(adapter, journal.targetPath);
  if (backupExists) {
    if (targetHash === journal.expectedHash) {
      const backupHash = await readHash(adapter, journal.backupPath);
      if (
        journal.originalHash === undefined ||
        backupHash !== journal.originalHash
      ) {
        if (allowUnknownTarget) {
          await adapter.rename(journal.backupPath, journal.targetPath);
        }
        throw new Error(
          `Staged backup needs review for ${journal.targetPath}; preserving ${journal.journalPath} and staged content`,
        );
      }
      await trashFileIfPresent(adapter, journal.backupPath);
    } else if (targetHash === undefined) {
      const backupHash = await readHash(adapter, journal.backupPath);
      if (
        journal.originalHash === undefined ||
        backupHash !== journal.originalHash
      ) {
        if (allowUnknownTarget) {
          await adapter.rename(journal.backupPath, journal.targetPath);
        }
        throw new Error(
          `Staged backup needs review for ${journal.targetPath}; preserving ${journal.journalPath} and staged content`,
        );
      }
      await adapter.rename(journal.backupPath, journal.targetPath);
    } else {
      throw new Error(
        `Staged write needs review for ${journal.targetPath}; preserving ${journal.journalPath} and ${journal.backupPath}`,
      );
    }
  } else if (
    targetHash !== undefined &&
    targetHash !== journal.expectedHash &&
    targetHash !== journal.originalHash &&
    !allowUnknownTarget
  ) {
    throw new Error(
      `Staged write needs review for ${journal.targetPath}; preserving ${journal.journalPath}`,
    );
  }
  await removeFileIfPresent(adapter, journal.temporaryPath);
  await removeFileIfPresent(adapter, journal.journalPath);
};

const recoverPendingVaultWritesUnlocked = async (
  adapter: SafeWriteAdapter,
): Promise<void> => {
  if (!(await adapter.exists(STAGING_DIRECTORY))) {
    return;
  }
  const staged = await adapter.list(STAGING_DIRECTORY);
  for (const journalPath of staged.files.filter((path) =>
    path.endsWith(".json"),
  )) {
    await recoverJournal(
      adapter,
      parseJournal(await adapter.read(journalPath), journalPath),
    );
  }
};

const parseJournal = (body: string, journalPath: string): WriteJournal => {
  const parsed = JSON.parse(body) as Partial<WriteJournal>;
  if (
    typeof parsed.backupPath !== "string" ||
    typeof parsed.expectedHash !== "string" ||
    typeof parsed.hadOriginal !== "boolean" ||
    typeof parsed.targetPath !== "string" ||
    typeof parsed.temporaryPath !== "string" ||
    !isSafeStagingPath(parsed.backupPath) ||
    !isSafeStagingPath(parsed.temporaryPath) ||
    !isSafeTargetPath(parsed.targetPath)
  ) {
    throw new Error(`Invalid staged-write journal: ${journalPath}`);
  }
  return { ...parsed, journalPath } as WriteJournal;
};

export const recoverPendingVaultWrites = async (
  adapter: SafeWriteAdapter,
): Promise<void> =>
  withVaultMutationLock(adapter, () =>
    recoverPendingVaultWritesUnlocked(adapter),
  );

export const safeReplaceVaultFile = async (
  adapter: SafeWriteAdapter,
  targetPath: string,
  body: Uint8Array,
  expectedCurrentHash: string | null | undefined,
  createId: () => string = () => crypto.randomUUID(),
): Promise<void> => {
  if (!isSafeTargetPath(targetPath)) {
    throw new Error(`Refusing to write an unsafe Vault path: ${targetPath}`);
  }
  return withVaultMutationLock(adapter, async () => {
    await recoverPendingVaultWritesUnlocked(adapter);
    if (!(await adapter.exists(STAGING_DIRECTORY))) {
      await adapter.mkdir(STAGING_DIRECTORY);
    }
    const currentHash = await readHash(adapter, targetPath);
    if (
      expectedCurrentHash !== undefined &&
      ((expectedCurrentHash === null && currentHash !== undefined) ||
        (expectedCurrentHash !== null && currentHash !== expectedCurrentHash))
    ) {
      throw new LocalStateChangedError(targetPath);
    }
    const id = createId();
    const journal: WriteJournal = {
      backupPath: `${STAGING_DIRECTORY}/${id}.backup`,
      expectedHash: await sha256(body),
      hadOriginal: currentHash !== undefined,
      journalPath: `${STAGING_DIRECTORY}/${id}.json`,
      originalHash: currentHash ?? null,
      targetPath,
      temporaryPath: `${STAGING_DIRECTORY}/${id}.new`,
    };
    await adapter.write(journal.journalPath, JSON.stringify(journal));
    try {
      await adapter.writeBinary(journal.temporaryPath, toArrayBuffer(body));
      if (
        (await readHash(adapter, journal.temporaryPath)) !== journal.expectedHash
      ) {
        throw new Error(`Staged file failed verification: ${targetPath}`);
      }
      if ((await readHash(adapter, targetPath)) !== currentHash) {
        throw new LocalStateChangedError(targetPath);
      }
      if (journal.hadOriginal) {
        await adapter.rename(targetPath, journal.backupPath);
        if ((await readHash(adapter, journal.backupPath)) !== currentHash) {
          throw new LocalStateChangedError(targetPath);
        }
      }
      if ((await readHash(adapter, targetPath)) !== undefined) {
        throw new LocalStateChangedError(targetPath);
      }
      await adapter.copy(journal.temporaryPath, targetPath);
      if ((await readHash(adapter, targetPath)) !== journal.expectedHash) {
        throw new Error(`Promoted file failed verification: ${targetPath}`);
      }
      await recoverJournal(adapter, journal);
    } catch (error) {
      await recoverJournal(
        adapter,
        journal,
        error instanceof LocalStateChangedError,
      );
      throw error;
    }
  });
};
