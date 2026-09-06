const STAGING_DIRECTORY = ".obsidian/plugins/s3-vault-sync/staging";

export interface SafeWriteAdapter {
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<ArrayBuffer>;
  remove(path: string): Promise<void>;
  rename(fromPath: string, toPath: string): Promise<void>;
  stat(path: string): Promise<{ type: string } | null>;
  write(path: string, body: string): Promise<void>;
  writeBinary(path: string, body: ArrayBuffer): Promise<void>;
}

interface WriteJournal {
  backupPath: string;
  expectedHash: string;
  hadOriginal: boolean;
  journalPath: string;
  targetPath: string;
  temporaryPath: string;
}

const isSafeStagingPath = (path: string): boolean => {
  if (!path.startsWith(`${STAGING_DIRECTORY}/`)) {
    return false;
  }
  const basename = path.slice(STAGING_DIRECTORY.length + 1);
  return basename.length > 0 && !basename.includes("/") && basename !== "..";
};

const isSafeTargetPath = (path: string): boolean =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !path.startsWith(".obsidian/") &&
  !path.split("/").some((segment) => segment === "." || segment === "..");

const toArrayBuffer = (body: Uint8Array): ArrayBuffer =>
  body.byteOffset === 0 &&
  body.buffer instanceof ArrayBuffer &&
  body.byteLength === body.buffer.byteLength
    ? body.buffer
    : body.slice().buffer;

const sha256 = async (body: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(body));
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${hex}`;
};

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

const recoverJournal = async (
  adapter: SafeWriteAdapter,
  journal: WriteJournal,
): Promise<void> => {
  const backupExists = await adapter.exists(journal.backupPath);
  const targetHash = await readHash(adapter, journal.targetPath);
  if (backupExists) {
    if (targetHash === journal.expectedHash) {
      await removeFileIfPresent(adapter, journal.backupPath);
    } else {
      await removeFileIfPresent(adapter, journal.targetPath);
      await adapter.rename(journal.backupPath, journal.targetPath);
    }
  } else if (!journal.hadOriginal && targetHash !== undefined) {
    if (targetHash !== journal.expectedHash) {
      await removeFileIfPresent(adapter, journal.targetPath);
    }
  }
  await removeFileIfPresent(adapter, journal.temporaryPath);
  await removeFileIfPresent(adapter, journal.journalPath);
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

export const safeReplaceVaultFile = async (
  adapter: SafeWriteAdapter,
  targetPath: string,
  body: Uint8Array,
  expectedCurrentHash: string | null | undefined,
  createId: () => string = () => crypto.randomUUID(),
): Promise<void> => {
  await recoverPendingVaultWrites(adapter);
  if (!(await adapter.exists(STAGING_DIRECTORY))) {
    await adapter.mkdir(STAGING_DIRECTORY);
  }
  const currentHash = await readHash(adapter, targetPath);
  if (
    expectedCurrentHash !== undefined &&
    ((expectedCurrentHash === null && currentHash !== undefined) ||
      (expectedCurrentHash !== null && currentHash !== expectedCurrentHash))
  ) {
    throw new Error(`Local file changed before safe replacement: ${targetPath}`);
  }
  const id = createId();
  const journal: WriteJournal = {
    backupPath: `${STAGING_DIRECTORY}/${id}.backup`,
    expectedHash: await sha256(body),
    hadOriginal: currentHash !== undefined,
    journalPath: `${STAGING_DIRECTORY}/${id}.json`,
    targetPath,
    temporaryPath: `${STAGING_DIRECTORY}/${id}.new`,
  };
  await adapter.write(journal.journalPath, JSON.stringify(journal));
  try {
    await adapter.writeBinary(journal.temporaryPath, toArrayBuffer(body));
    if ((await readHash(adapter, journal.temporaryPath)) !== journal.expectedHash) {
      throw new Error(`Staged file failed verification: ${targetPath}`);
    }
    if ((await readHash(adapter, targetPath)) !== currentHash) {
      throw new Error(`Local file changed while staging replacement: ${targetPath}`);
    }
    if (journal.hadOriginal) {
      await adapter.rename(targetPath, journal.backupPath);
    }
    await adapter.rename(journal.temporaryPath, targetPath);
    if ((await readHash(adapter, targetPath)) !== journal.expectedHash) {
      throw new Error(`Promoted file failed verification: ${targetPath}`);
    }
    await removeFileIfPresent(adapter, journal.backupPath);
    await removeFileIfPresent(adapter, journal.journalPath);
  } catch (error) {
    await recoverJournal(adapter, journal);
    throw error;
  }
};
