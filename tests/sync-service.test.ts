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
import {
  RemoteStateError,
  RemoteStore,
} from "../src/storage/remote-store";
import { SyncRequestQueue } from "../src/sync/sync-request-queue";
import { sha256Content } from "../src/sync/content-hash";
import { LocalStateChangedError } from "../src/sync/errors";

class MemoryObjectStore implements ObjectStore {
  private sequence = 0;
  private readonly objects = new Map<string, StoredObject>();
  corruptNextBlobPut = false;
  onGet: ((key: string) => Promise<void> | void) | undefined;
  onPut: ((key: string) => Promise<void> | void) | undefined;

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
      throw new Error(`Local file changed during synchronization: ${fromPath}`);
    }
    const target = this.files.get(toPath);
    if (expectedTargetHash === null && target) {
      throw new Error(`Local file changed during synchronization: ${toPath}`);
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

describe("SyncService", () => {
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
      "cross-platform path collision",
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

  describe("reviewing local content without a trusted base", () => {
    const setup = async () => {
      const objects = new MemoryObjectStore();
      const remote = await RemoteStore.open({objects, prefix: "test", vaultKey: new Uint8Array(32)});
      const source = new MemoryVault();
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
        .rejects.toThrow("changed. Review");
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
      await expect(service.preserveLocalCopyAndAcceptRemote("article.md", review.reviewToken)).rejects.toThrow("changed");
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
      expect(review.blockedReason).toContain("device's transfer limit");
      expect(local.readCount).toBe(reads);
      await expect(service.preserveLocalCopyAndAcceptRemote("article.md", review.reviewToken)).rejects.toThrow("device's transfer limit");
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
      await expect(service.preserveLocalCopyAndAcceptRemote("article.md", review.reviewToken)).rejects.toThrow("Head changed");
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
      await expect(service.readConflictCandidate(before.entryId, "missing-candidate")).rejects.toThrow("no longer");
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
      "Local file changed during synchronization",
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

    const synchronization = phone.synchronize();
    await expect(synchronization).rejects.toThrow(
      "Vault Snapshot references missing blobs",
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

    const synchronization = phone.synchronize();
    await expect(synchronization).rejects.toThrow(
      "No authenticated remote recovery exists",
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
    ).rejects.toThrow("Head changed");
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
      message: "Local file changed during synchronization: notes/example.md",
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
      "cannot be authenticated",
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
      "Local file changed during synchronization",
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
      "Head changed",
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
      "it is owned by Entry",
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
      "Local file changed during synchronization: notes/b.md",
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
    const setupReview = async (count = 1) => {
      const objects = new MemoryObjectStore();
      const remote = await RemoteStore.open({objects, prefix: "test", vaultKey: new Uint8Array(32)});
      const local = new MemoryVault();
      for (let index = 0; index < count; index += 1) {
        await local.write(`old/${index}.md`, new TextEncoder().encode(`original ${index}`));
      }
      const cache = new MemorySyncCache();
      const service = new SyncService({cache, local, remote, replicaId: "desktop"});
      await service.initializeNew("vault");
      const original = structuredClone(cache.state!);
      for (let index = 0; index < count; index += 1) {
        await local.move(`old/${index}.md`, `new/${index}.md`);
        await local.write(`new/${index}.md`, new TextEncoder().encode(`edited ${index}`));
      }
      const issue = (await service.synchronize()).localIssues.find(issue => issue.kind === "possible-rename");
      if (!issue) throw new Error("Expected rename review");
      return {objects, remote, local, cache, service, original, issue};
    };

    it("accepts a reviewed folder move with edits, retaining every Entry and old content", async () => {
      const {service, issue, remote, original} = await setupReview(3);
      const result = await service.synchronize([], {renameResolution: {
        kind: "moves", reviewToken: issue.reviewToken,
        pairs: issue.oldPaths.map(fromPath => ({fromPath, toPath: fromPath.replace("old/", "new/")})),
      }});
      expect(result.status).toBe("complete");
      const snapshot = await remote.readSnapshot((await remote.readHead())!.value);
      expect(Object.keys(snapshot.entries).sort()).toEqual(Object.keys(original.snapshot.entries).sort());
      for (const entry of Object.values(snapshot.entries)) {
        expect(entry.kind).toBe("live");
        expect(entry.path.startsWith("new/")).toBe(true);
        expect(entry.history?.[0]?.contentHash).toBe(
          original.files[entry.path.replace("new/", "old/")]!.contentHash,
        );
      }
    });

    it.each(["local-edit", "new-file", "remote-change", "wrong-token"])(
      "rejects a stale review after %s without publishing or deleting files", async change => {
        const {service, issue, local, remote} = await setupReview();
        if (change === "local-edit") await local.write("new/0.md", new TextEncoder().encode("newer draft"));
        if (change === "new-file") await local.write("new/extra.md", new TextEncoder().encode("extra draft"));
        if (change === "remote-change") {
          const head = (await remote.readHead())!;
          const commitId = crypto.randomUUID();
          await remote.advance({expectedHeadEtag: head.etag, head: {...head.value, commitId, generation: head.value.generation + 1},
            commit: {commitId, changes: [], parentIds: [head.value.commitId], createdAt: head.serverDate,
              protocolVersion: 1, replicaId: "other", vaultId: "vault"}});
        }
        const before = (await remote.readHead())!.value.commitId;
        await expect(service.synchronize([], {renameResolution: {
          kind: "separate", reviewToken: change === "wrong-token" ? "stale" : issue.reviewToken,
        }})).rejects.toThrow("changed since the rename review");
        expect((await remote.readHead())!.value.commitId).toBe(before);
        expect(local.readText("new/0.md")).toBe(change === "local-edit" ? "newer draft" : "edited 0");
      },
    );

    it("rejects a mapping that assigns two old Entries to the same new file", async () => {
      const {service, issue} = await setupReview(2);
      await expect(service.synchronize([], {renameResolution: {kind: "moves", reviewToken: issue.reviewToken,
        pairs: issue.oldPaths.map(fromPath => ({fromPath, toPath: "new/0.md"})),
      }})).rejects.toThrow("not one-to-one");
    });

    it("requires exact bulk-delete confirmation after separate delete/add review", async () => {
      const {service, issue, remote, local} = await setupReview(2);
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
