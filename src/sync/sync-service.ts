import { diff3Merge } from "node-diff3";

import {
  SyncEngine,
  type ReplicaObservation,
  type RevisionRef,
  type VaultEntry,
  type VaultSnapshot,
} from "./sync-engine";
import {
  type CommitRecord,
  type HeadRecord,
  RemoteStore,
} from "../storage/remote-store";

export interface LocalFileInfo {
  modifiedAt: number;
  path: string;
  size: number;
}

export interface LocalVaultPort {
  delete(path: string): Promise<void>;
  list(): Promise<LocalFileInfo[]>;
  move(fromPath: string, toPath: string): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  supportsPath?(path: string): boolean;
  write(path: string, body: Uint8Array): Promise<void>;
}

export interface CachedFileState extends LocalFileInfo {
  contentHash: string;
  entryId: string;
}

export interface CachedSyncState {
  files: Record<string, CachedFileState>;
  snapshot: VaultSnapshot;
}

export interface SyncCachePort {
  load(): Promise<CachedSyncState | undefined>;
  save(state: CachedSyncState): Promise<void>;
}

export interface SyncServiceOptions {
  allowBulkDeletion?: boolean;
  cache: SyncCachePort;
  local: LocalVaultPort;
  maxAutomaticFileBytes?: number;
  onProgress?: (progress: SyncProgress) => void;
  remote: RemoteStore;
  replicaId: string;
}

export interface SyncProgress {
  completed: number;
  currentPath?: string;
  phase: "downloading" | "publishing" | "scanning" | "uploading";
  total: number;
  totalBytes: number;
  transferredBytes: number;
}

export interface SyncResult {
  deferredDownloadEntries: DeferredDownloadEntry[];
  bulkDeletion?: {
    count: number;
    totalLiveEntries: number;
  };
  deferredDownloads: number;
  deleted: number;
  downloaded: number;
  localIssues: LocalSyncIssue[];
  status: "action-required" | "complete";
  unsyncedLocalEntries: number;
  uploaded: number;
}

export interface DeferredDownloadEntry {
  entryId: string;
  path: string;
  reason: "device-limit" | "unsupported-path";
  size: number;
}

export type LocalSyncIssue =
  | { kind: "bootstrap-mismatch"; path: string }
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

const sha256 = async (input: Uint8Array): Promise<string> => {
  const buffer =
    input.byteOffset === 0 &&
    input.buffer instanceof ArrayBuffer &&
    input.byteLength === input.buffer.byteLength
      ? input.buffer
      : input.slice().buffer;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    buffer,
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${hex}`;
};

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

export class SyncService {
  private readonly engine = new SyncEngine();

  constructor(private readonly options: SyncServiceOptions) {}

  async initializeNew(vaultId: string): Promise<void> {
    if (await this.options.remote.readHead()) {
      throw new Error("Remote Store is already initialized");
    }
    const scan = await this.scanFiles(undefined, true);
    const files = scan.files;
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
        revision: {
          blobId,
          contentHash: file.contentHash,
          createdAt,
          revisionId,
          size: file.size,
        },
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
    await this.options.cache.save({ files: stableCacheFiles, snapshot });
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
    const plaintext = await this.options.remote.readBlob(entry.revision.blobId);
    if (!plaintext || (await sha256(plaintext)) !== entry.revision.contentHash) {
      throw new Error(`Deferred Revision ${entry.revision.revisionId} is damaged`);
    }
    await this.options.local.write(entry.path, plaintext);
    await this.options.cache.save(await this.buildCache(snapshot));
  }

  async importCandidate(path: string): Promise<void> {
    const versionedHead = await this.options.remote.readHead();
    if (!versionedHead) {
      throw new Error("Remote Store is not initialized");
    }
    const snapshot = await this.options.remote.readSnapshot(versionedHead.value);
    const canonicalPath = path.normalize("NFC").toLocaleLowerCase("en-US");
    const pathIsKnown = Object.values(snapshot.entries).some(
      (entry) =>
        entry.path.normalize("NFC").toLocaleLowerCase("en-US") === canonicalPath,
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
      this.options.maxAutomaticFileBytes !== undefined &&
      file.size > this.options.maxAutomaticFileBytes
    ) {
      throw new Error(`Import Candidate exceeds the mobile limit: ${path}`);
    }
    const plaintext = await this.options.local.read(path);
    const createdAt = versionedHead.serverDate;
    const entryId = crypto.randomUUID();
    const blobId = crypto.randomUUID();
    await this.options.remote.writeBlob(blobId, plaintext);
    const entry: VaultEntry = {
      entryId,
      kind: "live",
      path,
      revision: {
        blobId,
        contentHash: await sha256(plaintext),
        createdAt,
        revisionId: crypto.randomUUID(),
        size: plaintext.byteLength,
      },
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
    let materializedContent: Uint8Array | undefined;
    let resolvedEntry: VaultEntry;
    if (resolution.kind === "restore-candidate") {
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
        (await sha256(materializedContent)) !== candidate.contentHash
      ) {
        throw new Error(`Conflict candidate ${resolution.revisionId} is damaged`);
      }
      resolvedEntry = {
        entryId,
        history: [
          ...conflicted.candidates.filter(
            (revision) => revision.revisionId !== resolution.revisionId,
          ),
          ...(conflicted.history ?? []),
        ],
        kind: "live",
        path: conflicted.path,
        revision: candidate,
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
        history: conflicted.history,
        kind: "deleted",
        lastContentHash: conflicted.lastContentHash,
        lastRevisionId: conflicted.lastRevisionId,
        path: conflicted.path,
        recovery: conflicted.recovery,
      };
    }
    const createdAt = versionedHead.serverDate;
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
    if (materializedContent) {
      await this.options.local.write(conflicted.path, materializedContent);
    } else {
      await this.options.local.delete(conflicted.path);
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
    const historical = entry.history?.find(
      (revision) => revision.revisionId === revisionId,
    );
    if (!historical) {
      throw new Error(`Historical Revision ${revisionId} does not exist`);
    }
    const plaintext = await this.options.remote.readBlob(historical.blobId);
    if (!plaintext || (await sha256(plaintext)) !== historical.contentHash) {
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
    await this.options.local.write(entry.path, plaintext);
    await this.options.cache.save(
      await this.buildCache({
        commitId,
        entries: { ...snapshot.entries, [entryId]: restoredEntry },
        protocolVersion: 1,
        vaultId: snapshot.vaultId,
      }),
    );
  }

  async restoreDeleted(entryId: string): Promise<void> {
    const versionedHead = await this.options.remote.readHead();
    if (!versionedHead) {
      throw new Error("Remote Store is not initialized");
    }
    const snapshot = await this.options.remote.readSnapshot(versionedHead.value);
    const deleted = snapshot.entries[entryId];
    if (deleted?.kind !== "deleted" || !deleted.recovery) {
      throw new Error(`Entry ${entryId} has no Recovery Copy`);
    }
    const plaintext = await this.options.remote.readBlob(deleted.recovery.blobId);
    if (!plaintext || (await sha256(plaintext)) !== deleted.recovery.contentHash) {
      throw new Error(`Recovery Copy for ${entryId} is damaged`);
    }
    if (
      Date.parse(deleted.recovery.expiresAt) <=
      Date.parse(versionedHead.serverDate)
    ) {
      throw new Error(`Recovery Copy for ${entryId} has expired`);
    }
    const createdAt = versionedHead.serverDate;
    const restoredEntry: VaultEntry = {
      entryId,
      history: deleted.history,
      kind: "live",
      path: deleted.path,
      revision: restoreAsCurrent(deleted.recovery, createdAt),
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
    await this.options.local.write(deleted.path, plaintext);
    await this.options.cache.save(
      await this.buildCache({
        commitId,
        entries: { ...snapshot.entries, [entryId]: restoredEntry },
        protocolVersion: 1,
        vaultId: snapshot.vaultId,
      }),
    );
  }

  async synchronize(): Promise<SyncResult> {
    const versionedHead = await this.options.remote.readHead();
    if (!versionedHead) {
      throw new Error("Remote Store is not initialized");
    }
    let remote = await this.options.remote.readSnapshot(versionedHead.value);
    const cached = await this.options.cache.load();
    const scan = await this.scanFiles(cached, true);
    const scanned = scan.files;
    const localPaths = new Set(scanned.map((file) => file.path));
    const missingCachedByFingerprint = new Map<string, CachedFileState[]>();
    for (const cachedFile of Object.values(cached?.files ?? {})) {
      if (localPaths.has(cachedFile.path)) {
        continue;
      }
      const fingerprint = `${cachedFile.size}:${cachedFile.contentHash}`;
      const candidates = missingCachedByFingerprint.get(fingerprint) ?? [];
      candidates.push(cachedFile);
      missingCachedByFingerprint.set(fingerprint, candidates);
    }
    const entryIdByPath = new Map<string, string>();
    for (const file of scanned) {
      const exact = cached?.files[file.path];
      if (exact) {
        entryIdByPath.set(file.path, exact.entryId);
        continue;
      }
      const renameCandidates = missingCachedByFingerprint.get(
        `${file.size}:${file.contentHash}`,
      );
      if (renameCandidates?.length === 1 && renameCandidates[0]) {
        entryIdByPath.set(file.path, renameCandidates[0].entryId);
      }
    }
    const deferredDownloadEntries = Object.values(remote.entries).flatMap(
      (entry): DeferredDownloadEntry[] => {
        if (entry.kind !== "live" || localPaths.has(entry.path)) {
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
          this.options.maxAutomaticFileBytes !== undefined &&
          entry.revision.size > this.options.maxAutomaticFileBytes
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
    const deferredEntryIds = deferredDownloadEntries.map(
      (entry) => entry.entryId,
    );
    deferredEntryIds.push(...scan.skippedTrackedEntryIds);
    const observation: ReplicaObservation = {
      basedOnCommitId: cached?.snapshot.commitId,
      deferredEntryIds,
      files: scanned.map((file) => ({
        contentHash: file.contentHash,
        entryId: entryIdByPath.get(file.path),
        path: file.path,
        size: file.size,
      })),
      replicaId: this.options.replicaId,
    };
    const plan = this.engine.reconcile({
      base: cached?.snapshot,
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
      ...deferredDownloadEntries.flatMap((entry): LocalSyncIssue[] =>
        entry.reason === "unsupported-path"
          ? [{ kind: "unsupported-path", path: entry.path }]
          : [],
      ),
    ];

    if (plan.bulkDeletion && !this.options.allowBulkDeletion) {
      return {
        bulkDeletion: plan.bulkDeletion,
        deferredDownloadEntries,
        deferredDownloads: deferredEntryIds.length,
        deleted: 0,
        downloaded: 0,
        localIssues,
        status: "action-required",
        unsyncedLocalEntries: scan.unsyncedLocalEntries,
        uploaded: 0,
      };
    }

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
        await this.options.local.delete(action.path);
        deleted += 1;
      } else if (action.kind === "move-local") {
        await this.options.local.move(action.fromPath, action.toPath);
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
        if ((await sha256(plaintext)) !== action.revision.contentHash) {
          throw new Error(`Remote blob ${action.revision.blobId} failed hash verification`);
        }
        await this.options.local.write(action.path, plaintext);
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

    const sharedConflicts = plan.conflicts.filter(
      (conflict) =>
        conflict.kind === "delete-edit" ||
        conflict.kind === "edit-delete" ||
        conflict.kind === "edit-edit",
    );
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
      const deleteAfterCommit: string[] = [];
      const writeAfterCommit: Array<{ body: Uint8Array; path: string }> = [];
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
          if ((await sha256(plaintext)) !== change.file.contentHash) {
            throw new Error(`Local file changed while reading ${change.path}`);
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
          changedEntry = {
            entryId: change.entryId,
            history: previousRevisions,
            kind: "live",
            path: change.path,
            revision: {
              blobId,
              contentHash: change.file.contentHash,
              createdAt,
              revisionId: crypto.randomUUID(),
              size: change.file.size,
            },
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
        reportUpload(conflict.path);
        const plaintext = await this.options.local.read(conflict.path);
        if ((await sha256(plaintext)) !== conflict.localFile.contentHash) {
          throw new Error(`Local file changed while reading ${conflict.path}`);
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
          deleteAfterCommit.push(conflict.path);
          unresolvedConflicts += 1;
        } else {
          const baseEntry = cached?.snapshot.entries[conflict.entryId];
          if (remoteEntry?.kind !== "live" || baseEntry?.kind !== "live") {
            throw new Error(`Expected live Entry ${conflict.entryId}`);
          }
          const baseContent = await this.options.remote.readBlob(
            baseEntry.revision.blobId,
          );
          const remoteContent = await this.options.remote.readBlob(
            remoteEntry.revision.blobId,
          );
          if (!baseContent || !remoteContent) {
            throw new Error(`Conflict history is incomplete for ${conflict.path}`);
          }
          let merged: Uint8Array | undefined;
          if (
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
            changedEntry = {
              entryId: conflict.entryId,
              history: [
                keepForRecovery(remoteEntry.revision, createdAt),
                keepForRecovery(localRevision, createdAt),
                ...(remoteEntry.history ?? []),
              ],
              kind: "live",
              path: conflict.path,
              revision: {
                blobId: mergedBlobId,
                contentHash: await sha256(merged),
                createdAt,
                revisionId: crypto.randomUUID(),
                size: merged.byteLength,
              },
            };
            writeAfterCommit.push({ body: merged, path: conflict.path });
          } else {
            changedEntry = {
              candidates: [remoteEntry.revision, localRevision],
              entryId: conflict.entryId,
              history: remoteEntry.history,
              kind: "conflicted",
              materializedContentHash: remoteEntry.revision.contentHash,
              path: conflict.path,
              reason: "edit-edit",
            };
            writeAfterCommit.push({ body: remoteContent, path: conflict.path });
            unresolvedConflicts += 1;
          }
        }
        reportUpload(conflict.path, conflict.localFile.size);
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
      for (const path of deleteAfterCommit) {
        await this.options.local.delete(path);
      }
      for (const pendingWrite of writeAfterCommit) {
        await this.options.local.write(pendingWrite.path, pendingWrite.body);
      }
    }
    await this.options.cache.save(await this.buildCache(remote));
    return {
      bulkDeletion: plan.bulkDeletion,
      deferredDownloadEntries,
      deferredDownloads: deferredEntryIds.length,
      deleted,
      downloaded,
      localIssues,
      status:
        unresolvedConflicts > 0 ||
        scan.unsyncedLocalEntries > 0 ||
        deferredDownloadEntries.some(
          (entry) => entry.reason === "unsupported-path",
        )
          ? "action-required"
          : "complete",
      unsyncedLocalEntries: scan.unsyncedLocalEntries,
      uploaded: publishedChanges,
    };
  }

  private async buildCache(snapshot: VaultSnapshot): Promise<CachedSyncState> {
    const current = await this.options.cache.load();
    const scanned = (await this.scanFiles(current)).files;
    const files: Record<string, CachedFileState> = {};
    const liveEntriesByPath = new Map(
      Object.values(snapshot.entries).flatMap((entry) =>
        entry.kind === "live" ? ([[entry.path, entry]] as const) : [],
      ),
    );
    for (const file of scanned) {
      const entry = liveEntriesByPath.get(file.path);
      if (entry && entry.revision.contentHash === file.contentHash) {
        files[file.path] = { ...file, entryId: entry.entryId };
      }
    }
    return { files, snapshot };
  }

  private async scanFiles(
    cached?: CachedSyncState,
    reportProgress = false,
  ): Promise<{
    files: Array<LocalFileInfo & { contentHash: string }>;
    skippedTrackedEntryIds: string[];
    unsyncedLocalEntries: number;
    unsyncedLocalPaths: string[];
  }> {
    const files: Array<LocalFileInfo & { contentHash: string }> = [];
    const skippedTrackedEntryIds: string[] = [];
    const unsyncedLocalPaths: string[] = [];
    let unsyncedLocalEntries = 0;
    const localFiles = await this.options.local.list();
    const totalBytes = localFiles.reduce((sum, file) => sum + file.size, 0);
    let completed = 0;
    let transferredBytes = 0;
    const reportScanned = (file?: LocalFileInfo): void => {
      if (file) {
        completed += 1;
        transferredBytes += file.size;
      }
      if (reportProgress) {
        this.reportProgress({
          completed,
          ...(file ? { currentPath: file.path } : {}),
          phase: "scanning",
          total: localFiles.length,
          totalBytes,
          transferredBytes,
        });
      }
    };
    reportScanned();
    for (const file of localFiles) {
      const cachedFile = cached?.files[file.path];
      if (
        this.options.maxAutomaticFileBytes !== undefined &&
        file.size > this.options.maxAutomaticFileBytes
      ) {
        if (
          cachedFile &&
          cachedFile.size === file.size &&
          cachedFile.modifiedAt === file.modifiedAt
        ) {
          files.push({ ...file, contentHash: cachedFile.contentHash });
        } else {
          unsyncedLocalEntries += 1;
          unsyncedLocalPaths.push(file.path);
          if (cachedFile) {
            skippedTrackedEntryIds.push(cachedFile.entryId);
          }
        }
        reportScanned(file);
        continue;
      }
      const contentHash =
        cachedFile &&
        cachedFile.size === file.size &&
        cachedFile.modifiedAt === file.modifiedAt
          ? cachedFile.contentHash
          : await sha256(await this.options.local.read(file.path));
      files.push({
        ...file,
        contentHash,
      });
      reportScanned(file);
    }
    return {
      files,
      skippedTrackedEntryIds,
      unsyncedLocalEntries,
      unsyncedLocalPaths,
    };
  }
}
