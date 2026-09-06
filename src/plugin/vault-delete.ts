export interface VaultDeletionPort<File> {
  adapter: {
    exists(path: string): Promise<boolean>;
    remove(path: string): Promise<void>;
    stat(path: string): Promise<{ type: string } | null>;
  };
  delete(file: File, force?: boolean): Promise<void>;
  getAbstractFileByPath(path: string): File | null;
  trash(file: File, system: boolean): Promise<void>;
}

export const deleteVaultPath = async <File>(
  vault: VaultDeletionPort<File>,
  path: string,
  isFile: (candidate: File) => boolean,
): Promise<void> => {
  const indexed = vault.getAbstractFileByPath(path);
  if (indexed) {
    if (!isFile(indexed)) {
      throw new Error(`Refusing to delete a folder at file path: ${path}`);
    }
    await vault.trash(indexed, true);
  }
  if (!(await vault.adapter.exists(path))) {
    return;
  }
  const remaining = vault.getAbstractFileByPath(path);
  if (remaining) {
    if (!isFile(remaining)) {
      throw new Error(`Refusing to delete a folder at file path: ${path}`);
    }
    await vault.delete(remaining);
  } else {
    const stat = await vault.adapter.stat(path);
    if (stat?.type !== "file") {
      throw new Error(`Refusing to remove a non-file path: ${path}`);
    }
    await vault.adapter.remove(path);
  }
  if (await vault.adapter.exists(path)) {
    throw new Error(`Local Vault path still exists after deletion: ${path}`);
  }
};
