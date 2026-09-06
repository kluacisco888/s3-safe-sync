import { describe, expect, it } from "vitest";

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
  type ObjectStore,
  type StoredObject,
} from "../src/storage/object-store";
import { RemoteStore } from "../src/storage/remote-store";
import { SyncRequestQueue } from "../src/sync/sync-request-queue";

class MemoryObjectStore implements ObjectStore {
  private sequence = 0;
  private readonly objects = new Map<string, StoredObject>();
  onGet: ((key: string) => Promise<void> | void) | undefined;

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
    const value = {
      body: body.slice(),
      etag: `etag-${++this.sequence}`,
      lastModified: "2026-09-05T00:00:00.000Z",
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
  beforeStat: ((path: string) => Promise<void> | void) | undefined;
  readCount = 0;
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

  move(fromPath: string, toPath: string): Promise<void> {
    const file = this.files.get(fromPath);
    if (!file) {
      throw new Error(`Missing local file ${fromPath}`);
    }
    this.files.delete(fromPath);
    this.files.set(toPath, { bytes: file.bytes, modifiedAt: ++this.clock });
    return Promise.resolve();
  }

  read(path: string): Promise<Uint8Array> {
    this.readCount += 1;
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

describe("SyncService", () => {
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
        completed: 0,
        phase: "scanning",
        total: 2,
        totalBytes: 8,
        transferredBytes: 0,
      },
      {
        completed: 1,
        currentPath: "notes/one.md",
        phase: "scanning",
        total: 2,
        totalBytes: 8,
        transferredBytes: 3,
      },
      {
        completed: 2,
        currentPath: "notes/two.md",
        phase: "scanning",
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
      "Local file changed while reading notes/example.md",
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
      "Local file changed during synchronization: notes/example.md",
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
      "Local file changed during synchronization: notes/example.md",
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

    await expect(phone.synchronize()).rejects.toThrow(
      "Vault Snapshot references missing blobs",
    );

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
      "cannot be authenticated",
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

    await expect(phone.synchronize()).rejects.toThrow(
      "No authenticated remote recovery exists",
    );

    expect(phoneVault.readText("notes/example.md")).toBe("v1");
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

    await expect(service.synchronize()).rejects.toThrow(
      "Local file changed during synchronization: notes/example.md",
    );
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
      "not supported on this device",
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
    ).rejects.toThrow("No authenticated remote recovery exists");

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
      "Local file changed during synchronization",
    );

    expect(local.readText("notes/example.md")).toBe("new local draft");
    await expect(remote.readHead()).resolves.toMatchObject({
      value: { commitId: deletedHead.value.commitId },
    });
    await local.delete("notes/example.md");

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
