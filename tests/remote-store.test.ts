import { describe, expect, it } from "vitest";

import {
  HeadChangedError,
  RemoteStore,
  type CommitRecord,
  type HeadRecord,
} from "../src/storage/remote-store";
import {
  ObjectPreconditionError,
  type ObjectPutOptions,
  type ObjectStore,
  type StoredObject,
} from "../src/storage/object-store";
import type { VaultEntry } from "../src/sync/sync-engine";

class MemoryObjectStore implements ObjectStore {
  private etagSequence = 0;
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
    const current = this.objects.get(key);
    if (options.ifNoneMatch && current) {
      throw new ObjectPreconditionError();
    }
    if (options.ifMatch !== undefined && current?.etag !== options.ifMatch) {
      throw new ObjectPreconditionError();
    }
    const stored = {
      body: body.slice(),
      etag: `etag-${++this.etagSequence}`,
      lastModified: "2026-09-05T00:00:00.000Z",
    };
    this.objects.set(key, stored);
    return stored;
  }
}

const commit = (
  commitId: string,
  parentId?: string,
  entries: VaultEntry[] = [],
): CommitRecord => ({
  changes: entries.map((entry) => ({ entry, kind: "set-entry" })),
  commitId,
  createdAt: "2026-09-05T00:00:00.000Z",
  parentIds: parentId ? [parentId] : [],
  protocolVersion: 1,
  replicaId: "desktop",
  vaultId: "vault-1",
});

const head = (commitId: string, generation: number): HeadRecord => ({
  commitId,
  generation,
  protocolVersion: 1,
  vaultId: "vault-1",
});

describe("RemoteStore", () => {
  it("rejects a stale Head update instead of overwriting a concurrent commit", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const first = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const second = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    await first.initialize({
      commit: commit("commit-1"),
      head: head("commit-1", 1),
    });
    const firstView = await first.readHead();
    const secondView = await second.readHead();
    if (!firstView || !secondView) {
      throw new Error("Expected initialized Head");
    }

    await first.advance({
      commit: commit("commit-a", "commit-1"),
      expectedHeadEtag: firstView.etag,
      head: head("commit-a", 2),
    });

    await expect(
      second.advance({
        commit: commit("commit-b", "commit-1"),
        expectedHeadEtag: secondView.etag,
        head: head("commit-b", 2),
      }),
    ).rejects.toBeInstanceOf(HeadChangedError);
    await expect(second.readHead()).resolves.toMatchObject({
      value: head("commit-a", 2),
    });
  });

  it("stores Commit and blob payloads as authenticated ciphertext", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const initialCommit = commit("commit-1");
    await remote.initialize({
      commit: initialCommit,
      head: head("commit-1", 1),
    });
    await remote.writeBlob("blob-1", new TextEncoder().encode("secret note"));

    const rawCommit = await objects.get(
      "chosen-prefix/v1/commits/commit-1",
    );
    const rawBlob = await objects.get("chosen-prefix/v1/blobs/blob-1");
    expect(new TextDecoder().decode(rawCommit?.body)).not.toContain("vault-1");
    expect(new TextDecoder().decode(rawBlob?.body)).not.toContain("secret note");
    await expect(remote.readCommit("commit-1")).resolves.toEqual(initialCommit);
    await expect(remote.readBlob("blob-1")).resolves.toEqual(
      new TextEncoder().encode("secret note"),
    );
  });

  it("rebuilds a Vault Snapshot from encrypted immutable Commits", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const liveEntry: VaultEntry = {
      entryId: "entry-1",
      kind: "live",
      path: "notes/example.md",
      revision: {
        blobId: "blob-1",
        contentHash: "sha256:old",
        createdAt: "2026-09-05T00:00:00.000Z",
        revisionId: "revision-1",
        size: 3,
      },
    };
    await remote.initialize({
      commit: commit("commit-1", undefined, [liveEntry]),
      head: head("commit-1", 1),
    });
    await remote.writeBlob("blob-1", new TextEncoder().encode("old"));
    const currentHead = await remote.readHead();
    if (!currentHead) {
      throw new Error("Expected initialized Head");
    }

    await expect(remote.readSnapshot(currentHead.value)).resolves.toEqual({
      commitId: "commit-1",
      entries: { "entry-1": liveEntry },
      protocolVersion: 1,
      vaultId: "vault-1",
    });
  });

  it("boots from an encrypted Snapshot without replaying older Commits", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const liveEntry: VaultEntry = {
      entryId: "entry-1",
      kind: "live",
      path: "notes/example.md",
      revision: {
        blobId: "blob-1",
        contentHash: "sha256:old",
        createdAt: "2026-09-05T00:00:00.000Z",
        revisionId: "revision-1",
        size: 3,
      },
    };
    const initialCommit = commit("commit-1", undefined, [liveEntry]);
    await remote.initialize({
      commit: initialCommit,
      head: head("commit-1", 1),
    });
    await remote.writeBlob("blob-1", new TextEncoder().encode("old"));
    const initialHead = await remote.readHead();
    if (!initialHead) {
      throw new Error("Expected initialized Head");
    }
    const snapshot = {
      commitId: "commit-2",
      entries: { "entry-1": liveEntry },
      protocolVersion: 1 as const,
      vaultId: "vault-1",
    };
    await remote.writeSnapshot("snapshot-1", snapshot);
    await remote.advance({
      commit: commit("commit-2", "commit-1"),
      expectedHeadEtag: initialHead.etag,
      head: { ...head("commit-2", 100), snapshotId: "snapshot-1" },
    });
    await objects.delete("chosen-prefix/v1/commits/commit-1");
    const currentHead = await remote.readHead();
    if (!currentHead) {
      throw new Error("Expected snapshotted Head");
    }

    await expect(remote.readSnapshot(currentHead.value)).resolves.toEqual(snapshot);
  });

  it("rejects a Snapshot whose referenced blob is missing", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const liveEntry: VaultEntry = {
      entryId: "entry-1",
      kind: "live",
      path: "notes/example.md",
      revision: {
        blobId: "blob-1",
        contentHash: "sha256:old",
        createdAt: "2026-09-05T00:00:00.000Z",
        revisionId: "revision-1",
        size: 3,
      },
    };
    await remote.writeBlob("blob-1", new TextEncoder().encode("old"));
    await remote.initialize({
      commit: commit("commit-1", undefined, [liveEntry]),
      head: head("commit-1", 1),
    });
    const currentHead = await remote.readHead();
    if (!currentHead) {
      throw new Error("Expected initialized Head");
    }
    await objects.delete("chosen-prefix/v1/blobs/blob-1");

    await expect(remote.readSnapshot(currentHead.value)).rejects.toThrow(
      "Vault Snapshot references missing blobs: blob-1",
    );
  });
});
