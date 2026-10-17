import { LocalStateChangedError } from "../sync/errors";
import { sha256Content as sha256 } from "../sync/content-hash";

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
      throw new Error(`拒绝删除文件路径上的文件夹：${path}`);
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
      `移到本地回收站失败，同步期间拒绝永久删除：${path}`,
    );
  }
  const remaining = vault.getAbstractFileByPath(path);
  if (remaining) {
    if (!isFile(remaining)) {
      throw new Error(`拒绝删除文件路径上的文件夹：${path}`);
    }
    await assertExpectedContent(vault, path, expectedContentHash);
    await vault.delete(remaining);
  } else {
    const stat = await vault.adapter.stat(path);
    if (stat?.type !== "file") {
      throw new Error(`拒绝移除不是文件的路径：${path}`);
    }
    await assertExpectedContent(vault, path, expectedContentHash);
    await vault.adapter.remove(path);
  }
  if (await vault.adapter.exists(path)) {
    throw new Error(`删除后本地仓库路径仍然存在：${path}`);
  }
};
