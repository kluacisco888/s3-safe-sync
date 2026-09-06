import { normalizePath, Platform, TFile, type Vault } from "obsidian";

import type { LocalFileInfo, LocalVaultPort } from "../sync/sync-service";
import { deleteVaultPath } from "./vault-delete";
import {
  recoverPendingVaultWrites,
  safeReplaceVaultFile,
  withVaultMutationLock,
} from "./safe-vault-write";

const EXCLUDED_SEGMENTS = new Set([
  ".git",
  ".github",
  ".gitlab",
  ".svn",
  "node_modules",
]);

export const isInSyncScope = (path: string): boolean => {
  const segments = normalizePath(path).split("/");
  if (
    segments.some(
      (segment) =>
        segment.startsWith(".") ||
        segment.startsWith("_") ||
        EXCLUDED_SEGMENTS.has(segment),
    )
  ) {
    return false;
  }
  const basename = segments.at(-1) ?? "";
  return !/^~\$.*\.(?:docx?|pptx?|xlsx?)$/iu.test(basename);
};

const ANDROID_UNSUPPORTED_PATH_CHARACTERS = /[*"<>:|?]/u;

export class ObsidianVaultPort implements LocalVaultPort {
  private recovery: Promise<void> | undefined;

  constructor(private readonly vault: Vault) {}

  async delete(
    path: string,
    expectedContentHash?: string | null,
  ): Promise<void> {
    await this.ensureRecovered();
    await withVaultMutationLock(this.vault.adapter, () =>
      deleteVaultPath(
        this.vault,
        normalizePath(path),
        (candidate) => candidate instanceof TFile,
        expectedContentHash,
      ),
    );
  }

  async list(): Promise<LocalFileInfo[]> {
    await this.ensureRecovered();
    return this.vault
      .getFiles()
      .filter((file) => isInSyncScope(file.path))
      .map((file) => ({
        modifiedAt: file.stat.mtime,
        path: file.path,
        size: file.stat.size,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    await this.ensureRecovered();
    await withVaultMutationLock(this.vault.adapter, async () => {
      const file = this.vault.getAbstractFileByPath(normalizePath(fromPath));
      if (!(file instanceof TFile)) {
        throw new Error(`Local Vault path does not exist: ${fromPath}`);
      }
      const normalizedTarget = normalizePath(toPath);
      const parent = normalizedTarget.includes("/")
        ? normalizedTarget.slice(0, normalizedTarget.lastIndexOf("/"))
        : "";
      if (parent) {
        await this.ensureFolder(parent);
      }
      await this.vault.rename(file, normalizedTarget);
    });
  }

  async read(path: string): Promise<Uint8Array> {
    await this.ensureRecovered();
    const file = this.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) {
      throw new Error(`Local Vault file does not exist: ${path}`);
    }
    return new Uint8Array(await this.vault.readBinary(file));
  }

  async stat(path: string): Promise<LocalFileInfo | undefined> {
    await this.ensureRecovered();
    const file = this.vault.getAbstractFileByPath(normalizePath(path));
    return file instanceof TFile
      ? {
          modifiedAt: file.stat.mtime,
          path: file.path,
          size: file.stat.size,
        }
      : undefined;
  }

  supportsPath(path: string): boolean {
    return !(
      Platform.isAndroidApp &&
      ANDROID_UNSUPPORTED_PATH_CHARACTERS.test(normalizePath(path))
    );
  }

  async write(
    path: string,
    body: Uint8Array,
    expectedCurrentHash?: string | null,
  ): Promise<void> {
    await this.ensureRecovered();
    const normalized = normalizePath(path);
    const parent = normalized.includes("/")
      ? normalized.slice(0, normalized.lastIndexOf("/"))
      : "";
    if (parent) {
      await this.ensureFolder(parent);
    }
    await safeReplaceVaultFile(
      this.vault.adapter,
      normalized,
      body,
      expectedCurrentHash,
    );
  }

  private ensureRecovered(): Promise<void> {
    this.recovery ??= recoverPendingVaultWrites(this.vault.adapter);
    return this.recovery;
  }

  private async ensureFolder(path: string): Promise<void> {
    const segments = path.split("/");
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.vault.getAbstractFileByPath(current)) {
        await this.vault.createFolder(current);
      }
    }
  }
}
