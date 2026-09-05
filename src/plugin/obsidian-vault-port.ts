import { normalizePath, TFile, type Vault } from "obsidian";

import type { LocalFileInfo, LocalVaultPort } from "../sync/sync-service";

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

const asArrayBuffer = (body: Uint8Array): ArrayBuffer =>
  body.byteOffset === 0 &&
  body.buffer instanceof ArrayBuffer &&
  body.byteLength === body.buffer.byteLength
    ? body.buffer
    : body.slice().buffer;

export class ObsidianVaultPort implements LocalVaultPort {
  constructor(private readonly vault: Vault) {}

  async delete(path: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(normalizePath(path));
    if (file) {
      await this.vault.trash(file, true);
    }
  }

  list(): Promise<LocalFileInfo[]> {
    return Promise.resolve(
      this.vault
        .getFiles()
        .filter((file) => isInSyncScope(file.path))
        .map((file) => ({
          modifiedAt: file.stat.mtime,
          path: file.path,
          size: file.stat.size,
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    );
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(normalizePath(fromPath));
    if (!file) {
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
  }

  async read(path: string): Promise<Uint8Array> {
    const file = this.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) {
      throw new Error(`Local Vault file does not exist: ${path}`);
    }
    return new Uint8Array(await this.vault.readBinary(file));
  }

  async write(path: string, body: Uint8Array): Promise<void> {
    const normalized = normalizePath(path);
    const existing = this.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) {
      await this.vault.modifyBinary(existing, asArrayBuffer(body));
      return;
    }
    const parent = normalized.includes("/")
      ? normalized.slice(0, normalized.lastIndexOf("/"))
      : "";
    if (parent) {
      await this.ensureFolder(parent);
    }
    await this.vault.createBinary(normalized, asArrayBuffer(body));
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
