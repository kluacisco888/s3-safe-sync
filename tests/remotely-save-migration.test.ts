import { describe, expect, it } from "vitest";

import { RcloneCompat } from "../src/crypto/rclone-compat";
import { RemotelySaveMigration } from "../src/migration/remotely-save-migration";
import type { LocalFileInfo, LocalVaultPort } from "../src/sync/sync-service";
import type {
  ObjectPutOptions,
  ObjectStore,
  StoredObject,
} from "../src/storage/object-store";

class MemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, StoredObject>();

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async get(key: string): Promise<StoredObject | undefined> {
    return this.objects.get(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix));
  }

  async put(
    key: string,
    body: Uint8Array,
    _options?: ObjectPutOptions,
  ): Promise<StoredObject> {
    const stored = {
      body: body.slice(),
      etag: '"etag"',
      lastModified: "2026-09-05T00:00:00.000Z",
    };
    this.objects.set(key, stored);
    return stored;
  }
}

class OneFileVault implements LocalVaultPort {
  constructor(
    private readonly path: string,
    private readonly body: Uint8Array,
  ) {}

  delete(): Promise<void> {
    return Promise.resolve();
  }

  list(): Promise<LocalFileInfo[]> {
    return Promise.resolve([
      { modifiedAt: 1, path: this.path, size: this.body.byteLength },
    ]);
  }

  move(): Promise<void> {
    return Promise.resolve();
  }

  read(path: string): Promise<Uint8Array> {
    if (path !== this.path) {
      throw new Error(`Missing ${path}`);
    }
    return Promise.resolve(this.body.slice());
  }

  stat(path: string): Promise<LocalFileInfo | undefined> {
    return Promise.resolve(
      path === this.path
        ? { modifiedAt: 1, path, size: this.body.byteLength }
        : undefined,
    );
  }

  write(): Promise<void> {
    return Promise.resolve();
  }
}

describe("RemotelySaveMigration", () => {
  it("verifies an encrypted legacy prefix without writing to it", async () => {
    const objects = new MemoryObjectStore();
    const password = "existing rclone password";
    const path = "notes/example.md";
    const body = new TextEncoder().encode("legacy content");
    const cipher = await RcloneCompat.fromPassword(password);
    const encryptedPath = await cipher.encryptPath(path);
    await objects.put(`legacy/${encryptedPath}`, await cipher.encryptData(body));
    const migration = await RemotelySaveMigration.open({
      objects,
      password,
      prefix: "legacy",
    });

    const result = await migration.compare(new OneFileVault(path, body));

    expect(result).toEqual({ differences: [], filesCompared: 1, status: "clean" });
    expect(await objects.list("legacy/")).toHaveLength(1);
  });
});
