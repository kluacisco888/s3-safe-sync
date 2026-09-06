import { LocalStateChangedError } from "../sync/errors";

export interface VaultDeletionPort<File> {
  adapter: {
    exists(path: string): Promise<boolean>;
    readBinary(path: string): Promise<ArrayBuffer>;
    remove(path: string): Promise<void>;
    stat(path: string): Promise<{ type: string } | null>;
    trashLocal(path: string): Promise<void>;
  };
  delete(file: File, force?: boolean): Promise<void>;
  getAbstractFileByPath(path: string): File | null;
  trash(file: File, system: boolean): Promise<void>;
}

const sha256 = async (body: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", body);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${hex}`;
};

const assertExpectedContent = async <File>(
  vault: VaultDeletionPort<File>,
  path: string,
  expectedContentHash: string | null | undefined,
): Promise<void> => {
  if (expectedContentHash === undefined) {
    return;
  }
  const exists = await vault.adapter.exists(path);
  if (expectedContentHash === null) {
    if (exists) {
      throw new LocalStateChangedError(path);
    }
    return;
  }
  if (!exists || (await vault.adapter.stat(path))?.type !== "file") {
    throw new LocalStateChangedError(path);
  }
  if ((await sha256(await vault.adapter.readBinary(path))) !== expectedContentHash) {
    throw new LocalStateChangedError(path);
  }
};

export const deleteVaultPath = async <File>(
  vault: VaultDeletionPort<File>,
  path: string,
  isFile: (candidate: File) => boolean,
  expectedContentHash?: string | null,
): Promise<void> => {
  await assertExpectedContent(vault, path, expectedContentHash);
  const indexed = vault.getAbstractFileByPath(path);
  if (indexed) {
    if (!isFile(indexed)) {
      throw new Error(`Refusing to delete a folder at file path: ${path}`);
    }
    await vault.trash(indexed, false);
  }
  if (!(await vault.adapter.exists(path))) {
    return;
  }
  await assertExpectedContent(vault, path, expectedContentHash);
  await vault.adapter.trashLocal(path);
  if (!(await vault.adapter.exists(path))) {
    return;
  }
  await assertExpectedContent(vault, path, expectedContentHash);
  if (expectedContentHash !== undefined) {
    throw new Error(
      `Local trash failed; refusing permanent deletion during synchronization: ${path}`,
    );
  }
  const remaining = vault.getAbstractFileByPath(path);
  if (remaining) {
    if (!isFile(remaining)) {
      throw new Error(`Refusing to delete a folder at file path: ${path}`);
    }
    await assertExpectedContent(vault, path, expectedContentHash);
    await vault.delete(remaining);
  } else {
    const stat = await vault.adapter.stat(path);
    if (stat?.type !== "file") {
      throw new Error(`Refusing to remove a non-file path: ${path}`);
    }
    await assertExpectedContent(vault, path, expectedContentHash);
    await vault.adapter.remove(path);
  }
  if (await vault.adapter.exists(path)) {
    throw new Error(`Local Vault path still exists after deletion: ${path}`);
  }
};
