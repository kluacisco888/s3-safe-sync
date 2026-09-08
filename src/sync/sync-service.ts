import { diff3Merge } from "node-diff3";

import {
  SyncEngine,
  type BulkDeletionPlan,
  type DeletedEntry,
  type LiveEntry,
  type ReplicaObservation,
  type RevisionRef,
  type VaultEntry,
  type VaultSnapshot,
} from "./sync-engine";
import {
  type CommitRecord,
  type HeadRecord,
  RemoteStateError,
  RemoteStore,
} from "../storage/remote-store";
import { LocalStateChangedError } from "./errors";
import type { PersistedPathRename } from "./path-rename-tracker";
import { sha256Content as sha256 } from "./content-hash";
import { canonicalVaultPath } from "./canonical-path";

export interface LocalFileInfo {
  modifiedAt: number;
  path: string;
  size: number;
}

export interface LocalContentHash {
  contentHash: string;
  size: number;
}

export interface LocalHashOptions {
  onProgress?: (hashedBytes: number) => void;
  yieldToHost?: () => Promise<void>;
}

export interface LocalVaultPort {
  delete(
    path: string,
    expectedContentHash?: string | null,
  ): Promise<void>;
  hashContent?(
    path: string,
    options?: LocalHashOptions,
  ): Promise<LocalContentHash>;
  list(): Promise<LocalFileInfo[]>;
  move(
    fromPath: string,
    toPath: string,
    expectedSourceHash?: string,
    expectedTargetHash?: string | null,
  ): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<LocalFileInfo | undefined>;
  supportsPath?(path: string): boolean;
  write(
    path: string,
    body: Uint8Array,
    expectedCurrentHash?: string | null,
  ): Promise<void>;
}

export interface CachedFileState extends LocalFileInfo {
  contentHash: string;
  entryId: string;
}

export interface CachedSyncState {
  files: Record<string, CachedFileState>;
  snapshot: VaultSnapshot;
  unmaterializedEntryIds?: string[];
}

export interface SyncCachePort {
  load(): Promise<CachedSyncState | undefined>;
  save(state: CachedSyncState): Promise<void>;
}

export interface SyncServiceOptions {
  cache: SyncCachePort;
  local: LocalVaultPort;
  maxAutomaticFileBytes?: number | ((path: string) => number | undefined);
  onProgress?: (progress: SyncProgress) => void;
  remote: RemoteStore;
  replicaId: string;
  yieldDuringHashing?: () => Promise<void>;
}

export interface SyncProgress {
  completed: number;
  currentPath?: string;
  phase: "downloading" | "hashing" | "publishing" | "scanning" | "uploading";
  total: number;
  totalBytes: number;
  transferredBytes: number;
}

export interface SyncResult {
  cacheUpdated: boolean;
  deferredDownloadEntries: DeferredDownloadEntry[];
  bulkDeletion?: BulkDeletionPlan;
  deferredDownloads: number;
  deleted: number;
  downloaded: number;
  localIssues: LocalSyncIssue[];
  status: "action-required" | "complete";
  unsyncedLocalEntries: number;
  uploaded: number;
}

export interface SyncScanOptions {
  forceHashPaths?: ReadonlySet<string>;
  fullHashVerification?: boolean;
  retryHashMemo?: Map<string, VerifiedLocalFile>;
}

export interface SynchronizeOptions extends SyncScanOptions {
  assertLocalObservationCurrent?: () => void;
  pathRenames?: ReadonlyMap<string, PersistedPathRename>;
}

export interface VerifiedLocalFile extends LocalFileInfo {
  contentHash: string;
}

interface FileScanOptions extends SyncScanOptions {
  hashHints?: ReadonlyMap<string, VerifiedLocalFile>;
  pathRenames?: ReadonlyMap<string, PersistedPathRename>;
}

export interface DeferredDownloadEntry {
  entryId: string;
  path: string;
  reason: "device-limit" | "unsupported-path";
  size: number;
}

export type LocalSyncIssue =
  | { kind: "bootstrap-mismatch"; path: string }
  | { kind: "deferred-local-edit"; path: string }
  | { kind: "import-candidate"; path: string }
  | { kind: "path-collision"; paths: string[] }
  | { kind: "possible-rename"; newPaths: string[]; oldPaths: string[] }
  | { kind: "resolution-mismatch"; path: string }
  | { kind: "unsupported-path"; path: string }
  | { kind: "unsynced-local"; path: string };

export interface RestoreCandidateResolution {
  kind: "restore-candidate";
  revisionId: string;
}

export interface KeepDeletedResolution {
  kind: "keep-deleted";
}

export type ConflictResolution =
  | KeepDeletedResolution
  | RestoreCandidateResolution;

const mergeMarkdown = (
  local: Uint8Array,
  base: Uint8Array,
  remote: Uint8Array,
): Uint8Array | undefined => {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const regions = diff3Merge(
    decoder.decode(local).split("\n"),
    decoder.decode(base).split("\n"),
    decoder.decode(remote).split("\n"),
    { excludeFalseConflicts: true },
  );
  if (regions.some((region) => region.conflict !== undefined)) {
    return undefined;
  }
  return new TextEncoder().encode(
    regions.flatMap((region) => region.ok ?? []).join("\n"),
  );
};

const expiresInDays = (createdAt: string, days: number): string => {
  const expiresAt = new Date(createdAt);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + days);
  return expiresAt.toISOString();
};

const keepForRecovery = <T extends { createdAt: string }>(
  revision: T,
  from: string,
): T & { expiresAt: string } => ({
  ...revision,
  expiresAt: expiresInDays(from, 30),
});

const restoreAsCurrent = (
  revision: RevisionRef,
  createdAt: string,
): RevisionRef => {
  const { expiresAt: _expiredRecovery, ...current } = revision;
  return { ...current, createdAt, revisionId: crypto.randomUUID() };
};

const retainConflictHistory = (
  revisions: RevisionRef[],
  createdAt: string,
): RevisionRef[] => {
  const retained = new Map<string, RevisionRef>();
  for (const revision of revisions) {
    retained.set(
      revision.revisionId,
      revision.expiresAt ? revision : keepForRecovery(revision, createdAt),
    );
  }
  return [...retained.values()];
};

export class SyncService {
  private readonly engine = new SyncEngine();

  constructor(private readonly options: SyncServiceOptions) {}

  async initializeNew(vaultId: string): Promise<void> {
    if (await this.options.remote.readHead()) {
      throw new Error("Remote Store is already initialized");
    }
    const scan = await this.scanFiles(undefined, true);
    const files = scan.files;
    const pathsByCanonicalForm = new Map<string, string[]>();
    for (const file of files) {
      const canonical = canonicalVaultPath(file.path);
      const paths = pathsByCanonicalForm.get(canonical) ?? [];
      paths.push(file.path);
      pathsByCanonicalForm.set(canonical, paths);
    }
    const collision = [...pathsByCanonicalForm.values()].find(
      (paths) => paths.length > 1,
    );
    if (collision) {
      throw new Error(
        `Migration Baseline contains a cross-platform path collision: ${collision.join(", ")}`,
      );
    }
    if (scan.unsyncedLocalEntries > 0) {
      throw new Error("The Migration Baseline contains files above the device limit");
    }
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    let completed = 0;
    let transferredBytes = 0;
    this.reportProgress({
      completed,
      phase: "uploading",
      total: files.length,
      totalBytes,
      transferredBytes,
    });
    const createdAt = new Date().toISOString();
    const entries: VaultSnapshot["entries"] = {};
    const cacheFiles: Record<string, CachedFileState> = {};
    for (const file of files) {
      const entryId = crypto.randomUUID();
      const blobId = crypto.randomUUID();
      const revisionId = crypto.randomUUID();
      this.reportProgress({
        completed,
        currentPath: file.path,
        phase: "uploading",
        total: files.length,
        totalBytes,
        transferredBytes,
      });
      const plaintext = await this.options.local.read(file.path);
      if (
        plaintext.byteLength !== file.size ||
        (await sha256(plaintext)) !== file.contentHash
      ) {
        throw new Error(`Local file changed while reading ${file.path}`);
      }
      await this.options.remote.writeBlob(blobId, plaintext);
      const revision: RevisionRef = {
        blobId,
        contentHash: file.contentHash,
        createdAt,
        revisionId,
        size: file.size,
      };
      await this.assertRemoteRevision(revision);
      completed += 1;
      transferredBytes += file.size;
      this.reportProgress({
        completed,
        currentPath: file.path,
        phase: "uploading",
        total: files.length,
        totalBytes,
        transferredBytes,
      });
      entries[entryId] = {
        entryId,
        kind: "live",
        path: file.path,
        revision,
      };
      cacheFiles[file.path] = { ...file, entryId };
    }
    const commitId = crypto.randomUUID();
    const commit: CommitRecord = {
      changes: Object.values(entries).map((entry) => ({
        entry,
        kind: "set-entry",
      })),
      commitId,
      createdAt,
      parentIds: [],
      protocolVersion: 1,
      replicaId: this.options.replicaId,
      vaultId,
    };
    const head: HeadRecord = {
      commitId,
      generation: 1,
      protocolVersion: 1,
      vaultId,
    };
    this.reportProgress({
      completed,
      phase: "publishing",
      total: files.length,
      totalBytes,
      transferredBytes,
    });
    await this.options.remote.initialize({ commit, head });
    const snapshot: VaultSnapshot = {
      commitId,
      entries,
      protocolVersion: 1,
      vaultId,
    };
    const currentFiles = new Map(
      (await this.options.local.list()).map((file) => [file.path, file] as const),
    );
    const stableCacheFiles = Object.fromEntries(
      Object.entries(cacheFiles).filter(([path, cached]) => {
        const current = currentFiles.get(path);
        return (
          current?.modifiedAt === cached.modifiedAt &&
          current.size === cached.size
        );
      }),
    );
    await this.options.cache.save({
      files: stableCacheFiles,
      snapshot,
      unmaterializedEntryIds: [],
    });
  }

  private reportProgress(progress: SyncProgress): void {
    this.options.onProgress?.(progress);
  }

  async downloadDeferred(entryId: string): Promise<void> {
    const versionedHead = await this.options.remote.readHead();
    if (!versionedHead) {
      throw new Error("Remote Store is not initialized");
    }
    const snapshot = await this.options.remote.readSnapshot(versionedHead.value);
    const entry = snapshot.entries[entryId];
    if (entry?.kind !== "live") {
      throw new Error(`Deferred Entry ${entryId} is not live`);
    }
    if (this.options.local.supportsPath?.(entry.path) === false) {
      throw new Error(`Path is not supported on this device: ${entry.path}`);
    }
    const cached = await this.options.cache.load();
    const expectedContentHash = cached?.files[entry.path]?.contentHash ?? null;
    await this.assertLocalContent(entry.path, expectedContentHash);
    await this.assertRemoteRecoveryForLocalContent(
      snapshot,
      entry.entryId,
      expectedContentHash,
    );
    const plaintext = await this.options.remote.readBlob(entry.revision.blobId);
    if (
      !plaintext ||
      plaintext.byteLength !== entry.revision.size ||
      (await sha256(plaintext)) !== entry.revision.contentHash
    ) {
      throw new Error(`Deferred Revision ${entry.revision.revisionId} is damaged`);
    }
    await this.assertLocalContent(entry.path, expectedContentHash);
    await this.options.local.write(
      entry.path,
      plaintext,
      expectedContentHash,
    );
    await this.options.cache.save(await this.buildCache(snapshot));
  }

  async importCandidate(path: string): Promise<void> {
    const versionedHead = await this.options.remote.readHead();
    if (!versionedHead) {
      throw new Error("Remote Store is not initialized");
    }
    const snapshot = await this.options.remote.readSnapshot(versionedHead.value);
    const canonicalPath = canonicalVaultPath(path);
    const pathIsKnown = Object.values(snapshot.entries).some(
      (entry) =>
        canonicalVaultPath(entry.path) === canonicalPath,
    );
    if (pathIsKnown) {
      throw new Error(`Remote Store already knows path ${path}`);
    }
    const file = (await this.options.local.list()).find(
      (candidate) => candidate.path === path,
    );
    if (!file) {
      throw new Error(`Import Candidate no longer exists: ${path}`);
    }
    if (
      this.exceedsAutomaticFileLimit(file.path, file.size)
    ) {
      throw new Error(`Import Candidate exceeds the mobile limit: ${path}`);
    }
    const plaintext = await this.options.local.read(path);
    if (plaintext.byteLength !== file.size) {
      throw new LocalStateChangedError(path);
    }
    const createdAt = versionedHead.serverDate;
    const entryId = crypto.randomUUID();
    const blobId = crypto.randomUUID();
    await this.options.remote.writeBlob(blobId, plaintext);
    const revision: RevisionRef = {
      blobId,
      contentHash: await sha256(plaintext),
      createdAt,
      revisionId: crypto.randomUUID(),
      size: plaintext.byteLength,
    };
    await this.assertRemoteRevision(revision);
    const entry: VaultEntry = {
      entryId,
      kind: "live",
      path,
      revision,
    };
    const commitId = crypto.randomUUID();
    await this.options.remote.advance({
      commit: {
        changes: [{ entry, kind: "set-entry" }],
        commitId,
        createdAt,
        parentIds: [versionedHead.value.commitId],
        protocolVersion: 1,
        replicaId: this.options.replicaId,
        vaultId: snapshot.vaultId,
      },
      expectedHeadEtag: versionedHead.etag,
      head: {
        commitId,
        generation: versionedHead.value.generation + 1,
        protocolVersion: 1,
        snapshotId: versionedHead.value.snapshotId,
        vaultId: snapshot.vaultId,
      },
    });
    await this.options.cache.save(
      await this.buildCache({
        commitId,
        entries: { ...snapshot.entries, [entryId]: entry },
        protocolVersion: 1,
        vaultId: snapshot.vaultId,
      }),
    );
  }

  async resolveConflict(
    entryId: string,
    resolution: ConflictResolution,
  ): Promise<void> {
    const versionedHead = await this.options.remote.readHead();
    if (!versionedHead) {
      throw new Error("Remote Store is not initialized");
    }
    const snapshot = await this.options.remote.readSnapshot(versionedHead.value);
    const conflicted = snapshot.entries[entryId];
    if (conflicted?.kind !== "conflicted") {
      throw new Error(`Entry ${entryId} is not conflicted`);
    }
    if (this.options.local.supportsPath?.(conflicted.path) === false) {
      throw new Error(`Path is not supported on this device: ${conflicted.path}`);
    }
    await this.assertRemoteEntriesBeforePublication(
      snapshot,
      new Set([entryId]),
      [],
    );
    const expectedMaterializedContentHash =
      conflicted.materializedContentHash ?? null;
    await this.assertLocalContent(
      conflicted.path,
      expectedMaterializedContentHash,
    );
    const createdAt = versionedHead.serverDate;
    let materializedContent: Uint8Array | undefined;
    let resolvedEntry: VaultEntry;
    if (resolution.kind === "restore-candidate") {
      this.assertRemotePathAvailable(
        snapshot,
        conflicted.entryId,
        conflicted.path,
      );
      const candidate = conflicted.candidates.find(
        (revision) => revision.revisionId === resolution.revisionId,
      );
      if (!candidate) {
        throw new Error(
          `Conflict candidate ${resolution.revisionId} does not exist`,
        );
      }
      materializedContent = await this.options.remote.readBlob(candidate.blobId);
      if (
        !materializedContent ||
        materializedContent.byteLength !== candidate.size ||
        (await sha256(materializedContent)) !== candidate.contentHash
      ) {
        throw new Error(`Conflict candidate ${resolution.revisionId} is damaged`);
      }
      resolvedEntry = {
        entryId,
        history: retainConflictHistory(
          [
            ...conflicted.candidates.filter(
              (revision) => revision.revisionId !== resolution.revisionId,
            ),
            ...(conflicted.recovery ? [conflicted.recovery] : []),
            ...(conflicted.history ?? []),
          ],
          createdAt,
        ),
        kind: "live",
        path: conflicted.path,
        revision: restoreAsCurrent(candidate, createdAt),
      };
    } else {
      if (
        !conflicted.deletedAt ||
        !conflicted.lastContentHash ||
        !conflicted.lastRevisionId
      ) {
        throw new Error("This Conflict does not contain a deletion decision");
      }
      resolvedEntry = {
        deletedAt: conflicted.deletedAt,
        entryId,
        history: retainConflictHistory(
          [...conflicted.candidates, ...(conflicted.history ?? [])],
          createdAt,
        ),
        kind: "deleted",
        lastContentHash: conflicted.lastContentHash,
        lastRevisionId: conflicted.lastRevisionId,
        path: conflicted.path,
        recovery: conflicted.recovery,
      };
    }
    const commitId = crypto.randomUUID();
    const commit: CommitRecord = {
      changes: [{ entry: resolvedEntry, kind: "set-entry" }],
      commitId,
      createdAt,
      parentIds: [versionedHead.value.commitId],
      protocolVersion: 1,
      replicaId: this.options.replicaId,
      vaultId: versionedHead.value.vaultId,
    };
    const head: HeadRecord = {
      commitId,
      generation: versionedHead.value.generation + 1,
      protocolVersion: 1,
      snapshotId: versionedHead.value.snapshotId,
      vaultId: versionedHead.value.vaultId,
    };
    await this.options.remote.advance({
      commit,
      expectedHeadEtag: versionedHead.etag,
      head,
    });
    await this.assertLocalContent(
      conflicted.path,
      expectedMaterializedContentHash,
    );
    if (materializedContent) {
      await this.options.local.write(
        conflicted.path,
        materializedContent,
        expectedMaterializedContentHash,
      );
    } else {
      await this.options.local.delete(
        conflicted.path,
        expectedMaterializedContentHash,
      );
    }
    await this.options.cache.save(
      await this.buildCache({
        commitId,
        entries: { ...snapshot.entries, [entryId]: resolvedEntry },
        protocolVersion: 1,
        vaultId: snapshot.vaultId,
      }),
    );
  }

  async restoreRevision(entryId: string, revisionId: string): Promise<void> {
    const versionedHead = await this.options.remote.readHead();
    if (!versionedHead) {
      throw new Error("Remote Store is not initialized");
    }
    const snapshot = await this.options.remote.readSnapshot(versionedHead.value);
    const entry = snapshot.entries[entryId];
    if (entry?.kind !== "live") {
      throw new Error(`Entry ${entryId} is not live`);
    }
    if (this.options.local.supportsPath?.(entry.path) === false) {
      throw new Error(`Path is not supported on this device: ${entry.path}`);
    }
    const historical = entry.history?.find(
      (revision) => revision.revisionId === revisionId,
    );
    if (!historical) {
      throw new Error(`Historical Revision ${revisionId} does not exist`);
    }
    await this.assertLocalContent(entry.path, entry.revision.contentHash);
    await this.assertRemoteRecoveryForLocalContent(
      snapshot,
      entry.entryId,
      entry.revision.contentHash,
    );
    const plaintext = await this.options.remote.readBlob(historical.blobId);
    if (
      !plaintext ||
      plaintext.byteLength !== historical.size ||
      (await sha256(plaintext)) !== historical.contentHash
    ) {
      throw new Error(`Historical Revision ${revisionId} is damaged`);
    }
    if (
      historical.expiresAt !== undefined &&
      Date.parse(historical.expiresAt) <= Date.parse(versionedHead.serverDate)
    ) {
      throw new Error(`Historical Revision ${revisionId} has expired`);
    }
    const createdAt = versionedHead.serverDate;
    const restoredEntry: VaultEntry = {
      entryId,
      history: [
        keepForRecovery(entry.revision, createdAt),
        ...(entry.history ?? []).filter(
          (revision) => revision.revisionId !== revisionId,
        ),
      ],
      kind: "live",
      path: entry.path,
      revision: restoreAsCurrent(historical, createdAt),
    };
    const commitId = crypto.randomUUID();
    await this.options.remote.advance({
      commit: {
        changes: [{ entry: restoredEntry, kind: "set-entry" }],
        commitId,
        createdAt,
        parentIds: [versionedHead.value.commitId],
        protocolVersion: 1,
        replicaId: this.options.replicaId,
        vaultId: snapshot.vaultId,
      },
      expectedHeadEtag: versionedHead.etag,
      head: {
        commitId,
        generation: versionedHead.value.generation + 1,
        protocolVersion: 1,
        snapshotId: versionedHead.value.snapshotId,
        vaultId: snapshot.vaultId,
      },
    });
    await this.assertLocalContent(entry.path, entry.revision.contentHash);
    await this.options.local.write(
      entry.path,
      plaintext,
      entry.revision.contentHash,
    );
    await this.options.cache.save(
      await this.buildCache({
        commitId,
        entries: { ...snapshot.entries, [entryId]: restoredEntry },
        protocolVersion: 1,
        vaultId: snapshot.vaultId,
      }),
    );
  }

  async readDeletedRecovery(
    entryId: string,
    revisionId?: string,
  ): Promise<Uint8Array> {
    const versionedHead = await this.options.remote.readHead();
    if (!versionedHead) {
      throw new Error("Remote Store is not initialized");
    }
    const snapshot = await this.options.remote.readSnapshot(versionedHead.value);
    const deleted = snapshot.entries[entryId];
    if (deleted?.kind !== "deleted") {
      throw new Error(`Entry ${entryId} is not deleted`);
    }
    const revision = revisionId
      ? [deleted.recovery, ...(deleted.history ?? [])].find(
          (candidate) => candidate?.revisionId === revisionId,
        )
      : deleted.recovery;
    if (!revision) {
      throw new Error(`Deleted Revision ${revisionId ?? entryId} does not exist`);
    }
    return this.readDeletedRevisionCopy(
      deleted.entryId,
      revision,
      versionedHead.serverDate,
    );
  }

  async restoreDeleted(entryId: string, revisionId?: string): Promise<void> {
    const versionedHead = await this.options.remote.readHead();
    if (!versionedHead) {
      throw new Error("Remote Store is not initialized");
    }
    const snapshot = await this.options.remote.readSnapshot(versionedHead.value);
    const deleted = snapshot.entries[entryId];
    if (deleted?.kind !== "deleted") {
      throw new Error(`Entry ${entryId} is not deleted`);
    }
    const selected = revisionId
      ? [deleted.recovery, ...(deleted.history ?? [])].find(
          (candidate) => candidate?.revisionId === revisionId,
        )
      : deleted.recovery;
    if (!selected) {
      throw new Error(`Deleted Revision ${revisionId ?? entryId} does not exist`);
    }
    if (this.options.local.supportsPath?.(deleted.path) === false) {
      throw new Error(`Path is not supported on this device: ${deleted.path}`);
    }
    this.assertRemotePathAvailable(snapshot, deleted.entryId, deleted.path);
    await this.assertRemoteEntriesBeforePublication(
      snapshot,
      new Set([entryId]),
      [],
    );
    const plaintext = await this.readDeletedRevisionCopy(
      deleted.entryId,
      selected,
      versionedHead.serverDate,
    );
    await this.assertLocalContent(deleted.path, null);
    const createdAt = versionedHead.serverDate;
    const restoredEntry: VaultEntry = {
      entryId,
      history: retainConflictHistory(
        [
          ...(deleted.recovery?.revisionId !== selected.revisionId &&
          deleted.recovery
            ? [deleted.recovery]
            : []),
          ...(deleted.history ?? []).filter(
            (revision) => revision.revisionId !== selected.revisionId,
          ),
        ],
        createdAt,
      ),
      kind: "live",
      path: deleted.path,
      revision: restoreAsCurrent(selected, createdAt),
    };
    const commitId = crypto.randomUUID();
    await this.options.remote.advance({
      commit: {
        changes: [{ entry: restoredEntry, kind: "set-entry" }],
        commitId,
        createdAt,
        parentIds: [versionedHead.value.commitId],
        protocolVersion: 1,
        replicaId: this.options.replicaId,
        vaultId: snapshot.vaultId,
      },
      expectedHeadEtag: versionedHead.etag,
      head: {
        commitId,
        generation: versionedHead.value.generation + 1,
        protocolVersion: 1,
        snapshotId: versionedHead.value.snapshotId,
        vaultId: snapshot.vaultId,
      },
    });
    await this.assertLocalContent(deleted.path, null);
    await this.options.local.write(deleted.path, plaintext, null);
    await this.options.cache.save(
      await this.buildCache({
        commitId,
        entries: { ...snapshot.entries, [entryId]: restoredEntry },
        protocolVersion: 1,
        vaultId: snapshot.vaultId,
      }),
    );
  }

  private async readRecoveryCopy(
    deleted: DeletedEntry,
    serverDate: string,
  ): Promise<Uint8Array> {
    const recovery = deleted.recovery;
    if (!recovery) {
      throw new Error(`Entry ${deleted.entryId} has no Recovery Copy`);
    }
    return this.readDeletedRevisionCopy(
      deleted.entryId,
      recovery,
      serverDate,
    );
  }

  private async readDeletedRevisionCopy(
    entryId: string,
    revision: RevisionRef,
    serverDate: string,
  ): Promise<Uint8Array> {
    const plaintext = await this.options.remote.readBlob(revision.blobId);
    if (
      !plaintext ||
      plaintext.byteLength !== revision.size ||
      (await sha256(plaintext)) !== revision.contentHash
    ) {
      throw new Error(`Recovery Copy for ${entryId} is damaged`);
    }
    if (
      revision.expiresAt !== undefined &&
      Date.parse(revision.expiresAt) <= Date.parse(serverDate)
    ) {
      throw new Error(`Recovery Copy for ${entryId} has expired`);
    }
    return plaintext;
  }

  async synchronize(
    approvedBulkDeletionEntryIds: readonly string[] = [],
    syncOptions: SynchronizeOptions = { fullHashVerification: true },
  ): Promise<SyncResult> {
    const versionedHead = await this.options.remote.readHead();
    if (!versionedHead) {
      throw new Error("Remote Store is not initialized");
    }
    let remote = await this.options.remote.readSnapshot(versionedHead.value);
    const cached = await this.options.cache.load();
    const scan = await this.scanFiles(cached, true, syncOptions);
    syncOptions.assertLocalObservationCurrent?.();
    const scanned = scan.files;
    const localPaths = new Set(scan.localPaths);
    const scannedByPath = new Map(
      scanned.map((file) => [file.path, file] as const),
    );
    const applicablePathRenames = new Map(
      [...(syncOptions.pathRenames ?? [])].filter(
        ([fromPath, rename]) =>
          cached?.files[fromPath]?.entryId === rename.entryId,
      ),
    );
    const renamedSourcePaths = new Set(applicablePathRenames.keys());
    const renameSourcesByTarget = new Map<string, string[]>();
    for (const [fromPath, rename] of applicablePathRenames) {
      const sources = renameSourcesByTarget.get(rename.toPath) ?? [];
      sources.push(fromPath);
      renameSourcesByTarget.set(rename.toPath, sources);
    }
    const missingCachedByFingerprint = new Map<string, CachedFileState[]>();
    for (const cachedFile of Object.values(cached?.files ?? {})) {
      if (
        localPaths.has(cachedFile.path) &&
        !renamedSourcePaths.has(cachedFile.path)
      ) {
        continue;
      }
      const fingerprint = `${cachedFile.size}:${cachedFile.contentHash}`;
      const candidates = missingCachedByFingerprint.get(fingerprint) ?? [];
      candidates.push(cachedFile);
      missingCachedByFingerprint.set(fingerprint, candidates);
    }
    const entryIdByPath = new Map<string, string>();
    const newFilesByFingerprint = new Map<string, LocalFileInfo[]>();
    for (const file of scanned) {
      if (
        cached?.files[file.path] &&
        !renamedSourcePaths.has(file.path)
      ) {
        continue;
      }
      const fingerprint = `${file.size}:${file.contentHash}`;
      const claimants = newFilesByFingerprint.get(fingerprint) ?? [];
      claimants.push(file);
      newFilesByFingerprint.set(fingerprint, claimants);
    }
    for (const file of scanned) {
      const renameSources = renameSourcesByTarget.get(file.path);
      const renamedFile =
        renameSources?.length === 1 && renameSources[0]
          ? cached?.files[renameSources[0]]
          : undefined;
      if (renamedFile) {
        entryIdByPath.set(file.path, renamedFile.entryId);
        continue;
      }
      if (renamedSourcePaths.has(file.path)) {
        continue;
      }
      const exact = cached?.files[file.path];
      if (exact) {
        entryIdByPath.set(file.path, exact.entryId);
        continue;
      }
      const renameCandidates = missingCachedByFingerprint.get(
        `${file.size}:${file.contentHash}`,
      );
      const newClaimants = newFilesByFingerprint.get(
        `${file.size}:${file.contentHash}`,
      );
      if (
        renameCandidates?.length === 1 &&
        renameCandidates[0] &&
        newClaimants?.length === 1
      ) {
        entryIdByPath.set(file.path, renameCandidates[0].entryId);
      }
    }
    const deferredDownloadEntries = Object.values(remote.entries).flatMap(
      (entry): DeferredDownloadEntry[] => {
        if (entry.kind !== "live") {
          return [];
        }
        const localFile = scannedByPath.get(entry.path);
        if (localFile?.contentHash === entry.revision.contentHash) {
          return [];
        }
        if (this.options.local.supportsPath?.(entry.path) === false) {
          return [
            {
              entryId: entry.entryId,
              path: entry.path,
              reason: "unsupported-path",
              size: entry.revision.size,
            },
          ];
        }
        if (
          this.exceedsAutomaticFileLimit(entry.path, entry.revision.size)
        ) {
          return [
            {
              entryId: entry.entryId,
              path: entry.path,
              reason: "device-limit",
              size: entry.revision.size,
            },
          ];
        }
        return [];
      },
    );
    const deferredEntryIds = new Set(
      deferredDownloadEntries.map((entry) => entry.entryId),
    );
    for (const entryId of scan.skippedTrackedEntryIds) {
      deferredEntryIds.add(entryId);
    }
    const cachedLiveEntriesByPath = new Map(
      Object.values(cached?.snapshot.entries ?? {}).flatMap((entry) =>
        entry.kind === "live" ? ([[entry.path, entry]] as const) : [],
      ),
    );
    const remoteLiveEntriesByPath = new Map(
      Object.values(remote.entries).flatMap((entry) =>
        entry.kind === "live" ? ([[entry.path, entry]] as const) : [],
      ),
    );
    for (const path of scan.unsyncedLocalPaths) {
      const knownEntry =
        cachedLiveEntriesByPath.get(path) ?? remoteLiveEntriesByPath.get(path);
      if (knownEntry) {
        deferredEntryIds.add(knownEntry.entryId);
      }
    }
    const cachedFilesByEntryId = new Map(
      Object.values(cached?.files ?? {}).map((file) => [file.entryId, file]),
    );
    const deferredLocalEditPaths = scanned.flatMap((file) => {
      const entryId = entryIdByPath.get(file.path);
      const accepted = entryId
        ? cachedFilesByEntryId.get(entryId)
        : undefined;
      return entryId &&
        deferredEntryIds.has(entryId) &&
        accepted &&
        file.contentHash !== accepted.contentHash
        ? [file.path]
        : [];
    });
    const materializedEntryIds = new Set(
      Object.values(cached?.files ?? {}).map((file) => file.entryId),
    );
    const unmaterializedEntryIds = new Set(
      cached?.unmaterializedEntryIds ?? [],
    );
    if (cached && cached.unmaterializedEntryIds === undefined) {
      for (const entry of Object.values(cached.snapshot.entries)) {
        if (
          entry.kind === "live" &&
          !materializedEntryIds.has(entry.entryId)
        ) {
          unmaterializedEntryIds.add(entry.entryId);
        }
      }
    }
    const observation: ReplicaObservation = {
      basedOnCommitId: cached?.snapshot.commitId,
      deferredEntryIds: [...deferredEntryIds],
      files: scanned.map((file) => ({
        contentHash: file.contentHash,
        entryId: entryIdByPath.get(file.path),
        path: file.path,
        size: file.size,
      })),
      replicaId: this.options.replicaId,
      unmaterializedEntryIds: [...unmaterializedEntryIds],
    };
    const expectedLocalContentByPath = new Map(
      observation.files.map((file) => [file.path, file.contentHash] as const),
    );
    const locallyMutatedPaths = new Set<string>();
    const reconciliationBase = this.buildReconciliationBase(cached);
    const plan = this.engine.reconcile({
      base: reconciliationBase,
      local: observation,
      remote,
    });
    const localIssues: LocalSyncIssue[] = [
      ...plan.conflicts.flatMap((conflict): LocalSyncIssue[] => {
        if (conflict.kind === "import-candidate") {
          return [{ kind: "import-candidate", path: conflict.path }];
        }
        if (conflict.kind === "bootstrap-mismatch") {
          return [{ kind: "bootstrap-mismatch", path: conflict.path }];
        }
        if (conflict.kind === "resolution-mismatch") {
          return [{ kind: "resolution-mismatch", path: conflict.path }];
        }
        if (conflict.kind === "possible-rename") {
          return [
            {
              kind: "possible-rename",
              newPaths: conflict.newFiles.map((file) => file.path),
              oldPaths: conflict.deletedEntries.map((entry) => entry.path),
            },
          ];
        }
        if (conflict.kind === "path-collision") {
          return [{ kind: "path-collision", paths: conflict.paths }];
        }
        return [];
      }),
      ...scan.unsyncedLocalPaths.map(
        (path): LocalSyncIssue => ({ kind: "unsynced-local", path }),
      ),
      ...deferredLocalEditPaths.map(
        (path): LocalSyncIssue => ({ kind: "deferred-local-edit", path }),
      ),
      ...deferredDownloadEntries.flatMap((entry): LocalSyncIssue[] =>
        entry.reason === "unsupported-path"
          ? [{ kind: "unsupported-path", path: entry.path }]
          : [],
      ),
    ];

    const hasBlockingConflict = plan.conflicts.some(
      (conflict) =>
        conflict.kind === "bootstrap-mismatch" ||
        conflict.kind === "import-candidate" ||
        conflict.kind === "path-collision" ||
        conflict.kind === "possible-rename" ||
        conflict.kind === "resolution-mismatch",
    );
    if (hasBlockingConflict) {
      return {
        bulkDeletion: plan.bulkDeletion,
        cacheUpdated: false,
        deferredDownloadEntries,
        deferredDownloads: deferredEntryIds.size,
        deleted: 0,
        downloaded: 0,
        localIssues,
        status: "action-required",
        unsyncedLocalEntries: scan.unsyncedLocalEntries,
        uploaded: 0,
      };
    }

    const approvedBulkDeletionEntryIdSet = new Set(
      approvedBulkDeletionEntryIds,
    );
    const bulkDeletionIsApproved =
      plan.bulkDeletion !== undefined &&
      approvedBulkDeletionEntryIdSet.size === plan.bulkDeletion.entryIds.length &&
      plan.bulkDeletion.entryIds.every((entryId) =>
        approvedBulkDeletionEntryIdSet.has(entryId),
      );
    if (plan.bulkDeletion && !bulkDeletionIsApproved) {
      return {
        bulkDeletion: plan.bulkDeletion,
        cacheUpdated: false,
        deferredDownloadEntries,
        deferredDownloads: deferredEntryIds.size,
        deleted: 0,
        downloaded: 0,
        localIssues,
        status: "action-required",
        unsyncedLocalEntries: scan.unsyncedLocalEntries,
        uploaded: 0,
      };
    }

    const sharedConflicts = plan.conflicts.filter(
      (conflict) =>
        conflict.kind === "delete-edit" ||
        conflict.kind === "edit-delete" ||
        conflict.kind === "edit-edit",
    );
    await this.assertRemoteEntriesBeforePublication(
      remote,
      new Set([
        ...plan.remoteChanges.map((change) => change.entryId),
        ...sharedConflicts.map((conflict) => conflict.entryId),
      ]),
      [
        ...plan.remoteChanges.flatMap((change) =>
          change.kind === "delete-remote" ? [change.recoveryRevision] : [],
        ),
        ...sharedConflicts.flatMap((conflict) =>
          conflict.kind === "delete-edit" ? [conflict.baseRevision] : [],
        ),
      ],
    );

    const downloadingActions = plan.localActions.filter(
      (action) => action.kind === "download-remote",
    );
    const downloadTotalBytes = downloadingActions.reduce(
      (sum, action) => sum + action.revision.size,
      0,
    );
    let deleted = 0;
    let downloaded = 0;
    let downloadedBytes = 0;
    for (const action of plan.localActions) {
      if (action.kind === "delete-local") {
        const remoteEntry = remote.entries[action.entryId];
        if (remoteEntry?.kind === "deleted") {
          await this.assertRecoveryBeforeDelete(
            remoteEntry,
            versionedHead.serverDate,
          );
        }
        await this.assertLocalContent(
          action.path,
          expectedLocalContentByPath.get(action.path) ?? null,
        );
        const expectedContentHash =
          expectedLocalContentByPath.get(action.path) ?? null;
        await this.options.local.delete(action.path, expectedContentHash);
        locallyMutatedPaths.add(action.path);
        expectedLocalContentByPath.delete(action.path);
        deleted += 1;
      } else if (action.kind === "move-local") {
        const expectedContentHash =
          expectedLocalContentByPath.get(action.fromPath) ?? null;
        await this.assertLocalContent(action.fromPath, expectedContentHash);
        await this.options.local.move(
          action.fromPath,
          action.toPath,
          expectedContentHash ?? undefined,
          null,
        );
        locallyMutatedPaths.add(action.fromPath);
        locallyMutatedPaths.add(action.toPath);
        expectedLocalContentByPath.delete(action.fromPath);
        if (expectedContentHash) {
          expectedLocalContentByPath.set(action.toPath, expectedContentHash);
        }
      } else {
        this.reportProgress({
          completed: downloaded,
          currentPath: action.path,
          phase: "downloading",
          total: downloadingActions.length,
          totalBytes: downloadTotalBytes,
          transferredBytes: downloadedBytes,
        });
        const plaintext = await this.options.remote.readBlob(
          action.revision.blobId,
        );
        if (!plaintext) {
          throw new Error(`Missing remote blob ${action.revision.blobId}`);
        }
        if (
          plaintext.byteLength !== action.revision.size ||
          (await sha256(plaintext)) !== action.revision.contentHash
        ) {
          throw new Error(`Remote blob ${action.revision.blobId} failed hash verification`);
        }
        const expectedContentHash =
          expectedLocalContentByPath.get(action.path) ?? null;
        await this.assertRemoteRecoveryForLocalContent(
          remote,
          action.entryId,
          expectedContentHash,
        );
        await this.assertLocalContent(action.path, expectedContentHash);
        await this.options.local.write(
          action.path,
          plaintext,
          expectedContentHash,
        );
        locallyMutatedPaths.add(action.path);
        expectedLocalContentByPath.set(
          action.path,
          action.revision.contentHash,
        );
        downloaded += 1;
        downloadedBytes += action.revision.size;
        this.reportProgress({
          completed: downloaded,
          currentPath: action.path,
          phase: "downloading",
          total: downloadingActions.length,
          totalBytes: downloadTotalBytes,
          transferredBytes: downloadedBytes,
        });
      }
    }

    const uploadingChanges = plan.remoteChanges.filter(
      (change) => change.kind === "upload-local" || change.kind === "upload-new",
    );
    const uploadingConflicts = sharedConflicts.filter(
      (conflict) => conflict.kind === "edit-delete" || conflict.kind === "edit-edit",
    );
    const uploadTotal = uploadingChanges.length + uploadingConflicts.length;
    const uploadTotalBytes = [
      ...uploadingChanges.map((change) => change.file.size),
      ...uploadingConflicts.map((conflict) => conflict.localFile.size),
    ].reduce((sum, size) => sum + size, 0);
    let uploadCompleted = 0;
    let uploadedBytes = 0;
    const reportUpload = (path: string, completedSize?: number): void => {
      if (completedSize !== undefined) {
        uploadCompleted += 1;
        uploadedBytes += completedSize;
      }
      this.reportProgress({
        completed: uploadCompleted,
        currentPath: path,
        phase: "uploading",
        total: uploadTotal,
        totalBytes: uploadTotalBytes,
        transferredBytes: uploadedBytes,
      });
    };
    let unresolvedConflicts =
      plan.conflicts.length -
      sharedConflicts.length +
      Object.values(remote.entries).filter((entry) => entry.kind === "conflicted")
        .length;
    let publishedChanges = plan.remoteChanges.length;
    if (plan.remoteChanges.length > 0 || sharedConflicts.length > 0) {
      const createdAt = versionedHead.serverDate;
      const changedEntries: VaultEntry[] = [];
      const nextEntries = { ...remote.entries };
      const deleteAfterCommit: Array<{
        expectedContentHash: string;
        path: string;
      }> = [];
      const writeAfterCommit: Array<{
        body: Uint8Array;
        expectedContentHash: string | null;
        path: string;
      }> = [];
      for (const change of plan.remoteChanges) {
        let changedEntry: VaultEntry;
        if (change.kind === "delete-remote") {
          changedEntry = {
            deletedAt: createdAt,
            entryId: change.entryId,
            history: change.history,
            kind: "deleted",
            lastContentHash: change.lastContentHash,
            lastRevisionId: change.lastRevisionId,
            path: change.path,
            recovery: {
              ...change.recoveryRevision,
              expiresAt: expiresInDays(createdAt, 30),
            },
          };
        } else if (change.kind === "move-remote") {
          const current = remote.entries[change.entryId];
          if (current?.kind !== "live") {
            throw new Error(`Cannot move non-live Entry ${change.entryId}`);
          }
          changedEntry = { ...current, path: change.toPath };
        } else {
          reportUpload(change.path);
          const plaintext = await this.options.local.read(change.path);
          if (
            plaintext.byteLength !== change.file.size ||
            (await sha256(plaintext)) !== change.file.contentHash
          ) {
            throw new LocalStateChangedError(change.path);
          }
          const blobId = crypto.randomUUID();
          await this.options.remote.writeBlob(blobId, plaintext);
          reportUpload(change.path, change.file.size);
          const current = remote.entries[change.entryId];
          const previousRevisions =
            current?.kind === "live"
              ? [
                  keepForRecovery(current.revision, createdAt),
                  ...(current.history ?? []),
                ]
              : [];
          const revision: RevisionRef = {
            blobId,
            contentHash: change.file.contentHash,
            createdAt,
            revisionId: crypto.randomUUID(),
            size: change.file.size,
          };
          await this.assertRemoteRevision(revision);
          changedEntry = {
            entryId: change.entryId,
            history: previousRevisions,
            kind: "live",
            path: change.path,
            revision,
          };
        }
        nextEntries[change.entryId] = changedEntry;
        changedEntries.push(changedEntry);
      }
      for (const conflict of sharedConflicts) {
        const remoteEntry = remote.entries[conflict.entryId];
        let changedEntry: VaultEntry;
        if (conflict.kind === "delete-edit") {
          if (remoteEntry?.kind !== "live") {
            throw new Error(`Expected live Entry ${conflict.entryId}`);
          }
          changedEntry = {
            candidates: [remoteEntry.revision],
            deletedAt: createdAt,
            entryId: conflict.entryId,
            history: remoteEntry.history,
            kind: "conflicted",
            lastContentHash: conflict.baseContentHash,
            lastRevisionId: conflict.baseRevisionId,
            path: conflict.path,
            reason: "delete-edit",
            recovery: keepForRecovery(conflict.baseRevision, createdAt),
          };
          unresolvedConflicts += 1;
          nextEntries[conflict.entryId] = changedEntry;
          changedEntries.push(changedEntry);
          continue;
        }
        const localPath = conflict.localFile.path;
        reportUpload(localPath);
        const plaintext = await this.options.local.read(localPath);
        if (
          plaintext.byteLength !== conflict.localFile.size ||
          (await sha256(plaintext)) !== conflict.localFile.contentHash
        ) {
          throw new LocalStateChangedError(localPath);
        }
        const blobId = crypto.randomUUID();
        await this.options.remote.writeBlob(blobId, plaintext);
        const localRevision = {
          blobId,
          contentHash: conflict.localFile.contentHash,
          createdAt,
          revisionId: crypto.randomUUID(),
          size: conflict.localFile.size,
        };
        await this.assertRemoteRevision(localRevision);
        if (conflict.kind === "edit-delete") {
          if (remoteEntry?.kind !== "deleted") {
            throw new Error(`Expected deleted Entry ${conflict.entryId}`);
          }
          changedEntry = {
            candidates: [localRevision],
            deletedAt: remoteEntry.deletedAt,
            entryId: conflict.entryId,
            history: remoteEntry.history,
            kind: "conflicted",
            lastContentHash: remoteEntry.lastContentHash,
            lastRevisionId: remoteEntry.lastRevisionId,
            path: conflict.path,
            reason: "edit-delete",
            recovery: remoteEntry.recovery,
          };
          deleteAfterCommit.push({
            expectedContentHash: conflict.localFile.contentHash,
            path: localPath,
          });
          unresolvedConflicts += 1;
        } else {
          const baseEntry = reconciliationBase?.entries[conflict.entryId];
          if (
            remoteEntry?.kind !== "live" ||
            (baseEntry?.kind !== "live" && baseEntry?.kind !== "deleted")
          ) {
            throw new Error(`Expected live or restored Entry ${conflict.entryId}`);
          }
          const baseContent =
            baseEntry.kind === "live"
              ? await this.options.remote.readBlob(baseEntry.revision.blobId)
              : undefined;
          const remoteContent = await this.options.remote.readBlob(
            remoteEntry.revision.blobId,
          );
          if ((baseEntry.kind === "live" && !baseContent) || !remoteContent) {
            throw new Error(`Conflict history is incomplete for ${conflict.path}`);
          }
          if (
            (baseEntry.kind === "live" &&
              (!baseContent ||
                baseContent.byteLength !== baseEntry.revision.size ||
                (await sha256(baseContent)) !==
                  baseEntry.revision.contentHash)) ||
            remoteContent.byteLength !== remoteEntry.revision.size ||
            (await sha256(remoteContent)) !== remoteEntry.revision.contentHash
          ) {
            throw new Error(`Conflict history is damaged for ${conflict.path}`);
          }
          let merged: Uint8Array | undefined;
          if (
            baseContent &&
            conflict.path.toLowerCase().endsWith(".md") &&
            plaintext.byteLength <= 5 * 1024 * 1024 &&
            remoteContent.byteLength <= 5 * 1024 * 1024
          ) {
            try {
              merged = mergeMarkdown(plaintext, baseContent, remoteContent);
            } catch {
              merged = undefined;
            }
          }
          if (merged) {
            const mergedBlobId = crypto.randomUUID();
            await this.options.remote.writeBlob(mergedBlobId, merged);
            const mergedRevision: RevisionRef = {
              blobId: mergedBlobId,
              contentHash: await sha256(merged),
              createdAt,
              revisionId: crypto.randomUUID(),
              size: merged.byteLength,
            };
            await this.assertRemoteRevision(mergedRevision);
            changedEntry = {
              entryId: conflict.entryId,
              history: [
                keepForRecovery(remoteEntry.revision, createdAt),
                keepForRecovery(localRevision, createdAt),
                ...(remoteEntry.history ?? []),
              ],
              kind: "live",
              path: conflict.path,
              revision: mergedRevision,
            };
            if (localPath !== conflict.path) {
              deleteAfterCommit.push({
                expectedContentHash: conflict.localFile.contentHash,
                path: localPath,
              });
            }
            writeAfterCommit.push({
              body: merged,
              expectedContentHash:
                localPath === conflict.path
                  ? conflict.localFile.contentHash
                  : null,
              path: conflict.path,
            });
          } else {
            const keepLocalMaterialized = baseEntry.kind === "deleted";
            changedEntry = {
              candidates: [remoteEntry.revision, localRevision],
              entryId: conflict.entryId,
              history: remoteEntry.history,
              kind: "conflicted",
              materializedContentHash: keepLocalMaterialized
                ? localRevision.contentHash
                : remoteEntry.revision.contentHash,
              path: conflict.path,
              reason: "edit-edit",
            };
            if (keepLocalMaterialized && localPath !== conflict.path) {
              deleteAfterCommit.push({
                expectedContentHash: conflict.localFile.contentHash,
                path: localPath,
              });
              writeAfterCommit.push({
                body: plaintext,
                expectedContentHash: null,
                path: conflict.path,
              });
            } else if (!keepLocalMaterialized) {
              if (localPath !== conflict.path) {
                deleteAfterCommit.push({
                  expectedContentHash: conflict.localFile.contentHash,
                  path: localPath,
                });
              }
              writeAfterCommit.push({
                body: remoteContent,
                expectedContentHash:
                  localPath === conflict.path
                    ? conflict.localFile.contentHash
                    : null,
                path: conflict.path,
              });
            }
            unresolvedConflicts += 1;
          }
        }
        reportUpload(localPath, conflict.localFile.size);
        nextEntries[conflict.entryId] = changedEntry;
        changedEntries.push(changedEntry);
      }
      publishedChanges = changedEntries.length;
      const commitId = crypto.randomUUID();
      const commit: CommitRecord = {
        changes: changedEntries.map((entry) => ({
          entry,
          kind: "set-entry",
        })),
        commitId,
        createdAt,
        parentIds: [versionedHead.value.commitId],
        protocolVersion: 1,
        replicaId: this.options.replicaId,
        vaultId: versionedHead.value.vaultId,
      };
      const head: HeadRecord = {
        commitId,
        generation: versionedHead.value.generation + 1,
        protocolVersion: 1,
        snapshotId: versionedHead.value.snapshotId,
        vaultId: versionedHead.value.vaultId,
      };
      if (head.generation % 100 === 0) {
        const snapshotId = crypto.randomUUID();
        await this.options.remote.writeSnapshot(snapshotId, {
          commitId,
          entries: nextEntries,
          protocolVersion: 1,
          vaultId: head.vaultId,
        });
        head.snapshotId = snapshotId;
      }
      for (const change of plan.remoteChanges) {
        if (change.kind === "delete-remote") {
          await this.assertLocalContent(change.path, null);
        }
      }
      this.reportProgress({
        completed: uploadCompleted,
        phase: "publishing",
        total: uploadTotal,
        totalBytes: uploadTotalBytes,
        transferredBytes: uploadedBytes,
      });
      await this.options.remote.advance({
        commit,
        expectedHeadEtag: versionedHead.etag,
        head,
      });
      remote = {
        commitId,
        entries: nextEntries,
        protocolVersion: 1,
        vaultId: head.vaultId,
      };
      for (const pendingDelete of deleteAfterCommit) {
        await this.assertLocalContent(
          pendingDelete.path,
          pendingDelete.expectedContentHash,
        );
        await this.options.local.delete(
          pendingDelete.path,
          pendingDelete.expectedContentHash,
        );
        locallyMutatedPaths.add(pendingDelete.path);
      }
      for (const pendingWrite of writeAfterCommit) {
        await this.assertLocalContent(
          pendingWrite.path,
          pendingWrite.expectedContentHash,
        );
        await this.options.local.write(
          pendingWrite.path,
          pendingWrite.body,
          pendingWrite.expectedContentHash,
        );
        locallyMutatedPaths.add(pendingWrite.path);
      }
    }
    await this.options.cache.save(
      await this.buildCache(
        remote,
        deferredDownloadEntries.map((entry) => entry.entryId),
        {
          forceHashPaths: locallyMutatedPaths,
          fullHashVerification: false,
          hashHints: new Map(scan.files.map((file) => [file.path, file])),
          pathRenames: syncOptions.pathRenames,
        },
      ),
    );
    return {
      bulkDeletion: plan.bulkDeletion,
      cacheUpdated: true,
      deferredDownloadEntries,
      deferredDownloads: deferredEntryIds.size,
      deleted,
      downloaded,
      localIssues,
      status:
        unresolvedConflicts > 0 ||
        scan.unsyncedLocalEntries > 0 ||
        deferredLocalEditPaths.length > 0 ||
        deferredDownloadEntries.some(
          (entry) => entry.reason === "unsupported-path",
        )
          ? "action-required"
          : "complete",
      unsyncedLocalEntries: scan.unsyncedLocalEntries,
      uploaded: publishedChanges,
    };
  }

  private async buildCache(
    snapshot: VaultSnapshot,
    additionalUnmaterializedEntryIds: Iterable<string> = [],
    scanOptions: FileScanOptions = { fullHashVerification: true },
  ): Promise<CachedSyncState> {
    const current = await this.options.cache.load();
    const scan = await this.scanFiles(current, false, scanOptions);
    const files: Record<string, CachedFileState> = {};
    const pendingUnmaterializedEntryIds = new Set([
      ...(current?.unmaterializedEntryIds ?? []),
      ...additionalUnmaterializedEntryIds,
    ]);
    const liveEntriesByPath = new Map(
      Object.values(snapshot.entries).flatMap((entry) =>
        entry.kind === "live" ? ([[entry.path, entry]] as const) : [],
      ),
    );
    for (const file of scan.files) {
      const entry = liveEntriesByPath.get(file.path);
      if (entry) {
        const prior = current?.files[file.path];
        files[file.path] =
          pendingUnmaterializedEntryIds.has(entry.entryId) &&
          prior?.entryId === entry.entryId &&
          file.contentHash !== entry.revision.contentHash
            ? prior
            : { ...file, entryId: entry.entryId };
      }
    }
    const physicallyPresentPaths = new Set(scan.localPaths);
    const alreadyMaterializedEntryIds = new Set(
      Object.values(files).flatMap((file) => {
        const entry = snapshot.entries[file.entryId];
        return entry?.kind === "live" &&
          entry.revision.contentHash === file.contentHash
          ? [file.entryId]
          : [];
      }),
    );
    for (const cachedFile of Object.values(current?.files ?? {})) {
      if (
        pendingUnmaterializedEntryIds.has(cachedFile.entryId) &&
        !alreadyMaterializedEntryIds.has(cachedFile.entryId) &&
        physicallyPresentPaths.has(cachedFile.path) &&
        snapshot.entries[cachedFile.entryId]?.kind === "live"
      ) {
        files[cachedFile.path] = cachedFile;
      }
    }
    const skippedTrackedEntryIds = new Set(scan.skippedTrackedEntryIds);
    for (const cachedFile of Object.values(current?.files ?? {})) {
      if (
        skippedTrackedEntryIds.has(cachedFile.entryId) &&
        snapshot.entries[cachedFile.entryId]?.kind === "live"
      ) {
        files[cachedFile.path] = cachedFile;
      }
    }
    const materializedEntryIds = new Set(
      Object.values(files).flatMap((file) => {
        const entry = snapshot.entries[file.entryId];
        return entry?.kind === "live" &&
          entry.revision.contentHash === file.contentHash
          ? [file.entryId]
          : [];
      }),
    );
    return {
      files,
      snapshot,
      unmaterializedEntryIds: [...pendingUnmaterializedEntryIds].filter(
        (entryId) =>
          snapshot.entries[entryId]?.kind === "live" &&
          !materializedEntryIds.has(entryId),
      ),
    };
  }

  private buildReconciliationBase(
    cached: CachedSyncState | undefined,
  ): VaultSnapshot | undefined {
    if (!cached) {
      return undefined;
    }
    const entries = { ...cached.snapshot.entries };
    const unmaterializedEntryIds = new Set(
      cached.unmaterializedEntryIds ?? [],
    );
    for (const cachedFile of Object.values(cached.files)) {
      const entry = cached.snapshot.entries[cachedFile.entryId];
      if (
        entry?.kind !== "live" ||
        (!unmaterializedEntryIds.has(entry.entryId) &&
          entry.revision.contentHash === cachedFile.contentHash)
      ) {
        continue;
      }
      const priorRevision =
        entry.revision.contentHash === cachedFile.contentHash
          ? entry.revision
          : entry.history?.find(
              (revision) => revision.contentHash === cachedFile.contentHash,
            );
      if (!priorRevision) {
        continue;
      }
      const priorEntry: LiveEntry = {
        ...entry,
        path: cachedFile.path,
        revision: priorRevision,
      };
      entries[entry.entryId] = priorEntry;
    }
    return { ...cached.snapshot, entries };
  }

  private async assertLocalContent(
    path: string,
    expectedContentHash: string | null,
  ): Promise<void> {
    const current = await this.options.local.stat(path);
    if (expectedContentHash === null) {
      if (current) {
        throw new LocalStateChangedError(path);
      }
      return;
    }
    if (!current) {
      throw new LocalStateChangedError(path);
    }
    const content = await this.options.local.read(path);
    if (
      content.byteLength !== current.size ||
      (await sha256(content)) !== expectedContentHash
    ) {
      throw new LocalStateChangedError(path);
    }
  }

  private async assertRemoteEntriesBeforePublication(
    snapshot: VaultSnapshot,
    entryIds: ReadonlySet<string>,
    additionalRevisions: readonly RevisionRef[],
  ): Promise<void> {
    const revisions = new Map<string, RevisionRef>();
    for (const revision of additionalRevisions) {
      revisions.set(revision.blobId, revision);
    }
    for (const entryId of entryIds) {
      const entry = snapshot.entries[entryId];
      if (entry?.kind === "live") {
        revisions.set(entry.revision.blobId, entry.revision);
      } else if (entry?.kind === "deleted") {
        if (entry.recovery) {
          revisions.set(entry.recovery.blobId, entry.recovery);
        }
      } else if (entry?.kind === "conflicted") {
        for (const candidate of entry.candidates) {
          revisions.set(candidate.blobId, candidate);
        }
        if (entry.recovery) {
          revisions.set(entry.recovery.blobId, entry.recovery);
        }
      }
    }
    for (const revision of revisions.values()) {
      await this.assertRemoteRevision(revision);
    }
  }

  private assertRemotePathAvailable(
    snapshot: VaultSnapshot,
    entryId: string,
    path: string,
  ): void {
    const canonicalPath = canonicalVaultPath(path);
    const occupyingEntry = Object.values(snapshot.entries).find(
      (entry) =>
        entry.entryId !== entryId &&
        entry.kind !== "deleted" &&
        canonicalVaultPath(entry.path) === canonicalPath,
    );
    if (occupyingEntry) {
      throw new Error(
        `Cannot restore ${path}; it is owned by Entry ${occupyingEntry.entryId}`,
      );
    }
  }

  private async assertRemoteRecoveryForLocalContent(
    snapshot: VaultSnapshot,
    entryId: string,
    expectedContentHash: string | null,
  ): Promise<void> {
    if (expectedContentHash === null) {
      return;
    }
    const entry = snapshot.entries[entryId];
    if (!entry) {
      throw new Error(`Entry ${entryId} has no remote recovery for local content`);
    }
    const revisions: RevisionRef[] = [
      ...(entry.kind === "live" ? [entry.revision] : []),
      ...(entry.kind === "conflicted" ? entry.candidates : []),
      ...(entry.kind !== "live" && entry.recovery ? [entry.recovery] : []),
      ...(entry.history ?? []),
    ].filter((revision) => revision.contentHash === expectedContentHash);
    for (const revision of revisions) {
      try {
        await this.assertRemoteRevision(revision);
        return;
      } catch (error) {
        if (!(error instanceof RemoteStateError)) {
          throw error;
        }
        // Another retained copy with the same plaintext hash may still be valid.
      }
    }
    throw new RemoteStateError(
      `No authenticated remote recovery exists for local content at ${entry.path} (Entry ${entryId})`,
    );
  }

  private async assertRemoteRevision(revision: RevisionRef): Promise<void> {
    let plaintext: Uint8Array | undefined;
    try {
      plaintext = await this.options.remote.readBlob(revision.blobId);
    } catch (error) {
      if (!(error instanceof RemoteStateError)) {
        throw error;
      }
      throw new RemoteStateError(
        `Remote Revision ${revision.revisionId} cannot be authenticated`,
        error,
      );
    }
    if (
      !plaintext ||
      plaintext.byteLength !== revision.size ||
      (await sha256(plaintext)) !== revision.contentHash
    ) {
      throw new RemoteStateError(
        `Remote Revision ${revision.revisionId} failed content verification`,
      );
    }
  }

  private async assertRecoveryBeforeDelete(
    deleted: DeletedEntry,
    serverDate: string,
  ): Promise<void> {
    const recoveryRequiredUntil = Date.parse(
      expiresInDays(deleted.deletedAt, 30),
    );
    const serverTime = Date.parse(serverDate);
    if (serverTime < recoveryRequiredUntil) {
      if (!deleted.recovery) {
        throw new Error(
          `Deleted Entry ${deleted.entryId} is missing its Recovery Copy`,
        );
      }
      await this.readRecoveryCopy(deleted, serverDate);
    } else if (
      deleted.recovery &&
      Date.parse(deleted.recovery.expiresAt) > serverTime
    ) {
      await this.readRecoveryCopy(deleted, serverDate);
    }
  }

  private async scanFiles(
    cached?: CachedSyncState,
    reportProgress = false,
    options: FileScanOptions = { fullHashVerification: true },
  ): Promise<{
    files: VerifiedLocalFile[];
    localPaths: string[];
    skippedTrackedEntryIds: string[];
    unsyncedLocalEntries: number;
    unsyncedLocalPaths: string[];
  }> {
    const files: VerifiedLocalFile[] = [];
    const skippedTrackedEntryIds: string[] = [];
    const unsyncedLocalPaths: string[] = [];
    let unsyncedLocalEntries = 0;
    const localFiles = await this.options.local.list();
    const renamedEntryIdsByTarget = new Map<string, string[]>();
    for (const [fromPath, rename] of options.pathRenames ?? []) {
      if (cached?.files[fromPath]?.entryId !== rename.entryId) {
        continue;
      }
      const entryIds = renamedEntryIdsByTarget.get(rename.toPath) ?? [];
      entryIds.push(rename.entryId);
      renamedEntryIdsByTarget.set(rename.toPath, entryIds);
    }
    const reusableHash = (file: LocalFileInfo): string | undefined => {
      if (options.fullHashVerification !== false) {
        return undefined;
      }
      const retryHash = options.retryHashMemo?.get(file.path);
      if (
        retryHash?.modifiedAt === file.modifiedAt &&
        retryHash.size === file.size
      ) {
        return retryHash.contentHash;
      }
      if (options.forceHashPaths?.has(file.path)) {
        return undefined;
      }
      const hint = options.hashHints?.get(file.path);
      if (
        hint?.modifiedAt === file.modifiedAt &&
        hint.size === file.size
      ) {
        return hint.contentHash;
      }
      const cachedFile = cached?.files[file.path];
      return cachedFile?.modifiedAt === file.modifiedAt &&
        cachedFile.size === file.size
        ? cachedFile.contentHash
        : undefined;
    };
    const hashesByPath = new Map(
      localFiles.map((file) => [file.path, reusableHash(file)] as const),
    );
    const filesToHash = localFiles.filter(
      (file) =>
        !this.exceedsAutomaticFileLimit(file.path, file.size) &&
        hashesByPath.get(file.path) === undefined,
    );
    const totalBytes = filesToHash.reduce(
      (sum, file) => sum + file.size,
      0,
    );
    if (reportProgress) {
      this.reportProgress({
        completed: localFiles.length,
        phase: "scanning",
        total: localFiles.length,
        totalBytes: 0,
        transferredBytes: 0,
      });
    }
    let completed = 0;
    let transferredBytes = 0;
    const reportHashed = (file?: LocalFileInfo): void => {
      if (reportProgress) {
        this.reportProgress({
          completed,
          ...(file ? { currentPath: file.path } : {}),
          phase: "hashing",
          total: filesToHash.length,
          totalBytes,
          transferredBytes,
        });
      }
    };
    const finishHash = (file: LocalFileInfo, hashedBytes: number): void => {
      transferredBytes += Math.max(0, file.size - hashedBytes);
      completed += 1;
      reportHashed(file);
    };
    if (filesToHash.length > 0) {
      reportHashed();
    }
    for (const file of localFiles) {
      const cachedFile = cached?.files[file.path];
      if (
        this.exceedsAutomaticFileLimit(file.path, file.size)
      ) {
        unsyncedLocalEntries += 1;
        unsyncedLocalPaths.push(file.path);
        if (cachedFile) {
          skippedTrackedEntryIds.push(cachedFile.entryId);
        } else {
          const renamedEntryIds = renamedEntryIdsByTarget.get(file.path);
          if (renamedEntryIds?.length === 1 && renamedEntryIds[0]) {
            skippedTrackedEntryIds.push(renamedEntryIds[0]);
          }
        }
        continue;
      }
      const cachedContentHash = hashesByPath.get(file.path);
      if (cachedContentHash !== undefined) {
        const verifiedFile = { ...file, contentHash: cachedContentHash };
        files.push(verifiedFile);
        options.retryHashMemo?.set(file.path, verifiedFile);
        continue;
      }
      reportHashed(file);
      if (this.options.local.hashContent) {
        let hashedBytes = 0;
        const hashed = await this.options.local.hashContent(file.path, {
          onProgress: (currentBytes) => {
            const boundedBytes = Math.min(
              file.size,
              Math.max(hashedBytes, currentBytes),
            );
            transferredBytes += boundedBytes - hashedBytes;
            hashedBytes = boundedBytes;
            reportHashed(file);
          },
          yieldToHost: this.options.yieldDuringHashing,
        });
        const current = await this.options.local.stat(file.path);
        if (
          !current ||
          current.modifiedAt !== file.modifiedAt ||
          current.size !== file.size ||
          hashed.size !== file.size
        ) {
          throw new LocalStateChangedError(file.path);
        }
        const verifiedFile = {
          ...file,
          contentHash: hashed.contentHash,
        };
        files.push(verifiedFile);
        options.retryHashMemo?.set(file.path, verifiedFile);
        finishHash(file, hashedBytes);
        continue;
      }
      await this.options.yieldDuringHashing?.();
      const content = await this.options.local.read(file.path);
      const current = await this.options.local.stat(file.path);
      if (
        !current ||
        current.modifiedAt !== file.modifiedAt ||
        current.size !== file.size ||
        content.byteLength !== file.size
      ) {
        throw new LocalStateChangedError(file.path);
      }
      const contentHash = await sha256(content);
      const verifiedFile = {
        ...file,
        contentHash,
      };
      files.push(verifiedFile);
      options.retryHashMemo?.set(file.path, verifiedFile);
      finishHash(file, 0);
    }
    return {
      files,
      localPaths: localFiles.map((file) => file.path),
      skippedTrackedEntryIds,
      unsyncedLocalEntries,
      unsyncedLocalPaths,
    };
  }

  private maxAutomaticFileBytes(path: string): number | undefined {
    const configured = this.options.maxAutomaticFileBytes;
    return typeof configured === "function" ? configured(path) : configured;
  }

  private exceedsAutomaticFileLimit(path: string, size: number): boolean {
    const limit = this.maxAutomaticFileBytes(path);
    return limit !== undefined && size > limit;
  }
}
