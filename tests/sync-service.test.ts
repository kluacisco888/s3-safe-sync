import { describe, expect, it, vi } from "vitest";

import {
  SyncService,
  type CachedSyncState,
  type LocalFileInfo,
  type LocalVaultPort,
  type SyncCachePort,
  type SyncProgress,
} from "../src/sync/sync-service";
import {
  ObjectPreconditionError,
  type ObjectPutOptions,
  type ListedObject,
  type ObjectStore,
  type StoredObject,
} from "../src/storage/object-store";
import {
  RemoteStateError,
  RemoteStore,
} from "../src/storage/remote-store";
import { SyncRequestQueue } from "../src/sync/sync-request-queue";
import { SyncEngine, type DeletedEntry, type LiveEntry, type RevisionRef, type VaultEntry } from "../src/sync/sync-engine";
import { retryHeadChanges } from "../src/sync/head-change-retry";
import { sha256Content } from "../src/sync/content-hash";
import { LocalStateChangedError } from "../src/sync/errors";
import { PathRenameTracker } from "../src/sync/path-rename-tracker";
import { CollisionRenameJournal, type PendingCollisionRename } from "../src/sync/collision-rename-journal";

class MemoryObjectStore implements ObjectStore {
  private sequence = 0;
  private readonly objects = new Map<string, StoredObject>();
  corruptNextBlobPut = false;
  onGet: ((key: string) => Promise<void> | void) | undefined;
  onPut: ((key: string) => Promise<void> | void) | undefined;
  // 新写入对象的 S3 LastModified
  lastModifiedForPuts = "2026-09-05T00:00:00.000Z";

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async get(key: string): Promise<StoredObject | undefined> {
    await this.onGet?.(key);
    return this.objects.get(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix));
  }

  async listObjects(prefix: string): Promise<ListedObject[]> {
    return [...this.objects].filter(([key]) => key.startsWith(prefix))
      .map(([key, stored]) => ({ key, lastModified: stored.lastModified, size: stored.body.byteLength }));
  }

  async put(
    key: string,
    body: Uint8Array,
    options: ObjectPutOptions = {},
  ): Promise<StoredObject> {
    await this.onPut?.(key);
    const current = this.objects.get(key);
    if (options.ifNoneMatch && current) {
      throw new ObjectPreconditionError();
    }
    if (options.ifMatch !== undefined && current?.etag !== options.ifMatch) {
      throw new ObjectPreconditionError();
    }
    const shouldCorrupt = this.corruptNextBlobPut && key.includes("/blobs/");
    if (shouldCorrupt) {
      this.corruptNextBlobPut = false;
    }
    const value = {
      body: shouldCorrupt
        ? new TextEncoder().encode("corrupted ciphertext")
        : body.slice(),
      etag: `etag-${++this.sequence}`,
      lastModified: this.lastModifiedForPuts,
    };
    this.objects.set(key, value);
    return value;
  }
}

class MemoryVault implements LocalVaultPort {
  private clock = 0;
  private readonly files = new Map<
    string,
    { bytes: Uint8Array; modifiedAt: number }
  >();
  readonly listedSizeOverrides = new Map<string, number>();
  beforeMove: ((fromPath: string, toPath: string) => Promise<void> | void) | undefined;
  beforeStat: ((path: string) => Promise<void> | void) | undefined;
  readCount = 0;
  readonly readPaths: string[] = [];
  readonly unsupportedPaths = new Set<string>();

  delete(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }

  list(): Promise<LocalFileInfo[]> {
    return Promise.resolve(
      [...this.files.entries()].map(([path, file]) => ({
        modifiedAt: file.modifiedAt,
        path,
        size: this.listedSizeOverrides.get(path) ?? file.bytes.byteLength,
      })),
    );
  }

  async move(
    fromPath: string,
    toPath: string,
    expectedSourceHash?: string,
    expectedTargetHash?: string | null,
  ): Promise<void> {
    await this.beforeMove?.(fromPath, toPath);
    const file = this.files.get(fromPath);
    if (!file) {
      throw new Error(`Missing local file ${fromPath}`);
    }
    const sourceDigest = await crypto.subtle.digest(
      "SHA-256",
      file.bytes.slice().buffer,
    );
    const sourceHash = `sha256:${Array.from(new Uint8Array(sourceDigest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")}`;
    if (
      expectedSourceHash !== undefined &&
      sourceHash !== expectedSourceHash
    ) {
      throw new Error(`同步过程中本地文件被改动：${fromPath}`);
    }
    const target = this.files.get(toPath);
    if (expectedTargetHash === null && target) {
      throw new Error(`同步过程中本地文件被改动：${toPath}`);
    }
    this.files.delete(fromPath);
    this.files.set(toPath, { bytes: file.bytes, modifiedAt: ++this.clock });
  }

  read(path: string): Promise<Uint8Array> {
    this.readCount += 1;
    this.readPaths.push(path);
    const file = this.files.get(path);
    if (!file) {
      throw new Error(`Missing local file ${path}`);
    }
    return Promise.resolve(file.bytes.slice());
  }

  readText(path: string): string | undefined {
    const file = this.files.get(path);
    return file ? new TextDecoder().decode(file.bytes) : undefined;
  }

  async stat(path: string): Promise<LocalFileInfo | undefined> {
    await this.beforeStat?.(path);
    const file = this.files.get(path);
    return file
      ? {
          modifiedAt: file.modifiedAt,
          path,
          size: file.bytes.byteLength,
        }
      : undefined;
  }

  supportsPath(path: string): boolean {
    return !this.unsupportedPaths.has(path);
  }

  write(path: string, body: Uint8Array): Promise<void> {
    this.files.set(path, { bytes: body.slice(), modifiedAt: ++this.clock });
    return Promise.resolve();
  }

  writePreservingMetadata(path: string, body: Uint8Array): void {
    const existing = this.files.get(path);
    if (!existing || existing.bytes.byteLength !== body.byteLength) {
      throw new Error(`Cannot preserve metadata for ${path}`);
    }
    this.files.set(path, {
      bytes: body.slice(),
      modifiedAt: existing.modifiedAt,
    });
  }
}

class StreamingMemoryVault extends MemoryVault {
  directReadCount = 0;
  hashCount = 0;

  override read(path: string): Promise<Uint8Array> {
    this.directReadCount += 1;
    return super.read(path);
  }

  async hashContent(
    path: string,
    options: {
      onProgress?: (hashedBytes: number) => void;
      yieldToHost?: () => Promise<void>;
    } = {},
  ): Promise<{ contentHash: string; size: number }> {
    this.hashCount += 1;
    const content = await super.read(path);
    for (let hashedBytes = 2; hashedBytes < content.byteLength; hashedBytes += 2) {
      options.onProgress?.(hashedBytes);
      await options.yieldToHost?.();
    }
    if (content.byteLength > 0) {
      options.onProgress?.(content.byteLength);
      await options.yieldToHost?.();
    }
    return {
      contentHash: await sha256Content(content),
      size: content.byteLength,
    };
  }
}

class MemorySyncCache implements SyncCachePort {
  state: CachedSyncState | undefined;

  load(): Promise<CachedSyncState | undefined> {
    return Promise.resolve(this.state);
  }

  save(state: CachedSyncState): Promise<void> {
    this.state = structuredClone(state);
    return Promise.resolve();
  }
}

const currentLiveEntryIds = async (remote: RemoteStore): Promise<string[]> => {
  const head = await remote.readHead();
  if (!head) {
    throw new Error("Expected initialized Head");
  }
  const snapshot = await remote.readSnapshot(head.value);
  return Object.values(snapshot.entries).flatMap((entry) =>
    entry.kind === "live" ? [entry.entryId] : [],
  );
};

const collisionJournal = (local: LocalVaultPort, cache: MemorySyncCache, tracker: PathRenameTracker): CollisionRenameJournal => {
  let pending: PendingCollisionRename | undefined;
  return new CollisionRenameJournal(local, {
    read: () => pending,
    prepare: async value => {pending = {...value, identitySourcePath: value.entryId
      ? [...tracker.capture()].find(([, rename]) => rename.entryId === value.entryId)?.[0] ??
        Object.values(cache.state?.files ?? {}).find(file => file.entryId === value.entryId)?.path : undefined};},
    finish: async (value, moved) => {
      if (value.entryId && value.identitySourcePath) tracker.setReviewedRename(value.entryId, value.identitySourcePath, moved ? value.to : value.from);
      pending = undefined;
    },
  });
};

describe("SyncService", () => {
  it("rechecks only referenced content, accepts an alternate recovery copy, and respects device limits", async () => {
    const objects = new MemoryObjectStore();
    const remote = await RemoteStore.open({objects, prefix: "integrity", vaultKey: new Uint8Array(32)});
    const local = new MemoryVault();
    const cache = new MemorySyncCache();
    await local.write("note.md", new TextEncoder().encode("original"));
    const service = new SyncService({cache, local, remote, replicaId: "test"});
    await service.initializeNew("vault");
    const head = (await remote.readHead())!;
    const snapshot = await remote.readSnapshot(head.value);
    const entry = Object.values(snapshot.entries)[0]!;
    if (entry.kind !== "live") throw new Error("Expected live fixture");
    const recovery = {kind: "recovery" as const, entryId: entry.entryId, contentHash: entry.revision.contentHash};
    await objects.put(`integrity/v1/blobs/${entry.revision.blobId}`, new TextEncoder().encode("damaged"));
    await expect(service.verifyRemoteIntegrity([recovery], "vault")).rejects.toThrow("在远端没有可核实的恢复副本");
    await expect(service.verifyRemoteIntegrity([{kind: "blob", blobId: entry.revision.blobId}], "vault"))
      .rejects.toMatchObject({integrityCheck: {kind: "blob", blobId: entry.revision.blobId}});
    // Repair can supply another authenticated copy without deleting the old evidence.
    await remote.writeBlob("alternate", new TextEncoder().encode("original"));
    await remote.advance({expectedHeadEtag: head.etag, head: {...head.value, commitId: "alternate", generation: 2},
      commit: {commitId: "alternate", protocolVersion: 1, vaultId: "vault", replicaId: "test", createdAt: head.serverDate,
        parentIds: [head.value.commitId], changes: [{kind: "set-entry", entry: {...entry,
          history: [{...entry.revision, blobId: "alternate", revisionId: "alternate"}]}}]}});
    await expect(service.verifyRemoteIntegrity([recovery], "vault")).resolves.toBeUndefined();
    await expect(service.verifyRemoteIntegrity([{kind: "recovery", entryId: entry.entryId, contentHash: "sha256:unavailable"}], "vault"))
      .rejects.toThrow("在远端没有可核实的恢复副本");
    const limited = new SyncService({cache, local, remote, replicaId: "phone", maxAutomaticFileBytes: 1});
    const reads: string[] = [];
    objects.onGet = key => {reads.push(key);};
    for (const check of [recovery, {kind: "blob" as const, blobId: entry.revision.blobId}]) {
      await expect(limited.verifyRemoteIntegrity([check], "vault")).rejects.toThrow("传输限制");
    }
    expect(reads.some(key => key.includes("/blobs/"))).toBe(false);
    // A rejected upload not referenced by accepted history must not leave an eternal blocker.
    await objects.put("integrity/v1/blobs/orphan", new TextEncoder().encode("damaged orphan"));
    await expect(service.verifyRemoteIntegrity([{kind: "blob", blobId: "orphan"}], "vault")).resolves.toBeUndefined();
    expect(reads).not.toContain("integrity/v1/blobs/orphan");
  });

  it("does not clear a materialized-candidate failure just because metadata decrypts", async () => {
    const objects = new MemoryObjectStore();
    const remote = await RemoteStore.open({objects, prefix: "integrity", vaultKey: new Uint8Array(32)});
    const local = new MemoryVault();
    const cache = new MemorySyncCache();
    const service = new SyncService({cache, local, remote, replicaId: "test"});
    await local.write("note.md", new TextEncoder().encode("original"));
    await service.initializeNew("vault");
    const head = (await remote.readHead())!;
    const entry = Object.values((await remote.readSnapshot(head.value)).entries)[0]!;
    if (entry.kind !== "live") throw new Error("Expected live fixture");
    await remote.advance({expectedHeadEtag: head.etag, head: {...head.value, commitId: "conflict", generation: 2},
      commit: {commitId: "conflict", protocolVersion: 1, vaultId: "vault", replicaId: "test", createdAt: head.serverDate,
        parentIds: [head.value.commitId], changes: [{kind: "set-entry", entry: {kind: "conflicted", entryId: entry.entryId,
          path: entry.path, reason: "edit-edit", candidates: [], materializedContentHash: entry.revision.contentHash,
          history: [entry.revision]}}]}});
    await expect(service.verifyRemoteIntegrity([{kind: "recovery", entryId: entry.entryId, contentHash: entry.revision.contentHash}], "vault"))
      .rejects.toThrow("冲突没有可核实的候选版本");
  });

  it("rejects a cross-platform path collision before initializing Head", async () => {
    const objects = new MemoryObjectStore();
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey: Uint8Array.from({ length: 32 }, (_, index) => index),
    });
    const local = new MemoryVault();
    await local.write("notes/Foo.md", new TextEncoder().encode("upper"));
    await local.write("notes/foo.md", new TextEncoder().encode("lower"));
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      remote,
      replicaId: "android-first",
    });

    await expect(service.initializeNew("vault-1")).rejects.toThrow(
      "跨平台路径撞名",
    );

    await expect(remote.readHead()).resolves.toBeUndefined();
    expect(await objects.list("chosen-prefix/v1/blobs/")).toEqual([]);
  });

  it("reports initialization progress for every encrypted upload", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    await local.write("notes/one.md", new TextEncoder().encode("one"));
    await local.write("notes/two.md", new TextEncoder().encode("twice"));
    const progress: SyncProgress[] = [];
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      onProgress: (update) => progress.push(update),
      remote,
      replicaId: "desktop",
    });

    await service.initializeNew("vault-1");

    expect(local.readCount).toBe(4);
    expect(progress.filter((update) => update.phase === "scanning")).toEqual([
      {
        completed: 2,
        phase: "scanning",
        total: 2,
        totalBytes: 0,
        transferredBytes: 0,
      },
    ]);
    expect(progress.filter((update) => update.phase === "hashing")).toEqual([
      {
        completed: 0,
        phase: "hashing",
        total: 2,
        totalBytes: 8,
        transferredBytes: 0,
      },
      {
        completed: 0,
        currentPath: "notes/one.md",
        phase: "hashing",
        total: 2,
        totalBytes: 8,
        transferredBytes: 0,
      },
      {
        completed: 1,
        currentPath: "notes/one.md",
        phase: "hashing",
        total: 2,
        totalBytes: 8,
        transferredBytes: 3,
      },
      {
        completed: 1,
        currentPath: "notes/two.md",
        phase: "hashing",
        total: 2,
        totalBytes: 8,
        transferredBytes: 3,
      },
      {
        completed: 2,
        currentPath: "notes/two.md",
        phase: "hashing",
        total: 2,
        totalBytes: 8,
        transferredBytes: 8,
      },
    ]);
    expect(progress.filter((update) => update.phase === "uploading")).toEqual([
      {
        completed: 0,
        phase: "uploading",
        total: 2,
        totalBytes: 8,
        transferredBytes: 0,
      },
      {
        completed: 0,
        currentPath: "notes/one.md",
        phase: "uploading",
        total: 2,
        totalBytes: 8,
        transferredBytes: 0,
      },
      {
        completed: 1,
        currentPath: "notes/one.md",
        phase: "uploading",
        total: 2,
        totalBytes: 8,
        transferredBytes: 3,
      },
      {
        completed: 1,
        currentPath: "notes/two.md",
        phase: "uploading",
        total: 2,
        totalBytes: 8,
        transferredBytes: 3,
      },
      {
        completed: 2,
        currentPath: "notes/two.md",
        phase: "uploading",
        total: 2,
        totalBytes: 8,
        transferredBytes: 8,
      },
    ]);
    expect(progress.at(-1)).toEqual({
      completed: 2,
      phase: "publishing",
      total: 2,
      totalBytes: 8,
      transferredBytes: 8,
    });
  });

  it("stops initialization if a local file changes after scanning", async () => {
    const scanned = new TextEncoder().encode("first");
    const changed = new TextEncoder().encode("other");
    let reads = 0;
    const local: LocalVaultPort = {
      delete: () => Promise.resolve(),
      list: () =>
        Promise.resolve([
          { modifiedAt: 1, path: "notes/example.md", size: scanned.byteLength },
        ]),
      move: () => Promise.resolve(),
      read: () => Promise.resolve((reads++ === 0 ? scanned : changed).slice()),
      stat: () =>
        Promise.resolve({
          modifiedAt: 1,
          path: "notes/example.md",
          size: scanned.byteLength,
        }),
      write: () => Promise.resolve(),
    };
    const remote = await RemoteStore.open({
      objects: new MemoryObjectStore(),
      prefix: "chosen-prefix",
      vaultKey: Uint8Array.from({ length: 32 }, (_, index) => index),
    });
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      remote,
      replicaId: "desktop",
    });

    await expect(service.initializeNew("vault-1")).rejects.toThrow(
      "读取期间本地文件被改动：notes/example.md",
    );
    expect(await remote.readHead()).toBeUndefined();
  });

  it("reports the current file while uploading a later Revision", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    await local.write("notes/example.md", new TextEncoder().encode("first"));
    const progress: SyncProgress[] = [];
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      onProgress: (update) => progress.push(update),
      remote,
      replicaId: "desktop",
    });
    await service.initializeNew("vault-1");
    progress.splice(0);
    await local.write("notes/example.md", new TextEncoder().encode("second"));

    await service.synchronize();

    expect(progress.filter((update) => update.phase === "uploading")).toEqual([
      {
        completed: 0,
        currentPath: "notes/example.md",
        phase: "uploading",
        total: 1,
        totalBytes: 6,
        transferredBytes: 0,
      },
      {
        completed: 1,
        currentPath: "notes/example.md",
        phase: "uploading",
        total: 1,
        totalBytes: 6,
        transferredBytes: 6,
      },
    ]);
    expect(progress.at(-1)).toEqual({
      completed: 1,
      phase: "publishing",
      total: 1,
      totalBytes: 6,
      transferredBytes: 6,
    });
  });

  it("reports the current file while downloading a remote Revision", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("hello"),
    );
    await new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    }).initializeNew("vault-1");
    const progress: SyncProgress[] = [];
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: new MemoryVault(),
      onProgress: (update) => progress.push(update),
      remote: await RemoteStore.open({
        objects,
        prefix: "chosen-prefix",
        vaultKey,
      }),
      replicaId: "phone",
    });

    await phone.synchronize();

    expect(progress.filter((update) => update.phase === "downloading")).toEqual([
      {
        completed: 0,
        currentPath: "notes/example.md",
        phase: "downloading",
        total: 1,
        totalBytes: 5,
        transferredBytes: 0,
      },
      {
        completed: 1,
        currentPath: "notes/example.md",
        phase: "downloading",
        total: 1,
        totalBytes: 5,
        transferredBytes: 5,
      },
    ]);
  });

  it("bootstraps a new Replica from an encrypted Remote Store", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("hello from desktop"),
    );
    const desktopCache = new MemorySyncCache();
    const desktop = new SyncService({
      cache: desktopCache,
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    });
    await desktop.initializeNew("vault-1");

    const phoneVault = new MemoryVault();
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });
    const result = await phone.synchronize();

    expect(result).toMatchObject({ downloaded: 1, status: "complete" });
    expect(phoneVault.readText("notes/example.md")).toBe("hello from desktop");
  });

  it("keeps a cache-loss content mismatch blocked across repeated syncs", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopVault = new MemoryVault();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("remote version"),
    );
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    await new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote,
      replicaId: "desktop",
    }).initializeNew("vault-1");
    const local = new MemoryVault();
    await local.write(
      "notes/example.md",
      new TextEncoder().encode("local version"),
    );
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      remote,
      replicaId: "reinstalled-phone",
    });

    const first = await service.synchronize();
    const second = await service.synchronize();

    expect(first.localIssues).toContainEqual({
      kind: "bootstrap-mismatch",
      path: "notes/example.md",
    });
    expect(second.localIssues).toContainEqual({
      kind: "bootstrap-mismatch",
      path: "notes/example.md",
    });
    expect(local.readText("notes/example.md")).toBe("local version");
    expect((await remote.readHead())?.value.generation).toBe(1);
  });

  describe("a stale local copy that matches Version History", () => {
    const path = "notes/stale.md";
    const encode = (text: string) => new TextEncoder().encode(text);
    // 电脑依次发布 R1、R2、R3；手机的 base 停在 R1（或没有 base），本地内容另行写入
    const setup = async (options: {phoneHasBase: boolean; phoneContent: string}) => {
      const objects = new MemoryObjectStore();
      const remote = await RemoteStore.open({objects, prefix: "stale", vaultKey: new Uint8Array(32)});
      const desktopVault = new MemoryVault();
      const desktop = new SyncService({cache: new MemorySyncCache(), local: desktopVault, remote, replicaId: "desktop"});
      await desktopVault.write(path, encode("R1 first draft"));
      await desktop.initializeNew("vault");
      const phoneVault = new MemoryVault();
      const phone = new SyncService({cache: new MemorySyncCache(), local: phoneVault, remote, replicaId: "phone"});
      if (options.phoneHasBase) await phone.synchronize();
      await desktopVault.write(path, encode("R2 second draft"));
      await desktop.synchronize();
      await desktopVault.write(path, encode("R3 current"));
      await desktop.synchronize();
      await phoneVault.write(path, encode(options.phoneContent));
      const entryOf = async () => {
        const head = (await remote.readHead())!;
        return Object.values((await remote.readSnapshot(head.value)).entries).find(entry => entry.path === path)!;
      };
      const damageRevision = async (content: string) => {
        const entry = await entryOf();
        const hash = await sha256Content(encode(content));
        const revision = (entry.history ?? []).find(value => value.contentHash === hash)!;
        await objects.put(`stale/v1/blobs/${revision.blobId}`, encode("damaged"));
      };
      return {remote, phone, phoneVault, entryOf, damageRevision};
    };

    it("replaces a stale copy with the current Revision instead of conflicting", async () => {
      const {remote, phone, phoneVault, entryOf} = await setup({phoneHasBase: true, phoneContent: "R2 second draft"});
      const generation = (await remote.readHead())!.value.generation;

      await expect(phone.synchronize()).resolves.toMatchObject({
        status: "complete", downloaded: 1, uploaded: 0, localIssues: [],
      });

      expect(phoneVault.readText(path)).toBe("R3 current");
      const entry = await entryOf();
      expect(entry.kind).toBe("live");
      expect(entry.kind === "live" && entry.revision.contentHash).toBe(await sha256Content(encode("R3 current")));
      expect((await remote.readHead())!.value.generation).toBe(generation);
      await expect(phone.synchronize()).resolves.toMatchObject({
        status: "complete", downloaded: 0, uploaded: 0,
      });
    });

    it("replaces a stale copy without a base instead of asking for review", async () => {
      const {phone, phoneVault} = await setup({phoneHasBase: false, phoneContent: "R1 first draft"});

      await expect(phone.synchronize()).resolves.toMatchObject({
        status: "complete", downloaded: 1, uploaded: 0, localIssues: [],
      });

      expect(phoneVault.readText(path)).toBe("R3 current");
      await expect(phone.synchronize()).resolves.toMatchObject({
        status: "complete", downloaded: 0, uploaded: 0,
      });
    });

    it("keeps conflicting when local content is not a recorded Revision", async () => {
      const {phone, entryOf} = await setup({phoneHasBase: true, phoneContent: "phone edit"});

      await phone.synchronize();

      expect(await entryOf()).toMatchObject({kind: "conflicted", reason: "edit-edit"});
    });

    it("keeps bootstrap review when local content is not a recorded Revision", async () => {
      const {phone, phoneVault} = await setup({phoneHasBase: false, phoneContent: "phone edit"});

      await expect(phone.synchronize()).resolves.toMatchObject({
        status: "action-required", localIssues: [{kind: "bootstrap-mismatch", path}],
      });
      expect(phoneVault.readText(path)).toBe("phone edit");
    });

    it("conflicts when the matching Revision can no longer be authenticated", async () => {
      const {phone, entryOf, damageRevision} = await setup({phoneHasBase: true, phoneContent: "R2 second draft"});
      await damageRevision("R2 second draft");

      await phone.synchronize();

      expect(await entryOf()).toMatchObject({kind: "conflicted", reason: "edit-edit"});
    });

    it("asks for bootstrap review when the matching Revision can no longer be authenticated", async () => {
      const {phone, phoneVault, damageRevision} = await setup({phoneHasBase: false, phoneContent: "R1 first draft"});
      await damageRevision("R1 first draft");

      await expect(phone.synchronize()).resolves.toMatchObject({
        status: "action-required", localIssues: [{kind: "bootstrap-mismatch", path}],
      });
      expect(phoneVault.readText(path)).toBe("R1 first draft");
    });
  });

  describe("downloads materialized before an interrupted synchronization", () => {
    const x = "notes/x.txt";
    const encode = (text: string) => new TextEncoder().encode(text);
    // 电脑发布 R1 后手机建立（或不建立）base；电脑再发布 R2 和新文件，手机下载到一半被打断；电脑随后发布 R3
    const setup = async (options: {phoneHasBase: boolean}) => {
      const objects = new MemoryObjectStore();
      const remote = await RemoteStore.open({objects, prefix: "resume", vaultKey: new Uint8Array(32)});
      const desktopVault = new MemoryVault();
      const desktop = new SyncService({cache: new MemorySyncCache(), local: desktopVault, remote, replicaId: "desktop"});
      await desktopVault.write(x, encode("R1 x"));
      await desktopVault.write("notes/gone.txt", encode("gone"));
      await desktopVault.write("notes/y.txt", encode("R1 y"));
      await desktop.initializeNew("vault");
      const phoneVault = new MemoryVault();
      const phoneCache = new MemorySyncCache();
      const hooks: {onProgress?: (progress: SyncProgress) => void} = {};
      const phone = new SyncService({
        cache: phoneCache, local: phoneVault, remote, replicaId: "phone",
        onProgress: progress => hooks.onProgress?.(progress),
      });
      if (options.phoneHasBase) await phone.synchronize();
      await desktopVault.write(x, encode("R2 x"));
      await desktopVault.delete("notes/gone.txt");
      await desktopVault.write("notes/z.md", encode("new z"));
      // 删除 1 个文件超过 20% 的阈值，按确认后的集合发布
      const pending = await desktop.synchronize();
      await desktop.synchronize(pending.bulkDeletion?.entryIds ?? []);
      const entryAt = async (path: string) => {
        const head = (await remote.readHead())!;
        return Object.values((await remote.readSnapshot(head.value)).entries).find(entry => entry.path === path)!;
      };
      // 第 n 个文件下载完成后，下一次读取数据块时网络中断
      const interruptAfterDownloads = (count: number) => {
        let armed = false;
        hooks.onProgress = progress => {
          if (progress.phase === "downloading" && progress.completed >= count) armed = true;
        };
        objects.onGet = key => {
          if (!armed || !key.includes("/blobs/")) return;
          armed = false;
          hooks.onProgress = undefined;
          objects.onGet = undefined;
          throw new Error("network lost");
        };
      };
      // 规划阶段读不出这个历史版本（票 07 的旧副本规则因此不生效），进入下载阶段后恢复可读
      const hideRevisionWhilePlanning = async (path: string, content: string) => {
        const entry = await entryAt(path);
        const hash = await sha256Content(encode(content));
        const revision = (entry.history ?? []).find(value => value.contentHash === hash)!;
        const key = `resume/v1/blobs/${revision.blobId}`;
        const original = (await objects.get(key))!;
        await objects.put(key, encode("damaged"));
        hooks.onProgress = progress => {
          if (progress.phase !== "downloading") return;
          hooks.onProgress = undefined;
          void objects.put(key, original.body);
        };
      };
      const publishR3 = async () => {
        await desktopVault.write(x, encode("R3 x"));
        await desktop.synchronize();
      };
      return {objects, remote, phone, phoneVault, phoneCache, desktopVault, desktop, hooks,
        entryAt, interruptAfterDownloads, hideRevisionWhilePlanning, publishR3};
    };

    it("treats a file downloaded before the interruption as unmodified", async () => {
      const {phone, phoneVault, phoneCache, entryAt, interruptAfterDownloads, hideRevisionWhilePlanning, publishR3} =
        await setup({phoneHasBase: true});
      interruptAfterDownloads(1);
      await expect(phone.synchronize()).rejects.toThrow("network lost");
      expect(phoneVault.readText(x)).toBe("R2 x");
      expect(phoneVault.readText("notes/z.md")).toBeUndefined();
      // 只记下已落地的 x：还没下载的 z 不进 base，远端的删除也不提前写成 Deletion Record
      const accepted = phoneCache.state!;
      const xEntry = Object.values(accepted.snapshot.entries).find(entry => entry.path === x);
      expect(xEntry?.kind === "live" && xEntry.revision.contentHash).toBe(await sha256Content(encode("R2 x")));
      expect(accepted.files[x]?.contentHash).toBe(await sha256Content(encode("R2 x")));
      expect(Object.values(accepted.snapshot.entries).some(entry => entry.path === "notes/z.md")).toBe(false);
      expect(accepted.files["notes/z.md"]).toBeUndefined();
      expect(Object.values(accepted.snapshot.entries).find(entry => entry.path === "notes/gone.txt")?.kind).toBe("live");

      await publishR3();
      await hideRevisionWhilePlanning(x, "R2 x");
      await expect(phone.synchronize()).resolves.toMatchObject({
        status: "complete", downloaded: 2, uploaded: 0, localIssues: [],
      });

      expect(phoneVault.readText(x)).toBe("R3 x");
      expect(phoneVault.readText("notes/z.md")).toBe("new z");
      expect(await entryAt(x)).toMatchObject({kind: "live"});
      await expect(phone.synchronize()).resolves.toMatchObject({status: "complete", downloaded: 0, uploaded: 0});
    });

    it("stops without a Conflict when the downloaded Revision has no recovery copy left", async () => {
      const {objects, phone, phoneVault, entryAt, interruptAfterDownloads, publishR3} = await setup({phoneHasBase: true});
      interruptAfterDownloads(1);
      await expect(phone.synchronize()).rejects.toThrow("network lost");
      await publishR3();
      const entry = await entryAt(x);
      const hash = await sha256Content(encode("R2 x"));
      const r2 = (entry.history ?? []).find(value => value.contentHash === hash)!;
      await objects.put(`resume/v1/blobs/${r2.blobId}`, encode("damaged"));

      // 不变量 9：替换本地 R2 之前必须有可核实的恢复副本，没有就停下，不把它当成本机修改发布 Conflict
      await expect(phone.synchronize()).rejects.toBeInstanceOf(RemoteStateError);
      expect(phoneVault.readText(x)).toBe("R2 x");
      expect(await entryAt(x)).toMatchObject({kind: "live"});
    });

    it("does not ask for bootstrap review of a file downloaded before the interruption", async () => {
      const {phone, phoneVault, phoneCache, interruptAfterDownloads, hideRevisionWhilePlanning, publishR3} =
        await setup({phoneHasBase: false});
      interruptAfterDownloads(1);
      await expect(phone.synchronize()).rejects.toThrow("network lost");
      expect(phoneVault.readText(x)).toBe("R2 x");
      expect(phoneCache.state).toMatchObject({bootstrapPending: true});
      expect(Object.keys(phoneCache.state!.files)).toEqual([x]);

      await publishR3();
      await hideRevisionWhilePlanning(x, "R2 x");
      await expect(phone.synchronize()).resolves.toMatchObject({
        status: "complete", uploaded: 0, localIssues: [],
      });

      expect(phoneVault.readText(x)).toBe("R3 x");
      expect(phoneVault.readText("notes/z.md")).toBe("new z");
      expect(phoneCache.state?.bootstrapPending).toBeUndefined();
    });

    it("keeps a download materialized before an interrupted upload while real local edits still conflict", async () => {
      const {objects, phone, phoneVault, desktopVault, desktop, entryAt, hooks, hideRevisionWhilePlanning, publishR3} =
        await setup({phoneHasBase: true});
      // 下载前就存在的本机修改：y 不等于任何远端版本，另有一个本机新文件
      await phoneVault.write("notes/y.txt", encode("phone y edit"));
      await phoneVault.write("notes/new.txt", encode("phone new"));
      await desktopVault.write("notes/y.txt", encode("desktop y edit"));
      await desktop.synchronize();
      let uploadsStarted = false;
      hooks.onProgress = progress => {
        if (progress.phase === "uploading") uploadsStarted = true;
      };
      objects.onPut = key => {
        if (!uploadsStarted || !key.includes("/blobs/")) return;
        objects.onPut = undefined;
        throw new Error("network lost");
      };
      await expect(phone.synchronize()).rejects.toThrow("network lost");
      hooks.onProgress = undefined;
      expect(phoneVault.readText(x)).toBe("R2 x");

      await publishR3();
      await hideRevisionWhilePlanning(x, "R2 x");
      await expect(phone.synchronize()).resolves.toMatchObject({status: "action-required", uploaded: 2});

      expect(phoneVault.readText(x)).toBe("R3 x");
      expect(await entryAt(x)).toMatchObject({kind: "live"});
      expect(await entryAt("notes/y.txt")).toMatchObject({kind: "conflicted", reason: "edit-edit"});
      expect(await entryAt("notes/new.txt")).toMatchObject({kind: "live"});
    });

    it("does not record a file edited right after it was downloaded", async () => {
      const {phone, phoneVault, phoneCache, entryAt, interruptAfterDownloads, publishR3} =
        await setup({phoneHasBase: true});
      const write = phoneVault.write.bind(phoneVault);
      phoneVault.write = async (path: string, body: Uint8Array) => {
        await write(path, body);
        if (path === x) {
          phoneVault.write = write;
          await write(x, encode("phone edit after download"));
        }
      };
      interruptAfterDownloads(1);
      await expect(phone.synchronize()).rejects.toThrow("network lost");
      expect(phoneCache.state!.files[x]?.contentHash).toBe(await sha256Content(encode("R1 x")));

      await publishR3();
      await phone.synchronize();

      expect(await entryAt(x)).toMatchObject({kind: "conflicted", reason: "edit-edit"});
    });

    it("saves downloaded files periodically so a killed run keeps them", async () => {
      const {objects, phone, phoneCache, hooks} = await setup({phoneHasBase: true});
      vi.useFakeTimers({toFake: ["Date"]});
      try {
        // 第一个下载开始时时钟走过保存间隔；进程在下一个下载中途被杀，来不及走错误处理
        let savedBeforeKill: CachedSyncState | undefined;
        hooks.onProgress = progress => {
          if (progress.phase !== "downloading") return;
          if (progress.completed === 0) vi.setSystemTime(Date.now() + 5_000);
          if (progress.completed === 1) {
            hooks.onProgress = undefined;
            objects.onGet = key => {
              if (!key.includes("/blobs/")) return;
              objects.onGet = undefined;
              savedBeforeKill = structuredClone(phoneCache.state);
              throw new Error("process killed");
            };
          }
        };
        await expect(phone.synchronize()).rejects.toThrow("process killed");
        expect(savedBeforeKill?.files[x]?.contentHash).toBe(await sha256Content(encode("R2 x")));
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("reviewing local content without a trusted base", () => {
    const setup = async (reverseOrder = false) => {
      const objects = new MemoryObjectStore();
      const remote = await RemoteStore.open({objects, prefix: "test", vaultKey: new Uint8Array(32)});
      const source = new MemoryVault();
      if (reverseOrder) await source.write("unreviewed.md", new TextEncoder().encode("remote other"));
      await source.write("article.md", new TextEncoder().encode("remote article"));
      await source.write("unreviewed.md", new TextEncoder().encode("remote other"));
      const sourceCache = new MemorySyncCache();
      const sourceService = new SyncService({cache: sourceCache, local: source, remote, replicaId: "source"});
      await sourceService.initializeNew("vault");
      const local = new MemoryVault();
      await local.write("article.md", new TextEncoder().encode("local article"));
      await local.write("unreviewed.md", new TextEncoder().encode("local other"));
      const cache = new MemorySyncCache();
      const service = new SyncService({cache, local, remote, replicaId: "new-device"});
      return {objects, remote, local, cache, service, source, sourceService, sourceCache};
    };

    it("accepts S3 only after preserving the unpublished local version in recoverable history", async () => {
      const {service, remote, local} = await setup();
      const before = await local.list();
      const review = await service.reviewLocalContent("article.md");
      await service.resolveLocalContent("article.md", review.reviewToken, "remote");
      expect(local.readText("article.md")).toBe("remote article");
      expect((await local.list()).map(file => file.path)).toEqual(before.map(file => file.path));
      const snapshot = await remote.readSnapshot((await remote.readHead())!.value);
      const entry = Object.values(snapshot.entries).find(entry => entry.path === "article.md");
      if (entry?.kind !== "live") throw new Error("Expected the original live Entry");
      expect(entry.history).toHaveLength(1);
      const backup = entry.history![0]!;
      expect(new TextDecoder().decode(await remote.readBlob(backup.blobId))).toBe("local article");
      expect(new TextDecoder().decode(await service.readHistoricalRevision(entry.entryId, backup.revisionId))).toBe("local article");
      expect(backup.expiresAt).toBe("2026-10-05T00:00:00.000Z");
      expect((await service.synchronize()).localIssues).toEqual([{kind: "bootstrap-mismatch", path: "unreviewed.md"}]);
      await service.restoreRevision(entry.entryId, backup.revisionId);
      expect(local.readText("article.md")).toBe("local article");
    });

    it("does not infer a deleted reviewed file's identity onto an untouched S3-owned path", async () => {
      const {service, remote, local, cache, source, sourceService} = await setup();
      await source.write("unreviewed.md", new TextEncoder().encode("remote article"));
      await sourceService.synchronize();
      await local.write("unreviewed.md", new TextEncoder().encode("remote article"));
      const before = await remote.readSnapshot((await remote.readHead())!.value);
      const untouched = Object.values(before.entries).find(entry => entry.path === "unreviewed.md")!;
      const removed = Object.values(before.entries).find(entry => entry.path === "article.md")!;
      const review = await service.reviewLocalContent("article.md");
      await service.resolveLocalContent("article.md", review.reviewToken, "remote");
      await local.delete("article.md");
      const plan = await service.synchronize();
      expect(plan.localIssues).toEqual([]);
      expect(plan.bulkDeletion?.entryIds).toEqual([removed.entryId]);
      await service.synchronize(plan.bulkDeletion!.entryIds);
      expect(cache.state!.files["unreviewed.md"]!.entryId).toBe(untouched.entryId);
      expect(local.readText("unreviewed.md")).toBe("remote article");
      const after = await remote.readSnapshot((await remote.readHead())!.value);
      expect(after.entries[untouched.entryId]).toEqual(untouched);
      expect(after.entries[removed.entryId]?.kind).toBe("deleted");
    });

    it("publishes the local choice while keeping S3's previous version recoverable", async () => {
      const {service, remote, local, cache, sourceService, source} = await setup();
      const before = await local.list();
      const review = await service.reviewLocalContent("article.md");
      await service.resolveLocalContent("article.md", review.reviewToken, "local");
      expect(await local.list()).toEqual(before);
      expect(local.readText("article.md")).toBe("local article");
      expect((await cache.load())?.bootstrapPending).toBe(true);
      expect(local.readText("unreviewed.md")).toBe("local other");
      const snapshot = await remote.readSnapshot((await remote.readHead())!.value);
      const entry = Object.values(snapshot.entries).find(entry => entry.path === "article.md");
      if (entry?.kind !== "live") throw new Error("Expected a live original Entry");
      expect(new TextDecoder().decode(await remote.readBlob(entry.revision.blobId))).toBe("local article");
      const backup = entry.history![0]!;
      expect(new TextDecoder().decode(await remote.readBlob(backup.blobId))).toBe("remote article");
      expect(backup.expiresAt).toBe("2026-10-05T00:00:00.000Z");
      await sourceService.synchronize();
      expect(source.readText("article.md")).toBe("local article");
      await service.restoreRevision(entry.entryId, backup.revisionId);
      expect(local.readText("article.md")).toBe("remote article");
    });

    it.each(["local", "remote", "both"] as const)("rejects a stale %s choice without publishing or replacing content", async choice => {
      for (const changed of ["local", "remote"] as const) {
        const {service, remote, local, source, sourceService} = await setup();
        const review = await service.reviewLocalContent("article.md");
        if (changed === "local") await local.write("article.md", new TextEncoder().encode("new draft"));
        else { await source.write("article.md", new TextEncoder().encode("new S3 version")); await sourceService.synchronize(); }
        const head = await remote.readHead();
        const before = await local.list();
        await expect(service.resolveLocalContent("article.md", review.reviewToken, choice)).rejects.toThrow("有变化。请重新审查");
        expect(await remote.readHead()).toEqual(head);
        expect(await local.list()).toEqual(before);
        expect(local.readText("article.md")).toBe(changed === "local" ? "new draft" : "local article");
      }
    });

    it.each(["local", "remote"] as const)("keeps both existing versions if a %s choice upload fails verification", async choice => {
      const {service, remote, local, objects, cache} = await setup();
      const review = await service.reviewLocalContent("article.md");
      const head = await remote.readHead();
      const before = await local.list();
      objects.corruptNextBlobPut = true;
      await expect(service.resolveLocalContent("article.md", review.reviewToken, choice)).rejects.toThrow();
      expect(await remote.readHead()).toEqual(head);
      expect(await local.list()).toEqual(before);
      expect(local.readText("article.md")).toBe("local article");
      expect(await cache.load()).toBeUndefined();
    });

    it.each(["local", "remote"] as const)("does not overwrite typing during a %s choice's upload", async choice => {
      const {service, remote, local, objects} = await setup();
      const review = await service.reviewLocalContent("article.md");
      const head = await remote.readHead();
      objects.onPut = async key => {
        if (!key.includes("/blobs/")) return;
        objects.onPut = undefined;
        await local.write("article.md", new TextEncoder().encode("typing while saving"));
      };
      await expect(service.resolveLocalContent("article.md", review.reviewToken, choice)).rejects.toThrow("被改动");
      expect(local.readText("article.md")).toBe("typing while saving");
      expect(await remote.readHead()).toEqual(head);
    });

    it.each(["local", "remote"] as const)("rejects a %s choice when another device wins publication", async choice => {
      const {service, remote, local, objects, source, sourceService} = await setup();
      const review = await service.reviewLocalContent("article.md");
      objects.onPut = async key => {
        if (!key.includes("/blobs/")) return;
        objects.onPut = undefined;
        await source.write("article.md", new TextEncoder().encode("concurrent remote update"));
        await sourceService.synchronize();
      };
      await expect(service.resolveLocalContent("article.md", review.reviewToken, choice)).rejects.toThrow("Head 指针被改了");
      expect(local.readText("article.md")).toBe("local article");
      const snapshot = await remote.readSnapshot((await remote.readHead())!.value);
      const entry = Object.values(snapshot.entries).find(value => value.path === "article.md");
      if (entry?.kind !== "live") throw new Error("Expected the competing live Entry");
      expect(new TextDecoder().decode(await remote.readBlob(entry.revision.blobId))).toBe("concurrent remote update");
    });

    it("retains the unpublished backup when local replacement is interrupted after S3 accepts it", async () => {
      const {service, remote, local, objects, cache} = await setup();
      const review = await service.reviewLocalContent("article.md");
      objects.onPut = async key => {
        if (!key.endsWith("/head")) return;
        objects.onPut = undefined;
        await local.write("article.md", new TextEncoder().encode("typing during publication"));
      };
      await expect(service.resolveLocalContent("article.md", review.reviewToken, "remote")).rejects.toThrow("被改动");
      expect(local.readText("article.md")).toBe("typing during publication");
      const snapshot = await remote.readSnapshot((await remote.readHead())!.value);
      const entry = Object.values(snapshot.entries).find(value => value.path === "article.md");
      if (entry?.kind !== "live") throw new Error("Expected the original live Entry");
      expect(new TextDecoder().decode(await service.readHistoricalRevision(entry.entryId, entry.history![0]!.revisionId))).toBe("local article");
      expect(await cache.load()).toBeUndefined();
    });

    it.each(["missing-entry", "missing-revision"])("rejects an unavailable backup (%s) with a readable error", async missing => {
      const {service, remote} = await setup();
      const snapshot = await remote.readSnapshot((await remote.readHead())!.value);
      const entry = Object.values(snapshot.entries).find(value => value.path === "article.md")!;
      await expect(service.readHistoricalRevision(missing === "missing-entry" ? "missing" : entry.entryId, "missing"))
        .rejects.toThrow("这个历史版本已不可用");
    });

    it("refuses expired or corrupted backup previews and restores", async () => {
      const {service, remote, local, objects} = await setup();
      const review = await service.reviewLocalContent("article.md");
      await service.resolveLocalContent("article.md", review.reviewToken, "remote");
      const head = (await remote.readHead())!;
      const snapshot = await remote.readSnapshot(head.value);
      const entry = Object.values(snapshot.entries).find(value => value.path === "article.md");
      if (entry?.kind !== "live") throw new Error("Expected a live Entry");
      const backup = entry.history![0]!;
      objects.onGet = key => { if (key.includes(backup.blobId)) throw new Error("Network unavailable"); };
      await expect(service.readHistoricalRevision(entry.entryId, backup.revisionId)).rejects.toThrow("Network unavailable");
      objects.onGet = undefined;
      const key = (await objects.list("test/")).find(key => key.includes("/blobs/") && key.endsWith(backup.blobId))!;
      const stored = (await objects.get(key))!;
      await objects.put(key, new Uint8Array([1, 2, 3]));
      await expect(service.readHistoricalRevision(entry.entryId, backup.revisionId)).rejects.toThrow();
      await expect(service.restoreRevision(entry.entryId, backup.revisionId)).rejects.toThrow();
      expect(local.readText("article.md")).toBe("remote article");
      await objects.put(key, stored.body);
      const expired = {...entry, history: [{...backup, expiresAt: "2026-09-04T00:00:00.000Z"}]};
      const commitId = "expired-backup-test";
      await remote.advance({expectedHeadEtag: head.etag, head: {...head.value, commitId},
        commit: {commitId, vaultId: snapshot.vaultId, protocolVersion: 1, createdAt: head.serverDate,
          parentIds: [head.value.commitId], replicaId: "test", changes: [{kind: "set-entry", entry: expired}]}});
      await expect(service.readHistoricalRevision(entry.entryId, backup.revisionId)).rejects.toThrow("已过期");
      await expect(service.restoreRevision(entry.entryId, backup.revisionId)).rejects.toThrow("已过期");
      expect(local.readText("article.md")).toBe("remote article");
    });

    it("keeps unrelated Import Candidates unapproved through reviews, imports and restart", async () => {
      const {service, remote, local, cache} = await setup();
      await local.write("private-unreviewed.md", new TextEncoder().encode("needs explicit import"));
      const review = await service.reviewLocalContent("article.md");
      await service.preserveLocalCopyAndAcceptRemote("article.md", review.reviewToken);
      cache.state = structuredClone(cache.state);
      const restarted = new SyncService({remote, local, cache, replicaId: "restarted"});
      await local.move("private-unreviewed.md", "renamed-unreviewed.md");
      let result = await restarted.synchronize();
      expect(result.localIssues).toContainEqual({kind: "import-candidate", path: "renamed-unreviewed.md"});
      let snapshot = await remote.readSnapshot((await remote.readHead())!.value);
      expect(Object.values(snapshot.entries).some(entry => entry.path === "renamed-unreviewed.md")).toBe(false);
      await restarted.importCandidate("renamed-unreviewed.md");
      result = await restarted.synchronize();
      expect(result.localIssues).toEqual([{kind: "bootstrap-mismatch", path: "unreviewed.md"}]);
      expect(local.readText("unreviewed.md")).toBe("local other");
      const other = await restarted.reviewLocalContent("unreviewed.md");
      await restarted.preserveLocalCopyAndAcceptRemote("unreviewed.md", other.reviewToken);
      expect((await restarted.synchronize()).status).toBe("complete");
      await local.write("created-after-bootstrap.md", new TextEncoder().encode("ordinary new file"));
      expect((await restarted.synchronize()).status).toBe("complete");
      snapshot = await remote.readSnapshot((await remote.readHead())!.value);
      expect(Object.values(snapshot.entries).some(entry => entry.path === "created-after-bootstrap.md")).toBe(true);
    });

    it("does not accept other local files when Import is the first manual bootstrap action", async () => {
      const {service, local} = await setup();
      await local.write("first-import.md", new TextEncoder().encode("approved"));
      await local.write("second-import.md", new TextEncoder().encode("not approved"));
      await service.importCandidate("first-import.md");
      const result = await service.synchronize();
      expect(result.localIssues).toContainEqual({kind: "import-candidate", path: "second-import.md"});
      expect(result.localIssues).toContainEqual({kind: "bootstrap-mismatch", path: "article.md"});
      expect(result.uploaded).toBe(0);
    });

    it("does not upload an unreviewed local-only file after the only content mismatch is resolved", async () => {
      const {service, local, remote, cache} = await setup();
      await local.write("unreviewed.md", new TextEncoder().encode("remote other"));
      await local.write("private-unreviewed.md", new TextEncoder().encode("never approved"));
      const review = await service.reviewLocalContent("article.md");
      await service.preserveLocalCopyAndAcceptRemote("article.md", review.reviewToken);
      cache.state = structuredClone(cache.state);
      const restarted = new SyncService({remote, local, cache, replicaId: "restarted"});
      const result = await restarted.synchronize();
      expect(result.localIssues).toEqual([{kind: "import-candidate", path: "private-unreviewed.md"}]);
      expect(result.uploaded).toBe(0);
      const snapshot = await remote.readSnapshot((await remote.readHead())!.value);
      expect(Object.values(snapshot.entries).some(entry => entry.path === "private-unreviewed.md")).toBe(false);
    });

    it("retains bootstrap confirmation for a local-only file discovered during final cache rebuilding", async () => {
      const {service, local, cache} = await setup();
      await local.write("article.md", new TextEncoder().encode("remote article"));
      await local.write("unreviewed.md", new TextEncoder().encode("remote other"));
      const list = local.list.bind(local);
      let lists = 0;
      local.list = async () => {
        if (++lists === 2) await local.write("late-local-file.md", new TextEncoder().encode("unreviewed"));
        return list();
      };
      expect((await service.synchronize()).status).toBe("complete");
      expect(cache.state?.bootstrapPending).toBe(true);
      expect((await service.synchronize()).localIssues).toEqual([{kind: "import-candidate", path: "late-local-file.md"}]);
    });

    it.each(["forward", "reverse", "reverse-old-content"])("reviews the current owner of a reused path without removing its historical tombstone (%s)", async order => {
      const {remote, source, sourceService, sourceCache} = await setup(order.startsWith("reverse"));
      const deletedId = sourceCache.state!.files["article.md"]!.entryId;
      await source.delete("article.md");
      const deletion = await sourceService.synchronize();
      await sourceService.synchronize(deletion.bulkDeletion!.entryIds);
      const ownerId = sourceCache.state!.files["unreviewed.md"]!.entryId;
      await source.move("unreviewed.md", "article.md");
      await sourceService.synchronize([], {pathRenames: new Map([
        ["unreviewed.md", {entryId: ownerId, toPath: "article.md"}],
      ])});
      const local = new MemoryVault();
      const draft = order === "reverse-old-content" ? "remote article" : "new device draft";
      await local.write("article.md", new TextEncoder().encode(draft));
      const service = new SyncService({remote, local, cache: new MemorySyncCache(), replicaId: "new-device"});
      expect((await service.synchronize()).localIssues).toContainEqual({kind: "bootstrap-mismatch", path: "article.md"});
      const review = await service.reviewLocalContent("article.md");
      expect(review.remoteVersions[0]?.preview).toBe("remote other");
      const copyPath = await service.resolveLocalContent("article.md", review.reviewToken, "both");
      expect(local.readText(copyPath!)).toBe(draft);
      expect(local.readText("article.md")).toBe("remote other");
      const snapshot = await remote.readSnapshot((await remote.readHead())!.value);
      expect(snapshot.entries[deletedId]!.kind).toBe("deleted");
      expect(snapshot.entries[ownerId]!).toMatchObject({kind: "live", path: "article.md"});
      expect((await service.synchronize()).status).toBe("complete");
    });

    it.each([
      "a".repeat(240) + ".md",
      "文".repeat(75) + ".md",
      "😀".repeat(60) + ".md",
      "a." + "b".repeat(250),
      "c".repeat(255),
    ])("preserves a platform-safe local copy of a long filename (%#)", async name => {
      const remote = await RemoteStore.open({objects: new MemoryObjectStore(), prefix: "test", vaultKey: new Uint8Array(32)});
      const source = new MemoryVault();
      const path = `folder/${name}`;
      await source.write(path, new TextEncoder().encode("remote long-name content"));
      await new SyncService({remote, local: source, cache: new MemorySyncCache(), replicaId: "source"}).initializeNew("vault");
      const local = new MemoryVault();
      const write = local.write.bind(local);
      local.write = async (filePath, body) => {
        if (new TextEncoder().encode(filePath.split("/").at(-1)).byteLength > 255) throw new Error("ENAMETOOLONG");
        return write(filePath, body);
      };
      await local.write(path, new TextEncoder().encode("local long-name content"));
      const service = new SyncService({remote, local, cache: new MemorySyncCache(), replicaId: "new"});
      const review = await service.reviewLocalContent(path);
      const copyPath = await service.preserveLocalCopyAndAcceptRemote(path, review.reviewToken);
      expect(copyPath).toMatch(/^folder\//);
      expect(new TextEncoder().encode(copyPath!.split("/").at(-1)).byteLength).toBeLessThanOrEqual(255);
      if (name.endsWith(".md")) expect(copyPath).toMatch(/\.md$/);
      expect(local.readText(copyPath!)).toBe("local long-name content");
      expect(local.readText(path)).toBe("remote long-name content");
    });

    it("retains BOM and line endings in authenticated previews without writing either version", async () => {
      const {service, remote, local, source, sourceService, cache} = await setup();
      const remoteText = "\uFEFFremote\r\narticle\r\n";
      const localText = "\uFEFFlocal\narticle  \n";
      await source.write("article.md", new TextEncoder().encode(remoteText));
      await sourceService.synchronize();
      await local.write("article.md", new TextEncoder().encode(localText));
      const head = await remote.readHead();
      const cached = await cache.load();
      const files = await local.list();
      const review = await service.reviewLocalContent("article.md");
      expect(review.localPreview).toBe(localText);
      expect(review.localModifiedAt).toBe((await local.stat("article.md"))!.modifiedAt);
      expect(review.remoteVersions[0]?.preview).toBe(remoteText);
      expect(await remote.readHead()).toEqual(head);
      expect(await cache.load()).toEqual(cached);
      expect(await local.list()).toEqual(files);
      expect(await local.read("article.md")).toEqual(new TextEncoder().encode(localText));
    });

    it("preserves a verified local copy before accepting remote and leaves other mismatches blocked", async () => {
      const {service, remote, local} = await setup();
      expect((await service.synchronize()).localIssues).toHaveLength(2);
      const review = await service.reviewLocalContent("article.md");
      expect(review.localPreview).toBe("local article");
      expect(review.remoteVersions[0]?.preview).toBe("remote article");
      const copyPath = await service.preserveLocalCopyAndAcceptRemote("article.md", review.reviewToken);
      expect(copyPath).toMatch(/^article \(local copy .+\)\.md$/);
      expect(local.readText(copyPath!)).toBe("local article");
      expect(local.readText("article.md")).toBe("remote article");
      const snapshot = await remote.readSnapshot((await remote.readHead())!.value);
      const copy = Object.values(snapshot.entries).find(entry => entry.path === copyPath);
      if (copy?.kind !== "live") throw new Error("Local copy was not published");
      expect(new TextDecoder().decode(await remote.readBlob(copy.revision.blobId))).toBe("local article");
      const next = await service.synchronize();
      expect(next.localIssues).toEqual([{kind: "bootstrap-mismatch", path: "unreviewed.md"}]);
      expect(local.readText("unreviewed.md")).toBe("local other");
      const otherReview = await service.reviewLocalContent("unreviewed.md");
      await service.preserveLocalCopyAndAcceptRemote("unreviewed.md", otherReview.reviewToken);
      expect((await service.synchronize()).status).toBe("complete");
      expect((await service.synchronize()).uploaded).toBe(0);
    });

    it.each(["local", "remote"])("rejects the decision if %s content changed after preview", async side => {
      const {service, remote, local, source, sourceService} = await setup();
      const review = await service.reviewLocalContent("article.md");
      if (side === "local") await local.write("article.md", new TextEncoder().encode("new draft"));
      else {
        await source.write("article.md", new TextEncoder().encode("new remote"));
        await sourceService.synchronize();
      }
      const before = (await remote.readHead())!.value.commitId;
      await expect(service.preserveLocalCopyAndAcceptRemote("article.md", review.reviewToken))
        .rejects.toThrow("有变化。请重新审查");
      expect((await remote.readHead())!.value.commitId).toBe(before);
      expect((await local.list()).length).toBe(2);
      expect(local.readText("article.md")).toBe(side === "local" ? "new draft" : "local article");
    });

    it("keeps the original local bytes when uploaded preservation content is corrupt", async () => {
      const {service, remote, local, objects} = await setup();
      const review = await service.reviewLocalContent("article.md");
      objects.corruptNextBlobPut = true;
      const before = (await remote.readHead())!.value.commitId;
      await expect(service.preserveLocalCopyAndAcceptRemote("article.md", review.reviewToken)).rejects.toThrow();
      expect(local.readText("article.md")).toBe("local article");
      expect((await remote.readHead())!.value.commitId).toBe(before);
      expect((await local.list()).length).toBe(3); // The independent local copy is also retained.
    });

    it("stops if the original is edited during upload without overwriting the draft", async () => {
      const {service, local, objects} = await setup();
      const review = await service.reviewLocalContent("article.md");
      objects.onPut = async key => {
        if (!key.includes("/blobs/")) return;
        objects.onPut = undefined;
        await local.write("article.md", new TextEncoder().encode("typing during upload"));
      };
      await expect(service.preserveLocalCopyAndAcceptRemote("article.md", review.reviewToken)).rejects.toThrow("被改动");
      expect(local.readText("article.md")).toBe("typing during upload");
    });

    it("does not accept an unrelated remote update into an existing file's base", async () => {
      const {service, local, cache, sourceCache, source, sourceService} = await setup();
      cache.state = structuredClone(sourceCache.state);
      await local.write("unreviewed.md", new TextEncoder().encode("remote other"));
      await source.write("unreviewed.md", new TextEncoder().encode("remote updated while reviewing"));
      await sourceService.synchronize();
      const priorBase = cache.state!.snapshot.entries;
      const review = await service.reviewLocalContent("article.md");
      await service.preserveLocalCopyAndAcceptRemote("article.md", review.reviewToken);
      const other = Object.values(priorBase).find(entry => entry.path === "unreviewed.md")!;
      expect(cache.state!.snapshot.entries[other.entryId]).toEqual(other);
      await service.synchronize();
      expect(local.readText("unreviewed.md")).toBe("remote updated while reviewing");
    });

    it("reports mobile limits without reading oversized local or remote content", async () => {
      const {remote, local} = await setup();
      const service = new SyncService({remote, local, cache: new MemorySyncCache(), replicaId: "phone", maxAutomaticFileBytes: 5});
      const reads = local.readCount;
      const review = await service.reviewLocalContent("article.md");
      expect(review.blockedReason).toContain("本设备的传输限制");
      expect(local.readCount).toBe(reads);
      for (const choice of ["local", "remote", "both"] as const) {
        await expect(service.resolveLocalContent("article.md", review.reviewToken, choice)).rejects.toThrow("本设备的传输限制");
      }
    });

    it("keeps the original draft after a concurrent remote commit wins the Head race", async () => {
      const {service, remote, local, objects, source, sourceService} = await setup();
      const review = await service.reviewLocalContent("article.md");
      objects.onPut = async key => {
        if (!key.includes("/blobs/")) return;
        objects.onPut = undefined;
        await source.write("article.md", new TextEncoder().encode("another device edited during backup"));
        await sourceService.synchronize();
      };
      await expect(service.preserveLocalCopyAndAcceptRemote("article.md", review.reviewToken)).rejects.toThrow("Head 指针被改了");
      expect(local.readText("article.md")).toBe("local article");
      const snapshot = await remote.readSnapshot((await remote.readHead())!.value);
      const original = Object.values(snapshot.entries).find(entry => entry.path === "article.md");
      if (original?.kind !== "live") throw new Error("Expected remote file");
      expect(new TextDecoder().decode(await remote.readBlob(original.revision.blobId)))
        .toBe("another device edited during backup");
    });

    it("preserves a local copy without resurrecting the deleted remote Entry", async () => {
      const {service, remote, local, source, sourceService} = await setup();
      await source.delete("article.md");
      const deletion = await sourceService.synchronize();
      await sourceService.synchronize(deletion.bulkDeletion!.entryIds);
      const review = await service.reviewLocalContent("article.md");
      expect(review.remoteKind).toBe("deleted");
      const copyPath = await service.preserveLocalCopyAndAcceptRemote("article.md", review.reviewToken);
      expect(local.readText("article.md")).toBeUndefined();
      expect(local.readText(copyPath!)).toBe("local article");
      const snapshot = await remote.readSnapshot((await remote.readHead())!.value);
      expect(Object.values(snapshot.entries).find(entry => entry.path === "article.md")?.kind).toBe("deleted");
      expect(Object.values(snapshot.entries).find(entry => entry.path === copyPath)?.kind).toBe("live");
    });

    it("preserves additional edits made while an existing conflict is waiting", async () => {
      const {service, remote, local, cache, sourceCache, source, sourceService} = await setup();
      cache.state = structuredClone(sourceCache.state);
      await source.write("article.md", new TextEncoder().encode("concurrent remote edit"));
      await sourceService.synchronize();
      await service.synchronize();
      const before = Object.values(cache.state!.snapshot.entries).find(entry => entry.path === "article.md");
      if (before?.kind !== "conflicted") throw new Error("Expected edit/edit conflict");
      const previewHead = (await remote.readHead())!.value.commitId;
      const previews = await Promise.all(before.candidates.map(async revision =>
        new TextDecoder().decode(await service.readConflictCandidate(before.entryId, revision.revisionId)),
      ));
      expect(previews).toContain("local article");
      expect(previews).toContain("concurrent remote edit");
      expect((await remote.readHead())!.value.commitId).toBe(previewHead);
      await expect(service.readConflictCandidate(before.entryId, "missing-candidate")).rejects.toThrow("已不是冲突候选版本");
      await local.write("article.md", new TextEncoder().encode("extra local edits during conflict"));
      expect((await service.synchronize()).localIssues).toContainEqual({kind: "resolution-mismatch", path: "article.md"});
      const review = await service.reviewLocalContent("article.md");
      expect(review.remoteKind).toBe("conflicted");
      const copyPath = await service.preserveLocalCopyAndAcceptRemote("article.md", review.reviewToken);
      expect(local.readText(copyPath!)).toBe("extra local edits during conflict");
      const snapshot = await remote.readSnapshot((await remote.readHead())!.value);
      expect(snapshot.entries[before.entryId]).toEqual(before);
      expect((await service.synchronize()).localIssues.some(issue => issue.kind === "resolution-mismatch")).toBe(false);
    });

    it("can receive a reviewed remote file when the local file was removed", async () => {
      const {service, local} = await setup();
      await local.delete("article.md");
      const review = await service.reviewLocalContent("article.md");
      expect(review.localExists).toBe(false);
      expect(await service.preserveLocalCopyAndAcceptRemote("article.md", review.reviewToken)).toBeUndefined();
      expect(local.readText("article.md")).toBe("remote article");
    });
  });

  it("does not bind a cache-loss mismatch to an oversized remote Entry", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("remote content above limit"),
    );
    await new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote,
      replicaId: "desktop",
    }).initializeNew("vault-1");
    const local = new MemoryVault();
    await local.write("notes/example.md", new TextEncoder().encode("local"));
    const cache = new MemorySyncCache();
    const limited = new SyncService({
      cache,
      local,
      maxAutomaticFileBytes: 10,
      remote,
      replicaId: "reinstalled-phone",
    });

    const first = await limited.synchronize();

    expect(first.localIssues).toContainEqual({
      kind: "bootstrap-mismatch",
      path: "notes/example.md",
    });
    expect(first.uploaded).toBe(0);
    expect(cache.state).toBeUndefined();
    const unlimited = new SyncService({
      cache,
      local,
      remote,
      replicaId: "reinstalled-phone",
    });
    const second = await unlimited.synchronize();
    expect(second.localIssues).toContainEqual({
      kind: "bootstrap-mismatch",
      path: "notes/example.md",
    });
    expect(local.readText("notes/example.md")).toBe("local");
    expect((await remote.readHead())?.value.generation).toBe(1);
  });

  it("does not bind a draft created at an unmaterialized deferred path", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("remote content above limit"),
    );
    await new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote,
      replicaId: "desktop",
    }).initializeNew("vault-1");
    const local = new MemoryVault();
    const cache = new MemorySyncCache();
    const limited = new SyncService({
      cache,
      local,
      maxAutomaticFileBytes: 10,
      remote,
      replicaId: "phone",
    });
    const deferred = await limited.synchronize();
    expect(deferred.deferredDownloads).toBe(1);
    expect(cache.state?.unmaterializedEntryIds).toHaveLength(1);
    await local.write("notes/example.md", new TextEncoder().encode("draft"));

    const result = await limited.synchronize();

    expect(result.status).toBe("action-required");
    expect(result.localIssues).toContainEqual({
      kind: "bootstrap-mismatch",
      path: "notes/example.md",
    });
    expect(local.readText("notes/example.md")).toBe("draft");
    expect((await remote.readHead())?.value.generation).toBe(1);
  });

  it("does not overwrite an oversized local file after cache loss", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("remote"),
    );
    await new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote,
      replicaId: "desktop",
    }).initializeNew("vault-1");
    const phoneVault = new MemoryVault();
    await phoneVault.write(
      "notes/example.md",
      new TextEncoder().encode("local content above limit"),
    );
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      maxAutomaticFileBytes: 10,
      remote,
      replicaId: "reinstalled-phone",
    });

    const first = await phone.synchronize();
    const second = await phone.synchronize();

    expect(first).toMatchObject({ status: "action-required", uploaded: 0 });
    expect(second).toMatchObject({ status: "action-required", uploaded: 0 });
    expect(phoneVault.readText("notes/example.md")).toBe(
      "local content above limit",
    );
    expect((await remote.readHead())?.value.generation).toBe(1);
  });

  it("defers an oversized remote update when an older local file exists", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopVault = new MemoryVault();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("small"),
    );
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: await RemoteStore.open({
        objects,
        prefix: "chosen-prefix",
        vaultKey,
      }),
      replicaId: "desktop",
    });
    await desktop.initializeNew("vault-1");
    const phoneVault = new MemoryVault();
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      maxAutomaticFileBytes: 10,
      remote: await RemoteStore.open({
        objects,
        prefix: "chosen-prefix",
        vaultKey,
      }),
      replicaId: "phone",
    });
    await phone.synchronize();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("remote content above limit"),
    );
    await desktop.synchronize();

    const result = await phone.synchronize();

    expect(result).toMatchObject({ deferredDownloads: 1, downloaded: 0 });
    expect(phoneVault.readText("notes/example.md")).toBe("small");
    const deferred = result.deferredDownloadEntries[0];
    if (!deferred) {
      throw new Error("Expected deferred remote update");
    }

    await phone.downloadDeferred(deferred.entryId);

    expect(phoneVault.readText("notes/example.md")).toBe(
      "remote content above limit",
    );
  });

  it("downloads a deferred remote update after the device limit is raised", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopVault = new MemoryVault();
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("small"),
    );
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    });
    await desktop.initializeNew("vault-1");
    const phoneVault = new MemoryVault();
    const phoneCache = new MemorySyncCache();
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const limitedPhone = new SyncService({
      cache: phoneCache,
      local: phoneVault,
      maxAutomaticFileBytes: 10,
      remote: phoneRemote,
      replicaId: "phone",
    });
    await limitedPhone.synchronize();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("remote content above limit"),
    );
    await desktop.synchronize();
    const deferred = await limitedPhone.synchronize();
    expect(deferred).toMatchObject({ deferredDownloads: 1, downloaded: 0 });
    expect(phoneVault.readText("notes/example.md")).toBe("small");
    const generationBefore = (await phoneRemote.readHead())?.value.generation;
    const unlimitedPhone = new SyncService({
      cache: phoneCache,
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });

    const resumed = await unlimitedPhone.synchronize();

    expect(resumed).toMatchObject({ downloaded: 1, uploaded: 0 });
    expect(phoneVault.readText("notes/example.md")).toBe(
      "remote content above limit",
    );
    expect((await phoneRemote.readHead())?.value.generation).toBe(
      generationBefore,
    );
  });

  it("conflicts instead of rolling back a remote update edited while deferred", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopVault = new MemoryVault();
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    await desktopVault.write("notes/example.md", new TextEncoder().encode("small"));
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    });
    await desktop.initializeNew("vault-1");
    const phoneVault = new MemoryVault();
    const phoneCache = new MemorySyncCache();
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const limitedPhone = new SyncService({
      cache: phoneCache,
      local: phoneVault,
      maxAutomaticFileBytes: 10,
      remote: phoneRemote,
      replicaId: "phone",
    });
    await limitedPhone.synchronize();
    const acceptedLocalHash =
      phoneCache.state?.files["notes/example.md"]?.contentHash;
    if (!acceptedLocalHash) {
      throw new Error("Expected initial phone cache");
    }
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("remote content above limit"),
    );
    await desktop.synchronize();
    await limitedPhone.synchronize();
    await phoneVault.write(
      "notes/example.md",
      new TextEncoder().encode("phone edit"),
    );
    const editedWhileDeferred = await limitedPhone.synchronize();
    expect(editedWhileDeferred.status).toBe("action-required");
    expect(editedWhileDeferred.localIssues).toContainEqual({
      kind: "deferred-local-edit",
      path: "notes/example.md",
    });
    expect(phoneCache.state?.files["notes/example.md"]?.contentHash).toBe(
      acceptedLocalHash,
    );
    expect(phoneCache.state?.unmaterializedEntryIds).toHaveLength(1);
    const unlimitedPhone = new SyncService({
      cache: phoneCache,
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });

    const result = await unlimitedPhone.synchronize();

    expect(result.status).toBe("action-required");
    const head = await phoneRemote.readHead();
    if (!head) {
      throw new Error("Expected Conflict Head");
    }
    const snapshot = await phoneRemote.readSnapshot(head.value);
    const entry = Object.values(snapshot.entries)[0];
    if (entry?.kind !== "conflicted") {
      throw new Error("Expected deferred edit Conflict");
    }
    const candidateContents = await Promise.all(
      entry.candidates.map(async (candidate) => {
        const body = await phoneRemote.readBlob(candidate.blobId);
        return body ? new TextDecoder().decode(body) : "missing";
      }),
    );
    expect(candidateContents.sort()).toEqual([
      "phone edit",
      "remote content above limit",
    ]);
  });

  it("keeps a renamed deferred Entry tied to its old local materialization", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopVault = new MemoryVault();
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    await desktopVault.write("notes/old.md", new TextEncoder().encode("small"));
    const desktopCache = new MemorySyncCache();
    const desktop = new SyncService({
      cache: desktopCache,
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    });
    await desktop.initializeNew("vault-1");
    const phoneVault = new MemoryVault();
    const phoneCache = new MemorySyncCache();
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const limitedPhone = new SyncService({
      cache: phoneCache,
      local: phoneVault,
      maxAutomaticFileBytes: 10,
      remote: phoneRemote,
      replicaId: "phone",
    });
    await limitedPhone.synchronize();
    await desktopVault.move("notes/old.md", "notes/renamed.md");
    const cachedOld = desktopCache.state?.files["notes/old.md"];
    if (!desktopCache.state || !cachedOld) {
      throw new Error("Expected desktop rename cache");
    }
    delete desktopCache.state.files["notes/old.md"];
    desktopCache.state.files["notes/renamed.md"] = {
      ...cachedOld,
      path: "notes/renamed.md",
    };
    await desktopVault.write(
      "notes/renamed.md",
      new TextEncoder().encode("renamed remote content above limit"),
    );
    await desktop.synchronize();
    const renamedHead = await desktopRemote.readHead();
    if (!renamedHead) {
      throw new Error("Expected renamed Head");
    }
    const renamedSnapshot = await desktopRemote.readSnapshot(renamedHead.value);
    expect(Object.values(renamedSnapshot.entries)[0]).toMatchObject({
      kind: "live",
      path: "notes/renamed.md",
      revision: { size: 34 },
    });

    const first = await limitedPhone.synchronize();
    const generation = (await phoneRemote.readHead())?.value.generation;
    const second = await limitedPhone.synchronize();

    expect(first.deferredDownloads).toBe(1);
    expect(second).toMatchObject({ downloaded: 0, uploaded: 0 });
    expect((await phoneRemote.readHead())?.value.generation).toBe(generation);
    expect(phoneVault.readText("notes/old.md")).toBe("small");
    const unlimitedPhone = new SyncService({
      cache: phoneCache,
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });

    const resumed = await unlimitedPhone.synchronize();

    expect(resumed).toMatchObject({ downloaded: 1, uploaded: 0 });
    expect(phoneVault.readText("notes/old.md")).toBeUndefined();
    expect(phoneVault.readText("notes/renamed.md")).toBe(
      "renamed remote content above limit",
    );
  });

  it("updates an already-synced Replica after another Replica edits a file", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopVault = new MemoryVault();
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: await RemoteStore.open({
        objects,
        prefix: "chosen-prefix",
        vaultKey,
      }),
      replicaId: "desktop",
    });
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("first version"),
    );
    await desktop.initializeNew("vault-1");

    const phoneVault = new MemoryVault();
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      remote: await RemoteStore.open({
        objects,
        prefix: "chosen-prefix",
        vaultKey,
      }),
      replicaId: "phone",
    });
    await phone.synchronize();
    expect(phoneVault.readText("notes/example.md")).toBe("first version");

    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("second version"),
    );
    await desktop.synchronize();
    const result = await phone.synchronize();

    expect(result).toMatchObject({ downloaded: 1, status: "complete" });
    expect(phoneVault.readText("notes/example.md")).toBe("second version");
  });

  it("does not overwrite an edit made while a remote Revision is downloading", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopVault = new MemoryVault();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("first version"),
    );
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: await RemoteStore.open({
        objects,
        prefix: "chosen-prefix",
        vaultKey,
      }),
      replicaId: "desktop",
    });
    await desktop.initializeNew("vault-1");
    const phoneVault = new MemoryVault();
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });
    await phone.synchronize();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("second version"),
    );
    await desktop.synchronize();
    objects.onGet = async (key) => {
      if (key.includes("/blobs/")) {
        objects.onGet = undefined;
        await phoneVault.write(
          "notes/example.md",
          new TextEncoder().encode("edit made during download"),
        );
      }
    };

    await expect(phone.synchronize()).rejects.toThrow(
      "同步过程中本地文件被改动：notes/example.md",
    );

    expect(phoneVault.readText("notes/example.md")).toBe(
      "edit made during download",
    );
  });

  it("publishes an edit requested while the previous sync is still completing", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopVault = new MemoryVault();
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: await RemoteStore.open({
        objects,
        prefix: "chosen-prefix",
        vaultKey,
      }),
      replicaId: "desktop",
    });
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("first version"),
    );
    await desktop.initializeNew("vault-1");

    const phoneVault = new MemoryVault();
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      remote: await RemoteStore.open({
        objects,
        prefix: "chosen-prefix",
        vaultKey,
      }),
      replicaId: "phone",
    });
    await phone.synchronize();

    let markFirstRunComplete: (() => void) | undefined;
    const firstRunComplete = new Promise<void>((resolve) => {
      markFirstRunComplete = resolve;
    });
    let releaseFirstRun: (() => void) | undefined;
    const firstRunGate = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    let runCount = 0;
    const queue = new SyncRequestQueue(async () => {
      await desktop.synchronize();
      runCount += 1;
      if (runCount === 1) {
        markFirstRunComplete?.();
        await firstRunGate;
      }
    });

    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("second version"),
    );
    const firstRequest = queue.request();
    await firstRunComplete;
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("third version"),
    );
    const secondRequest = queue.request();
    releaseFirstRun?.();
    await Promise.all([firstRequest, secondRequest]);
    const phoneResult = await phone.synchronize();

    expect(runCount).toBe(2);
    expect(phoneResult).toMatchObject({ downloaded: 1, status: "complete" });
    expect(phoneVault.readText("notes/example.md")).toBe("third version");
  });

  it("propagates a permanent deletion to a stale Replica without resurrection", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("hello from desktop"),
    );
    const desktopCache = new MemorySyncCache();
    const desktop = new SyncService({
      cache: desktopCache,
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    });
    await desktop.initializeNew("vault-1");

    const phoneVault = new MemoryVault();
    const phoneCache = new MemorySyncCache();
    const phone = new SyncService({
      cache: phoneCache,
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });
    await phone.synchronize();
    await desktopVault.delete("notes/example.md");

    await desktop.synchronize(await currentLiveEntryIds(desktopRemote));
    phoneCache.state = undefined;
    const phoneResult = await phone.synchronize();

    expect(phoneResult).toMatchObject({ deleted: 1, status: "complete" });
    expect(phoneVault.readText("notes/example.md")).toBeUndefined();
    const currentHead = await phoneRemote.readHead();
    if (!currentHead) {
      throw new Error("Expected initialized Head");
    }
    const current = await phoneRemote.readSnapshot(currentHead.value);
    expect(Object.values(current.entries)).toEqual([
      expect.objectContaining({ kind: "deleted", path: "notes/example.md" }),
    ]);
  });

  it("does not publish a deletion when the local path reappears before Head", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    await local.write("notes/example.md", new TextEncoder().encode("original"));
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      remote,
      replicaId: "desktop",
    });
    await service.initializeNew("vault-1");
    const initialHead = await remote.readHead();
    if (!initialHead) {
      throw new Error("Expected initialized Head");
    }
    const entryIds = await currentLiveEntryIds(remote);
    await local.delete("notes/example.md");
    objects.onGet = async (key) => {
      if (key.includes("/blobs/")) {
        objects.onGet = undefined;
        await local.write(
          "notes/example.md",
          new TextEncoder().encode("recreated draft"),
        );
      }
    };

    await expect(service.synchronize(entryIds)).rejects.toThrow(
      "同步过程中本地文件被改动",
    );

    expect(local.readText("notes/example.md")).toBe("recreated draft");
    await expect(remote.readHead()).resolves.toMatchObject({
      value: { commitId: initialHead.value.commitId },
    });
  });

  it("does not delete an edit made after the deletion plan was scanned", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopVault = new MemoryVault();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("original"),
    );
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    });
    await desktop.initializeNew("vault-1");
    const phoneVault = new MemoryVault();
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });
    await phone.synchronize();
    await desktopVault.delete("notes/example.md");
    await desktop.synchronize(await currentLiveEntryIds(desktopRemote));
    phoneVault.beforeStat = async (path) => {
      phoneVault.beforeStat = undefined;
      await phoneVault.write(
        path,
        new TextEncoder().encode("edit made before delete"),
      );
    };

    await expect(phone.synchronize()).rejects.toThrow(
      "同步过程中本地文件被改动：notes/example.md",
    );

    expect(phoneVault.readText("notes/example.md")).toBe(
      "edit made before delete",
    );
  });

  it("does not delete the local copy when remote recovery is damaged", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopVault = new MemoryVault();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("only recoverable copy"),
    );
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    });
    await desktop.initializeNew("vault-1");
    const phoneVault = new MemoryVault();
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });
    await phone.synchronize();
    await desktopVault.delete("notes/example.md");
    await desktop.synchronize(await currentLiveEntryIds(desktopRemote));
    const head = await phoneRemote.readHead();
    if (!head) {
      throw new Error("Expected deleted Head");
    }
    const snapshot = await phoneRemote.readSnapshot(head.value);
    const deleted = Object.values(snapshot.entries)[0];
    if (deleted?.kind !== "deleted" || !deleted.recovery) {
      throw new Error("Expected deleted recovery");
    }
    await objects.delete(
      `chosen-prefix/v1/blobs/${deleted.recovery.blobId}`,
    );

    const synchronization = phone.synchronize();
    await expect(synchronization).rejects.toThrow(
      "仓库快照引用的数据块缺失",
    );
    await expect(synchronization).rejects.toThrow("notes/example.md");

    expect(phoneVault.readText("notes/example.md")).toBe(
      "only recoverable copy",
    );
  });

  it("does not publish when the remote live Revision is corrupted", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    await local.write("notes/example.md", new TextEncoder().encode("before"));
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      remote,
      replicaId: "desktop",
    });
    await service.initializeNew("vault-1");
    const initialHead = await remote.readHead();
    if (!initialHead) {
      throw new Error("Expected initialized Head");
    }
    const initial = await remote.readSnapshot(initialHead.value);
    const entry = Object.values(initial.entries)[0];
    if (entry?.kind !== "live") {
      throw new Error("Expected live Entry");
    }
    const keysBefore = await objects.list("chosen-prefix/v1/");
    await objects.put(
      `chosen-prefix/v1/blobs/${entry.revision.blobId}`,
      new TextEncoder().encode("corrupted ciphertext"),
    );
    await local.write("notes/example.md", new TextEncoder().encode("after"));

    await expect(service.synchronize()).rejects.toThrow(
      "无法核实远端版本",
    );

    await expect(remote.readHead()).resolves.toMatchObject({
      value: { commitId: initialHead.value.commitId },
    });
    expect(await objects.list("chosen-prefix/v1/")).toHaveLength(
      keysBefore.length,
    );
  });

  it("does not overwrite the only good local copy when remote history is corrupted", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    const phoneVault = new MemoryVault();
    await desktopVault.write("notes/example.md", new TextEncoder().encode("v1"));
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    });
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });
    await desktop.initializeNew("vault-1");
    await phone.synchronize();
    const initialHead = await desktopRemote.readHead();
    if (!initialHead) {
      throw new Error("Expected initialized Head");
    }
    const initial = await desktopRemote.readSnapshot(initialHead.value);
    const first = Object.values(initial.entries)[0];
    if (first?.kind !== "live") {
      throw new Error("Expected first live Revision");
    }
    await desktopVault.write("notes/example.md", new TextEncoder().encode("v2"));
    await desktop.synchronize();
    await objects.put(
      `chosen-prefix/v1/blobs/${first.revision.blobId}`,
      new TextEncoder().encode("corrupted ciphertext"),
    );

    const synchronization = phone.synchronize();
    await expect(synchronization).rejects.toThrow(
      "在远端没有可核实的恢复副本",
    );
    await expect(synchronization).rejects.toThrow("notes/example.md");
    await expect(synchronization).rejects.toBeInstanceOf(RemoteStateError);

    expect(phoneVault.readText("notes/example.md")).toBe("v1");
  });

  it("reports a recovery read network failure without claiming the copy is missing", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    const phoneVault = new MemoryVault();
    await desktopVault.write("notes/example.md", new TextEncoder().encode("v1"));
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    });
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });
    await desktop.initializeNew("vault-1");
    await phone.synchronize();
    const initialHead = await desktopRemote.readHead();
    if (!initialHead) {
      throw new Error("Expected initialized Head");
    }
    const initial = await desktopRemote.readSnapshot(initialHead.value);
    const first = Object.values(initial.entries)[0];
    if (first?.kind !== "live") {
      throw new Error("Expected first live Revision");
    }
    await desktopVault.write("notes/example.md", new TextEncoder().encode("v2"));
    await desktop.synchronize();
    objects.onGet = (key) => {
      if (key.endsWith(`/blobs/${first.revision.blobId}`)) {
        objects.onGet = undefined;
        throw new Error("temporary recovery read network failure");
      }
    };

    const synchronization = phone.synchronize();
    await expect(synchronization).rejects.toThrow(
      "temporary recovery read network failure",
    );
    await expect(synchronization).rejects.not.toBeInstanceOf(RemoteStateError);

    expect(phoneVault.readText("notes/example.md")).toBe("v1");
  });

  it("retries a draft edited after planning without publishing partial content", async () => {
    const objects = new MemoryObjectStore();
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey: Uint8Array.from({ length: 32 }, (_, index) => index),
    });
    const path = "notes/example.md";
    const local = new MemoryVault();
    const cache = new MemorySyncCache();
    const service = new SyncService({ cache, local, remote, replicaId: "desktop" });
    await local.write(path, new TextEncoder().encode("Original article."));
    await service.initializeNew("vault-1");
    const originalHead = await remote.readHead();
    const originalCache = structuredClone(cache.state);
    await local.write(path, new TextEncoder().encode("A paragraph in progress."));
    objects.onGet = async (key) => {
      if (key.includes("/blobs/")) {
        objects.onGet = undefined;
        await local.write(path, new TextEncoder().encode("A complete paragraph with its final sentence."));
      }
    };

    const synchronization = service.synchronize();
    await expect(synchronization).rejects.toBeInstanceOf(LocalStateChangedError);
    await expect(synchronization).rejects.toMatchObject({
      name: "LocalStateChangedError",
      path,
    });
    expect(await remote.readHead()).toEqual(originalHead);
    expect(cache.state).toEqual(originalCache);
    expect(local.readText(path)).toBe("A complete paragraph with its final sentence.");

    await expect(service.synchronize()).resolves.toMatchObject({ status: "complete", uploaded: 1 });
    const entry = Object.values(cache.state?.snapshot.entries ?? {})[0];
    if (entry?.kind !== "live") throw new Error("Expected live Revision");
    expect(new TextDecoder().decode(await remote.readBlob(entry.revision.blobId))).toBe(
      "A complete paragraph with its final sentence.",
    );
    const acceptedHead = await remote.readHead();
    await expect(service.synchronize()).resolves.toMatchObject({
      status: "complete", uploaded: 0, downloaded: 0,
    });
    expect(await remote.readHead()).toEqual(acceptedHead);
  });

  it("retries typing during conflict preparation and preserves both authors", async () => {
    const objects = new MemoryObjectStore();
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey: Uint8Array.from({ length: 32 }, (_, index) => index),
    });
    const path = "notes/example.md";
    const local = new MemoryVault();
    const cache = new MemorySyncCache();
    const service = new SyncService({ cache, local, remote, replicaId: "desktop" });
    await local.write(path, new TextEncoder().encode("Opening.\n\nClosing.\n"));
    await service.initializeNew("vault-1");
    const otherLocal = new MemoryVault();
    const other = new SyncService({
      cache: new MemorySyncCache(), local: otherLocal, remote, replicaId: "other",
    });
    await other.synchronize();
    await otherLocal.write(path, new TextEncoder().encode("Opening.\n\nClosing from the other device.\n"));
    await other.synchronize();
    const originalHead = await remote.readHead();
    await local.write(path, new TextEncoder().encode("Opening with a draft.\n\nClosing.\n"));
    objects.onGet = async (key) => {
      if (key.includes("/blobs/")) {
        objects.onGet = undefined;
        await local.write(path, new TextEncoder().encode("Opening with the complete paragraph.\n\nClosing.\n"));
      }
    };

    const synchronization = service.synchronize();
    await expect(synchronization).rejects.toBeInstanceOf(LocalStateChangedError);
    await expect(synchronization).rejects.toMatchObject({
      name: "LocalStateChangedError", path,
    });
    expect(await remote.readHead()).toEqual(originalHead);
    expect(local.readText(path)).toBe("Opening with the complete paragraph.\n\nClosing.\n");

    await expect(service.synchronize()).resolves.toMatchObject({ status: "complete" });
    await other.synchronize();
    const merged = "Opening with the complete paragraph.\n\nClosing from the other device.\n";
    expect(local.readText(path)).toBe(merged);
    expect(otherLocal.readText(path)).toBe(merged);
    const acceptedHead = await remote.readHead();
    await expect(service.synchronize()).resolves.toMatchObject({
      status: "complete", uploaded: 0, downloaded: 0,
    });
    expect(await remote.readHead()).toEqual(acceptedHead);
  });

  it("publishes an edit back to historical content made during another file's sync", async () => {
    const objects = new MemoryObjectStore();
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey: Uint8Array.from({ length: 32 }, (_, index) => index),
    });
    const local = new MemoryVault();
    const cache = new MemorySyncCache();
    const service = new SyncService({ cache, local, remote, replicaId: "desktop" });
    await local.write("target.md", new TextEncoder().encode("historical"));
    await local.write("other.md", new TextEncoder().encode("other-v1"));
    await service.initializeNew("vault-1");
    await local.write("target.md", new TextEncoder().encode("remote-current"));
    await service.synchronize();
    await local.write("other.md", new TextEncoder().encode("other-v2"));
    objects.onPut = async (key) => {
      if (key.endsWith("/head")) {
        objects.onPut = undefined;
        await local.write("target.md", new TextEncoder().encode("historical"));
      }
    };
    await service.synchronize();

    await expect(service.synchronize()).resolves.toMatchObject({
      downloaded: 0, uploaded: 1, status: "complete",
    });
    expect(local.readText("target.md")).toBe("historical");
    const replica = new MemoryVault();
    await new SyncService({
      cache: new MemorySyncCache(), local: replica, remote, replicaId: "reader",
    }).synchronize();
    expect(replica.readText("target.md")).toBe("historical");
    expect(replica.readText("other.md")).toBe("other-v2");
  });

  it("publishes a local edit as a new encrypted Revision", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("first version"),
    );
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    });
    await desktop.initializeNew("vault-1");
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("second version"),
    );

    const desktopResult = await desktop.synchronize();
    const phoneVault = new MemoryVault();
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });
    await phone.synchronize();

    expect(desktopResult).toMatchObject({ status: "complete", uploaded: 1 });
    expect(phoneVault.readText("notes/example.md")).toBe("second version");
  });

  it("detects an equal-size edit whose modified time is preserved", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    await local.write("notes/example.md", new TextEncoder().encode("first"));
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      remote,
      replicaId: "desktop",
    });
    await service.initializeNew("vault-1");
    local.writePreservingMetadata(
      "notes/example.md",
      new TextEncoder().encode("other"),
    );

    const result = await service.synchronize();

    expect(result.uploaded).toBe(1);
    expect((await remote.readHead())?.value.generation).toBe(2);
  });

  it("reads only a changed file during an incremental synchronization", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    await local.write("notes/changed.md", new TextEncoder().encode("first"));
    await local.write("notes/unchanged.md", new TextEncoder().encode("stable"));
    const progress: SyncProgress[] = [];
    let yieldCount = 0;
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      onProgress: (update) => progress.push(update),
      remote,
      replicaId: "desktop",
      yieldDuringHashing: () => {
        yieldCount += 1;
        return Promise.resolve();
      },
    });
    await service.initializeNew("vault-1");
    local.readCount = 0;
    local.readPaths.length = 0;
    progress.length = 0;
    yieldCount = 0;
    await local.write("notes/changed.md", new TextEncoder().encode("second"));

    const result = await service.synchronize([], {
      fullHashVerification: false,
    });

    expect(result).toMatchObject({ status: "complete", uploaded: 1 });
    expect(local.readPaths).toEqual([
      "notes/changed.md",
      "notes/changed.md",
    ]);
    expect(progress.filter((update) => update.phase === "hashing").at(-1))
      .toMatchObject({ totalBytes: 6, transferredBytes: 6 });
    expect(yieldCount).toBe(1);
  });

  it("uses a local streaming hash capability instead of reading the whole file", async () => {
    const objects = new MemoryObjectStore();
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey: Uint8Array.from({ length: 32 }, (_, index) => index),
    });
    const local = new StreamingMemoryVault();
    await local.write("notes/example.md", new TextEncoder().encode("example"));
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      remote,
      replicaId: "desktop",
    });

    await service.initializeNew("vault-1");

    expect(local.hashCount).toBe(1);
    expect(local.directReadCount).toBe(1);
  });

  it("accumulates streamed hash progress without double-counting bytes", async () => {
    const objects = new MemoryObjectStore();
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey: Uint8Array.from({ length: 32 }, (_, index) => index),
    });
    const local = new StreamingMemoryVault();
    await local.write("notes/one.md", new TextEncoder().encode("abcd"));
    await local.write("notes/two.md", new TextEncoder().encode("abcdef"));
    const progress: SyncProgress[] = [];
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      onProgress: (update) => progress.push(update),
      remote,
      replicaId: "desktop",
    });

    await service.initializeNew("vault-1");

    const hashing = progress.filter((update) => update.phase === "hashing");
    expect(
      hashing.map(({ completed, transferredBytes }) => ({
        completed,
        transferredBytes,
      })),
    ).toEqual([
      { completed: 0, transferredBytes: 0 },
      { completed: 0, transferredBytes: 0 },
      { completed: 0, transferredBytes: 2 },
      { completed: 0, transferredBytes: 4 },
      { completed: 1, transferredBytes: 4 },
      { completed: 1, transferredBytes: 4 },
      { completed: 1, transferredBytes: 6 },
      { completed: 1, transferredBytes: 8 },
      { completed: 1, transferredBytes: 10 },
      { completed: 2, transferredBytes: 10 },
    ]);
    expect(hashing.at(-1)).toMatchObject({
      completed: 2,
      total: 2,
      totalBytes: 10,
      transferredBytes: 10,
    });
  });

  it("rejects a file changed after streamed hashing before publishing Head", async () => {
    const objects = new MemoryObjectStore();
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey: Uint8Array.from({ length: 32 }, (_, index) => index),
    });
    const local = new StreamingMemoryVault();
    await local.write("notes/example.md", new TextEncoder().encode("before"));
    local.beforeStat = async (path) => {
      local.beforeStat = undefined;
      await local.write(path, new TextEncoder().encode("after!"));
    };
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      remote,
      replicaId: "desktop",
    });

    await expect(service.initializeNew("vault-1")).rejects.toMatchObject({
      path: "notes/example.md",
    } satisfies Partial<LocalStateChangedError>);
    await expect(remote.readHead()).resolves.toBeUndefined();
  });

  it("reuses cached hashes when an incremental metadata scan is unchanged", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    await local.write("notes/one.md", new TextEncoder().encode("one"));
    await local.write("notes/two.md", new TextEncoder().encode("two"));
    let yieldCount = 0;
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      remote,
      replicaId: "desktop",
      yieldDuringHashing: () => {
        yieldCount += 1;
        return Promise.resolve();
      },
    });
    await service.initializeNew("vault-1");
    local.readCount = 0;
    local.readPaths.length = 0;
    yieldCount = 0;

    const result = await service.synchronize([], {
      fullHashVerification: false,
    });

    expect(result).toMatchObject({
      cacheUpdated: true,
      status: "complete",
      uploaded: 0,
    });
    expect(local.readPaths).toEqual([]);
    expect(yieldCount).toBe(0);
  });

  it("does not publish a new Head for a no-op full verification", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    await local.write("notes/example.md", new TextEncoder().encode("stable"));
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      remote,
      replicaId: "desktop",
    });
    await service.initializeNew("vault-1");
    const initialHead = await remote.readHead();

    const result = await service.synchronize([], {
      fullHashVerification: true,
    });

    expect(result).toMatchObject({ status: "complete", uploaded: 0 });
    await expect(remote.readHead()).resolves.toEqual(initialHead);
  });

  it("hashes a dirty path even when its size and modified time are unchanged", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    await local.write("notes/changed.md", new TextEncoder().encode("first"));
    await local.write("notes/unchanged.md", new TextEncoder().encode("stable"));
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      remote,
      replicaId: "desktop",
    });
    await service.initializeNew("vault-1");
    local.readCount = 0;
    local.readPaths.length = 0;
    local.writePreservingMetadata(
      "notes/changed.md",
      new TextEncoder().encode("other"),
    );

    const result = await service.synchronize([], {
      forceHashPaths: new Set(["notes/changed.md"]),
      fullHashVerification: false,
    });

    expect(result).toMatchObject({ status: "complete", uploaded: 1 });
    expect(local.readPaths).toEqual([
      "notes/changed.md",
      "notes/changed.md",
    ]);
  });

  it("reads every eligible file during an explicit full hash verification", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    await local.write("notes/one.md", new TextEncoder().encode("one"));
    await local.write("notes/two.md", new TextEncoder().encode("two"));
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      remote,
      replicaId: "desktop",
    });
    await service.initializeNew("vault-1");
    local.readCount = 0;
    local.readPaths.length = 0;

    await service.synchronize([], { fullHashVerification: true });

    expect(local.readPaths).toEqual(["notes/one.md", "notes/two.md"]);
  });

  it("reuses verified hashes after a full check loses the Head race", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const competingRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    await local.write("notes/changed.md", new TextEncoder().encode("first"));
    await local.write("notes/unchanged.md", new TextEncoder().encode("stable"));
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      remote,
      replicaId: "desktop",
    });
    await service.initializeNew("vault-1");
    local.writePreservingMetadata(
      "notes/changed.md",
      new TextEncoder().encode("other"),
    );
    const competingHead = await competingRemote.readHead();
    if (!competingHead) {
      throw new Error("Expected initialized Head");
    }
    objects.onPut = async (key) => {
      if (!key.includes("/commits/")) {
        return;
      }
      objects.onPut = undefined;
      await competingRemote.advance({
        commit: {
          changes: [],
          commitId: "competing-commit",
          createdAt: competingHead.serverDate,
          parentIds: [competingHead.value.commitId],
          protocolVersion: 1,
          replicaId: "other-device",
          vaultId: competingHead.value.vaultId,
        },
        expectedHeadEtag: competingHead.etag,
        head: {
          commitId: "competing-commit",
          generation: competingHead.value.generation + 1,
          protocolVersion: 1,
          snapshotId: competingHead.value.snapshotId,
          vaultId: competingHead.value.vaultId,
        },
      });
    };
    const retryHashMemo = new Map();

    await expect(
      service.synchronize([], {
        fullHashVerification: true,
        retryHashMemo,
      }),
    ).rejects.toThrow("Head 指针被改了");
    local.readCount = 0;
    local.readPaths.length = 0;

    const result = await service.synchronize([], {
      fullHashVerification: false,
      retryHashMemo,
    });

    expect(result).toMatchObject({ status: "complete", uploaded: 1 });
    expect(local.readPaths).toEqual(["notes/changed.md"]);
    const currentHead = await remote.readHead();
    if (!currentHead) {
      throw new Error("Expected current Head");
    }
    const current = await remote.readSnapshot(currentHead.value);
    const currentEntry = Object.values(current.entries)[0];
    if (currentEntry?.kind !== "live") {
      throw new Error("Expected current live Entry");
    }
    const currentContent = await remote.readBlob(currentEntry.revision.blobId);
    expect(new TextDecoder().decode(currentContent)).toBe("other");
  });

  it("finds a deletion from metadata without rereading unchanged files", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    for (let index = 1; index <= 6; index += 1) {
      await local.write(
        `notes/${index}.md`,
        new TextEncoder().encode(`note ${index}`),
      );
    }
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      remote,
      replicaId: "desktop",
    });
    await service.initializeNew("vault-1");
    local.readCount = 0;
    local.readPaths.length = 0;
    await local.delete("notes/1.md");

    const result = await service.synchronize([], {
      fullHashVerification: false,
    });

    expect(result).toMatchObject({ cacheUpdated: true, status: "complete" });
    expect(local.readPaths).toEqual([]);
    expect((await remote.readHead())?.value.generation).toBe(2);
  });

  it("blocks a remote overwrite when an unreported edit kept identical metadata", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("first"),
    );
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    });
    const phoneVault = new MemoryVault();
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });
    await desktop.initializeNew("vault-1");
    await phone.synchronize();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("newer"),
    );
    await desktop.synchronize();
    phoneVault.writePreservingMetadata(
      "notes/example.md",
      new TextEncoder().encode("draft"),
    );

    await expect(
      phone.synchronize([], { fullHashVerification: false }),
    ).rejects.toMatchObject({ path: "notes/example.md" });

    expect(phoneVault.readText("notes/example.md")).toBe("draft");
  });

  it("restarts before planning when a file event arrives during scanning", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    await local.write("notes/example.md", new TextEncoder().encode("first"));
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      remote,
      replicaId: "desktop",
    });
    await service.initializeNew("vault-1");
    await local.write("notes/example.md", new TextEncoder().encode("second"));

    await expect(
      service.synchronize([], {
        assertLocalObservationCurrent: () => {
          throw new Error("stale local observation");
        },
      }),
    ).rejects.toThrow("stale local observation");

    expect((await remote.readHead())?.value.generation).toBe(1);
  });

  it("hashes a dirty attachment after a temporary device limit is raised", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    await local.write(
      "attachments/example.bin",
      new TextEncoder().encode("aaaaaaaaaaaa"),
    );
    let limit = 20;
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      maxAutomaticFileBytes: () => limit,
      remote,
      replicaId: "phone",
    });
    await service.initializeNew("vault-1");
    local.readCount = 0;
    local.readPaths.length = 0;
    local.writePreservingMetadata(
      "attachments/example.bin",
      new TextEncoder().encode("bbbbbbbbbbbb"),
    );
    const dirtyPath = new Set(["attachments/example.bin"]);
    limit = 10;

    const deferred = await service.synchronize([], {
      forceHashPaths: dirtyPath,
      fullHashVerification: false,
    });

    expect(deferred).toMatchObject({
      cacheUpdated: true,
      localIssues: [
        { kind: "unsynced-local", path: "attachments/example.bin" },
      ],
      status: "action-required",
      uploaded: 0,
    });
    expect(local.readPaths).toEqual([]);

    limit = 20;
    const resumed = await service.synchronize([], {
      forceHashPaths: dirtyPath,
      fullHashVerification: false,
    });

    expect(resumed).toMatchObject({ status: "complete", uploaded: 1 });
    expect(local.readPaths).toEqual([
      "attachments/example.bin",
      "attachments/example.bin",
    ]);
  });

  it("retains a tracked rename while its target exceeds the device limit", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    await local.write(
      "attachments/a.bin",
      new TextEncoder().encode("aaaaaaaaaaaa"),
    );
    const cache = new MemorySyncCache();
    let limit = 20;
    const service = new SyncService({
      cache,
      local,
      maxAutomaticFileBytes: () => limit,
      remote,
      replicaId: "phone",
    });
    await service.initializeNew("vault-1");
    const tracked = cache.state?.files["attachments/a.bin"];
    if (!tracked) {
      throw new Error("Expected cached Entry");
    }
    const pathRenames = new Map([
      [
        "attachments/a.bin",
        { entryId: tracked.entryId, toPath: "attachments/b.bin" },
      ],
    ]);
    await local.move("attachments/a.bin", "attachments/b.bin");
    limit = 10;

    const deferred = await service.synchronize([], {
      fullHashVerification: false,
      pathRenames,
    });

    expect(deferred).toMatchObject({
      status: "action-required",
      uploaded: 0,
    });
    expect(cache.state?.files["attachments/a.bin"]?.entryId).toBe(
      tracked.entryId,
    );
    expect((await remote.readHead())?.value.generation).toBe(1);

    limit = 20;
    const resumed = await service.synchronize([], {
      fullHashVerification: false,
      pathRenames,
    });

    expect(resumed.status).toBe("complete");
    const currentHead = await remote.readHead();
    if (!currentHead) {
      throw new Error("Expected current Head");
    }
    const current = await remote.readSnapshot(currentHead.value);
    expect(current.entries[tracked.entryId]).toMatchObject({
      entryId: tracked.entryId,
      kind: "live",
      path: "attachments/b.bin",
    });
  });

  it("does not publish a file whose bytes are shorter than the scanned size", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    await local.write("notes/example.md", new TextEncoder().encode("first"));
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      remote,
      replicaId: "desktop",
    });
    await service.initializeNew("vault-1");
    await local.write("notes/example.md", new TextEncoder().encode("short"));
    local.listedSizeOverrides.set("notes/example.md", 100);

    await expect(service.synchronize()).rejects.toMatchObject({
      message: "同步过程中本地文件被改动：notes/example.md",
      path: "notes/example.md",
    });
    expect((await remote.readHead())?.value.generation).toBe(1);
  });

  it("publishes edit-delete content to the shared Conflict Center", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("shared base"),
    );
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    });
    await desktop.initializeNew("vault-1");
    const phoneVault = new MemoryVault();
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });
    await phone.synchronize();
    await phoneVault.write(
      "notes/example.md",
      new TextEncoder().encode("offline phone edit"),
    );
    await desktopVault.delete("notes/example.md");
    await desktop.synchronize(await currentLiveEntryIds(desktopRemote));

    const phoneResult = await phone.synchronize();

    expect(phoneResult.status).toBe("action-required");
    expect(phoneVault.readText("notes/example.md")).toBeUndefined();
    const currentHead = await phoneRemote.readHead();
    if (!currentHead) {
      throw new Error("Expected initialized Head");
    }
    const current = await phoneRemote.readSnapshot(currentHead.value);
    expect(Object.values(current.entries)).toEqual([
      expect.objectContaining({ kind: "conflicted", reason: "edit-delete" }),
    ]);
    const conflicted = Object.values(current.entries)[0];
    if (conflicted?.kind !== "conflicted" || !conflicted.candidates[0]) {
      throw new Error("Expected shared Conflict candidate");
    }
    expect((await phone.synchronize()).status).toBe("action-required");

    await phone.resolveConflict(conflicted.entryId, {
      kind: "restore-candidate",
      revisionId: conflicted.candidates[0].revisionId,
    });
    await desktop.synchronize();

    expect(desktopVault.readText("notes/example.md")).toBe("offline phone edit");
  });

  it("publishes a renamed offline edit when the old remote path was deleted", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    const phoneVault = new MemoryVault();
    await desktopVault.write("notes/old.md", new TextEncoder().encode("base"));
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    });
    const phoneCache = new MemorySyncCache();
    const phone = new SyncService({
      cache: phoneCache,
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });
    await desktop.initializeNew("vault-1");
    await phone.synchronize();
    const entryIds = await currentLiveEntryIds(desktopRemote);
    await phoneVault.move("notes/old.md", "notes/renamed.md");
    const cachedFile = phoneCache.state?.files["notes/old.md"];
    if (!phoneCache.state || !cachedFile) {
      throw new Error("Expected phone rename cache");
    }
    delete phoneCache.state.files["notes/old.md"];
    phoneCache.state.files["notes/renamed.md"] = {
      ...cachedFile,
      path: "notes/renamed.md",
    };
    await phoneVault.write(
      "notes/renamed.md",
      new TextEncoder().encode("renamed phone edit"),
    );
    await desktopVault.delete("notes/old.md");
    await desktop.synchronize(entryIds);

    const result = await phone.synchronize();

    expect(result.status).toBe("action-required");
    expect(phoneVault.readText("notes/renamed.md")).toBeUndefined();
    const head = await phoneRemote.readHead();
    if (!head) {
      throw new Error("Expected Conflict Head");
    }
    const snapshot = await phoneRemote.readSnapshot(head.value);
    const entry = Object.values(snapshot.entries)[0];
    if (entry?.kind !== "conflicted" || !entry.candidates[0]) {
      throw new Error("Expected renamed edit-delete candidate");
    }
    const candidate = await phoneRemote.readBlob(entry.candidates[0].blobId);
    expect(candidate && new TextDecoder().decode(candidate)).toBe(
      "renamed phone edit",
    );
  });

  it("defers an oversized mobile download without turning it into a deletion", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    await desktopVault.write(
      "attachments/large.bin",
      new TextEncoder().encode("larger than the test limit"),
    );
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    });
    await desktop.initializeNew("vault-1");
    const phoneVault = new MemoryVault();
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      maxAutomaticFileBytes: 10,
      remote: phoneRemote,
      replicaId: "phone",
    });

    const first = await phone.synchronize();
    const second = await phone.synchronize();

    expect(first).toMatchObject({ deferredDownloads: 1, downloaded: 0 });
    expect(second).toMatchObject({ deferredDownloads: 1, uploaded: 0 });
    expect(phoneVault.readText("attachments/large.bin")).toBeUndefined();
    const currentHead = await phoneRemote.readHead();
    expect(currentHead?.value.generation).toBe(1);
    if (!currentHead) {
      throw new Error("Expected initialized Head");
    }
    const current = await phoneRemote.readSnapshot(currentHead.value);
    const entry = Object.values(current.entries)[0];
    if (entry?.kind !== "live") {
      throw new Error("Expected live oversized Entry");
    }

    await phone.downloadDeferred(entry.entryId);

    expect(phoneVault.readText("attachments/large.bin")).toBe(
      "larger than the test limit",
    );
  });

  it("accepts legacy Try anyway downloads after upgrading to unrestricted synchronization", async () => {
    const remote = await RemoteStore.open({objects: new MemoryObjectStore(), prefix: "legacy-limit", vaultKey: new Uint8Array(32)});
    const source = new MemoryVault(), local = new MemoryVault(), cache = new MemorySyncCache();
    const desktop = new SyncService({remote, local: source, cache: new MemorySyncCache(), replicaId: "desktop"});
    await source.write("attachment.bin", new TextEncoder().encode("verified content above old limit"));
    await desktop.initializeNew("vault");
    const limited = new SyncService({remote, local, cache, replicaId: "phone", maxAutomaticFileBytes: 10});
    const before = await limited.synchronize();
    const entryId = before.deferredDownloadEntries[0]!.entryId;
    await limited.downloadDeferred(entryId);
    expect((await limited.synchronize()).unsyncedLocalEntries).toBe(1);
    const head = (await remote.readHead())!.value.commitId;

    const upgraded = new SyncService({remote, local, cache, replicaId: "phone"});
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await upgraded.synchronize()).toMatchObject({status: "complete", uploaded: 0, downloaded: 0,
        deferredDownloads: 0, unsyncedLocalEntries: 0, localIssues: []});
    }
    expect(local.readText("attachment.bin")).toBe("verified content above old limit");
    expect(cache.state!.files["attachment.bin"]!.entryId).toBe(entryId);
    expect((await remote.readHead())!.value.commitId).toBe(head);
  });

  it("uploads and receives an attachment above 50 MiB without a device policy", async () => {
    const remote = await RemoteStore.open({objects: new MemoryObjectStore(), prefix: "unrestricted-large", vaultKey: new Uint8Array(32)});
    const source = new MemoryVault(), local = new MemoryVault();
    const desktop = new SyncService({remote, local: source, cache: new MemorySyncCache(), replicaId: "desktop"});
    const phone = new SyncService({remote, local, cache: new MemorySyncCache(), replicaId: "phone"});
    await desktop.initializeNew("vault");
    await phone.synchronize();
    const body = new Uint8Array(51 * 1024 * 1024);
    body[0] = 31; body[body.length - 1] = 79;
    const expectedHash = await sha256Content(body);
    await local.write("large.bin", body);
    expect(await phone.synchronize()).toMatchObject({status: "complete", uploaded: 1, unsyncedLocalEntries: 0});
    expect(await desktop.synchronize()).toMatchObject({status: "complete", downloaded: 1, deferredDownloads: 0});
    const received = await source.read("large.bin");
    expect(received.byteLength).toBe(51 * 1024 * 1024);
    expect(await sha256Content(received)).toBe(expectedHash);
    expect(await phone.synchronize()).toMatchObject({status: "complete", uploaded: 0, downloaded: 0, localIssues: []});
  }, 120_000);

  it("applies a lower cellular limit only to attachments", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    await desktopVault.write(
      "notes/article.md",
      new TextEncoder().encode("twenty-byte-note...."),
    );
    await desktopVault.write(
      "attachments/photo.jpg",
      new TextEncoder().encode("twenty-byte-photo..."),
    );
    await new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    }).initializeNew("vault-1");
    const phoneVault = new MemoryVault();
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      maxAutomaticFileBytes: (path) =>
        path.endsWith(".md") ? 50 : 10,
      remote: phoneRemote,
      replicaId: "phone",
    });

    const result = await phone.synchronize();

    expect(result).toMatchObject({ deferredDownloads: 1, downloaded: 1 });
    expect(phoneVault.readText("notes/article.md")).toBe("twenty-byte-note....");
    expect(phoneVault.readText("attachments/photo.jpg")).toBeUndefined();
  });

  it("continues syncing when this device cannot create a remote path", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    await desktopVault.write(
      "notes/portable.md",
      new TextEncoder().encode("portable"),
    );
    await desktopVault.write(
      "notes/question?.md",
      new TextEncoder().encode("unsupported"),
    );
    await new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    }).initializeNew("vault-1");
    const phoneVault = new MemoryVault();
    phoneVault.unsupportedPaths.add("notes/question?.md");
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });

    const result = await phone.synchronize();

    expect(result).toMatchObject({
      deferredDownloadEntries: [
        {
          path: "notes/question?.md",
          reason: "unsupported-path",
          size: 11,
        },
      ],
      downloaded: 1,
      localIssues: [
        { kind: "unsupported-path", path: "notes/question?.md" },
      ],
      status: "action-required",
    });
    expect(phoneVault.readText("notes/portable.md")).toBe("portable");
    expect(phoneVault.readText("notes/question?.md")).toBeUndefined();
    const unsupported = result.deferredDownloadEntries[0];
    if (!unsupported) {
      throw new Error("Expected unsupported remote path");
    }
    await expect(phone.downloadDeferred(unsupported.entryId)).rejects.toThrow(
      "本设备不支持这个路径",
    );
  });

  it("downloads a previously deferred file after its remote path becomes supported", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopVault = new MemoryVault();
    await desktopVault.write(
      "notes/question?.md",
      new TextEncoder().encode("portable after rename"),
    );
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: await RemoteStore.open({
        objects,
        prefix: "chosen-prefix",
        vaultKey,
      }),
      replicaId: "desktop",
    });
    await desktop.initializeNew("vault-1");

    const phoneVault = new MemoryVault();
    phoneVault.unsupportedPaths.add("notes/question?.md");
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phoneCache = new MemorySyncCache();
    const phone = new SyncService({
      cache: phoneCache,
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });
    expect((await phone.synchronize()).deferredDownloads).toBe(1);
    if (!phoneCache.state) {
      throw new Error("Expected phone cache");
    }
    phoneCache.state.unmaterializedEntryIds = undefined;
    phoneVault.unsupportedPaths.delete("notes/question?.md");

    await desktopVault.move("notes/question?.md", "notes/question？.md");
    await desktop.synchronize();
    const phoneResult = await phone.synchronize();

    expect(phoneResult).toMatchObject({ downloaded: 1, status: "complete" });
    expect(phoneVault.readText("notes/question？.md")).toBe(
      "portable after rename",
    );
    const head = await phoneRemote.readHead();
    if (!head) {
      throw new Error("Expected remote Head");
    }
    const snapshot = await phoneRemote.readSnapshot(head.value);
    expect(Object.values(snapshot.entries)).toContainEqual(
      expect.objectContaining({ kind: "live", path: "notes/question？.md" }),
    );
  });

  it("reports an oversized local mobile file without reading or uploading it", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: new MemoryVault(),
      remote: desktopRemote,
      replicaId: "desktop",
    });
    await desktop.initializeNew("vault-1");
    const phoneVault = new MemoryVault();
    await phoneVault.write(
      "attachments/local-large.bin",
      new TextEncoder().encode("larger than the test limit"),
    );
    phoneVault.readCount = 0;
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      maxAutomaticFileBytes: 10,
      remote: phoneRemote,
      replicaId: "phone",
    });

    const result = await phone.synchronize();

    expect(result).toMatchObject({
      status: "action-required",
      unsyncedLocalEntries: 1,
      uploaded: 0,
    });
    expect(phoneVault.readCount).toBe(0);
  });

  it("does not overwrite a tracked local edit that grows beyond the mobile limit", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopVault = new MemoryVault();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("remote"),
    );
    await new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: await RemoteStore.open({
        objects,
        prefix: "chosen-prefix",
        vaultKey,
      }),
      replicaId: "desktop",
    }).initializeNew("vault-1");

    const phoneVault = new MemoryVault();
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      maxAutomaticFileBytes: 10,
      remote: phoneRemote,
      replicaId: "phone",
    });
    await phone.synchronize();
    await phoneVault.write(
      "notes/example.md",
      new TextEncoder().encode("local content above limit"),
    );

    const first = await phone.synchronize();
    const second = await phone.synchronize();

    expect(first).toMatchObject({ status: "action-required", uploaded: 0 });
    expect(second).toMatchObject({ status: "action-required", uploaded: 0 });
    expect(phoneVault.readText("notes/example.md")).toBe(
      "local content above limit",
    );
    expect((await phoneRemote.readHead())?.value.generation).toBe(1);
  });

  it("does not publish a Bulk Deletion before confirmation", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    for (let index = 1; index <= 5; index += 1) {
      await local.write(
        `notes/${index}.md`,
        new TextEncoder().encode(`note ${index}`),
      );
    }
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      remote,
      replicaId: "desktop",
    });
    await service.initializeNew("vault-1");
    await local.delete("notes/1.md");
    await local.delete("notes/2.md");

    const result = await service.synchronize();

    expect(result).toMatchObject({
      bulkDeletion: { count: 2, totalLiveEntries: 5 },
      cacheUpdated: false,
      status: "action-required",
      uploaded: 0,
    });
    expect((await remote.readHead())?.value.generation).toBe(1);
    if (!result.bulkDeletion) {
      throw new Error("Expected Bulk Deletion plan");
    }

    const confirmed = await service.synchronize(result.bulkDeletion.entryIds);

    expect(confirmed.status).toBe("complete");
    expect((await remote.readHead())?.value.generation).toBe(2);
  });

  it("rejects bulk deletion approval when the deletion set changes", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    for (let index = 1; index <= 5; index += 1) {
      await local.write(
        `notes/${index}.md`,
        new TextEncoder().encode(`note ${index}`),
      );
    }
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      remote,
      replicaId: "desktop",
    });
    await service.initializeNew("vault-1");
    await local.delete("notes/1.md");
    await local.delete("notes/2.md");
    const first = await service.synchronize();
    if (!first.bulkDeletion) {
      throw new Error("Expected initial Bulk Deletion plan");
    }
    await local.delete("notes/3.md");

    const changed = await service.synchronize(first.bulkDeletion.entryIds);

    expect(changed).toMatchObject({
      bulkDeletion: { count: 3, totalLiveEntries: 5 },
      status: "action-required",
      uploaded: 0,
    });
    expect((await remote.readHead())?.value.generation).toBe(1);
  });

  it("restores a Conflict candidate as the next live Revision", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const candidate = {
      blobId: "blob-candidate",
      contentHash:
        "sha256:a70c756cd47ddf26be4ea49c0f09a0122f8e648e172efb0d46aa60af8c9430f8",
      createdAt: "2026-09-05T00:00:00.000Z",
      revisionId: "revision-candidate",
      size: 16,
    };
    const otherCandidate = {
      ...candidate,
      revisionId: "revision-other-candidate",
    };
    const recovery = {
      ...candidate,
      expiresAt: "2026-10-05T00:00:00.000Z",
      revisionId: "revision-recovery",
    };
    const conflictedEntry = {
      candidates: [candidate, otherCandidate],
      deletedAt: "2026-09-04T00:00:00.000Z",
      entryId: "entry-1",
      kind: "conflicted" as const,
      lastContentHash: "sha256:old",
      lastRevisionId: "revision-old",
      path: "notes/example.md",
      reason: "edit-delete" as const,
      recovery,
    };
    await remote.writeBlob(
      candidate.blobId,
      new TextEncoder().encode("restored content"),
    );
    await remote.initialize({
      commit: {
        changes: [{ entry: conflictedEntry, kind: "set-entry" }],
        commitId: "commit-1",
        createdAt: "2026-09-05T00:00:00.000Z",
        parentIds: [],
        protocolVersion: 1,
        replicaId: "phone",
        vaultId: "vault-1",
      },
      head: {
        commitId: "commit-1",
        generation: 1,
        protocolVersion: 1,
        vaultId: "vault-1",
      },
    });
    const local = new MemoryVault();
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      remote,
      replicaId: "phone",
    });

    await service.resolveConflict("entry-1", {
      kind: "restore-candidate",
      revisionId: "revision-candidate",
    });

    expect(local.readText("notes/example.md")).toBe("restored content");
    const currentHead = await remote.readHead();
    if (!currentHead) {
      throw new Error("Expected initialized Head");
    }
    const current = await remote.readSnapshot(currentHead.value);
    expect(current.entries["entry-1"]).toMatchObject({
      entryId: "entry-1",
      history: [
        expect.objectContaining({ revisionId: "revision-other-candidate" }),
        expect.objectContaining({ revisionId: "revision-recovery" }),
      ],
      kind: "live",
      revision: expect.objectContaining({
        blobId: candidate.blobId,
        contentHash: candidate.contentHash,
        size: candidate.size,
      }),
    });
    if (current.entries["entry-1"]?.kind !== "live") {
      throw new Error("Expected restored live Entry");
    }
    expect(current.entries["entry-1"].revision.revisionId).not.toBe(
      candidate.revisionId,
    );
  });

  it("retains edited Conflict candidates when keeping a deletion", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const candidate = {
      blobId: "blob-candidate",
      contentHash:
        "sha256:a70c756cd47ddf26be4ea49c0f09a0122f8e648e172efb0d46aa60af8c9430f8",
      createdAt: "2026-09-05T00:00:00.000Z",
      revisionId: "revision-candidate",
      size: 16,
    };
    await remote.initialize({
      commit: {
        changes: [
          {
            entry: {
              candidates: [candidate],
              deletedAt: "2026-09-04T00:00:00.000Z",
              entryId: "entry-1",
              kind: "conflicted",
              lastContentHash: "sha256:old",
              lastRevisionId: "revision-old",
              path: "notes/example.md",
              reason: "edit-delete",
            },
            kind: "set-entry",
          },
        ],
        commitId: "commit-1",
        createdAt: "2026-09-05T00:00:00.000Z",
        parentIds: [],
        protocolVersion: 1,
        replicaId: "phone",
        vaultId: "vault-1",
      },
      head: {
        commitId: "commit-1",
        generation: 1,
        protocolVersion: 1,
        vaultId: "vault-1",
      },
    });
    const local = new MemoryVault();
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      remote,
      replicaId: "phone",
    });
    await remote.writeBlob(
      candidate.blobId,
      new TextEncoder().encode("restored content"),
    );

    await service.resolveConflict("entry-1", { kind: "keep-deleted" });

    const head = await remote.readHead();
    if (!head) {
      throw new Error("Expected resolved Head");
    }
    const current = await remote.readSnapshot(head.value);
    expect(current.entries["entry-1"]).toMatchObject({
      history: [
        expect.objectContaining({
          expiresAt: expect.any(String),
          revisionId: "revision-candidate",
        }),
      ],
      kind: "deleted",
    });

    await service.restoreDeleted("entry-1", candidate.revisionId);

    expect(local.readText("notes/example.md")).toBe("restored content");
  });

  it("restores Version History without erasing the newer Revision", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    await local.write("notes/example.md", new TextEncoder().encode("version one"));
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      remote,
      replicaId: "desktop",
    });
    await service.initializeNew("vault-1");
    await local.write("notes/example.md", new TextEncoder().encode("version two"));
    await service.synchronize();
    const beforeHead = await remote.readHead();
    if (!beforeHead) {
      throw new Error("Expected initialized Head");
    }
    const before = await remote.readSnapshot(beforeHead.value);
    const entry = Object.values(before.entries)[0];
    if (entry?.kind !== "live" || !entry.history?.[0]) {
      throw new Error("Expected Version History fixture");
    }
    const oldRevisionId = entry.history[0].revisionId;

    await service.restoreRevision(entry.entryId, oldRevisionId);

    expect(local.readText("notes/example.md")).toBe("version one");
    const afterHead = await remote.readHead();
    if (!afterHead) {
      throw new Error("Expected initialized Head");
    }
    const after = await remote.readSnapshot(afterHead.value);
    const restored = after.entries[entry.entryId];
    expect(restored).toMatchObject({
      entryId: entry.entryId,
      kind: "live",
      history: expect.arrayContaining([
        expect.objectContaining({ contentHash: entry.revision.contentHash }),
      ]),
      revision: expect.objectContaining({
        contentHash: entry.history[0].contentHash,
      }),
    });
    if (restored?.kind !== "live") {
      throw new Error("Expected restored live Entry");
    }
    expect(restored.revision.revisionId).not.toBe(oldRevisionId);
  });

  it("does not restore history over the only good current local copy", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    await local.write("notes/example.md", new TextEncoder().encode("version one"));
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      remote,
      replicaId: "desktop",
    });
    await service.initializeNew("vault-1");
    await local.write("notes/example.md", new TextEncoder().encode("version two"));
    await service.synchronize();
    const currentHead = await remote.readHead();
    if (!currentHead) {
      throw new Error("Expected initialized Head");
    }
    const current = await remote.readSnapshot(currentHead.value);
    const entry = Object.values(current.entries)[0];
    if (entry?.kind !== "live" || !entry.history?.[0]) {
      throw new Error("Expected Version History fixture");
    }
    await objects.put(
      `chosen-prefix/v1/blobs/${entry.revision.blobId}`,
      new TextEncoder().encode("corrupted ciphertext"),
    );

    await expect(
      service.restoreRevision(entry.entryId, entry.history[0].revisionId),
    ).rejects.toThrow("在远端没有可核实的恢复副本");

    expect(local.readText("notes/example.md")).toBe("version two");
    await expect(remote.readHead()).resolves.toMatchObject({
      value: { commitId: currentHead.value.commitId },
    });
  });

  it("automatically merges non-overlapping Markdown edits", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("title\nbase\nend"),
    );
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    });
    await desktop.initializeNew("vault-1");
    const phoneVault = new MemoryVault();
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });
    await phone.synchronize();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("desktop title\nbase\nend"),
    );
    await phoneVault.write(
      "notes/example.md",
      new TextEncoder().encode("title\nbase\nphone end"),
    );
    await desktop.synchronize();

    const result = await phone.synchronize();

    expect(result.status).toBe("complete");
    expect(phoneVault.readText("notes/example.md")).toBe(
      "desktop title\nbase\nphone end",
    );
  });

  it("keeps overlapping Markdown edits out of the live note", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    await desktopVault.write("notes/example.md", new TextEncoder().encode("base"));
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    });
    await desktop.initializeNew("vault-1");
    const phoneVault = new MemoryVault();
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });
    await phone.synchronize();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("desktop edit"),
    );
    await phoneVault.write(
      "notes/example.md",
      new TextEncoder().encode("phone edit"),
    );
    await desktop.synchronize();

    const result = await phone.synchronize();

    expect(result.status).toBe("action-required");
    expect(phoneVault.readText("notes/example.md")).toBe("desktop edit");
    const currentHead = await phoneRemote.readHead();
    if (!currentHead) {
      throw new Error("Expected initialized Head");
    }
    const current = await phoneRemote.readSnapshot(currentHead.value);
    expect(Object.values(current.entries)).toEqual([
      expect.objectContaining({
        candidates: expect.arrayContaining([
          expect.objectContaining({ contentHash: expect.any(String) }),
          expect.objectContaining({ contentHash: expect.any(String) }),
        ]),
        kind: "conflicted",
        reason: "edit-edit",
      }),
    ]);
  });

  it("preserves both candidates when concurrent renames are also edited", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    const phoneVault = new MemoryVault();
    await desktopVault.write("notes/old.md", new TextEncoder().encode("base"));
    const desktopCache = new MemorySyncCache();
    const phoneCache = new MemorySyncCache();
    const desktop = new SyncService({
      cache: desktopCache,
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    });
    const phone = new SyncService({
      cache: phoneCache,
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });
    await desktop.initializeNew("vault-1");
    await phone.synchronize();
    await phoneVault.move("notes/old.md", "notes/phone.md");
    const phoneCached = phoneCache.state?.files["notes/old.md"];
    if (!phoneCache.state || !phoneCached) {
      throw new Error("Expected phone cache");
    }
    delete phoneCache.state.files["notes/old.md"];
    phoneCache.state.files["notes/phone.md"] = {
      ...phoneCached,
      path: "notes/phone.md",
    };
    await phoneVault.write(
      "notes/phone.md",
      new TextEncoder().encode("phone edit"),
    );
    await desktopVault.move("notes/old.md", "notes/desktop.md");
    const desktopCached = desktopCache.state?.files["notes/old.md"];
    if (!desktopCache.state || !desktopCached) {
      throw new Error("Expected desktop cache");
    }
    delete desktopCache.state.files["notes/old.md"];
    desktopCache.state.files["notes/desktop.md"] = {
      ...desktopCached,
      path: "notes/desktop.md",
    };
    await desktopVault.write(
      "notes/desktop.md",
      new TextEncoder().encode("desktop edit"),
    );
    await desktop.synchronize();

    const result = await phone.synchronize();

    expect(result.status).toBe("action-required");
    expect(phoneVault.readText("notes/phone.md")).toBeUndefined();
    expect(phoneVault.readText("notes/desktop.md")).toBe("desktop edit");
    const head = await phoneRemote.readHead();
    if (!head) {
      throw new Error("Expected Conflict Head");
    }
    const snapshot = await phoneRemote.readSnapshot(head.value);
    const entry = Object.values(snapshot.entries)[0];
    if (entry?.kind !== "conflicted") {
      throw new Error("Expected rename/edit Conflict");
    }
    const candidates = await Promise.all(
      entry.candidates.map(async (candidate) => {
        const body = await phoneRemote.readBlob(candidate.blobId);
        return body ? new TextDecoder().decode(body) : "missing";
      }),
    );
    expect(candidates.sort()).toEqual(["desktop edit", "phone edit"]);
  });

  it("does not publish or replace a local Conflict candidate until its upload authenticates", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    const phoneVault = new MemoryVault();
    await desktopVault.write("notes/example.md", new TextEncoder().encode("base"));
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    });
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });
    await desktop.initializeNew("vault-1");
    await phone.synchronize();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("desktop edit"),
    );
    await phoneVault.write(
      "notes/example.md",
      new TextEncoder().encode("phone edit"),
    );
    await desktop.synchronize();
    const before = await phoneRemote.readHead();
    if (!before) {
      throw new Error("Expected desktop edit Head");
    }
    objects.corruptNextBlobPut = true;

    await expect(phone.synchronize()).rejects.toThrow(
      "无法核实远端版本",
    );

    expect(phoneVault.readText("notes/example.md")).toBe("phone edit");
    await expect(phoneRemote.readHead()).resolves.toMatchObject({
      value: { commitId: before.value.commitId },
    });
  });

  it("imports an unknown local file only after explicit confirmation", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    await new SyncService({
      cache: new MemorySyncCache(),
      local: new MemoryVault(),
      remote: desktopRemote,
      replicaId: "desktop",
    }).initializeNew("vault-1");
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phoneVault = new MemoryVault();
    await phoneVault.write(
      "notes/local-only.md",
      new TextEncoder().encode("local candidate"),
    );
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });

    const before = await phone.synchronize();
    expect(before).toMatchObject({ status: "action-required", uploaded: 0 });

    await phone.importCandidate("notes/local-only.md");

    const currentHead = await phoneRemote.readHead();
    if (!currentHead) {
      throw new Error("Expected initialized Head");
    }
    const current = await phoneRemote.readSnapshot(currentHead.value);
    expect(Object.values(current.entries)).toEqual([
      expect.objectContaining({ kind: "live", path: "notes/local-only.md" }),
    ]);
  });

  it("restores deleted content from its 30-day Recovery Copy", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    await local.write(
      "notes/example.md",
      new TextEncoder().encode("recover me"),
    );
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      remote,
      replicaId: "desktop",
    });
    await service.initializeNew("vault-1");
    const initialHead = await remote.readHead();
    if (!initialHead) {
      throw new Error("Expected initialized Head");
    }
    const initial = await remote.readSnapshot(initialHead.value);
    const entryId = Object.values(initial.entries)[0]?.entryId;
    if (!entryId) {
      throw new Error("Expected initialized Entry");
    }
    await local.delete("notes/example.md");
    await service.synchronize(await currentLiveEntryIds(remote));

    expect(
      new TextDecoder().decode(await service.readDeletedRecovery(entryId)),
    ).toBe("recover me");
    expect(local.readText("notes/example.md")).toBeUndefined();

    const deletedHead = await remote.readHead();
    if (!deletedHead) {
      throw new Error("Expected deleted Head");
    }
    const deletedSnapshot = await remote.readSnapshot(deletedHead.value);
    const deletedEntry = deletedSnapshot.entries[entryId];
    if (deletedEntry?.kind !== "deleted" || !deletedEntry.recovery) {
      throw new Error("Expected deleted Entry with recovery");
    }
    objects.onGet = async (key) => {
      if (key.endsWith(`/blobs/${deletedEntry.recovery?.blobId}`)) {
        objects.onGet = undefined;
        await local.write(
          "notes/example.md",
          new TextEncoder().encode("new local draft"),
        );
      }
    };

    await expect(service.restoreDeleted(entryId)).rejects.toThrow(
      "同步过程中本地文件被改动",
    );

    expect(local.readText("notes/example.md")).toBe("new local draft");
    await expect(remote.readHead()).resolves.toMatchObject({
      value: { commitId: deletedHead.value.commitId },
    });
    await local.delete("notes/example.md");

    const competingRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const competingHead = await competingRemote.readHead();
    if (!competingHead) {
      throw new Error("Expected competing Head");
    }
    objects.onPut = async (key) => {
      if (key.includes("/commits/")) {
        objects.onPut = undefined;
        await competingRemote.advance({
          commit: {
            changes: [],
            commitId: "competing-commit",
            createdAt: competingHead.serverDate,
            parentIds: [competingHead.value.commitId],
            protocolVersion: 1,
            replicaId: "other-device",
            vaultId: competingHead.value.vaultId,
          },
          expectedHeadEtag: competingHead.etag,
          head: {
            commitId: "competing-commit",
            generation: competingHead.value.generation + 1,
            protocolVersion: 1,
            snapshotId: competingHead.value.snapshotId,
            vaultId: competingHead.value.vaultId,
          },
        });
      }
    };

    await expect(service.restoreDeleted(entryId)).rejects.toThrow(
      "Head 指针被改了",
    );

    expect(local.readText("notes/example.md")).toBeUndefined();

    await service.restoreDeleted(entryId);

    expect(local.readText("notes/example.md")).toBe("recover me");
    const restoredHead = await remote.readHead();
    if (!restoredHead) {
      throw new Error("Expected restored Head");
    }
    const restored = await remote.readSnapshot(restoredHead.value);
    expect(restored.entries[entryId]).toMatchObject({
      entryId,
      kind: "live",
      path: "notes/example.md",
    });
  });

  it("refuses to restore a deleted Entry whose path belongs to another live Entry", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    await local.write("notes/foo.md", new TextEncoder().encode("foo"));
    await local.write("notes/bar.md", new TextEncoder().encode("bar"));
    const cache = new MemorySyncCache();
    const service = new SyncService({
      cache,
      local,
      remote,
      replicaId: "desktop",
    });
    await service.initializeNew("vault-1");
    const initialHead = await remote.readHead();
    if (!initialHead) {
      throw new Error("Expected initialized Head");
    }
    const initial = await remote.readSnapshot(initialHead.value);
    const foo = Object.values(initial.entries).find(
      (entry) => entry.path === "notes/foo.md",
    );
    if (foo?.kind !== "live") {
      throw new Error("Expected foo Entry");
    }
    await local.delete("notes/foo.md");
    await service.synchronize([foo.entryId]);
    await local.move("notes/bar.md", "notes/foo.md");
    await service.synchronize();
    expect(
      new TextDecoder().decode(await service.readDeletedRecovery(foo.entryId)),
    ).toBe("foo");
    const occupiedHead = await remote.readHead();
    if (!occupiedHead) {
      throw new Error("Expected occupied Head");
    }
    const emptyLocal = new MemoryVault();
    const restoringReplica = new SyncService({
      cache: new MemorySyncCache(),
      local: emptyLocal,
      remote,
      replicaId: "restoring-device",
    });

    await expect(restoringReplica.restoreDeleted(foo.entryId)).rejects.toThrow(
      "这个路径已被文件",
    );

    expect(emptyLocal.readText("notes/foo.md")).toBeUndefined();
    await expect(remote.readHead()).resolves.toMatchObject({
      value: { commitId: occupiedHead.value.commitId },
    });
  });

  it("preserves a new local draft when another Replica restores a deleted path", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    const phoneVault = new MemoryVault();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("original"),
    );
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    });
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });
    await desktop.initializeNew("vault-1");
    await phone.synchronize();
    const initialHead = await desktopRemote.readHead();
    if (!initialHead) {
      throw new Error("Expected initialized Head");
    }
    const initial = await desktopRemote.readSnapshot(initialHead.value);
    const entryId = Object.values(initial.entries)[0]?.entryId;
    if (!entryId) {
      throw new Error("Expected initialized Entry");
    }
    await desktopVault.delete("notes/example.md");
    await desktop.synchronize(await currentLiveEntryIds(desktopRemote));
    await phone.synchronize();
    await phoneVault.write(
      "notes/example.md",
      new TextEncoder().encode("new phone draft"),
    );

    await desktop.restoreDeleted(entryId);
    const result = await phone.synchronize();

    expect(result.status).toBe("action-required");
    expect(phoneVault.readText("notes/example.md")).toBe("new phone draft");
    const conflictHead = await phoneRemote.readHead();
    if (!conflictHead) {
      throw new Error("Expected Conflict Head");
    }
    const conflictSnapshot = await phoneRemote.readSnapshot(conflictHead.value);
    const conflicted = conflictSnapshot.entries[entryId];
    if (conflicted?.kind !== "conflicted") {
      throw new Error("Expected shared Conflict");
    }
    const candidateContents = await Promise.all(
      conflicted.candidates.map(async (candidate) => {
        const body = await phoneRemote.readBlob(candidate.blobId);
        return body ? new TextDecoder().decode(body) : "missing";
      }),
    );
    expect(candidateContents.sort()).toEqual([
      "new phone draft",
      "original",
    ]);
  });

  it("propagates a rename while preserving one stable Entry identity", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    await desktopVault.write(
      "notes/example.md",
      new TextEncoder().encode("same identity"),
    );
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    });
    await desktop.initializeNew("vault-1");
    const phoneVault = new MemoryVault();
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });
    await phone.synchronize();

    await desktopVault.move("notes/example.md", "notes/renamed.md");
    await desktop.synchronize();
    await phone.synchronize();

    expect(phoneVault.readText("notes/example.md")).toBeUndefined();
    expect(phoneVault.readText("notes/renamed.md")).toBe("same identity");
    const currentHead = await phoneRemote.readHead();
    if (!currentHead) {
      throw new Error("Expected initialized Head");
    }
    const current = await phoneRemote.readSnapshot(currentHead.value);
    expect(Object.values(current.entries)).toHaveLength(1);
    expect(Object.values(current.entries)[0]).toMatchObject({
      kind: "live",
      path: "notes/renamed.md",
    });
  });

  it("combines a local rename with a concurrent remote edit", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    const phoneVault = new MemoryVault();
    await desktopVault.write("notes/old.md", new TextEncoder().encode("base"));
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    });
    const phoneCache = new MemorySyncCache();
    const phone = new SyncService({
      cache: phoneCache,
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });
    await desktop.initializeNew("vault-1");
    await phone.synchronize();
    await phoneVault.move("notes/old.md", "notes/phone-name.md");
    const cachedFile = phoneCache.state?.files["notes/old.md"];
    if (!phoneCache.state || !cachedFile) {
      throw new Error("Expected phone cache");
    }
    delete phoneCache.state.files["notes/old.md"];
    phoneCache.state.files["notes/phone-name.md"] = {
      ...cachedFile,
      path: "notes/phone-name.md",
    };
    await desktopVault.write(
      "notes/old.md",
      new TextEncoder().encode("desktop edit"),
    );
    await desktop.synchronize();

    const result = await phone.synchronize();

    expect(result.status).toBe("complete");
    expect(phoneVault.readText("notes/old.md")).toBeUndefined();
    expect(phoneVault.readText("notes/phone-name.md")).toBe("desktop edit");
    const head = await phoneRemote.readHead();
    if (!head) {
      throw new Error("Expected merged rename Head");
    }
    const snapshot = await phoneRemote.readSnapshot(head.value);
    expect(Object.values(snapshot.entries)[0]).toMatchObject({
      kind: "live",
      path: "notes/phone-name.md",
      revision: { size: 12 },
    });
  });

  it("combines a local edit with a concurrent remote rename", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    const phoneVault = new MemoryVault();
    await desktopVault.write("notes/old.md", new TextEncoder().encode("base"));
    const desktopCache = new MemorySyncCache();
    const desktop = new SyncService({
      cache: desktopCache,
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    });
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });
    await desktop.initializeNew("vault-1");
    await phone.synchronize();
    await phoneVault.write("notes/old.md", new TextEncoder().encode("phone edit"));
    await desktopVault.move("notes/old.md", "notes/desktop-name.md");
    const cachedFile = desktopCache.state?.files["notes/old.md"];
    if (!desktopCache.state || !cachedFile) {
      throw new Error("Expected desktop cache");
    }
    delete desktopCache.state.files["notes/old.md"];
    desktopCache.state.files["notes/desktop-name.md"] = {
      ...cachedFile,
      path: "notes/desktop-name.md",
    };
    await desktop.synchronize();

    const result = await phone.synchronize();

    expect(result.status).toBe("complete");
    expect(phoneVault.readText("notes/old.md")).toBeUndefined();
    expect(phoneVault.readText("notes/desktop-name.md")).toBe("phone edit");
    const head = await phoneRemote.readHead();
    if (!head) {
      throw new Error("Expected merged edit Head");
    }
    const snapshot = await phoneRemote.readSnapshot(head.value);
    expect(Object.values(snapshot.entries)[0]).toMatchObject({
      kind: "live",
      path: "notes/desktop-name.md",
      revision: { size: 10 },
    });
  });

  it("finishes a copied remote rename and receives unrelated updates without publishing duplicate Entries", async () => {
    const remote = await RemoteStore.open({objects: new MemoryObjectStore(), prefix: "resume-move", vaultKey: new Uint8Array(32)});
    const desktopFiles = new MemoryVault(), phoneFiles = new MemoryVault();
    const desktopCache = new MemorySyncCache(), phoneCache = new MemorySyncCache();
    const desktop = new SyncService({remote, local: desktopFiles, cache: desktopCache, replicaId: "desktop"});
    const phone = new SyncService({remote, local: phoneFiles, cache: phoneCache, replicaId: "phone"});
    await desktopFiles.write("old/Frontend.md", new TextEncoder().encode("same content"));
    await desktopFiles.write("project.md", new TextEncoder().encode("v1.1"));
    await desktop.initializeNew("vault");
    await phone.synchronize();
    const entryId = phoneCache.state!.files["old/Frontend.md"]!.entryId;
    await desktopFiles.move("old/Frontend.md", "new/Frontend.md");
    await desktopFiles.write("project.md", new TextEncoder().encode("v1.2"));
    await desktopFiles.write("Raycloud/new.md", new TextEncoder().encode("new project"));
    await desktop.synchronize();
    const currentHead = (await remote.readHead())!.value.commitId;
    // Simulate termination after copying the new path, before retiring the old path/cache.
    await phoneFiles.write("new/Frontend.md", new TextEncoder().encode("same content"));

    const result = await phone.synchronize();

    expect(result.status).toBe("complete");
    expect(result.uploaded).toBe(0);
    expect(phoneFiles.readText("old/Frontend.md")).toBeUndefined();
    expect(phoneFiles.readText("new/Frontend.md")).toBe("same content");
    expect(phoneFiles.readText("project.md")).toBe("v1.2");
    expect(phoneFiles.readText("Raycloud/new.md")).toBe("new project");
    expect(phoneCache.state!.files["new/Frontend.md"]!.entryId).toBe(entryId);
    expect(phoneCache.state!.snapshot.commitId).toBe(currentHead);
    expect((await remote.readHead())!.value.commitId).toBe(currentHead);
    expect((await phone.synchronize()).status).toBe("complete");
  });

  it("resumes after a remote rename and content update finished before a later download failed", async () => {
    const remote = await RemoteStore.open({objects: new MemoryObjectStore(), prefix: "completed-move", vaultKey: new Uint8Array(32)});
    class InterruptedVault extends MemoryVault {
      interrupt = false;
      override async write(path: string, body: Uint8Array): Promise<void> {
        if (this.interrupt && path === "Raycloud/remaining.md") {
          this.interrupt = false;
          throw new Error("Later download interrupted");
        }
        return super.write(path, body);
      }
    }
    const source = new MemoryVault(), local = new InterruptedVault(), cache = new MemorySyncCache();
    const desktop = new SyncService({remote, local: source, cache: new MemorySyncCache(), replicaId: "desktop"});
    const phone = new SyncService({remote, local, cache, replicaId: "phone"});
    await source.write("old/note.md", new TextEncoder().encode("old content"));
    await desktop.initializeNew("vault");
    await phone.synchronize();
    const base = cache.state!.snapshot.commitId;
    const id = cache.state!.files["old/note.md"]!.entryId;
    await source.move("old/note.md", "new/note.md");
    await source.write("new/note.md", new TextEncoder().encode("updated remote content"));
    await source.write("Raycloud/remaining.md", new TextEncoder().encode("remaining document"));
    await desktop.synchronize([], {pathRenames: new Map([["old/note.md", {entryId: id, toPath: "new/note.md"}]])});
    const head = (await remote.readHead())!.value.commitId;
    local.interrupt = true;
    await expect(phone.synchronize()).rejects.toThrow("Later download interrupted");
    expect(local.readText("old/note.md")).toBeUndefined();
    expect(local.readText("new/note.md")).toBe("updated remote content");
    expect(cache.state!.snapshot.commitId).toBe(base);

    const resumed = await phone.synchronize();

    expect(resumed.status).toBe("complete");
    expect(resumed.uploaded).toBe(0);
    expect(local.readText("new/note.md")).toBe("updated remote content");
    expect(local.readText("Raycloud/remaining.md")).toBe("remaining document");
    expect(cache.state!.files["new/note.md"]!.entryId).toBe(id);
    expect(cache.state!.snapshot.commitId).toBe(head);
    expect((await remote.readHead())!.value.commitId).toBe(head);
    expect((await phone.synchronize()).status).toBe("complete");
  });

  it.each(["edited target", "recreated source"])("keeps a completed-move recovery blocked for %s", async change => {
    const remote = await RemoteStore.open({objects: new MemoryObjectStore(), prefix: "ambiguous-completed-move", vaultKey: new Uint8Array(32)});
    const source = new MemoryVault(), local = new MemoryVault(), cache = new MemorySyncCache();
    const desktop = new SyncService({remote, local: source, cache: new MemorySyncCache(), replicaId: "desktop"});
    const phone = new SyncService({remote, local, cache, replicaId: "phone"});
    await source.write("old.md", new TextEncoder().encode("original"));
    await desktop.initializeNew("vault");
    await phone.synchronize();
    const base = cache.state!.snapshot.commitId, id = cache.state!.files["old.md"]!.entryId;
    await source.move("old.md", "new.md");
    await source.write("new.md", new TextEncoder().encode("updated remote"));
    await desktop.synchronize([], {pathRenames: new Map([["old.md", {entryId: id, toPath: "new.md"}]])});
    const head = (await remote.readHead())!.value.commitId;
    await local.move("old.md", "new.md");
    await local.write("new.md", new TextEncoder().encode(change === "edited target" ? "new phone draft" : "updated remote"));
    if (change === "recreated source") await local.write("old.md", new TextEncoder().encode("new old-path draft"));

    const result = await phone.synchronize();

    expect(result.status).toBe("action-required");
    expect(result.cacheUpdated).toBe(false);
    expect(local.readText("new.md")).toBe(change === "edited target" ? "new phone draft" : "updated remote");
    expect(local.readText("old.md")).toBe(change === "recreated source" ? "new old-path draft" : undefined);
    expect(cache.state!.snapshot.commitId).toBe(base);
    expect((await remote.readHead())!.value.commitId).toBe(head);
  });

  it("cleans only retired parent paths after the new state is accepted, never while a collision blocks sync", async () => {
    const remote = await RemoteStore.open({objects: new MemoryObjectStore(), prefix: "cleanup-order", vaultKey: new Uint8Array(32)});
    const source = new MemoryVault(), cache = new MemorySyncCache();
    const cleaned: string[] = [];
    class CleanupVault extends MemoryVault {
      async cleanupEmptyDirectories(retiredPaths: readonly string[]): Promise<void> {
        expect((await cache.load())?.snapshot.commitId).toBe((await remote.readHead())!.value.commitId);
        for (const path of retiredPaths) expect(this.readText(path)).toBeUndefined();
        cleaned.push(...retiredPaths);
      }
    }
    const local = new CleanupVault();
    const desktop = new SyncService({remote, local: source, cache: new MemorySyncCache(), replicaId: "desktop"});
    const phone = new SyncService({remote, local, cache, replicaId: "phone"});
    await source.write("old/note.md", new TextEncoder().encode("original"));
    await desktop.initializeNew("vault");
    await phone.synchronize();
    await source.move("old/note.md", "new/note.md");
    await desktop.synchronize();
    await local.write("new/note.md", new TextEncoder().encode("independent draft"));
    expect((await phone.synchronize()).status).toBe("action-required");
    expect(cleaned).toEqual([]);
    await local.delete("new/note.md");
    expect((await phone.synchronize()).status).toBe("complete");
    expect(cleaned).toEqual(["old/note.md"]);
    await phone.synchronize();
    expect(cleaned).toEqual(["old/note.md"]);
  });

  it("blocks a remote rename when its target is already a different local file", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    const phoneVault = new MemoryVault();
    await desktopVault.write("notes/a.md", new TextEncoder().encode("remote"));
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    });
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });
    await desktop.initializeNew("vault-1");
    await phone.synchronize();
    await phoneVault.write("notes/b.md", new TextEncoder().encode("local draft"));
    await desktopVault.move("notes/a.md", "notes/b.md");
    await desktop.synchronize();

    const result = await phone.synchronize();

    expect(result.status).toBe("action-required");
    expect(result.localIssues).toEqual([
      { kind: "path-collision", paths: ["notes/b.md"] },
    ]);
    expect(phoneVault.readText("notes/a.md")).toBe("remote");
    expect(phoneVault.readText("notes/b.md")).toBe("local draft");
  });

  it.each(["source", "target"])("does not retire a move copy after a new %s edit", async edited => {
    const remote = await RemoteStore.open({objects: new MemoryObjectStore(), prefix: "changed-move", vaultKey: new Uint8Array(32)});
    const source = new MemoryVault(), local = new MemoryVault();
    const desktop = new SyncService({remote, local: source, cache: new MemorySyncCache(), replicaId: "desktop"});
    const phone = new SyncService({remote, local, cache: new MemorySyncCache(), replicaId: "phone"});
    await source.write("old.md", new TextEncoder().encode("original"));
    await desktop.initializeNew("vault");
    await phone.synchronize();
    await source.move("old.md", "new.md");
    await desktop.synchronize();
    await local.write("new.md", new TextEncoder().encode("original"));
    await local.write(edited === "source" ? "old.md" : "new.md", new TextEncoder().encode("new draft"));

    const result = await phone.synchronize();

    expect(result.status).toBe("action-required");
    expect(local.readText("old.md")).toBe(edited === "source" ? "new draft" : "original");
    expect(local.readText("new.md")).toBe(edited === "target" ? "new draft" : "original");
  });

  it("does not merge equal bytes when the occupied target belongs to another Entry", async () => {
    const remote = await RemoteStore.open({objects: new MemoryObjectStore(), prefix: "owned-target", vaultKey: new Uint8Array(32)});
    const local = new MemoryVault();
    const service = new SyncService({remote, local, cache: new MemorySyncCache(), replicaId: "phone"});
    await local.write("old.md", new TextEncoder().encode("same"));
    await local.write("new.md", new TextEncoder().encode("same"));
    await service.initializeNew("vault");
    const head = (await remote.readHead())!;
    const snapshot = await remote.readSnapshot(head.value);
    const moved = Object.values(snapshot.entries).map(entry => ({...entry, path: entry.path === "old.md" ? "new.md" : "other.md"}));
    await remote.advance({expectedHeadEtag: head.etag, head: {...head.value, commitId: "moved", generation: 2},
      commit: {commitId: "moved", vaultId: "vault", protocolVersion: 1, replicaId: "desktop", createdAt: head.serverDate,
        parentIds: [head.value.commitId], changes: moved.map(entry => ({kind: "set-entry", entry}))}});
    const result = await service.synchronize();
    expect(result.status).toBe("action-required");
    expect(local.readText("old.md")).toBe("same");
    expect(local.readText("new.md")).toBe("same");
  });

  it("does not retire a copied move when a conflicted Entry also owns the remote target", async () => {
    const remote = await RemoteStore.open({objects: new MemoryObjectStore(), prefix: "conflicted-target", vaultKey: new Uint8Array(32)});
    const local = new MemoryVault(), cache = new MemorySyncCache();
    const service = new SyncService({remote, local, cache, replicaId: "phone"});
    await local.write("old.md", new TextEncoder().encode("original"));
    await service.initializeNew("vault");
    const head = (await remote.readHead())!;
    const source = Object.values((await remote.readSnapshot(head.value)).entries)[0]!;
    if (source.kind !== "live") throw new Error("Expected live fixture");
    await remote.advance({expectedHeadEtag: head.etag, head: {...head.value, commitId: "occupied", generation: 2},
      commit: {commitId: "occupied", vaultId: "vault", protocolVersion: 1, replicaId: "other", createdAt: head.serverDate,
        parentIds: [head.value.commitId], changes: [
          {kind: "set-entry", entry: {...source, path: "new.md"}},
          {kind: "set-entry", entry: {kind: "conflicted", entryId: "another-entry", path: "new.md", reason: "edit-edit",
            candidates: [source.revision], materializedContentHash: source.revision.contentHash}},
        ]}});
    await local.write("new.md", new TextEncoder().encode("original"));
    const result = await service.synchronize();
    expect(result.cacheUpdated).toBe(false);
    expect(result.localIssues).toEqual([{kind: "path-collision", paths: ["new.md"]}]);
    expect(local.readText("old.md")).toBe("original");
    expect(local.readText("new.md")).toBe("original");
    expect(cache.state!.snapshot.commitId).toBe(head.value.commitId);
  });

  it("preserves both move copies when the authenticated remote recovery is damaged", async () => {
    const objects = new MemoryObjectStore();
    const remote = await RemoteStore.open({objects, prefix: "damaged-move", vaultKey: new Uint8Array(32)});
    const source = new MemoryVault(), local = new MemoryVault();
    const desktop = new SyncService({remote, local: source, cache: new MemorySyncCache(), replicaId: "desktop"});
    const phone = new SyncService({remote, local, cache: new MemorySyncCache(), replicaId: "phone"});
    await source.write("old.md", new TextEncoder().encode("original"));
    await desktop.initializeNew("vault");
    await phone.synchronize();
    await source.move("old.md", "new.md");
    await desktop.synchronize();
    const snapshot = await remote.readSnapshot((await remote.readHead())!.value);
    const entry = Object.values(snapshot.entries)[0]!;
    if (entry.kind !== "live") throw new Error("Expected live fixture");
    await objects.put(`damaged-move/v1/blobs/${entry.revision.blobId}`, new TextEncoder().encode("damaged ciphertext"));
    await local.write("new.md", new TextEncoder().encode("original"));
    await expect(phone.synchronize()).rejects.toThrow("在远端没有可核实的恢复副本");
    expect(local.readText("old.md")).toBe("original");
    expect(local.readText("new.md")).toBe("original");
  });

  it("resolves an occupied remote-move target by renaming the local draft and preserves both contents", async () => {
    const objects = new MemoryObjectStore();
    const remote = await RemoteStore.open({objects, prefix: "collision", vaultKey: new Uint8Array(32)});
    const source = new MemoryVault();
    const local = new MemoryVault();
    const cache = new MemorySyncCache();
    const tracker = new PathRenameTracker();
    const desktop = new SyncService({remote, local: source, cache: new MemorySyncCache(), replicaId: "source"});
    const service = new SyncService({remote, local, cache, replicaId: "target"});
    await source.write("notes/a.md", new TextEncoder().encode("remote original"));
    await desktop.initializeNew("vault");
    await service.synchronize();
    const originalId = cache.state!.files["notes/a.md"]!.entryId;
    await local.write("notes/b.md", new TextEncoder().encode("local draft"));
    await source.move("notes/a.md", "notes/b.md");
    await desktop.synchronize();
    expect((await service.synchronize()).localIssues).toEqual([{kind: "path-collision", paths: ["notes/b.md"]}]);
    const review = await service.reviewPathCollision(["notes/b.md"], tracker.capture());
    expect(review.localFiles[0]?.preview).toBe("local draft");
    expect(review.remoteFiles[0]?.preview).toBe("remote original");
    expect(review.remoteFiles[0]?.previousPath).toBe("notes/a.md");
    expect(review.relatedPaths).toContain("notes/a.md");
    await service.resolvePathCollision({paths: review.paths, reviewToken: review.reviewToken, side: "local",
      path: "notes/b.md", newName: "b-local-draft.md"}, tracker.capture(), collisionJournal(local, cache, tracker));
    expect(local.readText("notes/b-local-draft.md")).toBe("local draft");
    expect((await service.synchronize([], {pathRenames: tracker.capture()})).status).toBe("complete");
    expect(local.readText("notes/b.md")).toBe("remote original");
    expect(cache.state!.files["notes/b.md"]!.entryId).toBe(originalId);
    expect(local.readText("notes/b-local-draft.md")).toBe("local draft");
    await desktop.synchronize();
    expect(source.readText("notes/b-local-draft.md")).toBe("local draft");
  });

  it("resolves a reused local old path without stealing the pending move's identity", async () => {
    const remote = await RemoteStore.open({objects: new MemoryObjectStore(), prefix: "collision", vaultKey: new Uint8Array(32)});
    const local = new MemoryVault();
    const cache = new MemorySyncCache();
    const tracker = new PathRenameTracker();
    const service = new SyncService({remote, local, cache, replicaId: "local"});
    await local.write("b.md", new TextEncoder().encode("tracked original"));
    await service.initializeNew("vault");
    const id = cache.state!.files["b.md"]!.entryId;
    await local.move("b.md", "c.md");
    tracker.record(Object.values(cache.state!.files), "b.md", "c.md");
    await local.write("b.md", new TextEncoder().encode("new draft"));
    expect((await service.synchronize([], {pathRenames: tracker.capture()})).localIssues).toEqual([{kind: "path-collision", paths: ["b.md"]}]);
    const review = await service.reviewPathCollision(["b.md"], tracker.capture());
    expect(review.localFiles[0]?.entryId).toBeUndefined();
    expect(review.pendingMoves).toEqual([{from: "b.md", to: "c.md"}]);
    await service.resolvePathCollision({paths: review.paths, reviewToken: review.reviewToken, side: "local",
      path: "b.md", newName: "draft.md"}, tracker.capture(), collisionJournal(local, cache, tracker));
    expect(tracker.serialize()).toEqual({"b.md": {entryId: id, toPath: "c.md"}});
    expect((await service.synchronize([], {pathRenames: tracker.capture()})).status).toBe("complete");
    expect(cache.state!.files["c.md"]!.entryId).toBe(id);
    expect(local.readText("c.md")).toBe("tracked original");
    expect(local.readText("draft.md")).toBe("new draft");
    expect(cache.state!.files["draft.md"]!.entryId).not.toBe(id);
  });

  it("separates duplicate S3 path owners without changing either identity or history", async () => {
    const remote = await RemoteStore.open({objects: new MemoryObjectStore(), prefix: "collision", vaultKey: new Uint8Array(32)});
    const local = new MemoryVault();
    const cache = new MemorySyncCache();
    const tracker = new PathRenameTracker();
    const service = new SyncService({remote, local, cache, replicaId: "test"});
    await local.write("a.md", new TextEncoder().encode("file a"));
    await local.write("b.md", new TextEncoder().encode("file b"));
    await service.initializeNew("vault");
    await local.write("b.md", new TextEncoder().encode("updated b"));
    await service.synchronize();
    const head = (await remote.readHead())!;
    const snapshot = await remote.readSnapshot(head.value);
    const b = Object.values(snapshot.entries).find(entry => entry.path === "b.md")!;
    const duplicated = {...b, path: "a.md"};
    const commitId = crypto.randomUUID();
    await remote.advance({expectedHeadEtag: head.etag, head: {...head.value, commitId},
      commit: {commitId, vaultId: snapshot.vaultId, protocolVersion: 1, createdAt: head.serverDate,
        parentIds: [head.value.commitId], replicaId: "old-client", changes: [{kind: "set-entry", entry: duplicated}]}});
    expect((await service.synchronize()).localIssues.some(issue => issue.kind === "path-collision")).toBe(true);
    const review = await service.reviewPathCollision(["a.md"], tracker.capture());
    expect(review.remoteFiles).toHaveLength(2);
    const before = structuredClone(cache.state);
    await service.resolvePathCollision({paths: review.paths, reviewToken: review.reviewToken, side: "remote",
      path: "a.md", entryId: b.entryId, newName: "b-kept.md"}, tracker.capture(), collisionJournal(local, cache, tracker));
    expect(cache.state).toEqual(before);
    const repaired = await remote.readSnapshot((await remote.readHead())!.value);
    expect(repaired.entries[b.entryId]).toEqual({...b, path: "b-kept.md"});
    expect((await service.synchronize()).status).toBe("complete");
    expect(local.readText("a.md")).toBe("file a");
    expect(local.readText("b-kept.md")).toBe("updated b");
    expect(cache.state!.files["b-kept.md"]!.entryId).toBe(b.entryId);
  });

  it("preserves a stale deleted local identity as a new file without reviving its deletion record", async () => {
    const remote = await RemoteStore.open({objects: new MemoryObjectStore(), prefix: "collision", vaultKey: new Uint8Array(32)});
    const source = new MemoryVault();
    const local = new MemoryVault();
    const cache = new MemorySyncCache();
    const tracker = new PathRenameTracker();
    const sourceService = new SyncService({remote, local: source, cache: new MemorySyncCache(), replicaId: "source"});
    const service = new SyncService({remote, local, cache, replicaId: "target"});
    await source.write("a.md", new TextEncoder().encode("old a"));
    await source.write("b.md", new TextEncoder().encode("file b"));
    await sourceService.initializeNew("vault");
    await service.synchronize();
    const deletedId = cache.state!.files["a.md"]!.entryId;
    const liveId = cache.state!.files["b.md"]!.entryId;
    await source.delete("a.md");
    const deletion = await sourceService.synchronize();
    await sourceService.synchronize(deletion.bulkDeletion!.entryIds);
    await source.move("b.md", "a.md");
    await sourceService.synchronize();
    expect((await service.synchronize()).localIssues).toContainEqual({kind: "path-collision", paths: ["a.md"]});
    const review = await service.reviewPathCollision(["a.md"], tracker.capture());
    expect(review.localFiles[0]?.preserveAsNew).toBe(true);
    await service.resolvePathCollision({paths: review.paths, reviewToken: review.reviewToken, side: "local",
      path: "a.md", newName: "a-kept.md"}, tracker.capture(), collisionJournal(local, cache, tracker));
    expect((await service.synchronize()).status).toBe("complete");
    const snapshot = await remote.readSnapshot((await remote.readHead())!.value);
    expect(snapshot.entries[deletedId]?.kind).toBe("deleted");
    expect(cache.state!.files["a.md"]!.entryId).toBe(liveId);
    expect(cache.state!.files["a-kept.md"]!.entryId).not.toBe(deletedId);
    expect(local.readText("a-kept.md")).toBe("old a");
    expect(local.readText("a.md")).toBe("file b");
  });

  it.each(["occupied.md", "OCCUPIED.md", "../escape.md", "bad:name.md", "_excluded.md"])(
    "rejects unsafe or remotely occupied rename destination %s before publication", async newName => {
      const remote = await RemoteStore.open({objects: new MemoryObjectStore(), prefix: "collision", vaultKey: new Uint8Array(32)});
      const source = new MemoryVault();
      await source.write("note.md", new TextEncoder().encode("note"));
      await source.write("occupied.md/child.md", new TextEncoder().encode("child"));
      await new SyncService({remote, local: source, cache: new MemorySyncCache(), replicaId: "source"}).initializeNew("vault");
      const local = new MemoryVault();
      const cache = new MemorySyncCache();
      const tracker = new PathRenameTracker();
      const service = new SyncService({remote, local, cache, replicaId: "target"});
      const review = await service.reviewPathCollision(["note.md"], tracker.capture());
      const head = await remote.readHead();
      await expect(service.resolvePathCollision({paths: review.paths, reviewToken: review.reviewToken, side: "remote",
        path: "note.md", entryId: review.remoteFiles[0]!.entryId, newName}, tracker.capture(), collisionJournal(local, cache, tracker))).rejects.toThrow();
      expect(await remote.readHead()).toEqual(head);
      expect(await local.list()).toEqual([]);
    },
  );

  it("rejects collision rename after a local edit without moving anything", async () => {
    const remote = await RemoteStore.open({objects: new MemoryObjectStore(), prefix: "collision", vaultKey: new Uint8Array(32)});
    const local = new MemoryVault();
    const cache = new MemorySyncCache();
    const tracker = new PathRenameTracker();
    const service = new SyncService({remote, local, cache, replicaId: "test"});
    await local.write("note.md", new TextEncoder().encode("first"));
    await service.initializeNew("vault");
    const review = await service.reviewPathCollision(["note.md"], tracker.capture());
    await local.write("note.md", new TextEncoder().encode("typing"));
    const head = await remote.readHead();
    await expect(service.resolvePathCollision({paths: review.paths, reviewToken: review.reviewToken, side: "local",
      path: "note.md", newName: "renamed.md"}, tracker.capture(), collisionJournal(local, cache, tracker))).rejects.toThrow("文件或同步记录有变化");
    expect(await remote.readHead()).toEqual(head);
    expect(local.readText("note.md")).toBe("typing");
    expect(local.readText("renamed.md")).toBeUndefined();
  });

  it("rejects a remote rename into an existing empty local directory", async () => {
    const remote = await RemoteStore.open({objects: new MemoryObjectStore(), prefix: "collision", vaultKey: new Uint8Array(32)});
    const source = new MemoryVault();
    await source.write("note.md", new TextEncoder().encode("note"));
    await new SyncService({remote, local: source, cache: new MemorySyncCache(), replicaId: "source"}).initializeNew("vault");
    const local: LocalVaultPort = new MemoryVault();
    local.pathExists = async path => path.toLowerCase() === "empty.md";
    const cache = new MemorySyncCache();
    const tracker = new PathRenameTracker();
    const service = new SyncService({remote, local, cache, replicaId: "target"});
    const review = await service.reviewPathCollision(["note.md"], tracker.capture());
    const head = await remote.readHead();
    await expect(service.resolvePathCollision({paths: review.paths, reviewToken: review.reviewToken, side: "remote",
      path: "note.md", entryId: review.remoteFiles[0]!.entryId, newName: "EMPTY.md"}, tracker.capture(), collisionJournal(local, cache, tracker)))
      .rejects.toThrow("已被占用");
    expect(await remote.readHead()).toEqual(head);
  });

  it("preserves a target created after a remote move was planned", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const desktopRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const phoneRemote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const desktopVault = new MemoryVault();
    const phoneVault = new MemoryVault();
    await desktopVault.write("notes/a.md", new TextEncoder().encode("remote"));
    const desktop = new SyncService({
      cache: new MemorySyncCache(),
      local: desktopVault,
      remote: desktopRemote,
      replicaId: "desktop",
    });
    const phone = new SyncService({
      cache: new MemorySyncCache(),
      local: phoneVault,
      remote: phoneRemote,
      replicaId: "phone",
    });
    await desktop.initializeNew("vault-1");
    await phone.synchronize();
    await desktopVault.move("notes/a.md", "notes/b.md");
    await desktop.synchronize();
    phoneVault.beforeMove = async (_fromPath, toPath) => {
      phoneVault.beforeMove = undefined;
      await phoneVault.write(toPath, new TextEncoder().encode("last-moment draft"));
    };

    await expect(phone.synchronize()).rejects.toThrow(
      "同步过程中本地文件被改动：notes/b.md",
    );

    expect(phoneVault.readText("notes/a.md")).toBe("remote");
    expect(phoneVault.readText("notes/b.md")).toBe("last-moment draft");
  });

  it("blocks an offline rename when a new file reuses the old path", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    await local.write("notes/b.md", new TextEncoder().encode("tracked"));
    const cache = new MemorySyncCache();
    const service = new SyncService({
      cache,
      local,
      remote,
      replicaId: "desktop",
    });
    await service.initializeNew("vault-1");
    const initialHead = await remote.readHead();
    if (!initialHead || !cache.state) {
      throw new Error("Expected initialized state");
    }
    await local.move("notes/b.md", "notes/c.md");
    const cachedFile = cache.state.files["notes/b.md"];
    if (!cachedFile) {
      throw new Error("Expected cached Entry");
    }
    await local.write("notes/b.md", new TextEncoder().encode("new local file"));

    const result = await service.synchronize([], {
      pathRenames: new Map([
        [
          "notes/b.md",
          { entryId: cachedFile.entryId, toPath: "notes/c.md" },
        ],
      ]),
    });

    expect(result.status).toBe("action-required");
    expect(result.localIssues).toEqual([
      { kind: "path-collision", paths: ["notes/b.md"] },
    ]);
    expect(local.readText("notes/b.md")).toBe("new local file");
    expect(local.readText("notes/c.md")).toBe("tracked");
    await expect(remote.readHead()).resolves.toMatchObject({
      value: { commitId: initialHead.value.commitId },
    });
  });

  it("ignores a persisted rename after its Entry is already cached at the target", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    await local.write("notes/b.md", new TextEncoder().encode("tracked"));
    const cache = new MemorySyncCache();
    const service = new SyncService({
      cache,
      local,
      remote,
      replicaId: "desktop",
    });
    await service.initializeNew("vault-1");
    const tracked = cache.state?.files["notes/b.md"];
    if (!tracked) {
      throw new Error("Expected cached Entry");
    }
    const rename = new Map([
      [
        "notes/b.md",
        { entryId: tracked.entryId, toPath: "notes/c.md" },
      ],
    ]);
    await local.move("notes/b.md", "notes/c.md");
    await service.synchronize([], { pathRenames: rename });
    await local.write("notes/b.md", new TextEncoder().encode("new file"));

    const result = await service.synchronize([], { pathRenames: rename });

    expect(result.status).toBe("complete");
    const currentHead = await remote.readHead();
    if (!currentHead) {
      throw new Error("Expected current Head");
    }
    const current = await remote.readSnapshot(currentHead.value);
    expect(current.entries[tracked.entryId]).toMatchObject({
      entryId: tracked.entryId,
      kind: "live",
      path: "notes/c.md",
    });
    expect(Object.values(current.entries)).toContainEqual(
      expect.objectContaining({ kind: "live", path: "notes/b.md" }),
    );
  });

  it.each([2, 148])("recovers a chained folder rename of %i files after cache rebuilding loses the intermediate paths", async count => {
    const objects = new MemoryObjectStore();
    const remote = await RemoteStore.open({
      objects, prefix: "chosen-prefix", vaultKey: new Uint8Array(32),
    });
    const local = new MemoryVault();
    await local.write("original/table.csv", new TextEncoder().encode("a,b\n1,2"));
    await local.write("original/article.md", new TextEncoder().encode("before"));
    for (let index = 2; index < count; index += 1) {
      await local.write(`original/${index}.csv`, new TextEncoder().encode("identical empty table"));
    }
    const cache = new MemorySyncCache();
    const service = new SyncService({ cache, local, remote, replicaId: "desktop" });
    await service.initializeNew("vault-1");
    const entries = Object.values(cache.state!.snapshot.entries);
    const renames = new Map(entries.map(entry => [
      entry.path, { entryId: entry.entryId, toPath: entry.path.replace("original/", "middle/") },
    ]));
    for (const entry of entries) await local.move(entry.path, renames.get(entry.path)!.toPath);
    // The second move arrives while the first Head is being published, before buildCache.
    objects.onPut = async key => {
      if (!key.endsWith("/head")) return;
      objects.onPut = undefined;
      for (const rename of renames.values()) {
        const previous = rename.toPath;
        rename.toPath = previous.replace("middle/", "final/");
        await local.move(previous, rename.toPath);
      }
      await local.write("final/article.md", new TextEncoder().encode("edited during move"));
    };
    await service.synchronize([], { pathRenames: new Map([...renames].map(([key, value]) => [key, { ...value }])) });
    expect(Object.keys(cache.state!.files)).toHaveLength(0);
    expect(Object.values(cache.state!.snapshot.entries).every(entry => entry.path.startsWith("middle/"))).toBe(true);

    const result = await service.synchronize([], { pathRenames: renames });

    expect(result.status).toBe("complete");
    expect(result.localIssues).toEqual([]);
    const snapshot = await remote.readSnapshot((await remote.readHead())!.value);
    expect(Object.keys(snapshot.entries).sort()).toEqual(entries.map(entry => entry.entryId).sort());
    for (const entry of entries) {
      expect(snapshot.entries[entry.entryId]).toMatchObject({kind: "live", path: entry.path.replace("original/", "final/")});
    }
    expect(local.readText("final/article.md")).toBe("edited during move");
    expect((await service.synchronize()).uploaded).toBe(0);
  });

  it.each(["edit", "delete"])("preserves the local draft when a recovered rename meets a concurrent remote %s", async action => {
    const remote = await RemoteStore.open({objects: new MemoryObjectStore(), prefix: "test", vaultKey: new Uint8Array(32)});
    const local = new MemoryVault();
    await local.write("middle/article.md", new TextEncoder().encode("base"));
    await local.write("other.md", new TextEncoder().encode("other"));
    await local.write("third.md", new TextEncoder().encode("third"));
    await local.write("fourth.md", new TextEncoder().encode("fourth"));
    await local.write("fifth.md", new TextEncoder().encode("fifth"));
    const cache = new MemorySyncCache();
    const service = new SyncService({cache, local, remote, replicaId: "desktop"});
    await service.initializeNew("vault");
    const entryId = cache.state!.files["middle/article.md"]!.entryId;
    const other = new MemoryVault();
    const otherService = new SyncService({cache: new MemorySyncCache(), local: other, remote, replicaId: "phone"});
    await otherService.synchronize();
    if (action === "edit") await other.write("middle/article.md", new TextEncoder().encode("remote draft"));
    else await other.delete("middle/article.md");
    await otherService.synchronize();
    await local.move("middle/article.md", "final/article.md");
    await local.write("final/article.md", new TextEncoder().encode("local draft"));
    delete cache.state!.files["middle/article.md"];

    const result = await service.synchronize([], {pathRenames: new Map([
      ["original/article.md", {entryId, toPath: "final/article.md"}],
    ])});

    expect(result.status).toBe("action-required");
    expect(result.localIssues.some(issue => issue.kind === "possible-rename")).toBe(false);
    const entry = (await remote.readSnapshot((await remote.readHead())!.value)).entries[entryId]!;
    if (entry.kind !== "conflicted") throw new Error("Expected conflict preserving the renamed draft");
    const contents = await Promise.all(entry.candidates.map(async revision =>
      new TextDecoder().decode(await remote.readBlob(revision.blobId)),
    ));
    expect(contents).toContain("local draft");
    if (action === "edit") expect(contents).toContain("remote draft");
  });

  it("keeps a recovered chained rename blocked when the accepted old path is reused", async () => {
    const remote = await RemoteStore.open({objects: new MemoryObjectStore(), prefix: "test", vaultKey: new Uint8Array(32)});
    const local = new MemoryVault();
    await local.write("middle/file.md", new TextEncoder().encode("original"));
    const cache = new MemorySyncCache();
    const service = new SyncService({cache, local, remote, replicaId: "desktop"});
    await service.initializeNew("vault");
    const file = cache.state!.files["middle/file.md"]!;
    await local.move("middle/file.md", "final/file.md");
    await local.write("middle/file.md", new TextEncoder().encode("new occupant"));
    cache.state!.files = {};
    const before = (await remote.readHead())!.value.commitId;
    const result = await service.synchronize([], {pathRenames: new Map([
      ["original/file.md", {entryId: file.entryId, toPath: "final/file.md"}],
    ])});
    expect(result.status).toBe("action-required");
    expect(result.localIssues.some(issue => issue.kind === "path-collision")).toBe(true);
    expect((await remote.readHead())!.value.commitId).toBe(before);
    expect(local.readText("middle/file.md")).toBe("new occupant");
    expect(local.readText("final/file.md")).toBe("original");
  });

  describe("possible rename review", () => {
    // unrelated：无关的存活文件数。被扣住的消失 Entry 计入 Bulk Deletion 门槛，补足它们才能走挪动审查而不是批量删除
    const setupReview = async (count = 1, unrelated = 20) => {
      const objects = new MemoryObjectStore();
      const remote = await RemoteStore.open({objects, prefix: "test", vaultKey: new Uint8Array(32)});
      const local = new MemoryVault();
      for (let index = 0; index < count; index += 1) {
        await local.write(`old/${index}.md`, new TextEncoder().encode(`original ${index}`));
      }
      for (let index = 0; index < unrelated; index += 1) {
        await local.write(`keep/${index}.md`, new TextEncoder().encode(`keep ${index}`));
      }
      const cache = new MemorySyncCache();
      const service = new SyncService({cache, local, remote, replicaId: "desktop"});
      await service.initializeNew("vault");
      const original = structuredClone(cache.state!);
      for (let index = 0; index < count; index += 1) {
        await local.move(`old/${index}.md`, `new/${index}.md`);
        await local.write(`new/${index}.md`, new TextEncoder().encode(`edited ${index}`));
      }
      const review = await service.synchronize();
      const issue = review.localIssues.find(issue => issue.kind === "possible-rename");
      if (!issue) throw new Error("Expected rename review");
      return {objects, remote, local, cache, service, original, issue, review};
    };

    it("accepts a reviewed folder move with edits, retaining every Entry and old content", async () => {
      const {service, issue, remote, original, review} = await setupReview(3);
      expect(review.bulkDeletion).toBeUndefined();
      const result = await service.synchronize([], {renameResolution: {
        kind: "moves", reviewToken: issue.reviewToken,
        pairs: issue.oldPaths.map(fromPath => ({fromPath, toPath: fromPath.replace("old/", "new/")})),
      }});
      expect(result.status).toBe("complete");
      const snapshot = await remote.readSnapshot((await remote.readHead())!.value);
      expect(Object.keys(snapshot.entries).sort()).toEqual(Object.keys(original.snapshot.entries).sort());
      const moved = Object.values(snapshot.entries).filter(entry => !entry.path.startsWith("keep/"));
      expect(moved).toHaveLength(3);
      for (const entry of moved) {
        expect(entry.kind).toBe("live");
        expect(entry.path.startsWith("new/")).toBe(true);
        expect(entry.history?.[0]?.contentHash).toBe(
          original.files[entry.path.replace("new/", "old/")]!.contentHash,
        );
      }
    });

    it.each(["local-edit", "new-file", "remote-edit", "wrong-token"])(
      "rejects a stale review after %s without publishing or deleting files", async change => {
        const {service, issue, local, remote, review} = await setupReview();
        expect(review.bulkDeletion).toBeUndefined();
        if (change === "local-edit") await local.write("new/0.md", new TextEncoder().encode("newer draft"));
        if (change === "new-file") await local.write("new/extra.md", new TextEncoder().encode("extra draft"));
        if (change === "remote-edit") {
          const other = new MemoryVault();
          const otherService = new SyncService({cache: new MemorySyncCache(), local: other, remote, replicaId: "phone"});
          await otherService.synchronize();
          await other.write("old/0.md", new TextEncoder().encode("remote draft"));
          await otherService.synchronize();
        }
        const before = (await remote.readHead())!.value.commitId;
        await expect(service.synchronize([], {renameResolution: {
          kind: "separate", reviewToken: change === "wrong-token" ? "stale" : issue.reviewToken,
        }})).rejects.toThrow("审查挪动之后文件或远端状态有变化");
        expect((await remote.readHead())!.value.commitId).toBe(before);
        expect(local.readText("new/0.md")).toBe(change === "local-edit" ? "newer draft" : "edited 0");
      },
    );

    it("rejects a mapping that assigns two old Entries to the same new file", async () => {
      const {service, issue, review} = await setupReview(2);
      expect(review.bulkDeletion).toBeUndefined();
      await expect(service.synchronize([], {renameResolution: {kind: "moves", reviewToken: issue.reviewToken,
        pairs: issue.oldPaths.map(fromPath => ({fromPath, toPath: "new/0.md"})),
      }})).rejects.toThrow("不是一对一的");
    });

    it("requires exact bulk-delete confirmation after separate delete/add review", async () => {
      // 不补无关文件：分开处理后的删除集合与审查时被扣住的集合相同，要让前者成为批量删除，审查阶段也必然超过门槛
      const {service, issue, remote, local} = await setupReview(2, 0);
      const before = (await remote.readHead())!.value.commitId;
      const resolution = {kind: "separate" as const, reviewToken: issue.reviewToken};
      const blocked = await service.synchronize([], {renameResolution: resolution});
      expect(blocked.bulkDeletion?.count).toBe(2);
      expect(blocked.cacheUpdated).toBe(false);
      expect((await remote.readHead())!.value.commitId).toBe(before);
      const result = await service.synchronize(blocked.bulkDeletion!.entryIds, {renameResolution: resolution});
      expect(result.status).toBe("complete");
      const snapshot = await remote.readSnapshot((await remote.readHead())!.value);
      expect(Object.values(snapshot.entries).filter(entry => entry.kind === "deleted")).toHaveLength(2);
      expect(Object.values(snapshot.entries).filter(entry => entry.kind === "live")).toHaveLength(2);
      expect(local.readText("new/0.md")).toBe("edited 0");
    });
  });

  describe("held unobserved moves", () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    const notes = ["a.md", "b.md", "c.md", "d.md", "e.md"];
    // 2026-10-13 图纸场景：旧 PDF 消失，两个同内容 PDF 新增，另有截图与笔记改动
    const setupDrawings = async () => {
      const remote = await RemoteStore.open({objects: new MemoryObjectStore(), prefix: "test", vaultKey: new Uint8Array(32)});
      const local = new MemoryVault();
      await local.write("TM/8799-D R1.pdf", encode("drawing"));
      for (const note of notes) await local.write(note, encode(`note ${note}`));
      const cache = new MemorySyncCache();
      const service = new SyncService({cache, local, remote, replicaId: "desktop"});
      await service.initializeNew("vault");
      const pdfEntryId = cache.state!.files["TM/8799-D R1.pdf"]!.entryId;
      const other = new MemoryVault();
      const otherService = new SyncService({cache: new MemorySyncCache(), local: other, remote, replicaId: "phone"});
      await otherService.synchronize();
      await other.write("b.md", encode("remote edit"));
      await otherService.synchronize();
      await local.delete("TM/8799-D R1.pdf");
      await local.write("TM/archive/8799-D R1 old.pdf", encode("drawing"));
      await local.write("TM/8797-D R1.pdf", encode("drawing"));
      for (let index = 0; index < 5; index += 1) await local.write(`shots/${index}.png`, encode(`png ${index}`));
      await local.write("a.md", encode("local edit"));
      return {remote, local, cache, service, other, otherService, pdfEntryId};
    };
    const liveByPath = async (remote: RemoteStore) => {
      const snapshot = await remote.readSnapshot((await remote.readHead())!.value);
      return new Map(Object.values(snapshot.entries).flatMap(entry => entry.kind === "live" ? [[entry.path, entry] as const] : []));
    };
    const heldPdfIssue = {
      kind: "possible-rename",
      newPaths: expect.arrayContaining(["TM/archive/8799-D R1 old.pdf", "TM/8797-D R1.pdf"]),
      oldPaths: ["TM/8799-D R1.pdf"],
      reviewToken: expect.any(String),
    };

    it("syncs unrelated changes while holding only the same-type files of an unrecognized move", async () => {
      const {remote, local, service, pdfEntryId} = await setupDrawings();

      const result = await service.synchronize();

      expect(result.status).toBe("action-required");
      expect(result.cacheUpdated).toBe(true);
      expect(result.localIssues).toEqual([heldPdfIssue]);
      const live = await liveByPath(remote);
      for (let index = 0; index < 5; index += 1) expect(live.has(`shots/${index}.png`)).toBe(true);
      const note = live.get("a.md")!;
      expect(new TextDecoder().decode(await remote.readBlob(note.revision.blobId))).toBe("local edit");
      expect(local.readText("b.md")).toBe("remote edit");
      expect(live.get("TM/8799-D R1.pdf")?.entryId).toBe(pdfEntryId);
      expect(live.has("TM/archive/8799-D R1 old.pdf")).toBe(false);
      expect(live.has("TM/8797-D R1.pdf")).toBe(false);
      expect(local.readText("TM/8799-D R1.pdf")).toBeUndefined();
    });

    it("keeps the held files unchanged on the next sync without a decision", async () => {
      const {remote, local, service, pdfEntryId} = await setupDrawings();
      const first = await service.synchronize();
      const firstIssue = first.localIssues.find(issue => issue.kind === "possible-rename");
      const head = (await remote.readHead())!.value.commitId;

      const second = await service.synchronize();

      expect(second.status).toBe("action-required");
      expect(second.localIssues).toEqual([firstIssue]);
      expect(second.downloaded).toBe(0);
      expect(second.uploaded).toBe(0);
      expect((await remote.readHead())!.value.commitId).toBe(head);
      expect(local.readText("TM/8799-D R1.pdf")).toBeUndefined();
      const live = await liveByPath(remote);
      expect(live.get("TM/8799-D R1.pdf")?.entryId).toBe(pdfEntryId);
      expect(live.has("TM/archive/8799-D R1 old.pdf")).toBe(false);
      expect(live.has("TM/8797-D R1.pdf")).toBe(false);
    });

    it("recognizes the held move once only one identical candidate remains", async () => {
      const {remote, local, service, pdfEntryId} = await setupDrawings();
      await service.synchronize();
      await local.delete("TM/8797-D R1.pdf");

      const result = await service.synchronize();

      expect(result.status).toBe("complete");
      expect(result.localIssues).toEqual([]);
      const live = await liveByPath(remote);
      expect(live.get("TM/archive/8799-D R1 old.pdf")?.entryId).toBe(pdfEntryId);
      expect(live.has("TM/8799-D R1.pdf")).toBe(false);
    });

    const setupVault = async (files: Record<string, string>) => {
      const remote = await RemoteStore.open({objects: new MemoryObjectStore(), prefix: "test", vaultKey: new Uint8Array(32)});
      const local = new MemoryVault();
      for (const [path, text] of Object.entries(files)) await local.write(path, encode(text));
      const cache = new MemorySyncCache();
      const service = new SyncService({cache, local, remote, replicaId: "desktop"});
      await service.initializeNew("vault");
      return {remote, local, cache, service};
    };
    const notesVault = (count: number) =>
      Object.fromEntries(Array.from({length: count}, (_, index) => [`note-${index}.md`, `note ${index}`]));
    const entriesById = async (remote: RemoteStore) =>
      (await remote.readSnapshot((await remote.readHead())!.value)).entries;

    it("syncs a missing file as a deletion when only other file types are new", async () => {
      const {remote, local, cache, service} = await setupVault({"drawing.pdf": "drawing", ...notesVault(5)});
      const pdfEntryId = cache.state!.files["drawing.pdf"]!.entryId;
      await local.delete("drawing.pdf");
      await local.write("shot.png", encode("png"));

      const result = await service.synchronize();

      expect(result.status).toBe("complete");
      expect(result.localIssues).toEqual([]);
      expect((await entriesById(remote))[pdfEntryId]).toMatchObject({kind: "deleted", path: "drawing.pdf"});
      expect((await liveByPath(remote)).has("shot.png")).toBe(true);
    });

    it("accepts the earlier review token after unrelated files publish a new Commit", async () => {
      const {remote, local, service, pdfEntryId} = await setupDrawings();
      const issue = (await service.synchronize()).localIssues.find(issue => issue.kind === "possible-rename")!;
      await local.write("c.md", encode("another local edit"));
      expect((await service.synchronize()).uploaded).toBe(1);

      const result = await service.synchronize([], {renameResolution: {kind: "separate", reviewToken: issue.reviewToken}});

      expect(result.status).toBe("complete");
      expect((await entriesById(remote))[pdfEntryId]).toMatchObject({
        kind: "deleted", path: "TM/8799-D R1.pdf", recovery: expect.objectContaining({contentHash: expect.any(String)}),
      });
      const live = await liveByPath(remote);
      expect(live.has("TM/archive/8799-D R1 old.pdf")).toBe(true);
      expect(live.has("TM/8797-D R1.pdf")).toBe(true);
    });

    it("rejects the review token after a held file changes", async () => {
      const {remote, local, service} = await setupDrawings();
      const issue = (await service.synchronize()).localIssues.find(issue => issue.kind === "possible-rename")!;
      await local.write("TM/8797-D R1.pdf", encode("corrected drawing"));
      const before = (await remote.readHead())!.value.commitId;

      await expect(service.synchronize([], {renameResolution: {kind: "separate", reviewToken: issue.reviewToken}}))
        .rejects.toThrow("审查挪动之后文件或远端状态有变化");

      expect((await remote.readHead())!.value.commitId).toBe(before);
      expect((await liveByPath(remote)).has("TM/8797-D R1.pdf")).toBe(false);
    });

    it("confirms a held one-to-one move after unrelated files were synced", async () => {
      const {remote, local, cache, service} = await setupVault({"plan.pdf": "plan v1", ...notesVault(5)});
      const pdfEntryId = cache.state!.files["plan.pdf"]!.entryId;
      const oldHash = cache.state!.files["plan.pdf"]!.contentHash;
      await local.delete("plan.pdf");
      await local.write("archive/plan v2.pdf", encode("plan v2"));
      await local.write("shot.png", encode("png"));
      const first = await service.synchronize();
      expect((await liveByPath(remote)).has("shot.png")).toBe(true);
      const issue = first.localIssues.find(issue => issue.kind === "possible-rename")!;
      expect(issue).toMatchObject({oldPaths: ["plan.pdf"], newPaths: ["archive/plan v2.pdf"]});

      const result = await service.synchronize([], {renameResolution: {kind: "moves", reviewToken: issue.reviewToken,
        pairs: [{fromPath: "plan.pdf", toPath: "archive/plan v2.pdf"}]}});

      expect(result.status).toBe("complete");
      const entry = (await entriesById(remote))[pdfEntryId]!;
      expect(entry).toMatchObject({kind: "live", path: "archive/plan v2.pdf"});
      expect(entry.history?.[0]?.contentHash).toBe(oldHash);
    });

    const setupPartialReview = async () => {
      const vault = await setupVault({"a.pdf": "a v1", "b.pdf": "b v1", ...notesVault(10)});
      const aEntry = vault.cache.state!.files["a.pdf"]!;
      const bEntryId = vault.cache.state!.files["b.pdf"]!.entryId;
      await vault.local.delete("a.pdf");
      await vault.local.delete("b.pdf");
      await vault.local.write("new/x.pdf", encode("x"));
      await vault.local.write("new/y.pdf", encode("y"));
      await vault.local.write("new/z.pdf", encode("z"));
      const issue = (await vault.service.synchronize()).localIssues.find(issue => issue.kind === "possible-rename")!;
      expect(issue).toMatchObject({oldPaths: ["a.pdf", "b.pdf"], newPaths: ["new/x.pdf", "new/y.pdf", "new/z.pdf"]});
      return {...vault, aEntry, bEntryId, issue};
    };

    it("moves only the paired missing Entry, deletes the unpaired one and uploads unchosen new files", async () => {
      const {remote, service, aEntry, bEntryId, issue} = await setupPartialReview();

      const result = await service.synchronize([], {renameResolution: {kind: "moves", reviewToken: issue.reviewToken,
        pairs: [{fromPath: "a.pdf", toPath: "new/x.pdf"}]}});

      expect(result.status).toBe("complete");
      expect(result.localIssues).toEqual([]);
      const entries = await entriesById(remote);
      expect(entries[aEntry.entryId]).toMatchObject({kind: "live", path: "new/x.pdf"});
      expect(entries[aEntry.entryId]!.history?.[0]?.contentHash).toBe(aEntry.contentHash);
      expect(entries[bEntryId]).toMatchObject({
        kind: "deleted", path: "b.pdf", recovery: expect.objectContaining({contentHash: expect.any(String)}),
      });
      const live = await liveByPath(remote);
      for (const path of ["new/y.pdf", "new/z.pdf"]) {
        expect(live.get(path)?.entryId).toBeDefined();
        expect([aEntry.entryId, bEntryId]).not.toContain(live.get(path)!.entryId);
      }
    });

    it("treats a review that maps no missing file like separate deletions and additions", async () => {
      const {remote, service, aEntry, bEntryId, issue} = await setupPartialReview();

      const result = await service.synchronize([], {renameResolution: {kind: "moves", reviewToken: issue.reviewToken, pairs: []}});

      expect(result.status).toBe("complete");
      const entries = await entriesById(remote);
      expect(entries[aEntry.entryId]).toMatchObject({kind: "deleted", path: "a.pdf"});
      expect(entries[bEntryId]).toMatchObject({kind: "deleted", path: "b.pdf"});
      const live = await liveByPath(remote);
      for (const path of ["new/x.pdf", "new/y.pdf", "new/z.pdf"]) expect(live.has(path)).toBe(true);
    });

    it("rejects a move between a missing Entry and a held new file of another type", async () => {
      const {remote, local, service} = await setupVault({"plan.pdf": "plan", "memo.md": "memo", ...notesVault(10)});
      await local.delete("plan.pdf");
      await local.delete("memo.md");
      await local.write("archive/plan v2.pdf", encode("plan v2"));
      await local.write("archive/memo v2.md", encode("memo v2"));
      const issue = (await service.synchronize()).localIssues.find(issue => issue.kind === "possible-rename")!;
      const before = (await remote.readHead())!.value.commitId;

      await expect(service.synchronize([], {renameResolution: {kind: "moves", reviewToken: issue.reviewToken,
        pairs: [{fromPath: "plan.pdf", toPath: "archive/memo v2.md"}]}})).rejects.toThrow("同类型的新文件");

      expect((await remote.readHead())!.value.commitId).toBe(before);
    });

    it("keeps another Replica's edit of a held Entry and the local moved file without publishing a deletion", async () => {
      const {remote, local, cache, service} = await setupVault({"plan.pdf": "plan v1", ...notesVault(5)});
      const pdfEntryId = cache.state!.files["plan.pdf"]!.entryId;
      await local.delete("plan.pdf");
      await local.write("archive/plan v2.pdf", encode("plan v2"));
      const first = await service.synchronize();
      expect(first.localIssues.some(issue => issue.kind === "possible-rename")).toBe(true);
      const phoneFiles = new MemoryVault();
      const phone = new SyncService({cache: new MemorySyncCache(), local: phoneFiles, remote, replicaId: "phone"});
      await phone.synchronize();
      await phoneFiles.write("plan.pdf", encode("plan v1 edited on phone"));
      await phone.synchronize();
      const phoneHash = await sha256Content(encode("plan v1 edited on phone"));

      // 实际结果：被扣住的 Entry 在远端被改后，本机下一次同步把它当作 delete-edit 冲突发布到冲突中心，
      // 新位置的文件作为新文件上传；两份内容都在，不发布删除
      const second = await service.synchronize();
      expect(second.status).toBe("action-required");
      expect(second.localIssues).toEqual([]);
      for (let round = 0; round < 2; round += 1) await service.synchronize();
      await phone.synchronize();

      const entries = await entriesById(remote);
      expect(entries[pdfEntryId]).toMatchObject({kind: "conflicted", path: "plan.pdf", reason: "delete-edit"});
      const conflicted = entries[pdfEntryId];
      if (conflicted?.kind !== "conflicted") throw new Error("Expected conflicted Entry");
      expect(conflicted.candidates.map(candidate => candidate.contentHash)).toContain(phoneHash);
      expect(Object.values(entries).filter(entry => entry.kind === "deleted")).toEqual([]);
      const moved = (await liveByPath(remote)).get("archive/plan v2.pdf");
      expect(moved?.entryId).toBeDefined();
      expect(moved!.entryId).not.toBe(pdfEntryId);
      expect(local.readText("archive/plan v2.pdf")).toBe("plan v2");
      expect(phoneFiles.readText("plan.pdf")).toBe("plan v1 edited on phone");
      expect(phoneFiles.readText("archive/plan v2.pdf")).toBe("plan v2");
    });

    it("counts held missing Entries toward the bulk deletion threshold", async () => {
      const {remote, local, cache, service} = await setupVault({"drawing.pdf": "drawing", ...notesVault(10)});
      const pdfEntryId = cache.state!.files["drawing.pdf"]!.entryId;
      await local.delete("note-0.md");
      await local.delete("note-1.md");
      await local.delete("drawing.pdf");
      await local.write("archive/drawing a.pdf", encode("drawing"));
      await local.write("archive/drawing b.pdf", encode("drawing"));
      const before = (await remote.readHead())!.value.commitId;

      const blocked = await service.synchronize();

      expect(blocked.bulkDeletion?.count).toBe(3);
      expect(blocked.bulkDeletion?.entryIds).toContain(pdfEntryId);
      expect(blocked.cacheUpdated).toBe(false);
      expect((await remote.readHead())!.value.commitId).toBe(before);

      const approved = await service.synchronize(blocked.bulkDeletion!.entryIds);

      expect(approved.status).toBe("action-required");
      expect(approved.localIssues.some(issue => issue.kind === "possible-rename")).toBe(true);
      const entries = await entriesById(remote);
      expect(Object.values(entries).filter(entry => entry.kind === "deleted").map(entry => entry.path).sort())
        .toEqual(["note-0.md", "note-1.md"]);
      expect(entries[pdfEntryId]).toMatchObject({kind: "live", path: "drawing.pdf"});
    });
  });

  it("does not assign one missing Entry identity to two identical new files", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    await local.write("notes/old.md", new TextEncoder().encode("same"));
    // 补足无关的存活文件，让被扣住的消失 Entry 不触发 Bulk Deletion，走挪动审查
    for (let index = 0; index < 5; index += 1) {
      await local.write(`keep/${index}.md`, new TextEncoder().encode(`keep ${index}`));
    }
    const service = new SyncService({
      cache: new MemorySyncCache(),
      local,
      remote,
      replicaId: "desktop",
    });
    await service.initializeNew("vault-1");
    const initialGeneration = (await remote.readHead())?.value.generation;
    await local.delete("notes/old.md");
    await local.write("notes/new-1.md", new TextEncoder().encode("same"));
    await local.write("notes/new-2.md", new TextEncoder().encode("same"));

    const result = await service.synchronize();

    expect(result.status).toBe("action-required");
    expect(result.bulkDeletion).toBeUndefined();
    expect(result.localIssues).toEqual([
      {
        kind: "possible-rename",
        newPaths: ["notes/new-1.md", "notes/new-2.md"],
        oldPaths: ["notes/old.md"],
        reviewToken: expect.any(String),
      },
    ]);
    expect((await remote.readHead())?.value.generation).toBe(initialGeneration);
  });

  describe("same-name move inference among identical candidates", () => {
    const drawing = new TextEncoder().encode("%PDF identical drawing bytes");
    const setupVault = async (files: Record<string, Uint8Array>) => {
      const remote = await RemoteStore.open({objects: new MemoryObjectStore(), prefix: "same-name", vaultKey: new Uint8Array(32)});
      const local = new MemoryVault();
      for (const [path, bytes] of Object.entries(files)) await local.write(path, bytes);
      const cache = new MemorySyncCache();
      const service = new SyncService({cache, local, remote, replicaId: "desktop"});
      await service.initializeNew("vault");
      const readSnapshot = async () => remote.readSnapshot((await remote.readHead())!.value);
      const before = await readSnapshot();
      const entryAt = (path: string) => Object.values(before.entries).find(entry => entry.path === path)!;
      return {remote, local, cache, service, readSnapshot, entryAt};
    };

    it("keeps the Entry of a drawing moved under its own name when an identical new drawing appears", async () => {
      const {local, service, readSnapshot, entryAt} = await setupVault({
        "TM图纸/8799-D (Section) R1.pdf": drawing,
        "notes/project.md": new TextEncoder().encode("v1"),
      });
      const moved = entryAt("TM图纸/8799-D (Section) R1.pdf");
      if (moved.kind !== "live") throw new Error("Expected live fixture");
      await local.move("TM图纸/8799-D (Section) R1.pdf", "TM图纸/过程文档/8799-D (Section) R1.pdf");
      await local.write("TM图纸/8797-D (Section) R1.pdf", drawing);
      for (let index = 1; index <= 5; index += 1) {
        await local.write(`截图/screenshot-${index}.png`, new TextEncoder().encode(`png ${index}`));
      }
      await local.write("notes/project.md", new TextEncoder().encode("v2"));

      const result = await service.synchronize();

      expect(result.status).toBe("complete");
      expect(result.localIssues).toEqual([]);
      const snapshot = await readSnapshot();
      expect(snapshot.entries[moved.entryId]).toMatchObject({
        kind: "live",
        path: "TM图纸/过程文档/8799-D (Section) R1.pdf",
        revision: {blobId: moved.revision.blobId},
      });
      expect(Object.values(snapshot.entries).filter(entry => entry.kind === "deleted")).toEqual([]);
      const livePaths = Object.values(snapshot.entries).filter(entry => entry.kind === "live").map(entry => entry.path).sort();
      expect(livePaths).toEqual([
        "TM图纸/8797-D (Section) R1.pdf",
        "TM图纸/过程文档/8799-D (Section) R1.pdf",
        "notes/project.md",
        ...[1, 2, 3, 4, 5].map(index => `截图/screenshot-${index}.png`),
      ].sort());
      expect((await service.synchronize()).uploaded).toBe(0);
    });

    it("pairs every uniquely same-named move within one identical content group", async () => {
      const {local, service, readSnapshot, entryAt} = await setupVault({
        "图纸/a.pdf": drawing,
        "图纸/b.pdf": drawing,
        "图纸/c.pdf": drawing,
      });
      const ids = ["a", "b", "c"].map(name => entryAt(`图纸/${name}.pdf`).entryId);
      for (const name of ["a", "b", "c"]) await local.move(`图纸/${name}.pdf`, `归档/${name}.pdf`);
      await local.write("图纸/d.pdf", drawing);

      const result = await service.synchronize();

      expect(result.status).toBe("complete");
      expect(result.localIssues).toEqual([]);
      const snapshot = await readSnapshot();
      ["a", "b", "c"].forEach((name, index) => {
        expect(snapshot.entries[ids[index]!]).toMatchObject({kind: "live", path: `归档/${name}.pdf`});
      });
      expect(Object.values(snapshot.entries).filter(entry => entry.kind === "deleted")).toEqual([]);
      expect(Object.values(snapshot.entries).filter(entry => entry.kind === "live").map(entry => entry.path))
        .toContain("图纸/d.pdf");
    });

    // 无关的存活文件：让被扣住的消失 Entry 不触发 Bulk Deletion，走挪动审查
    const unrelated = Object.fromEntries([0, 1, 2, 3, 4].map(index =>
      [`notes/keep-${index}.md`, new TextEncoder().encode(`keep ${index}`)]));

    it("still reviews the move when two identical candidates share the missing name", async () => {
      const {remote, local, service} = await setupVault({"图纸/x.pdf": drawing, ...unrelated});
      const before = (await remote.readHead())!.value.commitId;
      await local.move("图纸/x.pdf", "甲/x.pdf");
      await local.write("乙/x.pdf", drawing);

      const result = await service.synchronize();

      expect(result.status).toBe("action-required");
      expect(result.bulkDeletion).toBeUndefined();
      expect(result.localIssues).toEqual([{
        kind: "possible-rename",
        newPaths: ["甲/x.pdf", "乙/x.pdf"],
        oldPaths: ["图纸/x.pdf"],
        reviewToken: expect.any(String),
      }]);
      expect((await remote.readHead())!.value.commitId).toBe(before);
    });

    it("does not pair a same-named candidate whose path another live Entry owns", async () => {
      const {remote, local, service, readSnapshot, entryAt} = await setupVault({"图纸/x.pdf": drawing, ...unrelated});
      const moved = entryAt("图纸/x.pdf");
      const phoneFiles = new MemoryVault();
      const phone = new SyncService({cache: new MemorySyncCache(), local: phoneFiles, remote, replicaId: "phone"});
      await phone.synchronize();
      await phoneFiles.write("归档/x.pdf", drawing);
      await phone.synchronize();
      const owner = Object.values((await readSnapshot()).entries).find(entry => entry.path === "归档/x.pdf")!;
      await local.move("图纸/x.pdf", "归档/x.pdf");
      await local.write("图纸/y.pdf", drawing);
      const result = await service.synchronize();

      expect(result.bulkDeletion).toBeUndefined();
      // 被占用的同名路径不配对：它归属另一 Entry，剩下的消失/新增照旧进入挪动审查，而不是路径冲突。
      expect(result.localIssues).toEqual([{
        kind: "possible-rename",
        newPaths: ["图纸/y.pdf"],
        oldPaths: ["图纸/x.pdf"],
        reviewToken: expect.any(String),
      }]);

      const snapshot = await readSnapshot();
      expect(snapshot.entries[owner.entryId]).toMatchObject({kind: "live", path: "归档/x.pdf"});
      expect(snapshot.entries[moved.entryId]?.path).not.toBe("归档/x.pdf");
    });

    it("still infers a single identical move whose name changed", async () => {
      const {local, service, readSnapshot, entryAt} = await setupVault({"图纸/x.pdf": drawing});
      const moved = entryAt("图纸/x.pdf");
      await local.move("图纸/x.pdf", "归档/renamed.pdf");

      const result = await service.synchronize();

      expect(result.status).toBe("complete");
      expect((await readSnapshot()).entries[moved.entryId]).toMatchObject({kind: "live", path: "归档/renamed.pdf"});
    });
  });

  describe("one-to-one move inference beside a Pending Path Rename", () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    const setupRenamed = async () => {
      const remote = await RemoteStore.open({objects: new MemoryObjectStore(), prefix: "one-to-one", vaultKey: new Uint8Array(32)});
      const local = new MemoryVault();
      await local.write("notes/a.md", encode("original a"));
      await local.write("notes/d.md", encode("original d"));
      for (let index = 0; index < 10; index += 1) await local.write(`keep/${index}.md`, encode(`keep ${index}`));
      const cache = new MemorySyncCache();
      const service = new SyncService({cache, local, remote, replicaId: "desktop"});
      await service.initializeNew("vault");
      const idA = cache.state!.files["notes/a.md"]!.entryId;
      const idD = cache.state!.files["notes/d.md"]!.entryId;
      const readSnapshot = async () => remote.readSnapshot((await remote.readHead())!.value);
      return {remote, local, cache, service, idA, idD, readSnapshot};
    };

    it("does not infer a renamed source Entry onto another new file with its old content", async () => {
      const {local, service, idA, readSnapshot} = await setupRenamed();
      await local.move("notes/a.md", "notes/b.md");
      await local.write("notes/b.md", encode("edited after rename"));
      await local.write("copy/c.md", encode("original a"));

      const result = await service.synchronize([], {pathRenames: new Map([["notes/a.md", {entryId: idA, toPath: "notes/b.md"}]])});

      // 修复前：copy/c.md 也被推断为 idA，同一 Entry ID 落到两个路径，同步停在 Path Collision
      expect(result.localIssues).toEqual([]);
      expect(result.status).toBe("complete");
      const live = Object.values((await readSnapshot()).entries).filter(entry => entry.kind === "live");
      expect(live.filter(entry => entry.entryId === idA).map(entry => entry.path)).toEqual(["notes/b.md"]);
      const copy = live.find(entry => entry.path === "copy/c.md");
      expect(copy?.entryId).toBeDefined();
      expect(copy?.entryId).not.toBe(idA);
    });

    it("does not infer a missing Entry onto a rename target with its content", async () => {
      const {local, service, idA, idD, readSnapshot} = await setupRenamed();
      await local.move("notes/a.md", "notes/b.md");
      await local.write("notes/b.md", encode("original d"));
      await local.delete("notes/d.md");

      await service.synchronize([], {pathRenames: new Map([["notes/a.md", {entryId: idA, toPath: "notes/b.md"}]])});

      const entries = (await readSnapshot()).entries;
      expect(entries[idA]).toMatchObject({kind: "live", path: "notes/b.md"});
      expect(Object.values(entries).filter(entry => entry.kind === "live" && entry.path === "notes/b.md")).toHaveLength(1);
      expect(entries[idD]?.kind).not.toBe("live");
    });
  });

  it("publishes a rename and edit as one updated live Entry", async () => {
    const objects = new MemoryObjectStore();
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const remote = await RemoteStore.open({
      objects,
      prefix: "chosen-prefix",
      vaultKey,
    });
    const local = new MemoryVault();
    await local.write(
      "notes/example.md",
      new TextEncoder().encode("before rename"),
    );
    const cache = new MemorySyncCache();
    const service = new SyncService({
      cache,
      local,
      remote,
      replicaId: "desktop",
    });
    await service.initializeNew("vault-1");
    const head = await remote.readHead();
    if (!head) {
      throw new Error("Expected initialized Head");
    }
    const before = await remote.readSnapshot(head.value);
    const entryId = Object.values(before.entries)[0]?.entryId;
    if (!entryId) {
      throw new Error("Expected initialized Entry");
    }
    await local.move("notes/example.md", "notes/renamed.md");
    if (!cache.state) {
      throw new Error("Expected initialized cache");
    }
    const cachedFile = cache.state.files["notes/example.md"];
    if (!cachedFile) {
      throw new Error("Expected cached file");
    }
    delete cache.state.files["notes/example.md"];
    cache.state.files["notes/renamed.md"] = {
      ...cachedFile,
      path: "notes/renamed.md",
    };
    await local.write(
      "notes/renamed.md",
      new TextEncoder().encode("edited after rename"),
    );

    await service.synchronize();

    const currentHead = await remote.readHead();
    if (!currentHead) {
      throw new Error("Expected current Head");
    }
    const current = await remote.readSnapshot(currentHead.value);
    expect(current.entries[entryId]).toMatchObject({
      entryId,
      kind: "live",
      path: "notes/renamed.md",
      revision: { size: 19 },
    });
  });
});

describe("a base Revision purged from the remote record", () => {
  const prefix = "purged";
  const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
  const text = (value: string): Uint8Array => new TextEncoder().encode(value);

  const readCurrent = async (remote: RemoteStore) => {
    const head = await remote.readHead();
    if (!head) throw new Error("Expected initialized Head");
    return { head, snapshot: await remote.readSnapshot(head.value) };
  };

  // 模拟票 03 的清理提交：把指定 Revision 从远端记录的 Version History 里去掉；
  // deleteBlobs 再模拟票 04 删掉它们的数据块
  const purgeRevisions = async (
    remote: RemoteStore,
    objects: MemoryObjectStore,
    revisionIds: readonly string[],
    deleteBlobs: boolean,
  ): Promise<void> => {
    const { head, snapshot } = await readCurrent(remote);
    const purged = new Set(revisionIds);
    const blobIds: string[] = [];
    const changes: Array<{ entry: VaultEntry; kind: "set-entry" }> = [];
    for (const entry of Object.values(snapshot.entries)) {
      const removed = (entry.history ?? []).filter((revision) => purged.has(revision.revisionId));
      if (removed.length === 0) continue;
      blobIds.push(...removed.map((revision) => revision.blobId));
      changes.push({
        entry: { ...entry, history: (entry.history ?? []).filter((revision) => !purged.has(revision.revisionId)) },
        kind: "set-entry",
      });
    }
    if (changes.length !== revisionIds.length) throw new Error("Expected every purged Revision in history");
    const commitId = crypto.randomUUID();
    await remote.advance({
      commit: {
        changes, commitId, createdAt: head.serverDate, parentIds: [head.value.commitId],
        protocolVersion: 1, replicaId: "cleanup", vaultId: snapshot.vaultId,
      },
      expectedHeadEtag: head.etag,
      head: { ...head.value, commitId, generation: head.value.generation + 1 },
    });
    if (deleteBlobs) {
      for (const blobId of blobIds) await objects.delete(`${prefix}/v1/blobs/${blobId}`);
    }
  };

  const setup = async (path = "note.md", initial = "v0", maxAutomaticFileBytes?: number) => {
    const objects = new MemoryObjectStore();
    const open = () => RemoteStore.open({ objects, prefix, vaultKey });
    const desktopVault = new MemoryVault();
    await desktopVault.write(path, text(initial));
    // 另有几篇无关笔记，删除一篇不会被当成 Bulk Deletion
    for (const other of ["a.md", "b.md", "c.md", "d.md"]) await desktopVault.write(other, text(other));
    const desktop = new SyncService({
      cache: new MemorySyncCache(), local: desktopVault, remote: await open(), replicaId: "desktop",
    });
    await desktop.initializeNew("vault");
    const phoneVault = new MemoryVault();
    const phoneCache = new MemorySyncCache();
    const phoneRemote = await open();
    const phone = new SyncService({
      cache: phoneCache, local: phoneVault, maxAutomaticFileBytes, remote: phoneRemote, replicaId: "phone",
    });
    await phone.synchronize();
    const unlimitedPhone = new SyncService({ cache: phoneCache, local: phoneVault, remote: phoneRemote, replicaId: "phone" });
    const observer = await open();
    const liveEntry = async (): Promise<LiveEntry> => {
      const entry = Object.values((await readCurrent(observer)).snapshot.entries).find((value) => value.path === path);
      if (entry?.kind !== "live") throw new Error("Expected a live Entry");
      return entry;
    };
    return { desktop, desktopVault, liveEntry, objects, observer, open, phone, phoneCache, phoneVault, unlimitedPhone };
  };

  it.each([
    ["purged from the record", false],
    ["purged and its blob deleted", true],
  ])("downloads a newer Revision over an unchanged copy whose base was %s", async (_label, deleteBlobs) => {
    const fixture = await setup();
    const base = await fixture.liveEntry();
    await fixture.desktopVault.write("note.md", text("v1"));
    await fixture.desktop.synchronize();
    await purgeRevisions(fixture.observer, fixture.objects, [base.revision.revisionId], deleteBlobs);
    const write = vi.spyOn(fixture.phoneVault, "write");

    const result = await fixture.phone.synchronize();

    expect(result).toMatchObject({ downloaded: 1, status: "complete", uploaded: 0 });
    expect(fixture.phoneVault.readText("note.md")).toBe("v1");
    // 被替换的旧字节交给安全写入：写入时带上被替换内容的哈希，由它把旧字节挪进本机回收站
    expect(write).toHaveBeenCalledWith("note.md", expect.any(Uint8Array), base.revision.contentHash);
    expect(fixture.phoneCache.state?.files["note.md"]?.contentHash).toBe(await sha256Content(text("v1")));
  });

  it("clears a recovery recheck left for content the remote record no longer references", async () => {
    const fixture = await setup();
    const base = await fixture.liveEntry();
    await fixture.desktopVault.write("note.md", text("v1"));
    await fixture.desktop.synchronize();
    await purgeRevisions(fixture.observer, fixture.objects, [base.revision.revisionId], true);
    // 旧版本插件在下载覆盖前找不到恢复副本时记下的就是这一项
    const check = { contentHash: base.revision.contentHash, entryId: base.entryId, kind: "recovery" as const };

    await expect(fixture.phone.verifyRemoteIntegrity([check], "vault")).resolves.toBeUndefined();
    await expect(fixture.phone.synchronize()).resolves.toMatchObject({ downloaded: 1, status: "complete" });
    expect(fixture.phoneVault.readText("note.md")).toBe("v1");
  });

  it("clears a recovery recheck recorded by a failed sync once that content is purged from the record", async () => {
    const fixture = await setup();
    const base = await fixture.liveEntry();
    await fixture.desktopVault.write("note.md", text("v1"));
    await fixture.desktop.synchronize();
    // 先由一次真实的同步记下待复查项：v0 的恢复副本还在记录里，但校验不过
    await fixture.objects.put(`${prefix}/v1/blobs/${base.revision.blobId}`, text("damaged"));
    const failure = await fixture.phone.synchronize().then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(RemoteStateError);
    const check = (failure as RemoteStateError).integrityCheck;
    expect(check).toMatchObject({ contentHash: base.revision.contentHash, entryId: base.entryId, kind: "recovery" });
    expect(fixture.phoneVault.readText("note.md")).toBe("v0");
    // 之后 v0 过期被清理出记录、数据块也被删掉
    await purgeRevisions(fixture.observer, fixture.objects, [base.revision.revisionId], true);

    await expect(fixture.phone.verifyRemoteIntegrity([check], "vault")).resolves.toBeUndefined();
    await expect(fixture.phone.synchronize()).resolves.toMatchObject({ downloaded: 1, status: "complete" });
    expect(fixture.phoneVault.readText("note.md")).toBe("v1");
  });

  it("keeps a real local edit as a Conflict instead of downloading over it when its base was purged", async () => {
    const fixture = await setup();
    const base = await fixture.liveEntry();
    await fixture.desktopVault.write("note.md", text("v1"));
    await fixture.desktop.synchronize();
    const remoteEdit = await fixture.liveEntry();
    await purgeRevisions(fixture.observer, fixture.objects, [base.revision.revisionId], true);
    // 本机真的改过：内容与已接受的 base 不同，不适用「旧内容已被清理就直接覆盖」的例外
    await fixture.phoneVault.write("note.md", text("phone edit"));
    const write = vi.spyOn(fixture.phoneVault, "write");
    const generationBefore = (await readCurrent(fixture.observer)).head.value.generation;

    const result = await fixture.phone.synchronize();

    expect(result).toMatchObject({ downloaded: 0, status: "action-required" });
    const after = await readCurrent(fixture.observer);
    expect(after.head.value.generation).toBe(generationBefore + 1);
    const conflicted = after.snapshot.entries[base.entryId];
    if (conflicted?.kind !== "conflicted") throw new Error("Expected a Conflict");
    expect(conflicted).toMatchObject({ reason: "edit-edit" });
    const localCandidate = conflicted.candidates.find((candidate) => candidate.revisionId !== remoteEdit.revision.revisionId);
    if (!localCandidate) throw new Error("Expected the local edit as a candidate");
    expect(new TextDecoder().decode(await fixture.phone.readConflictCandidate(base.entryId, localCandidate.revisionId)))
      .toBe("phone edit");
    // 没有走下载覆盖：本机文件只在本机修改已作为冲突候选发布之后，按冲突的照旧规则显示远端版本，
    // 且改写以本机修改的哈希为前提
    expect(write.mock.calls.filter(([path]) => path === "note.md")).toHaveLength(1);
    expect(write).toHaveBeenCalledWith("note.md", expect.any(Uint8Array), await sha256Content(text("phone edit")));
    expect(fixture.phoneVault.readText("note.md")).toBe("v1");
  });

  const big = "remote content above limit";

  // 手机限 10 字节：电脑改成大文件后手机暂缓下载，本机留着旧的 v0；之后 v0 被清理出记录
  const deferredWithPurgedBase = async (acceptPurgedRecordWhileDeferred: boolean) => {
    const fixture = await setup("note.md", "v0", 10);
    const base = await fixture.liveEntry();
    await fixture.desktopVault.write("note.md", text(big));
    await fixture.desktop.synchronize();
    await expect(fixture.phone.synchronize()).resolves.toMatchObject({ deferredDownloads: 1, downloaded: 0 });
    await purgeRevisions(fixture.observer, fixture.objects, [base.revision.revisionId], true);
    if (acceptPurgedRecordWhileDeferred) {
      // 仍在暂缓时同步一次：缓存接受了已清理的记录，里面再也找不到 v0 这个旧 Revision
      await expect(fixture.phone.synchronize()).resolves.toMatchObject({ deferredDownloads: 1, downloaded: 0 });
    }
    expect(fixture.phoneVault.readText("note.md")).toBe("v0");
    return { ...fixture, base };
  };

  it.each([
    ["while the cache still lists it", false],
    ["after the cache accepted the purged record", true],
  ])("downloads a deferred update after the limit is raised when the old local base was purged %s", async (_label, acceptPurged) => {
    const fixture = await deferredWithPurgedBase(acceptPurged);
    const generationBefore = (await readCurrent(fixture.observer)).head.value.generation;

    const result = await fixture.unlimitedPhone.synchronize();

    expect(result).toMatchObject({ downloaded: 1, status: "complete", uploaded: 0 });
    expect(fixture.phoneVault.readText("note.md")).toBe(big);
    expect((await readCurrent(fixture.observer)).head.value.generation).toBe(generationBefore);
    expect((await fixture.liveEntry()).revision.contentHash).toBe(await sha256Content(text(big)));
  });

  it("manually downloads a deferred update whose old local base was purged", async () => {
    const fixture = await deferredWithPurgedBase(true);

    await fixture.phone.downloadDeferred(fixture.base.entryId);

    expect(fixture.phoneVault.readText("note.md")).toBe(big);
    await expect(fixture.unlimitedPhone.synchronize()).resolves.toMatchObject({ downloaded: 0, status: "complete", uploaded: 0 });
  });

  it("publishes a local deletion with the remote history when the cached history still lists purged content", async () => {
    const fixture = await setup();
    const first = await fixture.liveEntry();
    await fixture.desktopVault.write("note.md", text("v1"));
    await fixture.desktop.synchronize();
    // 手机接受了带 v0 旧版本的记录，之后缓存一直停在清理之前
    await fixture.phone.synchronize();
    expect(fixture.phoneCache.state?.snapshot.entries[first.entryId]?.history?.map((revision) => revision.revisionId))
      .toContain(first.revision.revisionId);
    await purgeRevisions(fixture.observer, fixture.objects, [first.revision.revisionId], true);
    await fixture.phoneVault.delete("note.md");

    await expect(fixture.phone.synchronize()).resolves.toMatchObject({ status: "complete", uploaded: 1 });

    const { snapshot } = await readCurrent(await fixture.open());
    const deleted = snapshot.entries[first.entryId];
    expect(deleted).toMatchObject({ kind: "deleted", recovery: { contentHash: await sha256Content(text("v1")) } });
    expect(deleted?.history?.map((revision) => revision.revisionId) ?? []).not.toContain(first.revision.revisionId);
    await expect(fixture.desktop.synchronize()).resolves.toMatchObject({ deleted: 1, status: "complete" });
  });

  it.each([
    ["purged from the record", false],
    ["purged and its blob deleted", true],
  ])("records a delete-edit Conflict without a base that was %s", async (_label, deleteBlobs) => {
    const fixture = await setup();
    const base = await fixture.liveEntry();
    await fixture.desktopVault.write("note.md", text("v1"));
    await fixture.desktop.synchronize();
    const edited = await fixture.liveEntry();
    await purgeRevisions(fixture.observer, fixture.objects, [base.revision.revisionId], deleteBlobs);
    await fixture.phoneVault.delete("note.md");

    await expect(fixture.phone.synchronize()).resolves.toMatchObject({ status: "action-required" });

    const conflicted = (await readCurrent(await fixture.open())).snapshot.entries[base.entryId];
    expect(conflicted).toMatchObject({
      candidates: [{ revisionId: edited.revision.revisionId }],
      kind: "conflicted",
      lastContentHash: base.revision.contentHash,
      reason: "delete-edit",
    });
    expect(conflicted?.kind === "conflicted" ? conflicted.recovery : "missing").toBeUndefined();
    await expect(fixture.desktop.synchronize()).resolves.toMatchObject({ status: "action-required" });
  });

  it.each([
    ["purged from the record", false],
    ["purged and its blob deleted", true],
  ])("keeps both edits in the Conflict Center instead of merging over a base that was %s", async (_label, deleteBlobs) => {
    const fixture = await setup("note.md", "a\nb\nc");
    const base = await fixture.liveEntry();
    await fixture.desktopVault.write("note.md", text("a\nb\nC"));
    await fixture.desktop.synchronize();
    const remoteEdit = await fixture.liveEntry();
    await purgeRevisions(fixture.observer, fixture.objects, [base.revision.revisionId], deleteBlobs);
    // 本机真的改过（与 base 不同），而且和远端的改动本可以干净合并
    await fixture.phoneVault.write("note.md", text("A\nb\nc"));

    await expect(fixture.phone.synchronize()).resolves.toMatchObject({ status: "action-required" });

    const conflicted = (await readCurrent(await fixture.open())).snapshot.entries[base.entryId];
    if (conflicted?.kind !== "conflicted") throw new Error("Expected a Conflict");
    expect(conflicted).toMatchObject({ reason: "edit-edit" });
    expect(conflicted.candidates.map((candidate) => candidate.revisionId)).toContain(remoteEdit.revision.revisionId);
    const localCandidate = conflicted.candidates.find((candidate) => candidate.revisionId !== remoteEdit.revision.revisionId);
    if (!localCandidate) throw new Error("Expected the local edit as a candidate");
    const preserved = await fixture.phone.readConflictCandidate(base.entryId, localCandidate.revisionId);
    expect(new TextDecoder().decode(preserved)).toBe("A\nb\nc");
  });

  it("keeps an edit made while deferred in the Conflict Center after the old local base was purged", async () => {
    const fixture = await deferredWithPurgedBase(true);
    await fixture.phoneVault.write("note.md", text("phone"));
    await expect(fixture.phone.synchronize()).resolves.toMatchObject({
      localIssues: [{ kind: "deferred-local-edit", path: "note.md" }],
      status: "action-required",
    });

    await expect(fixture.unlimitedPhone.synchronize()).resolves.toMatchObject({ status: "action-required" });

    const conflicted = (await readCurrent(await fixture.open())).snapshot.entries[fixture.base.entryId];
    if (conflicted?.kind !== "conflicted") throw new Error("Expected a Conflict");
    expect(conflicted.candidates.map((candidate) => candidate.contentHash).sort())
      .toEqual([await sha256Content(text(big)), await sha256Content(text("phone"))].sort());
  });

  it("refuses to publish a commit that references content outside the Head it replaces", async () => {
    const fixture = await setup();
    const first = await fixture.liveEntry();
    await fixture.desktopVault.write("note.md", text("v1"));
    await fixture.desktop.synchronize();
    await fixture.phone.synchronize();
    // 数据块还在、但已不被记录引用：正是票 04 下一步可能删掉的那一类
    await purgeRevisions(fixture.observer, fixture.objects, [first.revision.revisionId], false);
    const before = await readCurrent(fixture.observer);
    const keysBefore = await fixture.objects.list("");
    await fixture.phoneVault.delete("note.md");
    // 人为构造违规提交：让删除记录带回已被清理的旧版本
    // 先绑定原方法再打桩，避免桩调到自己
    const reconcile = SyncEngine.prototype.reconcile.bind(new SyncEngine());
    const spy = vi.spyOn(SyncEngine.prototype, "reconcile").mockImplementation((input) => {
      const plan = reconcile(input);
      return {
        ...plan,
        remoteChanges: plan.remoteChanges.map((change) =>
          change.kind === "delete-remote" ? { ...change, history: [...(change.history ?? []), first.revision] } : change),
      };
    });
    try {
      await expect(fixture.phone.synchronize()).rejects.toThrow("不在远端当前记录里");
    } finally {
      spy.mockRestore();
    }

    const after = await readCurrent(fixture.observer);
    expect(after.head.etag).toBe(before.head.etag);
    expect(await fixture.objects.list("")).toEqual(keysBefore);
  });

  // 电脑 v0 -> v1 -> 改回 v0 -> v2：清理掉手机 base 那个 v0 之后，记录里仍有另一个内容同为 v0 的版本
  const purgedBaseWithReferencedCopy = async () => {
    const fixture = await setup();
    const base = await fixture.liveEntry();
    for (const content of ["v1", "v0", "v2"]) {
      await fixture.desktopVault.write("note.md", text(content));
      await fixture.desktop.synchronize();
    }
    await purgeRevisions(fixture.observer, fixture.objects, [base.revision.revisionId], true);
    const copy = (await fixture.liveEntry()).history?.find((revision) => revision.contentHash === base.revision.contentHash);
    if (!copy) throw new Error("Expected another referenced copy of v0");
    return { ...fixture, copy };
  };

  it("still reports a network failure while authenticating content the record still references", async () => {
    const fixture = await purgedBaseWithReferencedCopy();
    fixture.objects.onGet = (key) => {
      if (key.endsWith(`/blobs/${fixture.copy.blobId}`)) {
        fixture.objects.onGet = undefined;
        throw new Error("temporary recovery read network failure");
      }
    };

    const synchronization = fixture.phone.synchronize();

    await expect(synchronization).rejects.toThrow("temporary recovery read network failure");
    await expect(synchronization).rejects.not.toBeInstanceOf(RemoteStateError);
    expect(fixture.phoneVault.readText("note.md")).toBe("v0");
  });

  it("still reports an integrity failure when content the record still references cannot be authenticated", async () => {
    const fixture = await purgedBaseWithReferencedCopy();
    await fixture.objects.put(`${prefix}/v1/blobs/${fixture.copy.blobId}`, text("damaged"));

    const synchronization = fixture.phone.synchronize();

    await expect(synchronization).rejects.toBeInstanceOf(RemoteStateError);
    await expect(synchronization).rejects.toMatchObject({ integrityCheck: { kind: "recovery" } });
    expect(fixture.phoneVault.readText("note.md")).toBe("v0");
  });
});

describe("cleaning expired content out of the remote record", () => {
  const prefix = "expired";
  const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
  const text = (value: string): Uint8Array => new TextEncoder().encode(value);
  const DAY_MS = 24 * 60 * 60 * 1000;
  const T0 = "2026-09-05T00:00:00.000Z";
  // 以 T0 为起点的第 days 天（AWS 时间）
  const at = (days: number): string => new Date(Date.parse(T0) + days * DAY_MS).toISOString();

  // 读 Head 时带上可控的 AWS 时间；设备时间与它无关
  class ClockedObjectStore extends MemoryObjectStore {
    serverDate = T0;
    puts: string[] = [];

    override async get(key: string): Promise<StoredObject | undefined> {
      const stored = await super.get(key);
      return stored && key.endsWith("/head") ? { ...stored, serverDate: this.serverDate } : stored;
    }

    override async put(key: string, body: Uint8Array, options: ObjectPutOptions = {}): Promise<StoredObject> {
      this.puts.push(key);
      return super.put(key, body, options);
    }
  }

  const readCurrent = async (remote: RemoteStore) => {
    const head = await remote.readHead();
    if (!head) throw new Error("Expected initialized Head");
    return { head, snapshot: await remote.readSnapshot(head.value) };
  };

  const entryAt = async (remote: RemoteStore, path: string): Promise<VaultEntry> => {
    const entry = Object.values((await readCurrent(remote)).snapshot.entries).find((value) => value.path === path);
    if (!entry) throw new Error(`Expected an Entry at ${path}`);
    return entry;
  };

  const setup = async (files: Record<string, string>) => {
    const objects = new ClockedObjectStore();
    const open = () => RemoteStore.open({ objects, prefix, vaultKey });
    const desktopVault = new MemoryVault();
    for (const [path, body] of Object.entries(files)) await desktopVault.write(path, text(body));
    // 另有几篇无关笔记，删除一篇不会被当成 Bulk Deletion
    for (const other of ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md"]) await desktopVault.write(other, text(other));
    const desktopCache = new MemorySyncCache();
    const desktop = new SyncService({ cache: desktopCache, local: desktopVault, remote: await open(), replicaId: "desktop" });
    await desktop.initializeNew("vault");
    await desktop.synchronize();
    const phoneVault = new MemoryVault();
    const phoneCache = new MemorySyncCache();
    const phone = new SyncService({ cache: phoneCache, local: phoneVault, remote: await open(), replicaId: "phone" });
    await phone.synchronize();
    const observer = await open();
    return { desktop, desktopCache, desktopVault, objects, observer, open, phone, phoneCache, phoneVault };
  };

  // 直接发一个提交，造出指定形状的记录（数据块真实写入，读 Head 的存在性检查能通过）
  const revisionOf = async (remote: RemoteStore, body: string, expiresAt?: string): Promise<RevisionRef> => {
    const blobId = crypto.randomUUID();
    await remote.writeBlob(blobId, text(body));
    return {
      blobId, contentHash: await sha256Content(text(body)), createdAt: at(-1), revisionId: crypto.randomUUID(),
      size: text(body).byteLength, ...(expiresAt ? { expiresAt } : {}),
    };
  };

  const publish = async (remote: RemoteStore, entries: VaultEntry[]): Promise<void> => {
    const { head, snapshot } = await readCurrent(remote);
    const commitId = crypto.randomUUID();
    await remote.advance({
      commit: {
        changes: entries.map((entry) => ({ entry, kind: "set-entry" as const })), commitId, createdAt: head.serverDate,
        parentIds: [head.value.commitId], protocolVersion: 1, replicaId: "fixture", vaultId: snapshot.vaultId,
      },
      expectedHeadEtag: head.etag,
      head: { ...head.value, commitId, generation: head.value.generation + 1 },
    });
  };

  // 判据用的记录：每种情况一个 Entry
  const judgedRecord = async (remote: RemoteStore) => {
    const live: VaultEntry = {
      entryId: "live", kind: "live", path: "live.md", revision: await revisionOf(remote, "live current"),
      history: [await revisionOf(remote, "live h1", at(50)), await revisionOf(remote, "live h0", at(30))],
    };
    const gone: VaultEntry = {
      deletedAt: at(0), entryId: "gone", kind: "deleted", lastContentHash: "sha256:gone", lastRevisionId: "gone-last",
      path: "gone.md", recovery: { ...(await revisionOf(remote, "gone")), expiresAt: at(30) },
    };
    const deletedWithHistory: VaultEntry = {
      deletedAt: at(20), entryId: "deleted-history", kind: "deleted", lastContentHash: "sha256:dh",
      lastRevisionId: "dh-last", path: "deleted-history.md",
      recovery: { ...(await revisionOf(remote, "dh recovery")), expiresAt: at(50) },
      history: [await revisionOf(remote, "dh old", at(30))],
    };
    const keptConflictHistory: VaultEntry = {
      deletedAt: at(-5), entryId: "kept-deleted", kind: "deleted", lastContentHash: "sha256:kd",
      lastRevisionId: "kd-last", path: "kept-deleted.md",
      recovery: { ...(await revisionOf(remote, "kd recovery")), expiresAt: at(30) },
      history: [await revisionOf(remote, "kd candidate", at(60))],
    };
    const conflicted: VaultEntry = {
      candidates: [await revisionOf(remote, "candidate one"), await revisionOf(remote, "candidate two")],
      entryId: "conflicted", kind: "conflicted", path: "conflicted.md", reason: "edit-edit",
      history: [await revisionOf(remote, "conflict old", at(30))],
    };
    const missing: VaultEntry = {
      entryId: "missing", kind: "live", path: "missing.md", revision: await revisionOf(remote, "missing current"),
      history: [await revisionOf(remote, "missing old")],
    };
    const missingRecovery: VaultEntry = {
      deletedAt: at(1), entryId: "missing-recovery", kind: "deleted", lastContentHash: "sha256:mr",
      lastRevisionId: "mr-last", path: "missing-recovery.md",
      // 恢复副本的到期时间在格式上必填，这里用一个无法解析的值代表「缺到期时间」
      recovery: { ...(await revisionOf(remote, "missing recovery")), expiresAt: "unknown" },
    };
    const entries = [live, gone, deletedWithHistory, keptConflictHistory, conflicted, missing, missingRecovery];
    await publish(remote, entries);
    return Object.fromEntries(entries.map((entry) => [entry.entryId, entry])) as Record<string, VaultEntry>;
  };

  it("removes only expired Recovery Copies and expired Version History items and keeps every Deletion Record", async () => {
    const fixture = await setup({});
    const before = await judgedRecord(fixture.observer);
    fixture.objects.serverDate = at(40);
    const generationBefore = (await readCurrent(fixture.observer)).head.value.generation;

    const result = await fixture.desktop.cleanupExpiredContent("vault");

    expect(result).toMatchObject({ kind: "committed", removedHistory: 2, removedRecoveries: 2 });
    const { head, snapshot } = await readCurrent(fixture.observer);
    expect(head.value.generation).toBe(generationBefore + 1);
    const after = snapshot.entries;
    // Live：过期的旧版本去掉，未过期的保留，当前版本不动
    const live = before.live as LiveEntry;
    expect(after.live).toEqual({ ...live, history: [live.history![0]] });
    // Deleted：恢复副本过期就去掉，删除记录的其他字段原样保留
    const { recovery: _goneRecovery, ...goneRecord } = before.gone as DeletedEntry;
    expect(after.gone).toEqual(goneRecord);
    // Deleted：恢复副本未过期，只去掉过期的旧版本
    const { history: _oldHistory, ...deletedWithHistory } = before["deleted-history"] as DeletedEntry;
    expect(after["deleted-history"]).toEqual(deletedWithHistory);
    // 恢复副本过期但还有未过期的冲突候选历史：只去掉恢复副本
    const { recovery: _keptRecovery, ...keptDeleted } = before["kept-deleted"] as DeletedEntry;
    expect(after["kept-deleted"]).toEqual(keptDeleted);
    // Conflicted 一律不动；缺到期时间的项不算过期
    expect(after.conflicted).toEqual(before.conflicted);
    expect(after.missing).toEqual(before.missing);
    expect(after["missing-recovery"]).toEqual(before["missing-recovery"]);
    // 清理提交是普通的 v1 set-entry 提交，只改写受影响的 Entry
    const commit = await fixture.observer.readCommit(head.value.commitId);
    expect(commit).toMatchObject({ protocolVersion: 1, parentIds: [expect.any(String)] });
    expect(commit!.changes.map((change) => [change.kind, change.entry.entryId]).sort()).toEqual([
      ["set-entry", "deleted-history"], ["set-entry", "gone"], ["set-entry", "kept-deleted"], ["set-entry", "live"],
    ]);
  });

  it("leaves a file uploaded 60 days ago and never changed untouched", async () => {
    const fixture = await setup({ "old.md": "written once" });
    const before = await entryAt(fixture.observer, "old.md");
    const generationBefore = (await readCurrent(fixture.observer)).head.value.generation;
    fixture.objects.serverDate = at(60);

    const result = await fixture.desktop.cleanupExpiredContent("vault");

    expect(result).toMatchObject({ kind: "nothing-to-clean", removedHistory: 0, removedRecoveries: 0 });
    expect(await entryAt(fixture.observer, "old.md")).toEqual(before);
    expect((await readCurrent(fixture.observer)).head.value.generation).toBe(generationBefore);
  });

  it("judges expiry by AWS time even when the device clock is 60 days ahead", async () => {
    const fixture = await setup({});
    const before = await judgedRecord(fixture.observer);
    fixture.objects.serverDate = at(20);
    const generationBefore = (await readCurrent(fixture.observer)).head.value.generation;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(at(80)));
      const result = await fixture.desktop.cleanupExpiredContent("vault");
      expect(result).toMatchObject({ kind: "nothing-to-clean" });
    } finally {
      vi.useRealTimers();
    }
    const { head, snapshot } = await readCurrent(fixture.observer);
    expect(head.value.generation).toBe(generationBefore);
    expect(snapshot.entries.gone).toEqual(before.gone);
    expect(snapshot.entries.live).toEqual(before.live);
  });

  it("builds the cleanup from the remote Head only, keeping a phone edit the desktop cache has not seen", async () => {
    const fixture = await setup({ "note.md": "v0" });
    await fixture.desktopVault.write("note.md", text("v1"));
    await fixture.desktop.synchronize();
    await fixture.phone.synchronize();
    // 40 天后手机改了这篇；电脑缓存还停在之前
    fixture.objects.serverDate = at(40);
    await fixture.phoneVault.write("note.md", text("phone v2"));
    await fixture.phone.synchronize();
    const phoneEntry = await entryAt(fixture.observer, "note.md") as LiveEntry;
    expect(phoneEntry.history).toHaveLength(2);
    const desktopCacheBefore = structuredClone(fixture.desktopCache.state);

    const result = await fixture.desktop.cleanupExpiredContent("vault");

    expect(result).toMatchObject({ kind: "committed", removedHistory: 1, removedRecoveries: 0 });
    // 手机那次改动原样保留，只有过期的旧版本去掉了
    expect(await entryAt(fixture.observer, "note.md")).toEqual({ ...phoneEntry, history: [phoneEntry.history![0]] });
    // 电脑缓存落后于远端：不拿缓存构造、也不改缓存，本机文件不动
    expect(fixture.desktopCache.state).toEqual(desktopCacheBefore);
    expect(fixture.desktopVault.readText("note.md")).toBe("v1");
    await expect(fixture.desktop.synchronize()).resolves.toMatchObject({ downloaded: 1, status: "complete" });
    expect(fixture.desktopVault.readText("note.md")).toBe("phone v2");
  });

  it("accepts the cleaned record into a cache that is exactly at the Head it read", async () => {
    const fixture = await setup({ "note.md": "v0" });
    await fixture.desktopVault.write("note.md", text("v1"));
    await fixture.desktop.synchronize();
    fixture.objects.serverDate = at(40);

    const result = await fixture.desktop.cleanupExpiredContent("vault");

    const { head, snapshot } = await readCurrent(fixture.observer);
    expect(result).toMatchObject({ commitId: head.value.commitId, kind: "committed" });
    expect(fixture.desktopCache.state?.snapshot).toEqual(snapshot);
  });

  it("recomputes from the newer Head after another device wins the race", async () => {
    const fixture = await setup({ "note.md": "v0", "other.md": "o0" });
    await fixture.desktopVault.write("note.md", text("v1"));
    await fixture.desktop.synchronize();
    await fixture.phone.synchronize();
    fixture.objects.serverDate = at(40);
    let raced = false;
    fixture.objects.onPut = async (key) => {
      if (raced || !key.includes("/commits/")) return;
      raced = true;
      // 清理提交写好、发布 Head 之前，手机抢先发布了一次改动
      await fixture.phoneVault.write("other.md", text("phone o1"));
      await fixture.phone.synchronize();
    };

    const result = await retryHeadChanges(() => fixture.desktop.cleanupExpiredContent("vault"), { sleep: async () => {} });

    expect(raced).toBe(true);
    expect(result).toMatchObject({ kind: "committed", removedHistory: 1 });
    const other = await entryAt(fixture.observer, "other.md") as LiveEntry;
    expect(other.revision.contentHash).toBe(await sha256Content(text("phone o1")));
    expect((await entryAt(fixture.observer, "note.md") as LiveEntry).history ?? []).toEqual([]);
  });

  it("sends no commit when nothing has expired", async () => {
    const fixture = await setup({ "note.md": "v0" });
    await fixture.desktopVault.write("note.md", text("v1"));
    await fixture.desktop.synchronize();
    fixture.objects.serverDate = at(29);
    const putsBefore = fixture.objects.puts.length;

    await expect(fixture.desktop.cleanupExpiredContent("vault")).resolves.toMatchObject({ kind: "nothing-to-clean" });

    expect(fixture.objects.puts.length).toBe(putsBefore);
  });

  it("does nothing when the remote Head does not exist", async () => {
    const objects = new ClockedObjectStore();
    const service = new SyncService({
      cache: new MemorySyncCache(), local: new MemoryVault(), remote: await RemoteStore.open({ objects, prefix, vaultKey }),
      replicaId: "desktop",
    });

    await expect(service.cleanupExpiredContent("vault")).resolves.toEqual({ kind: "no-head" });

    expect(objects.puts).toEqual([]);
  });

  it("writes a full snapshot when the cleanup commit lands on a hundredth generation", async () => {
    const fixture = await setup({ "note.md": "v0" });
    await fixture.desktopVault.write("note.md", text("v1"));
    await fixture.desktop.synchronize();
    // 把 Head 推到第 99 代，清理提交就是第 100 代
    const { head, snapshot } = await readCurrent(fixture.observer);
    const commitId = crypto.randomUUID();
    const note = await entryAt(fixture.observer, "note.md");
    await fixture.observer.advance({
      commit: { changes: [{ entry: note, kind: "set-entry" }], commitId, createdAt: head.serverDate,
        parentIds: [head.value.commitId], protocolVersion: 1, replicaId: "fixture", vaultId: snapshot.vaultId },
      expectedHeadEtag: head.etag,
      head: { ...head.value, commitId, generation: 99 },
    });
    fixture.objects.serverDate = at(40);

    await fixture.desktop.cleanupExpiredContent("vault");

    const after = await readCurrent(fixture.observer);
    expect(after.head.value.generation).toBe(100);
    expect(after.head.value.snapshotId).toBeDefined();
    expect(after.head.value.snapshotId).not.toBe(head.value.snapshotId);
    expect(fixture.objects.puts).toContain(`${prefix}/v1/snapshots/${after.head.value.snapshotId}`);
    expect((after.snapshot.entries[note.entryId] as LiveEntry).history ?? []).toEqual([]);
  });

  it("lets every device sync after the cleanup and still applies an old deletion on a device that kept the file", async () => {
    const fixture = await setup({ "gone.md": "gone", "edited.md": "edited" });
    await fixture.desktopVault.delete("gone.md");
    await fixture.desktop.synchronize();
    await fixture.desktopVault.delete("edited.md");
    await fixture.desktop.synchronize();
    // 手机 40 天没同步：一篇没改，一篇改过
    fixture.objects.serverDate = at(40);
    await fixture.phoneVault.write("edited.md", text("phone edit"));
    const deletedList = (state: CachedSyncState | undefined) => Object.values(state?.snapshot.entries ?? {})
      .filter((entry) => entry.kind === "deleted" && (entry.recovery !== undefined || (entry.history?.length ?? 0) > 0))
      .map((entry) => entry.path);
    expect(deletedList(fixture.desktopCache.state).sort()).toEqual(["edited.md", "gone.md"]);

    await expect(fixture.desktop.cleanupExpiredContent("vault")).resolves.toMatchObject({ removedRecoveries: 2 });

    // 读 Head 的存在性检查照常通过
    await expect(readCurrent(fixture.observer)).resolves.toBeDefined();
    expect(deletedList(fixture.desktopCache.state)).toEqual([]);
    const remove = vi.spyOn(fixture.phoneVault, "delete");
    const result = await fixture.phone.synchronize();
    // 没改的照旧删到回收站，改过的照旧进 edit-delete 冲突
    expect(remove).toHaveBeenCalledWith("gone.md", await sha256Content(text("gone")));
    expect(fixture.phoneVault.readText("gone.md")).toBeUndefined();
    const conflict = await entryAt(fixture.observer, "edited.md");
    expect(conflict).toMatchObject({ kind: "conflicted", reason: "edit-delete" });
    expect(conflict.kind === "conflicted" && conflict.candidates.map((candidate) => candidate.contentHash))
      .toEqual([await sha256Content(text("phone edit"))]);
    expect(result.status).toBe("action-required");
    expect(deletedList(fixture.phoneCache.state)).toEqual([]);
  });

  it("lets a phone that went 40 days without syncing download the newer Revision after its base was cleaned", async () => {
    const fixture = await setup({ "note.md": "v0" });
    await fixture.desktopVault.write("note.md", text("v1"));
    await fixture.desktop.synchronize();
    fixture.objects.serverDate = at(40);
    await expect(fixture.desktop.cleanupExpiredContent("vault")).resolves.toMatchObject({ removedHistory: 1 });
    const write = vi.spyOn(fixture.phoneVault, "write");

    await expect(fixture.phone.synchronize()).resolves.toMatchObject({ downloaded: 1, status: "complete" });

    expect(fixture.phoneVault.readText("note.md")).toBe("v1");
    // 本机旧内容交给安全写入挪进本机回收站
    expect(write).toHaveBeenCalledWith("note.md", expect.any(Uint8Array), await sha256Content(text("v0")));
  });

  // 三台设备都在 v0；电脑改成 v1，40 天后清理提交去掉 v0；电脑另改一篇无关笔记；
  // 手机删除这篇得到 delete-edit 冲突，再选「保留删除」：得到一条不满 30 天、没有恢复副本的删除记录
  const keptDeletionAfterPurgedBase = async () => {
    const fixture = await setup({ "note.md": "v0" });
    const tabletVault = new MemoryVault();
    const tablet = new SyncService({
      cache: new MemorySyncCache(), local: tabletVault, remote: await fixture.open(), replicaId: "tablet",
    });
    await tablet.synchronize();
    fixture.objects.serverDate = at(1);
    await fixture.desktopVault.write("note.md", text("v1"));
    await fixture.desktop.synchronize();
    fixture.objects.serverDate = at(40);
    await expect(fixture.desktop.cleanupExpiredContent("vault")).resolves.toMatchObject({ kind: "committed", removedHistory: 1 });
    await fixture.desktopVault.write("a.md", text("desktop a1"));
    await expect(fixture.desktop.synchronize()).resolves.toMatchObject({ status: "complete", uploaded: 1 });
    await fixture.phoneVault.delete("note.md");
    await expect(fixture.phone.synchronize()).resolves.toMatchObject({ status: "action-required" });
    const conflicted = await entryAt(fixture.observer, "note.md");
    expect(conflicted).toMatchObject({ kind: "conflicted", reason: "delete-edit" });
    await fixture.phone.resolveConflict(conflicted.entryId, { kind: "keep-deleted" });
    const kept = await entryAt(fixture.observer, "note.md");
    expect(kept).toMatchObject({ kind: "deleted", lastContentHash: await sha256Content(text("v0")) });
    expect((kept as DeletedEntry).recovery).toBeUndefined();
    fixture.objects.serverDate = at(41);
    return { ...fixture, tablet, tabletVault };
  };

  it("deletes an unchanged copy on a third device when the kept Deletion Record has no Recovery Copy because its base was cleaned", async () => {
    const fixture = await keptDeletionAfterPurgedBase();
    const remove = vi.spyOn(fixture.tabletVault, "delete");

    const result = await fixture.tablet.synchronize();

    expect(result).toMatchObject({ deleted: 1, downloaded: 1, status: "complete" });
    // 本机旧内容交给本机删除，带上被删内容的哈希，由它挪进本地回收站
    expect(remove).toHaveBeenCalledWith("note.md", await sha256Content(text("v0")));
    expect(fixture.tabletVault.readText("note.md")).toBeUndefined();
    // 其他文件照常同步
    expect(fixture.tabletVault.readText("a.md")).toBe("desktop a1");
    expect(await entryAt(fixture.observer, "note.md")).toMatchObject({ kind: "deleted" });
  });

  it("keeps the edited copy on the device that edited it when the kept Deletion Record has no Recovery Copy", async () => {
    const fixture = await keptDeletionAfterPurgedBase();

    // 不走「远端已删、本机没改」的删除；照旧进 edit-delete 冲突，本机 v1 作为冲突候选上传保存
    await expect(fixture.desktop.synchronize()).resolves.toMatchObject({ deleted: 0, status: "action-required" });

    const conflict = await entryAt(fixture.observer, "note.md");
    expect(conflict).toMatchObject({ kind: "conflicted", reason: "edit-delete" });
    const candidates = conflict.kind === "conflicted" ? conflict.candidates : [];
    expect(candidates.map((candidate) => candidate.contentHash)).toEqual([await sha256Content(text("v1"))]);
    expect(new TextDecoder().decode(await fixture.observer.readBlob(candidates[0]!.blobId))).toBe("v1");
  });

  it("keeps a copy that differs from the deleted content when the kept Deletion Record has no Recovery Copy", async () => {
    const fixture = await keptDeletionAfterPurgedBase();
    await fixture.tabletVault.write("note.md", text("tablet edit"));

    await expect(fixture.tablet.synchronize()).resolves.toMatchObject({ deleted: 0, status: "action-required" });

    const conflict = await entryAt(fixture.observer, "note.md");
    expect(conflict).toMatchObject({ kind: "conflicted", reason: "edit-delete" });
    const candidates = conflict.kind === "conflicted" ? conflict.candidates : [];
    expect(candidates.map((candidate) => candidate.contentHash)).toEqual([await sha256Content(text("tablet edit"))]);
    expect(new TextDecoder().decode(await fixture.observer.readBlob(candidates[0]!.blobId))).toBe("tablet edit");
  });

  it("still refuses to delete when a recent Deletion Record has no Recovery Copy but the record still holds that content", async () => {
    const fixture = await setup({ "note.md": "v0" });
    const live = await entryAt(fixture.observer, "note.md") as LiveEntry;
    // 记录本身有问题：同内容的 Revision 还在记录里，删除记录却没带恢复副本
    await publish(fixture.observer, [{
      deletedAt: at(0), entryId: live.entryId, history: [live.revision], kind: "deleted",
      lastContentHash: live.revision.contentHash, lastRevisionId: live.revision.revisionId, path: "note.md",
    }]);
    fixture.objects.serverDate = at(1);
    const remove = vi.spyOn(fixture.phoneVault, "delete");

    await expect(fixture.phone.synchronize()).rejects.toThrow(/缺少恢复副本/u);

    expect(remove).not.toHaveBeenCalled();
    expect(fixture.phoneVault.readText("note.md")).toBe("v0");
  });

  it("deletes a copy only after its Recovery Copy reads back intact", async () => {
    const fixture = await setup({ "note.md": "v0" });
    fixture.objects.serverDate = at(1);
    await fixture.desktopVault.delete("note.md");
    await fixture.desktop.synchronize();
    expect(await entryAt(fixture.observer, "note.md")).toMatchObject({ kind: "deleted", recovery: expect.any(Object) });
    const remove = vi.spyOn(fixture.phoneVault, "delete");
    fixture.objects.serverDate = at(2);

    await expect(fixture.phone.synchronize()).resolves.toMatchObject({ deleted: 1, status: "complete" });

    expect(remove).toHaveBeenCalledWith("note.md", await sha256Content(text("v0")));
    expect(fixture.phoneVault.readText("note.md")).toBeUndefined();
  });

  it.each([
    ["missing", /仓库快照引用的数据块缺失/u],
    ["fails verification", /恢复副本已损坏/u],
  ])("does not delete a copy whose Recovery Copy is %s", async (state, error) => {
    const fixture = await setup({ "note.md": "v0" });
    fixture.objects.serverDate = at(1);
    await fixture.desktopVault.delete("note.md");
    await fixture.desktop.synchronize();
    const recovery = (await entryAt(fixture.observer, "note.md") as DeletedEntry).recovery!;
    await fixture.objects.delete(`${prefix}/v1/blobs/${recovery.blobId}`);
    if (state === "fails verification") await fixture.observer.writeBlob(recovery.blobId, text("other content"));
    const remove = vi.spyOn(fixture.phoneVault, "delete");
    fixture.objects.serverDate = at(2);

    await expect(fixture.phone.synchronize()).rejects.toThrow(error);

    expect(remove).not.toHaveBeenCalled();
    expect(fixture.phoneVault.readText("note.md")).toBe("v0");
  });

  describe("a remote deletion compared with this device's base", () => {
    // 问题 1 基本形：手机停在 V1，电脑改成 V2 后删除（删除记录带 V2 的恢复副本）
    const editedThenDeleted = async () => {
      const fixture = await setup({ "note.md": "V1" });
      fixture.objects.serverDate = at(1);
      await fixture.desktopVault.write("note.md", text("V2"));
      await expect(fixture.desktop.synchronize()).resolves.toMatchObject({ status: "complete", uploaded: 1 });
      await fixture.desktopVault.delete("note.md");
      await expect(fixture.desktop.synchronize()).resolves.toMatchObject({ status: "complete", uploaded: 1 });
      const deleted = await entryAt(fixture.observer, "note.md") as DeletedEntry;
      expect(deleted).toMatchObject({ kind: "deleted", lastContentHash: await sha256Content(text("V2")) });
      expect(deleted.recovery?.contentHash).toBe(await sha256Content(text("V2")));
      fixture.objects.serverDate = at(2);
      return fixture;
    };

    it("deletes a copy left at the base version when another device edited and then deleted it", async () => {
      const fixture = await editedThenDeleted();
      const remove = vi.spyOn(fixture.phoneVault, "delete");

      await expect(fixture.phone.synchronize()).resolves.toMatchObject({ deleted: 1, status: "complete" });

      // 本机 V1 带着自己的哈希交给本机删除，由它挪进本地回收站
      expect(remove).toHaveBeenCalledWith("note.md", await sha256Content(text("V1")));
      expect(fixture.phoneVault.readText("note.md")).toBeUndefined();
      expect(await entryAt(fixture.observer, "note.md")).toMatchObject({ kind: "deleted" });
    });

    it("deletes a base copy whose Revision was cleaned out of the record and whose blob is gone", async () => {
      const fixture = await setup({ "note.md": "V1" });
      const v1 = (await entryAt(fixture.observer, "note.md") as LiveEntry).revision;
      fixture.objects.serverDate = at(1);
      await fixture.desktopVault.write("note.md", text("V2"));
      await fixture.desktop.synchronize();
      fixture.objects.serverDate = at(40);
      await expect(fixture.desktop.cleanupExpiredContent("vault")).resolves.toMatchObject({ removedHistory: 1 });
      await fixture.objects.delete(`${prefix}/v1/blobs/${v1.blobId}`);
      await fixture.desktopVault.delete("note.md");
      await expect(fixture.desktop.synchronize()).resolves.toMatchObject({ status: "complete" });
      const deleted = await entryAt(fixture.observer, "note.md") as DeletedEntry;
      expect(deleted.recovery?.contentHash).toBe(await sha256Content(text("V2")));
      expect((deleted.history ?? []).some((revision) => revision.revisionId === v1.revisionId)).toBe(false);
      fixture.objects.serverDate = at(41);

      await expect(fixture.phone.synchronize()).resolves.toMatchObject({ deleted: 1, status: "complete" });

      expect(fixture.phoneVault.readText("note.md")).toBeUndefined();
    });

    it("still publishes unrelated edits on the device that edited a note whose kept Deletion Record has no Recovery Copy", async () => {
      const fixture = await keptDeletionAfterPurgedBase();
      await fixture.desktopVault.write("b.md", text("desktop b"));

      // S4：不抛「缺少恢复副本」，本机 v1 进冲突候选，无关的 b.md 照常发布
      await expect(fixture.desktop.synchronize()).resolves.toMatchObject({ deleted: 0, status: "action-required" });

      expect(await entryAt(fixture.observer, "note.md")).toMatchObject({ kind: "conflicted", reason: "edit-delete" });
      const published = await entryAt(fixture.observer, "b.md") as LiveEntry;
      expect(new TextDecoder().decode(await fixture.observer.readBlob(published.revision.blobId))).toBe("desktop b");
    });

    // 记录仍引用手机这份 V1，但 V1 的数据块读不回来
    const editedThenDeletedWithLostBase = async () => {
      const fixture = await setup({ "note.md": "V1" });
      const v1 = (await entryAt(fixture.observer, "note.md") as LiveEntry).revision;
      fixture.objects.serverDate = at(1);
      await fixture.desktopVault.write("note.md", text("V2"));
      await fixture.desktop.synchronize();
      await fixture.desktopVault.delete("note.md");
      await expect(fixture.desktop.synchronize()).resolves.toMatchObject({ status: "complete" });
      const deleted = await entryAt(fixture.observer, "note.md") as DeletedEntry;
      expect((deleted.history ?? []).some((revision) => revision.revisionId === v1.revisionId)).toBe(true);
      fixture.objects.serverDate = at(2);
      return { ...fixture, v1 };
    };

    it("keeps an edit-delete Conflict when the record still holds the base copy but it fails verification", async () => {
      const fixture = await editedThenDeletedWithLostBase();
      await fixture.objects.put(`${prefix}/v1/blobs/${fixture.v1.blobId}`, text("corrupted ciphertext"));
      await fixture.phoneVault.write("b.md", text("phone b"));

      await expect(fixture.phone.synchronize()).resolves.toMatchObject({ deleted: 0, status: "action-required" });

      expect(fixture.phoneVault.readText("note.md")).toBeUndefined();
      const conflict = await entryAt(fixture.observer, "note.md");
      expect(conflict).toMatchObject({ kind: "conflicted", reason: "edit-delete" });
      const candidates = conflict.kind === "conflicted" ? conflict.candidates : [];
      expect(candidates.map((candidate) => candidate.contentHash)).toEqual([await sha256Content(text("V1"))]);
      expect(new TextDecoder().decode(await fixture.observer.readBlob(candidates[0]!.blobId))).toBe("V1");
      // 别的改动照常发布
      expect(await entryAt(fixture.observer, "b.md")).toMatchObject({ kind: "live" });
    });

    it("reports a network failure while verifying the base copy without deleting it", async () => {
      const fixture = await editedThenDeletedWithLostBase();
      fixture.objects.onGet = (key) => {
        if (key.endsWith(`/blobs/${fixture.v1.blobId}`)) {
          fixture.objects.onGet = undefined;
          throw new Error("temporary recovery read network failure");
        }
      };

      const synchronization = fixture.phone.synchronize();

      await expect(synchronization).rejects.toThrow("temporary recovery read network failure");
      await expect(synchronization).rejects.not.toBeInstanceOf(RemoteStateError);
      expect(fixture.phoneVault.readText("note.md")).toBe("V1");
      // 网络恢复后照常删除
      await expect(fixture.phone.synchronize()).resolves.toMatchObject({ deleted: 1, status: "complete" });
      expect(fixture.phoneVault.readText("note.md")).toBeUndefined();
    });

    it.each([
      ["an empty file", ""],
      ["a non-empty file", "fresh start"],
    ])("uploads %s created at the path of a deletion this device already accepted", async (_, content) => {
      const fixture = await setup({ "未命名.md": "" });
      await fixture.phoneVault.delete("未命名.md");
      await expect(fixture.phone.synchronize()).resolves.toMatchObject({ status: "complete" });
      await expect(fixture.desktop.synchronize()).resolves.toMatchObject({ deleted: 1, status: "complete" });
      const accepted = await entryAt(fixture.observer, "未命名.md");
      expect(accepted).toMatchObject({ kind: "deleted" });

      await fixture.desktopVault.write("未命名.md", text(content));
      await expect(fixture.desktop.synchronize()).resolves.toMatchObject({ deleted: 0, status: "complete", uploaded: 1 });

      expect(fixture.desktopVault.readText("未命名.md")).toBe(content);
      const atPath = Object.values((await readCurrent(fixture.observer)).snapshot.entries)
        .filter((entry) => entry.path === "未命名.md");
      expect(atPath.map((entry) => entry.kind).sort()).toEqual(["deleted", "live"]);
      const created = atPath.find((entry) => entry.kind === "live")!;
      expect(created.entryId).not.toBe(accepted.entryId);
      // 已接受删除的另一台设备能下载到它
      await expect(fixture.phone.synchronize()).resolves.toMatchObject({ downloaded: 1, status: "complete" });
      expect(fixture.phoneVault.readText("未命名.md")).toBe(content);
    });
  });

  describe("listing and removing what the user confirmed", () => {
    const keyOf = (kind: "recovery" | "history", entryId: string, revisionId: string): string => `${kind}:${entryId}:${revisionId}`;

    it("lists only expired backups and expired old versions, never current versions, conflicts or items without an expiry", async () => {
      const fixture = await setup({});
      const before = await judgedRecord(fixture.observer);
      fixture.objects.serverDate = at(40);
      const live = before.live as LiveEntry;
      const gone = before.gone as DeletedEntry;
      const keptDeleted = before["kept-deleted"] as DeletedEntry;
      const deletedHistory = before["deleted-history"] as DeletedEntry;

      const listed = await fixture.desktop.listCleanupCandidates("vault");

      expect(listed.serverDate).toBe(at(40));
      expect(listed.items.filter((item) => item.kind !== "orphan").map((item) => item.key).sort()).toEqual([
        keyOf("history", "deleted-history", deletedHistory.history![0]!.revisionId),
        keyOf("history", "live", live.history![1]!.revisionId),
        keyOf("recovery", "gone", gone.recovery!.revisionId),
        keyOf("recovery", "kept-deleted", keptDeleted.recovery!.revisionId),
      ].sort());
      expect(listed.items.find((item) => item.key === keyOf("recovery", "gone", gone.recovery!.revisionId))).toEqual({
        blobId: gone.recovery!.blobId, deletedAt: at(0), entryId: "gone", expiresAt: at(30), key: keyOf("recovery", "gone", gone.recovery!.revisionId),
        kind: "recovery", path: "gone.md", revisionId: gone.recovery!.revisionId, size: gone.recovery!.size,
      });
      expect(listed.items.find((item) => item.key === keyOf("history", "live", live.history![1]!.revisionId))).toEqual({
        blobId: live.history![1]!.blobId, entryId: "live", expiresAt: at(30), key: keyOf("history", "live", live.history![1]!.revisionId),
        kind: "history", path: "live.md", revisionId: live.history![1]!.revisionId, size: live.history![1]!.size,
      });
    });

    it("lists without writing to S3 or the local cache", async () => {
      const fixture = await setup({});
      await judgedRecord(fixture.observer);
      fixture.objects.serverDate = at(40);
      const cacheBefore = structuredClone(fixture.desktopCache.state);
      const putsBefore = fixture.objects.puts.length;
      const generationBefore = (await readCurrent(fixture.observer)).head.value.generation;

      await fixture.desktop.listCleanupCandidates("vault");

      expect(fixture.objects.puts.length).toBe(putsBefore);
      expect(fixture.desktopCache.state).toEqual(cacheBefore);
      expect((await readCurrent(fixture.observer)).head.value.generation).toBe(generationBefore);
    });

    it("notes when an expired item's content is still used by an existing file or by another record", async () => {
      const fixture = await setup({});
      const current = await revisionOf(fixture.observer, "same as a current file");
      const elsewhere = await revisionOf(fixture.observer, "kept in another history", at(90));
      const deleted = (entryId: string, recovery: RevisionRef): VaultEntry => ({
        deletedAt: at(0), entryId, kind: "deleted", lastContentHash: recovery.contentHash, lastRevisionId: "last",
        path: `${entryId}.md`, recovery: { ...recovery, revisionId: `${entryId}-recovery`, expiresAt: at(30) },
      });
      await publish(fixture.observer, [
        { entryId: "keep", kind: "live", path: "folder/keep.md", revision: current },
        { entryId: "other", kind: "live", path: "other.md", revision: await revisionOf(fixture.observer, "other current"), history: [elsewhere] },
        deleted("same-content", current),
        deleted("in-history", elsewhere),
        deleted("alone", await revisionOf(fixture.observer, "only here")),
      ]);
      fixture.objects.serverDate = at(40);

      const listed = await fixture.desktop.listCleanupCandidates("vault");

      const byEntry = (entryId: string) => listed.items.find((item) => item.kind === "recovery" && item.entryId === entryId);
      expect(byEntry("same-content")).toMatchObject({ sharedWith: { path: "folder/keep.md" } });
      expect(byEntry("in-history")).toMatchObject({ sharedWith: {} });
      expect(byEntry("alone")).not.toHaveProperty("sharedWith");
    });

    it("removes only the confirmed items and keeps other expired content and every Deletion Record", async () => {
      const fixture = await setup({});
      const before = await judgedRecord(fixture.observer);
      fixture.objects.serverDate = at(40);
      const live = before.live as LiveEntry;
      const gone = before.gone as DeletedEntry;
      const selected = [keyOf("recovery", "gone", gone.recovery!.revisionId), keyOf("history", "live", live.history![1]!.revisionId)];

      const result = await fixture.desktop.cleanupExpiredContent("vault", new Set(selected));

      expect(result).toMatchObject({
        kind: "committed", outcomes: { [selected[0]!]: "removed", [selected[1]!]: "removed" }, removedHistory: 1,
        removedRecoveries: 1, serverDate: at(40),
      });
      const { head, snapshot } = await readCurrent(fixture.observer);
      const { recovery: _removed, ...goneRecord } = gone;
      expect(snapshot.entries.gone).toEqual(goneRecord);
      expect(snapshot.entries.live).toEqual({ ...live, history: [live.history![0]] });
      // 别的过期内容没被确认：原样留在记录里
      expect(snapshot.entries["kept-deleted"]).toEqual(before["kept-deleted"]);
      expect(snapshot.entries["deleted-history"]).toEqual(before["deleted-history"]);
      expect(snapshot.entries.conflicted).toEqual(before.conflicted);
      const commit = await fixture.observer.readCommit(head.value.commitId);
      expect(commit!.changes.map((change) => change.entry.entryId).sort()).toEqual(["gone", "live"]);
    });

    it("reports confirmed items that are already gone or have become a Conflict, and changes neither", async () => {
      const fixture = await setup({});
      const before = await judgedRecord(fixture.observer);
      const live = before.live as LiveEntry;
      const keptDeleted = before["kept-deleted"] as DeletedEntry;
      // 确认之后：别的设备改了 live.md（旧版本不在了），kept-deleted 变成了冲突
      const conflicted: VaultEntry = {
        candidates: [await revisionOf(fixture.observer, "new candidate")], entryId: "kept-deleted", kind: "conflicted",
        path: "kept-deleted.md", reason: "delete-edit", recovery: keptDeleted.recovery,
      };
      await publish(fixture.observer, [{ ...live, history: [live.history![0]!] }, conflicted]);
      fixture.objects.serverDate = at(40);
      const putsBefore = fixture.objects.puts.length;
      const selected = [
        keyOf("history", "live", live.history![1]!.revisionId),
        keyOf("recovery", "kept-deleted", keptDeleted.recovery!.revisionId),
        keyOf("recovery", "never-existed", "missing"),
      ];

      const result = await fixture.desktop.cleanupExpiredContent("vault", new Set(selected));

      expect(result).toEqual({
        kind: "nothing-to-clean", outcomes: { [selected[0]!]: "gone", [selected[1]!]: "skipped", [selected[2]!]: "gone" },
        removedHistory: 0, removedRecoveries: 0, serverDate: at(40),
      });
      expect(fixture.objects.puts.length).toBe(putsBefore);
      expect(await entryAt(fixture.observer, "kept-deleted.md")).toEqual(conflicted);
    });
  });
});

describe("deleting unreferenced blobs from this vault's folder", () => {
  const prefix = "blob-gc";
  const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
  const text = (value: string): Uint8Array => new TextEncoder().encode(value);
  const DAY_MS = 24 * 60 * 60 * 1000;
  const HOUR_MS = 60 * 60 * 1000;
  const T0 = "2026-09-05T00:00:00.000Z";
  // 以 T0 为起点的第 days 天（AWS 时间）
  const at = (days: number): string => new Date(Date.parse(T0) + days * DAY_MS).toISOString();
  const blobKey = (blobId: string): string => `${prefix}/v1/blobs/${blobId}`;

  // 一只假的 AWS 钟：新写入对象的 LastModified 和读 Head 时的 serverDate 都取 now
  class AwsClockStore extends MemoryObjectStore {
    readonly deleted: string[] = [];
    injectedListing: ListedObject[] = [];
    onListObjects: (() => Promise<void> | void) | undefined;

    get now(): string { return this.lastModifiedForPuts; }
    set now(value: string) { this.lastModifiedForPuts = value; }

    override async get(key: string): Promise<StoredObject | undefined> {
      const stored = await super.get(key);
      return stored && { ...stored, serverDate: this.now };
    }

    override async listObjects(listPrefix: string): Promise<ListedObject[]> {
      await this.onListObjects?.();
      return [...(await super.listObjects(listPrefix)), ...this.injectedListing];
    }

    override async delete(key: string): Promise<void> {
      this.deleted.push(key);
      await super.delete(key);
    }

    async exists(key: string): Promise<boolean> {
      return (await super.list(key)).includes(key);
    }
  }

  const readCurrent = async (remote: RemoteStore) => {
    const head = await remote.readHead();
    if (!head) throw new Error("Expected initialized Head");
    return { head, snapshot: await remote.readSnapshot(head.value) };
  };

  const setup = async (files: Record<string, string> = { "note.md": "v0" }, storePrefix = prefix) => {
    const objects = new AwsClockStore();
    objects.now = at(0);
    const open = () => RemoteStore.open({ objects, prefix: storePrefix, vaultKey });
    const desktopVault = new MemoryVault();
    for (const [path, body] of Object.entries(files)) await desktopVault.write(path, text(body));
    const desktopCache = new MemorySyncCache();
    const desktop = new SyncService({ cache: desktopCache, local: desktopVault, remote: await open(), replicaId: "desktop" });
    await desktop.initializeNew("vault");
    await desktop.synchronize();
    const phoneVault = new MemoryVault();
    const phoneCache = new MemorySyncCache();
    const phone = new SyncService({ cache: phoneCache, local: phoneVault, remote: await open(), replicaId: "phone" });
    await phone.synchronize();
    const observer = await open();
    return { desktop, desktopCache, desktopVault, objects, observer, phone, phoneCache, phoneVault };
  };

  // 在 AWS 时间 days 上传一个没有任何记录引用的数据块
  const orphan = async (fixture: { objects: AwsClockStore; observer: RemoteStore }, days: number, body = "orphan") => {
    fixture.objects.now = at(days);
    const blobId = crypto.randomUUID();
    await fixture.observer.writeBlob(blobId, text(body));
    return blobId;
  };

  const revisionOf = async (fixture: { objects: AwsClockStore; observer: RemoteStore }, days: number, body: string,
    expiresAt?: string): Promise<RevisionRef> => {
    const blobId = await orphan(fixture, days, body);
    return {
      blobId, contentHash: await sha256Content(text(body)), createdAt: at(days), revisionId: crypto.randomUUID(),
      size: text(body).byteLength, ...(expiresAt ? { expiresAt } : {}),
    };
  };

  // 在 AWS 时间 days 发一个提交（改写给定的 Entry），Head 对象的 LastModified 随之变成 days
  const publishAt = async (fixture: { objects: AwsClockStore; observer: RemoteStore }, days: number, entries: VaultEntry[] = []) => {
    fixture.objects.now = at(days);
    const { head, snapshot } = await readCurrent(fixture.observer);
    const changed = entries.length > 0 ? entries : [Object.values(snapshot.entries)[0]!];
    const commitId = crypto.randomUUID();
    await fixture.observer.advance({
      commit: {
        changes: changed.map((entry) => ({ entry, kind: "set-entry" as const })), commitId, createdAt: head.serverDate,
        parentIds: [head.value.commitId], protocolVersion: 1, replicaId: "fixture", vaultId: snapshot.vaultId,
      },
      expectedHeadEtag: head.etag,
      head: { ...head.value, commitId, generation: head.value.generation + 1 },
    });
  };

  const checkAt = async (fixture: { desktop: SyncService; objects: AwsClockStore }, time: string, marks?: Record<string, string>) => {
    fixture.objects.now = time;
    const result = await fixture.desktop.deleteUnreferencedBlobs("vault", marks);
    if (result.kind !== "checked") throw new Error(`Expected a completed check, got ${result.kind}`);
    return result;
  };

  it("deletes an old unreferenced blob only after two checks at least 24 hours apart both found it unused", async () => {
    const fixture = await setup();
    const blobId = await orphan(fixture, 1, "orphan bytes");
    await publishAt(fixture, 2);

    const first = await checkAt(fixture, at(40));
    expect(first).toMatchObject({ deletedBlobs: 0, deletedBytes: 0 });
    expect(first.marks).toEqual({ [blobId]: at(40) });
    const early = await checkAt(fixture, new Date(Date.parse(at(41)) - HOUR_MS).toISOString(), first.marks);
    expect(early.deletedBlobs).toBe(0);
    // 第一次判定的时间不会被后来的检查刷新
    expect(early.marks).toEqual({ [blobId]: at(40) });
    expect(fixture.objects.deleted).toEqual([]);

    const second = await checkAt(fixture, at(41), early.marks);

    expect(fixture.objects.deleted).toEqual([blobKey(blobId)]);
    expect(second.deletedBlobs).toBe(1);
    expect(second.deletedBytes).toBeGreaterThan(text("orphan bytes").byteLength);
    expect(second.marks).toEqual({});
  });

  it("keeps every blob the current record references, the same set the Head read checks", async () => {
    const fixture = await setup();
    const live: VaultEntry = {
      entryId: "live", kind: "live", path: "live.md", revision: await revisionOf(fixture, 1, "live current"),
      // 已过期但还没被清理提交去掉的旧版本也算引用
      history: [await revisionOf(fixture, 1, "live old", at(31))],
    };
    const deleted: VaultEntry = {
      deletedAt: at(1), entryId: "gone", kind: "deleted", lastContentHash: "sha256:gone", lastRevisionId: "gone-last",
      path: "gone.md", recovery: { ...(await revisionOf(fixture, 1, "gone recovery")), expiresAt: at(31) },
    };
    const conflicted: VaultEntry = {
      candidates: [await revisionOf(fixture, 1, "candidate")], entryId: "conflict", kind: "conflicted", path: "conflict.md",
      reason: "edit-delete", recovery: { ...(await revisionOf(fixture, 1, "conflict recovery")), expiresAt: at(31) },
      history: [await revisionOf(fixture, 1, "conflict history", at(90))],
    };
    const unused = await orphan(fixture, 1);
    await publishAt(fixture, 2, [live, deleted, conflicted]);

    const first = await checkAt(fixture, at(60));
    await checkAt(fixture, at(61), first.marks);

    // 被引用的连第一次判定都不记
    expect(Object.keys(first.marks)).toEqual([unused]);
    expect(fixture.objects.deleted).toEqual([blobKey(unused)]);
    await expect(readCurrent(fixture.observer)).resolves.toBeDefined();
  });

  it("keeps the blob of a file uploaded 60 days ago and never changed or opened since", async () => {
    const fixture = await setup({ "untouched.md": "written once", "other.md": "x" });
    const { snapshot } = await readCurrent(fixture.observer);
    const untouched = Object.values(snapshot.entries).find((entry) => entry.path === "untouched.md") as LiveEntry;
    // 之后别的文件有提交，Head 比这个数据块新
    await fixture.desktopVault.write("other.md", text("y"));
    fixture.objects.now = at(1);
    await fixture.desktop.synchronize();

    const first = await checkAt(fixture, at(60));
    await checkAt(fixture, at(61), first.marks);

    expect(first.marks).not.toHaveProperty(untouched.revision.blobId);
    expect(await fixture.objects.exists(blobKey(untouched.revision.blobId))).toBe(true);
  });

  it("keeps an unreferenced blob uploaded less than 30 days ago", async () => {
    const fixture = await setup();
    const recent = await orphan(fixture, 15);
    const old = await orphan(fixture, 1);
    await publishAt(fixture, 16);

    const first = await checkAt(fixture, at(40));
    await checkAt(fixture, at(41), first.marks);

    expect(fixture.objects.deleted).toEqual([blobKey(old)]);
    expect(await fixture.objects.exists(blobKey(recent))).toBe(true);
  });

  it("keeps an unreferenced blob that is not older than the current Head object", async () => {
    const fixture = await setup();
    await publishAt(fixture, 1);
    // 上传完一直没发布：设备上传后被挂起，Head 之后没再变过
    const suspended = await orphan(fixture, 2);
    fixture.objects.now = at(1);
    const sameTime = await orphan(fixture, 1);
    const before = await orphan(fixture, 0.5);

    const first = await checkAt(fixture, at(40));
    await checkAt(fixture, at(41), first.marks);

    expect(fixture.objects.deleted).toEqual([blobKey(before)]);
    expect(await fixture.objects.exists(blobKey(suspended))).toBe(true);
    expect(await fixture.objects.exists(blobKey(sameTime))).toBe(true);
  });

  it("restarts the 24-hour wait when the local first-judgment record is lost", async () => {
    const fixture = await setup();
    const blobId = await orphan(fixture, 1);
    await publishAt(fixture, 2);
    await checkAt(fixture, at(40));

    const restarted = await checkAt(fixture, at(41), undefined);

    expect(restarted).toMatchObject({ deletedBlobs: 0, marks: { [blobId]: at(41) } });
    expect(fixture.objects.deleted).toEqual([]);
    await checkAt(fixture, at(42), restarted.marks);
    expect(fixture.objects.deleted).toEqual([blobKey(blobId)]);
  });

  it("measures the 30 days and the 24 hours by AWS time, never by device time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const fixture = await setup();
      const blobId = await orphan(fixture, 20);
      await publishAt(fixture, 21);
      // 设备时间已经是一年以后，而且两次检查之间设备时间过了两天，AWS 时间只过了一小时
      vi.setSystemTime(Date.parse(at(400)));
      const first = await checkAt(fixture, at(40));
      vi.setSystemTime(Date.parse(at(402)));
      const second = await checkAt(fixture, new Date(Date.parse(at(40)) + HOUR_MS).toISOString(), first.marks);
      expect(first.marks).toEqual({ [blobId]: at(40) });
      expect(second.deletedBlobs).toBe(0);
      // AWS 时间满 30 天、两次检查相隔满 24 小时才删
      const third = await checkAt(fixture, at(51), second.marks);
      expect(third.deletedBlobs).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("computes the references only from the Head it read, never from the local cache", async () => {
    const fixture = await setup({ "note.md": "v0", "other.md": "o" });
    const cachedNote = Object.values(fixture.desktopCache.state!.snapshot.entries).find((entry) => entry.path === "note.md") as LiveEntry;
    // 远端：别的设备把 note.md 改成了引用一个旧数据块的版本，并且记录里不再引用 v0（比如被清理过）
    const remoteOnly = await revisionOf(fixture, 1, "restored long ago");
    await publishAt(fixture, 2, [{ ...cachedNote, revision: remoteOnly }]);
    // 本机缓存停在最初：还引用 v0，不知道 remoteOnly
    expect(fixture.desktopCache.state!.snapshot.entries[cachedNote.entryId]).toEqual(cachedNote);

    const first = await checkAt(fixture, at(40));
    await checkAt(fixture, at(41), first.marks);

    expect(fixture.objects.deleted).toEqual([blobKey(cachedNote.revision.blobId)]);
    expect(await fixture.objects.exists(blobKey(remoteOnly.blobId))).toBe(true);
  });

  it("rereads the Head before deleting and keeps a candidate that another device referenced meanwhile", async () => {
    const fixture = await setup();
    const picked = await orphan(fixture, 1, "picked up again");
    const unused = await orphan(fixture, 1);
    await publishAt(fixture, 2);
    const first = await checkAt(fixture, at(40));
    const reference: RevisionRef = {
      blobId: picked, contentHash: await sha256Content(text("picked up again")), createdAt: at(1), revisionId: "picked",
      size: text("picked up again").byteLength,
    };
    // 这次检查列完数据块、还没删除时，别的设备发布了引用 picked 的提交
    fixture.objects.onListObjects = async () => {
      fixture.objects.onListObjects = undefined;
      await publishAt(fixture, 41, [{ entryId: "picked", kind: "live", path: "picked.md", revision: reference }]);
    };

    const second = await checkAt(fixture, at(41), first.marks);

    expect(fixture.objects.deleted).toEqual([blobKey(unused)]);
    expect(second.marks).not.toHaveProperty(picked);
    await expect(readCurrent(fixture.observer)).resolves.toBeDefined();
  });

  it("deletes at most 200 blobs per run, oldest first, and leaves the rest for the next run", async () => {
    const fixture = await setup();
    const oldest = await orphan(fixture, 0.25);
    const rest: string[] = [];
    for (let index = 0; index < 204; index++) rest.push(await orphan(fixture, 1));
    await publishAt(fixture, 2);
    const first = await checkAt(fixture, at(40));

    const second = await checkAt(fixture, at(41), first.marks);

    expect(second.deletedBlobs).toBe(200);
    expect(fixture.objects.deleted).toHaveLength(200);
    expect(fixture.objects.deleted[0]).toBe(blobKey(oldest));
    expect(Object.keys(second.marks)).toHaveLength(5);
    const third = await checkAt(fixture, new Date(Date.parse(at(41)) + 60_000).toISOString(), second.marks);
    expect(third.deletedBlobs).toBe(5);
    expect(new Set(fixture.objects.deleted)).toEqual(new Set([oldest, ...rest].map(blobKey)));
  });

  it("leaves every Head read passing and lets another device sync normally after deleting", async () => {
    const fixture = await setup({ "note.md": "v0", "keep.md": "keep" });
    await fixture.desktopVault.write("note.md", text("v1"));
    fixture.objects.now = at(1);
    await fixture.desktop.synchronize();
    const orphaned = await orphan(fixture, 1);
    await publishAt(fixture, 2);
    // 过期的旧版本先由清理提交从记录里去掉，之后它的数据块才会被判定没人用
    fixture.objects.now = at(40);
    await expect(fixture.desktop.cleanupExpiredContent("vault")).resolves.toMatchObject({ kind: "committed", removedHistory: 1 });
    const first = await checkAt(fixture, at(40));
    expect(Object.keys(first.marks)).toHaveLength(2);

    await checkAt(fixture, at(41), first.marks);

    expect(fixture.objects.deleted).toHaveLength(2);
    expect(fixture.objects.deleted).toContain(blobKey(orphaned));
    await expect(readCurrent(fixture.observer)).resolves.toBeDefined();
    await expect(fixture.phone.synchronize()).resolves.toMatchObject({ status: "complete" });
    expect(fixture.phoneVault.readText("note.md")).toBe("v1");
    expect(fixture.phoneVault.readText("keep.md")).toBe("keep");
    await fixture.phoneVault.write("keep.md", text("phone edit"));
    await expect(fixture.phone.synchronize()).resolves.toMatchObject({ status: "complete", uploaded: 1 });
    await expect(fixture.desktop.synchronize()).resolves.toMatchObject({ status: "complete", downloaded: 1 });
    expect(fixture.desktopVault.readText("keep.md")).toBe("phone edit");
  });

  it.each([
    ["the Head", `${prefix}/v1/head`],
    ["a commit", `${prefix}/v1/commits/x`],
    ["a snapshot", `${prefix}/v1/snapshots/x`],
    ["the Key Envelope", `${prefix}/v1/key-envelope`],
    ["another folder", "obsidian-vault-v1/v1/blobs/0b6f3a52-5d0e-4c1b-9a7e-2f0d1c3b4a59"],
    ["a sub-path", `${prefix}/v1/blobs/0b6f3a52-5d0e-4c1b-9a7e-2f0d1c3b4a59/x`],
    ["a name that is not a UUID", `${prefix}/v1/blobs/not-a-uuid`],
  ])("deletes nothing at all and reports when the listing contains %s", async (_name, key) => {
    const fixture = await setup();
    await orphan(fixture, 1);
    await publishAt(fixture, 2);
    const first = await checkAt(fixture, at(40));
    fixture.objects.injectedListing = [{ key, lastModified: at(1), size: 1 }];

    await expect(fixture.desktop.deleteUnreferencedBlobs("vault", first.marks)).rejects.toThrow("这次不删除任何数据块");

    expect(fixture.objects.deleted).toEqual([]);
  });

  it("deletes nothing when the listing, the record, or the second Head read fails", async () => {
    const fixture = await setup();
    const blobId = await orphan(fixture, 1);
    await publishAt(fixture, 2);
    const first = await checkAt(fixture, at(40));
    fixture.objects.now = at(41);

    fixture.objects.onListObjects = () => { throw new Error("network down"); };
    await expect(fixture.desktop.deleteUnreferencedBlobs("vault", first.marks)).rejects.toThrow("network down");
    // 第二次读 Head 时它不见了
    fixture.objects.onListObjects = async () => {
      fixture.objects.onListObjects = undefined;
      await fixture.objects.delete(`${prefix}/v1/head`);
    };
    const head = await fixture.objects.get(`${prefix}/v1/head`);
    await expect(fixture.desktop.deleteUnreferencedBlobs("vault", first.marks)).rejects.toThrow("Head");
    await fixture.objects.put(`${prefix}/v1/head`, head!.body);
    // 当前记录引用的数据块缺失：读记录失败
    const { snapshot } = await readCurrent(fixture.observer);
    const referenced = (Object.values(snapshot.entries)[0] as LiveEntry).revision.blobId;
    await fixture.objects.delete(blobKey(referenced));
    fixture.objects.deleted.length = 0;
    await expect(fixture.desktop.deleteUnreferencedBlobs("vault", first.marks)).rejects.toBeInstanceOf(RemoteStateError);

    expect(fixture.objects.deleted).toEqual([]);
    expect(await fixture.objects.exists(blobKey(blobId))).toBe(true);
  });

  it("does nothing when the remote Head does not exist", async () => {
    const objects = new AwsClockStore();
    const service = new SyncService({
      cache: new MemorySyncCache(), local: new MemoryVault(), remote: await RemoteStore.open({ objects, prefix, vaultKey }),
      replicaId: "desktop",
    });

    await expect(service.deleteUnreferencedBlobs("vault", {})).resolves.toEqual({ kind: "no-head" });

    expect(objects.deleted).toEqual([]);
  });

  it("refuses to clean when the prefix is empty after normalization", async () => {
    const fixture = await setup({ "note.md": "v0" }, "/");
    await orphan(fixture, 1);
    await publishAt(fixture, 2);

    await expect(fixture.desktop.deleteUnreferencedBlobs("vault", undefined)).rejects.toThrow("前缀为空");
    await expect(fixture.desktop.listCleanupCandidates("vault")).rejects.toThrow("前缀为空");

    expect(fixture.objects.deleted).toEqual([]);
  });

  it("lists as unused only blobs the record does not reference, uploaded 30 days before AWS time and before the Head", async () => {
    const fixture = await setup();
    const old = await orphan(fixture, 1, "old orphan");
    const recent = await orphan(fixture, 15);
    await publishAt(fixture, 16);
    // 上传完一直没发布：比 Head 新
    const suspended = await orphan(fixture, 17);
    fixture.objects.now = at(40);
    const size = (await fixture.objects.get(blobKey(old)))!.body.byteLength;

    const listed = await fixture.desktop.listCleanupCandidates("vault");

    expect(listed.items).toEqual([{ blobId: old, key: `orphan:${old}`, kind: "orphan", size, uploadedAt: at(1) }]);
    expect(listed.items.map((item) => item.blobId)).not.toContain(recent);
    expect(listed.items.map((item) => item.blobId)).not.toContain(suspended);
    expect(fixture.objects.deleted).toEqual([]);
  });

  it("never lists anything of a file uploaded 60 days ago and never changed since", async () => {
    const fixture = await setup({ "untouched.md": "written once", "other.md": "x" });
    await fixture.desktopVault.write("other.md", text("y"));
    fixture.objects.now = at(1);
    await fixture.desktop.synchronize();
    fixture.objects.now = at(60);

    const listed = await fixture.desktop.listCleanupCandidates("vault");

    // 只有 other.md 的旧版本（被替换后满 30 天）
    expect(listed.items.map((item) => item.kind === "orphan" ? item.blobId : item.path)).toEqual(["other.md"]);
  });

  it("considers only the given blobs when deleting, by the times it was given", async () => {
    const fixture = await setup();
    const confirmed = await orphan(fixture, 1);
    const recentlyConfirmed = await orphan(fixture, 1);
    const notConfirmed = await orphan(fixture, 1);
    await publishAt(fixture, 2);
    fixture.objects.now = at(41);
    const marks = { [confirmed]: at(40), [recentlyConfirmed]: new Date(Date.parse(at(40)) + 2 * HOUR_MS).toISOString() };

    const result = await fixture.desktop.deleteUnreferencedBlobs("vault", marks, new Set(Object.keys(marks)));

    expect(fixture.objects.deleted).toEqual([blobKey(confirmed)]);
    expect(result).toMatchObject({ deletedBlobs: 1, kind: "checked", marks: { [recentlyConfirmed]: marks[recentlyConfirmed] } });
    expect(Object.keys(result.kind === "checked" ? result.marks : {})).toEqual([recentlyConfirmed]);
    expect(await fixture.objects.exists(blobKey(notConfirmed))).toBe(true);
  });

  it("rereads the Head before deleting the given blobs and keeps one that another device referenced meanwhile", async () => {
    const fixture = await setup();
    const picked = await orphan(fixture, 1, "picked up again");
    const other = await orphan(fixture, 1);
    await publishAt(fixture, 2);
    const reference: RevisionRef = {
      blobId: picked, contentHash: await sha256Content(text("picked up again")), createdAt: at(1), revisionId: "picked",
      size: text("picked up again").byteLength,
    };
    fixture.objects.onListObjects = async () => {
      fixture.objects.onListObjects = undefined;
      await publishAt(fixture, 41, [{ entryId: "picked", kind: "live", path: "picked.md", revision: reference }]);
    };
    fixture.objects.now = at(41);
    const marks = { [picked]: at(40), [other]: at(40) };

    const result = await fixture.desktop.deleteUnreferencedBlobs("vault", marks, new Set(Object.keys(marks)));

    expect(fixture.objects.deleted).toEqual([blobKey(other)]);
    expect(result.kind === "checked" && result.marks).toEqual({});
  });
});

describe("which files a synchronization changed", () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const byPath = <T extends {path: string}>(changes: readonly T[]) => [...changes].sort((a, b) => a.path.localeCompare(b.path));
  // 电脑建立 6 个文件的仓库，手机同步一次建立 base；删除 1 个不到 20%，不会触发批量删除确认
  const setup = async () => {
    const objects = new MemoryObjectStore();
    const remote = await RemoteStore.open({objects, prefix: "activity", vaultKey: new Uint8Array(32)});
    const desktopVault = new MemoryVault();
    const desktop = new SyncService({cache: new MemorySyncCache(), local: desktopVault, remote, replicaId: "desktop"});
    for (const name of ["a", "b", "c", "d", "e", "f"]) await desktopVault.write(`notes/${name}.md`, encode(`${name} first`));
    await desktop.initializeNew("vault");
    const phoneVault = new MemoryVault();
    const phone = new SyncService({cache: new MemorySyncCache(), local: phoneVault, remote, replicaId: "phone"});
    const first = await phone.synchronize();
    // 电脑上新增、修改、删除、挪动各一个文件
    const changeOnDesktop = async () => {
      await desktopVault.write("notes/new.txt", encode("brand new"));
      await desktopVault.write("notes/a.md", encode("a second"));
      await desktopVault.delete("notes/b.md");
      await desktopVault.move("notes/c.md", "archive/c.md");
      return desktop.synchronize();
    };
    return {objects, desktop, phone, phoneVault, first, changeOnDesktop};
  };

  it("lists an added, a modified, a deleted and a moved upload once Head is published", async () => {
    const {changeOnDesktop} = await setup();

    const result = await changeOnDesktop();

    expect(result.status).toBe("complete");
    expect(byPath(result.uploads)).toEqual([
      {kind: "moved", fromPath: "notes/c.md", path: "archive/c.md"},
      {kind: "modified", path: "notes/a.md"},
      {kind: "deleted", path: "notes/b.md"},
      {kind: "added", path: "notes/new.txt"},
    ]);
    expect(result.downloads).toEqual([]);
  });

  it("tells a downloaded new file from an updated one and records downloaded deletes and moves", async () => {
    const {phone, first, changeOnDesktop} = await setup();
    expect(first.downloads).toHaveLength(6);
    expect(first.downloads.every(change => change.kind === "added")).toBe(true);
    await changeOnDesktop();

    const applied: Array<{kind: string; path: string}> = [];
    const result = await phone.synchronize([], {fullHashVerification: true, onDownloadApplied: change => applied.push(change)});

    const expected = [
      {kind: "moved", fromPath: "notes/c.md", path: "archive/c.md"},
      {kind: "updated", path: "notes/a.md"},
      {kind: "deleted", path: "notes/b.md"},
      {kind: "added", path: "notes/new.txt"},
    ];
    expect(byPath(result.downloads)).toEqual(expected);
    expect(byPath(applied)).toEqual(expected);
    expect(result.uploads).toEqual([]);
  });

  it("records both directions when one synchronization uploads and downloads", async () => {
    const {phone, phoneVault, changeOnDesktop} = await setup();
    await changeOnDesktop();
    await phoneVault.write("notes/e.md", encode("e edited on the phone"));

    const result = await phone.synchronize();

    expect(result.uploads).toEqual([{kind: "modified", path: "notes/e.md"}]);
    expect(byPath(result.downloads).map(change => change.path)).toEqual(["archive/c.md", "notes/a.md", "notes/b.md", "notes/new.txt"]);
  });

  it.each([
    {failure: "another device publishing first", error: () => new ObjectPreconditionError()},
    {failure: "a network error", error: () => new Error("network lost")},
  ])("still hands over the landed downloads when publishing fails because of $failure", async ({error}) => {
    const {objects, phone, phoneVault, changeOnDesktop} = await setup();
    await changeOnDesktop();
    await phoneVault.write("notes/e.md", encode("e edited on the phone"));
    objects.onPut = key => {
      if (!key.endsWith("/head")) return;
      objects.onPut = undefined;
      throw error();
    };

    const applied: Array<{kind: string; path: string}> = [];
    await expect(phone.synchronize([], {fullHashVerification: true, onDownloadApplied: change => applied.push(change)}))
      .rejects.toBeDefined();

    expect(byPath(applied).map(change => `${change.kind} ${change.path}`))
      .toEqual(["moved archive/c.md", "updated notes/a.md", "deleted notes/b.md", "added notes/new.txt"]);
  });
});
