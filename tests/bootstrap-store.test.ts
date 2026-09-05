import { describe, expect, it } from "vitest";

import { BootstrapStore } from "../src/storage/bootstrap-store";
import type { KeyEnvelope } from "../src/crypto/vault-crypto";
import {
  ObjectPreconditionError,
  type ObjectPutOptions,
  type ObjectStore,
  type StoredObject,
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
    options: ObjectPutOptions = {},
  ): Promise<StoredObject> {
    if (options.ifNoneMatch && this.objects.has(key)) {
      throw new ObjectPreconditionError();
    }
    const stored = {
      body: body.slice(),
      etag: '"etag-1"',
      lastModified: "2026-09-05T00:00:00.000Z",
    };
    this.objects.set(key, stored);
    return stored;
  }
}

const envelope: KeyEnvelope = {
  cipher: "AES-256-GCM",
  ciphertext: "ciphertext",
  iterations: 310_000,
  iv: "iv",
  kdf: "PBKDF2-SHA256",
  salt: "salt",
  version: 1,
};

describe("BootstrapStore", () => {
  it("publishes and reads the password-locked Vault identity", async () => {
    const store = new BootstrapStore(new MemoryObjectStore(), "chosen-prefix");
    const record = { envelope, protocolVersion: 1 as const, vaultId: "vault-1" };

    await store.initialize(record);

    await expect(store.read()).resolves.toEqual(record);
    await expect(store.initialize(record)).rejects.toBeInstanceOf(
      ObjectPreconditionError,
    );
  });
});
