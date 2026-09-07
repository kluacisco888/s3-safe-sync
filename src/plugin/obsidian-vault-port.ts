import {
  FileSystemAdapter,
  normalizePath,
  Platform,
  TFile,
  type Vault,
} from "obsidian";

import type {
  LocalContentHash,
  LocalFileInfo,
  LocalHashOptions,
  LocalVaultPort,
} from "../sync/sync-service";
import { sha256Content as sha256 } from "../sync/content-hash";
import { LocalStateChangedError } from "../sync/errors";
import {
  hashDesktopFile,
  type DesktopHashDependencies,
} from "./desktop-streaming-hash";
import { deleteVaultPath } from "./vault-delete";
import {
  recoverPendingVaultWrites,
  isSafeTargetPath,
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
    if (!isSafeTargetPath(path)) {
      throw new Error(`Refusing to delete an unsafe Vault path: ${path}`);
    }
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

  async hashContent(
    path: string,
    options: LocalHashOptions = {},
  ): Promise<LocalContentHash> {
    await this.ensureRecovered();
    const normalized = normalizePath(path);
    const file = this.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) {
      throw new LocalStateChangedError(path);
    }
    if (
      Platform.isDesktopApp &&
      this.vault.adapter instanceof FileSystemAdapter
    ) {
      const nodeRequire = (
        window as Window & { require: (moduleId: string) => unknown }
      ).require;
      const cryptoModule = nodeRequire("node:crypto") as Pick<
        DesktopHashDependencies,
        "createHash"
      >;
      const fileSystemModule = nodeRequire("node:fs/promises") as Pick<
        DesktopHashDependencies,
        "open" | "stat"
      >;
      return hashDesktopFile(
        this.vault.adapter.getFullPath(normalized),
        {
          createHash: cryptoModule.createHash,
          open: fileSystemModule.open,
          stat: fileSystemModule.stat,
        },
        { ...options, errorPath: path },
      );
    }

    await options.yieldToHost?.();
    const content = new Uint8Array(await this.vault.readBinary(file));
    options.onProgress?.(content.byteLength);
    return {
      contentHash: await sha256(content),
      size: content.byteLength,
    };
  }

  async move(
    fromPath: string,
    toPath: string,
    expectedSourceHash?: string,
    expectedTargetHash?: string | null,
  ): Promise<void> {
    if (!isSafeTargetPath(fromPath) || !isSafeTargetPath(toPath)) {
      throw new Error(`Refusing to move an unsafe Vault path: ${toPath}`);
    }
    await this.ensureRecovered();
    await withVaultMutationLock(this.vault.adapter, async () => {
      const normalizedSource = normalizePath(fromPath);
      const file = this.vault.getAbstractFileByPath(normalizedSource);
      if (!(file instanceof TFile)) {
        throw new Error(`Local Vault path does not exist: ${fromPath}`);
      }
      const normalizedTarget = normalizePath(toPath);
      if (
        !isSafeTargetPath(normalizedSource) ||
        !isSafeTargetPath(normalizedTarget)
      ) {
        throw new Error(`Refusing to move an unsafe Vault path: ${toPath}`);
      }
      if (
        expectedSourceHash !== undefined &&
        (await this.readAdapterHash(normalizedSource)) !== expectedSourceHash
      ) {
        throw new LocalStateChangedError(fromPath);
      }
      const targetHash = await this.readAdapterHash(normalizedTarget);
      if (
        (expectedTargetHash === null && targetHash !== undefined) ||
        (typeof expectedTargetHash === "string" &&
          targetHash !== expectedTargetHash)
      ) {
        throw new LocalStateChangedError(toPath);
      }
      const parent = normalizedTarget.includes("/")
        ? normalizedTarget.slice(0, normalizedTarget.lastIndexOf("/"))
        : "";
      if (parent) {
        await this.ensureFolder(parent);
      }
      try {
        await this.vault.adapter.copy(normalizedSource, normalizedTarget);
      } catch (error) {
        if (await this.vault.adapter.exists(normalizedTarget)) {
          throw new LocalStateChangedError(toPath);
        }
        throw error;
      }
      const copiedHash = await this.readAdapterHash(normalizedTarget);
      const sourceHash = expectedSourceHash ?? (await this.readAdapterHash(normalizedSource));
      if (!sourceHash || copiedHash !== sourceHash) {
        throw new Error(`Copied local file failed verification: ${toPath}`);
      }
      await deleteVaultPath(
        this.vault,
        normalizedSource,
        (candidate) => candidate instanceof TFile,
        sourceHash,
      );
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
    return (
      isSafeTargetPath(path) &&
      isInSyncScope(path) &&
      !(
        Platform.isAndroidApp &&
        ANDROID_UNSUPPORTED_PATH_CHARACTERS.test(normalizePath(path))
      )
    );
  }

  async write(
    path: string,
    body: Uint8Array,
    expectedCurrentHash?: string | null,
  ): Promise<void> {
    if (!isSafeTargetPath(path)) {
      throw new Error(`Refusing to write an unsafe Vault path: ${path}`);
    }
    await this.ensureRecovered();
    const normalized = normalizePath(path);
    if (!isSafeTargetPath(normalized)) {
      throw new Error(`Refusing to write an unsafe Vault path: ${path}`);
    }
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

  private async readAdapterHash(path: string): Promise<string | undefined> {
    if (!(await this.vault.adapter.exists(path))) {
      return undefined;
    }
    if ((await this.vault.adapter.stat(path))?.type !== "file") {
      throw new Error(`Expected local file path: ${path}`);
    }
    return sha256(await this.vault.adapter.readBinary(path));
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
