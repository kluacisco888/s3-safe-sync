import { diff3Merge } from "node-diff3";

import {
  fileType,
  SyncEngine,
  type BulkDeletionPlan,
  type DeletedEntry,
  type LiveEntry,
  type ReconcileInput,
  type ReplicaObservation,
  type RevisionRef,
  type SyncPlan,
  type VaultEntry,
  type VaultSnapshot,
} from "./sync-engine";
import {
  type CommitRecord,
  type HeadRecord,
  type RemoteIntegrityCheck,
  RemoteStateError,
  RemoteStore,
  snapshotBlobReferences,
} from "../storage/remote-store";
import { LocalStateChangedError } from "./errors";
import type { PersistedPathRename } from "./path-rename-tracker";
import { sha256Content as sha256 } from "./content-hash";
import { canonicalVaultPath } from "./canonical-path";
import { PathCollisionReviewer, type PathCollisionReview, type PathCollisionResolution } from "./path-collision-review";
import type { CollisionRenameJournal } from "./collision-rename-journal";
import {
  expiredContentKey,
  planExpiredContentCleanup,
} from "./expired-content-cleanup";
import {
  MAX_BLOB_DELETIONS_PER_RUN,
  planUnreferencedBlobDeletion,
  type UnreferencedBlobMarks,
} from "./unreferenced-blob-cleanup";

export type UnreferencedBlobCleanupResult =
  | { kind: "no-head" }
  | {
      deletedBlobs: number;
      deletedBytes: number;
      kind: "checked";
      marks: UnreferencedBlobMarks;
      serverDate: string;
    };

export type ExpiredContentCleanupResult =
  | { kind: "no-head" }
  | {
      commitId?: string;
      kind: "committed" | "nothing-to-clean";
      // 只在指定了要去掉哪些项时给出：每一项的结果
      outcomes?: Record<string, CleanupItemOutcome>;
      removedHistory: number;
      removedRecoveries: number;
      serverDate: string;
    };

// removed：这次提交去掉了；gone：记录里已经没有这一项；skipped：对应 Entry 成了冲突，或这一项不再算过期，没动它
export type CleanupItemOutcome = "gone" | "removed" | "skipped";

// 「待清理」里的一项：过期的恢复副本、过期的旧版本，或没有任何记录引用的旧数据块
export type CleanupCandidate =
  | {
      blobId: string;
      deletedAt?: string;
      entryId: string;
      expiresAt: string;
      key: string;
      kind: "history" | "recovery";
      path: string;
      revisionId: string;
      // 去掉这一项后数据块仍被记录里别的东西引用：path 是用着它的现有文件；不是现有文件时为空对象
      sharedWith?: { path?: string };
      size: number;
    }
  | { blobId: string; key: string; kind: "orphan"; size: number; uploadedAt: string };

export interface CleanupCandidates {
  items: CleanupCandidate[];
  // 这次读到的 Head serverDate（AWS 时间）
  serverDate: string;
}

export const orphanBlobKey = (blobId: string): string => `orphan:${blobId}`;

// 下载阶段最多每隔这么久把已落地的文件写进 Sync Cache 一次；打断前和开始上传前另外各写一次
const DOWNLOAD_PROGRESS_SAVE_INTERVAL_MS = 2_000;

const retainedRevisions = (entry: VaultEntry): RevisionRef[] => [
  ...(entry.kind === "live" ? [entry.revision] : []),
  ...(entry.kind === "conflicted" ? entry.candidates : []),
  ...(entry.kind !== "live" && entry.recovery ? [entry.recovery] : []),
  ...(entry.history ?? []),
];

// 本机缓存里的 Revision 仍在远端当前记录（本次 CAS 所对 Head 的快照）里时，返回记录里的那一份；
// 不在就当它已被过期清理，不论数据块还在不在
const retainedInRecord = (
  snapshot: VaultSnapshot,
  entryId: string,
  revision: RevisionRef,
): RevisionRef | undefined => {
  const entry = snapshot.entries[entryId];
  return entry
    ? retainedRevisions(entry).find(
        (retained) => retained.revisionId === revision.revisionId && retained.blobId === revision.blobId,
      )
    : undefined;
};

// 本机缓存里这个 Entry 已接受的本机内容：当前版本，或冲突时已落地的那个候选
const acceptedContentHash = (base: VaultSnapshot | undefined, entryId: string): string | undefined => {
  const entry = base?.entries[entryId];
  return entry?.kind === "live" ? entry.revision.contentHash
    : entry?.kind === "conflicted" ? entry.materializedContentHash : undefined;
};

// 不变量 9 的例外：本机内容等于已接受的内容，而远端当前记录里这个 Entry 已没有任何同内容的 Revision
// （旧版本已过期并被清理出记录）。这时不再要求远端恢复副本，本机旧字节进本机回收站
const acceptedContentPurgedFromRecord = (
  entry: VaultEntry,
  localContentHash: string,
  acceptedContentHash: string | undefined,
): boolean =>
  acceptedContentHash === localContentHash &&
  !retainedRevisions(entry).some((revision) => revision.contentHash === localContentHash);

// 用户确认过的每一项在刚读到的记录里怎么样了。key 形如 <类型>:<Entry ID>:<Revision ID>
const cleanupOutcomes = (
  snapshot: VaultSnapshot,
  selected: ReadonlySet<string>,
  removedKeys: readonly string[],
): Record<string, CleanupItemOutcome> => {
  const removed = new Set(removedKeys);
  const outcomes: Record<string, CleanupItemOutcome> = {};
  for (const key of selected) {
    if (removed.has(key)) { outcomes[key] = "removed"; continue; }
    const [kind = "", ...rest] = key.split(":");
    const revisionId = rest.pop() ?? "";
    const entry = snapshot.entries[rest.join(":")];
    const present = entry !== undefined && (kind === "recovery"
      ? entry.kind !== "live" && entry.recovery?.revisionId === revisionId
      : (entry.history ?? []).some((revision) => revision.revisionId === revisionId));
    // 冲突一律不动；还在记录里却没被去掉的（不再算过期）也不动
    outcomes[key] = entry?.kind === "conflicted" || present ? "skipped" : "gone";
  }
  return outcomes;
};

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
  cleanupEmptyDirectories?(retiredPaths: readonly string[]): Promise<void>;
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
  pathExists?(path: string): Promise<boolean>;
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
  bootstrapPending?: boolean;
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
  onRemoteHead?: (commitId: string) => void;
  onRemotePublished?: (commitId: string) => void;
  onIntegrityVerified?: (check: RemoteIntegrityCheck) => Promise<void>;
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
  // 这次实际执行完的本地动作（下载新增、下载更新、本地删除、本地挪动）
  downloads: SyncFileChange[];
  localIssues: LocalSyncIssue[];
  status: "action-required" | "complete";
  unsyncedLocalEntries: number;
  uploaded: number;
  // Head 发布成功的远端改动；没发布成功时为空
  uploads: SyncFileChange[];
}

// 一次同步里改动的一个文件：挪动时 fromPath 是旧路径、path 是新路径
export interface SyncFileChange {
  fromPath?: string;
  kind: "added" | "deleted" | "modified" | "moved" | "updated";
  path: string;
}

export interface SyncScanOptions {
  forceHashPaths?: ReadonlySet<string>;
  fullHashVerification?: boolean;
  retryHashMemo?: Map<string, VerifiedLocalFile>;
}

export interface SynchronizeOptions extends SyncScanOptions {
  assertLocalObservationCurrent?: () => void;
  // 每个本地动作落地后立即交出；之后的上传或发布失败时，调用方仍知道哪些文件已经下载
  onDownloadApplied?: (change: SyncFileChange) => void;
  // 计划出要上传的新文件后、开始下载和上传前交出「路径 -> 计划分配的 Entry ID」；没有要上传的新文件时不调用。
  // 调用方据此把这次上传中被改名的新文件记成 Pending Path Rename
  onNewFilesPlanned?: (entryIdsByPath: ReadonlyMap<string, string>) => void;
  pathRenames?: ReadonlyMap<string, PersistedPathRename>;
  renameResolution?: PossibleRenameResolution;
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
  | PossibleRenameIssue
  | { kind: "resolution-mismatch"; path: string }
  | { kind: "unsupported-path"; path: string }
  | { kind: "unsynced-local"; path: string };

export interface PossibleRenameIssue {
  kind: "possible-rename";
  newPaths: string[];
  oldPaths: string[];
  reviewToken: string;
}

export type PossibleRenameResolution = {
  reviewToken: string;
} & (
  | { kind: "moves"; pairs: Array<{ fromPath: string; toPath: string }> }
  | { kind: "separate" }
);

export interface LocalContentReview {
  path: string;
  reviewToken: string;
  localExists: boolean;
  localSize: number;
  localModifiedAt?: number;
  localPreview?: string;
  remoteKind: VaultEntry["kind"];
  remoteVersions: Array<{ size: number; createdAt: string; preview?: string }>;
  blockedReason?: string;
}

export type LocalContentChoice = "local" | "remote" | "both";

// A second rename can arrive after Head publication but before cache rebuilding.
// In that window the accepted snapshot still proves identity even if files is empty.
const applicableRenames = (
  cache: CachedSyncState | undefined,
  pending: ReadonlyMap<string, PersistedPathRename> = new Map(),
): Map<string, PersistedPathRename> => {
  const result = new Map<string, PersistedPathRename>();
  const cachedIds = new Set(Object.values(cache?.files ?? {}).map(file => file.entryId));
  const usedIds = new Set<string>();
  const usedTargets = new Set<string>();
  for (const [fromPath, rename] of pending) {
    const file = cache?.files[fromPath];
    const entry = cache?.snapshot.entries[rename.entryId];
    let source: string;
    if (file?.entryId === rename.entryId) {
      source = fromPath;
    } else if (!file && !cachedIds.has(rename.entryId) && entry?.kind === "live" &&
        entry.path !== rename.toPath) {
      source = entry.path;
    } else {
      continue;
    }
    if (usedIds.has(rename.entryId) || usedTargets.has(rename.toPath) || result.has(source)) {
      throw new Error("保存的改名记录对应不唯一，请检查受影响的路径。");
    }
    usedIds.add(rename.entryId);
    usedTargets.add(rename.toPath);
    result.set(source, rename);
  }
  return result;
};

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

  async initializeNew(vaultId: string, beforeHeadPublication?: () => Promise<void>): Promise<void> {
    if (await this.options.remote.readHead()) {
      throw new Error("远端存储已经初始化过了");
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
        `迁移基线里有跨平台路径撞名：${collision.join("、")}`,
      );
    }
    if (scan.unsyncedLocalEntries > 0) {
      throw new Error("迁移基线里有超过本设备限制的文件");
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
        throw new Error(`读取期间本地文件被改动：${file.path}`);
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
    await this.options.remote.initialize({ commit, head }, beforeHeadPublication);
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
      throw new Error("远端存储尚未初始化");
    }
    const snapshot = await this.options.remote.readSnapshot(versionedHead.value);
    const entry = snapshot.entries[entryId];
    if (entry?.kind !== "live") {
      throw new Error(`暂缓下载的文件 ${entryId} 已不是当前版本`);
    }
    if (this.options.local.supportsPath?.(entry.path) === false) {
      throw new Error(`本设备不支持这个路径：${entry.path}`);
    }
    const cached = await this.options.cache.load();
    const cachedFile = cached?.files[entry.path];
    const expectedContentHash = cachedFile?.contentHash ?? null;
    await this.assertLocalContent(entry.path, expectedContentHash);
    await this.assertRemoteRecoveryForLocalContent(
      snapshot,
      entry.entryId,
      expectedContentHash,
      // 缓存里这个路径记的是本 Entry 时，记下的内容就是它已接受的本机 base
      cachedFile?.entryId === entry.entryId ? cachedFile.contentHash : undefined,
    );
    const plaintext = await this.options.remote.readBlob(entry.revision.blobId);
    if (
      !plaintext ||
      plaintext.byteLength !== entry.revision.size ||
      (await sha256(plaintext)) !== entry.revision.contentHash
    ) {
      throw new Error(`暂缓下载的版本 ${entry.revision.revisionId} 已损坏`);
    }
    await this.reportVerifiedContent(entry, entry.revision);
    await this.assertLocalContent(entry.path, expectedContentHash);
    await this.options.local.write(
      entry.path,
      plaintext,
      expectedContentHash,
    );
    await this.acceptReviewedEntries(snapshot, [entry]);
  }

  async importCandidate(path: string): Promise<void> {
    const versionedHead = await this.options.remote.readHead();
    if (!versionedHead) {
      throw new Error("远端存储尚未初始化");
    }
    const snapshot = await this.options.remote.readSnapshot(versionedHead.value);
    const canonicalPath = canonicalVaultPath(path);
    const pathIsKnown = Object.values(snapshot.entries).some(
      (entry) =>
        canonicalVaultPath(entry.path) === canonicalPath,
    );
    if (pathIsKnown) {
      throw new Error(`远端存储里已有路径 ${path}`);
    }
    const file = (await this.options.local.list()).find(
      (candidate) => candidate.path === path,
    );
    if (!file) {
      throw new Error(`待导入文件已不存在：${path}`);
    }
    if (
      this.exceedsAutomaticFileLimit(file.path, file.size)
    ) {
      throw new Error(`待导入文件超过移动端限制：${path}`);
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
    await this.acceptReviewedEntries({...snapshot, commitId}, [entry]);
  }

  async reviewLocalContent(path: string): Promise<LocalContentReview> {
    const { review } = await this.loadLocalContentReview(path);
    return review;
  }

  reviewPathCollision(paths: string[], renames: ReadonlyMap<string, PersistedPathRename>): Promise<PathCollisionReview> {
    return new PathCollisionReviewer(this.options).review(paths, renames);
  }

  resolvePathCollision(request: PathCollisionResolution, renames: ReadonlyMap<string, PersistedPathRename>,
    journal: Pick<CollisionRenameJournal, "prepare" | "recover">): Promise<string> {
    return new PathCollisionReviewer(this.options).resolve(request, renames, journal);
  }

  private async loadLocalContentReview(path: string) {
    const head = await this.options.remote.readHead();
    if (!head) throw new Error("远端存储尚未初始化");
    const snapshot = await this.options.remote.readSnapshot(head.value);
    const atPath = Object.values(snapshot.entries).filter(entry => entry.path === path);
    const currentOwners = atPath.filter(entry => entry.kind !== "deleted");
    const matches = currentOwners.length ? currentOwners : atPath;
    if (matches.length !== 1) throw new Error("远端路径已变化或对应不唯一。请同步后检查它当前的路径。");
    const entry = matches[0]!;
    const file = await this.options.local.stat(path);
    const revisions = entry.kind === "live" ? [entry.revision]
      : entry.kind === "conflicted" ? entry.candidates : [];
    const materialized = entry.kind === "live" ? entry.revision
      : entry.kind === "conflicted" ? entry.candidates.find(r => r.contentHash === entry.materializedContentHash)
      : undefined;
    if (entry.kind === "conflicted" && entry.materializedContentHash && !materialized) {
      throw new RemoteStateError("冲突没有可核实的候选版本", undefined,
        {kind: "recovery", entryId: entry.entryId, contentHash: entry.materializedContentHash});
    }
    const blockedReason = (file && this.exceedsAutomaticFileLimit(path, file.size)) ||
      revisions.some(revision => this.exceedsAutomaticFileLimit(path, revision.size))
      ? "这次审查超过了本设备的传输限制。请在桌面端处理；若是低于移动端限制的附件，可连接 Wi-Fi 后处理。"
      : this.options.local.supportsPath?.(path) === false
        ? "本设备不支持这个路径。请先在兼容的桌面设备上改名。"
        : undefined;
    const previewLimit = 256 * 1024;
    const textPreview = (body: Uint8Array): string | undefined => {
      if (body.byteLength > previewLimit) return undefined;
      try {
        const text = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(body);
        const binary = [...text].some(character => {
          const code = character.charCodeAt(0);
          return code < 32 && code !== 9 && code !== 10 && code !== 13;
        });
        return binary ? undefined : text;
      } catch { return undefined; }
    };
    let localPreview: string | undefined;
    let localHash: string | null = null;
    if (file && !blockedReason) {
      if (file.size <= previewLimit || !this.options.local.hashContent) {
        const body = await this.options.local.read(path);
        if (body.byteLength !== file.size) throw new LocalStateChangedError(path);
        localHash = await sha256(body);
        localPreview = textPreview(body);
      } else {
        const hashed = await this.options.local.hashContent(path, {yieldToHost: this.options.yieldDuringHashing});
        if (hashed.size !== file.size) throw new LocalStateChangedError(path);
        localHash = hashed.contentHash;
      }
    }
    const remoteVersions: LocalContentReview["remoteVersions"] = [];
    for (const [index, revision] of revisions.entries()) {
      let preview: string | undefined;
      if (!blockedReason && index < 3 && revision.size <= previewLimit) {
        const body = await this.options.remote.readBlob(revision.blobId);
        if (!body || body.byteLength !== revision.size || await sha256(body) !== revision.contentHash) {
          throw new RemoteStateError("远端审查内容未通过校验", undefined, {kind: "blob", blobId: revision.blobId});
        }
        await this.reportVerifiedContent(entry, revision);
        preview = textPreview(body);
      }
      remoteVersions.push({size: revision.size, createdAt: revision.createdAt, preview});
    }
    const review: LocalContentReview = {
      path, localExists: !!file, localSize: file?.size ?? 0, localModifiedAt: file?.modifiedAt, localPreview,
      remoteKind: entry.kind, remoteVersions, blockedReason,
      reviewToken: await sha256(new TextEncoder().encode(JSON.stringify({
        vault: snapshot.vaultId, commit: head.value.commitId, entryId: entry.entryId, path,
        localHash, size: file?.size ?? null,
      }))),
    };
    return {head, snapshot, entry, file, localHash, materialized, review};
  }

  async resolveLocalContent(path: string, reviewToken: string, choice: LocalContentChoice): Promise<string | undefined> {
    if (choice === "both") return this.preserveLocalCopyAndAcceptRemote(path, reviewToken);
    const {head, snapshot, entry, file, localHash, review} = await this.loadLocalContentReview(path);
    if (review.blockedReason) throw new Error(review.blockedReason);
    if (review.reviewToken !== reviewToken) throw new Error("本地或远端内容有变化。请重新审查两个版本。");
    if (entry.kind !== "live" || !file || !localHash) {
      throw new Error("这个选项需要同时有本地文件和 S3 当前版本。请重新审查当前状态。");
    }
    await this.assertLocalContent(path, localHash);
    await this.assertRemoteEntriesBeforePublication(snapshot, new Set([entry.entryId]), []);
    const remoteBody = await this.options.remote.readBlob(entry.revision.blobId);
    if (!remoteBody || remoteBody.byteLength !== entry.revision.size || await sha256(remoteBody) !== entry.revision.contentHash) {
      throw new RemoteStateError("远端内容未通过校验", undefined, {kind: "blob", blobId: entry.revision.blobId});
    }
    const localBody = await this.options.local.read(path);
    if (localBody.byteLength !== file.size || await sha256(localBody) !== localHash) throw new LocalStateChangedError(path);
    const localRevision: RevisionRef = {blobId: crypto.randomUUID(), revisionId: crypto.randomUUID(),
      contentHash: localHash, size: localBody.byteLength, createdAt: head.serverDate};
    await this.options.remote.writeBlob(localRevision.blobId, localBody);
    await this.assertRemoteRevision(localRevision);
    const resolved: LiveEntry = {...entry,
      revision: choice === "local" ? localRevision : entry.revision,
      history: [keepForRecovery(choice === "local" ? entry.revision : localRevision, head.serverDate), ...(entry.history ?? [])]};
    await this.assertLocalContent(path, localHash);
    const commitId = crypto.randomUUID();
    await this.options.remote.advance({
      expectedHeadEtag: head.etag,
      head: {...head.value, commitId, generation: head.value.generation + 1},
      commit: {commitId, createdAt: head.serverDate, vaultId: snapshot.vaultId, protocolVersion: 1,
        parentIds: [head.value.commitId], replicaId: this.options.replicaId,
        changes: [{kind: "set-entry", entry: resolved}]},
    });
    // The backup must be authenticated and referenced by Head before replacing local bytes.
    await this.assertLocalContent(path, localHash);
    if (choice === "remote") await this.options.local.write(path, remoteBody, localHash);
    await this.acceptReviewedEntries({...snapshot, commitId}, [resolved]);
    return undefined;
  }

  async preserveLocalCopyAndAcceptRemote(path: string, reviewToken: string): Promise<string | undefined> {
    const {head, snapshot, entry, file, localHash, materialized, review} = await this.loadLocalContentReview(path);
    if (review.blockedReason) throw new Error(review.blockedReason);
    if (review.reviewToken !== reviewToken) throw new Error("本地或远端内容有变化。请重新审查两个版本。");
    await this.assertLocalContent(path, localHash);
    await this.assertRemoteEntriesBeforePublication(snapshot, new Set([entry.entryId]), []);
    let remoteBody: Uint8Array | undefined;
    if (materialized) {
      remoteBody = await this.options.remote.readBlob(materialized.blobId);
      if (!remoteBody || remoteBody.byteLength !== materialized.size || await sha256(remoteBody) !== materialized.contentHash) {
        throw new RemoteStateError("远端内容未通过校验", undefined, {kind: "blob", blobId: materialized.blobId});
      }
    }
    let copy: LiveEntry | undefined;
    if (file && localHash) {
      const localBody = await this.options.local.read(path);
      if (localBody.byteLength !== file.size || await sha256(localBody) !== localHash) throw new LocalStateChangedError(path);
      const separator = path.lastIndexOf("/") + 1;
      const filename = path.slice(separator);
      const dot = filename.lastIndexOf(".");
      let extension = dot > 0 ? filename.slice(dot) : "";
      const stem = extension ? filename.slice(0, dot) : filename;
      const suffix = ` (local copy ${crypto.randomUUID()})`;
      const encoder = new TextEncoder();
      // 255 UTF-8 bytes also fits the desktop character limits. Do not split a code point.
      // An unusually long extension cannot be retained together with the unique suffix.
      if (encoder.encode(suffix + extension).byteLength > 251) extension = "";
      const available = 255 - encoder.encode(suffix + extension).byteLength;
      let shortened = "";
      let used = 0;
      for (const character of stem) {
        const size = encoder.encode(character).byteLength;
        if (used + size > available) break;
        shortened += character;
        used += size;
      }
      const copyPath = `${path.slice(0, separator)}${shortened || "file"}${suffix}${extension}`;
      this.assertRemotePathAvailable(snapshot, "new-local-copy", copyPath);
      await this.assertLocalContent(copyPath, null);
      // Save the independent local copy first; failed uploads never remove this copy.
      await this.options.local.write(copyPath, localBody, null);
      const revision: RevisionRef = {blobId: crypto.randomUUID(), revisionId: crypto.randomUUID(),
        contentHash: localHash, size: localBody.byteLength, createdAt: head.serverDate};
      await this.options.remote.writeBlob(revision.blobId, localBody);
      await this.assertRemoteRevision(revision);
      copy = {entryId: crypto.randomUUID(), path: copyPath, kind: "live", revision};
    }
    await this.assertLocalContent(path, localHash);
    const commitId = crypto.randomUUID();
    await this.options.remote.advance({
      expectedHeadEtag: head.etag,
      head: {...head.value, commitId, generation: head.value.generation + 1},
      commit: {commitId, createdAt: head.serverDate, vaultId: snapshot.vaultId, protocolVersion: 1,
        parentIds: [head.value.commitId], replicaId: this.options.replicaId,
        changes: copy ? [{kind: "set-entry", entry: copy}] : []},
    });
    // Only materialize the reviewed remote state after the local copy is accepted by S3.
    await this.assertLocalContent(path, localHash);
    if (remoteBody) await this.options.local.write(path, remoteBody, localHash);
    else if (file) await this.options.local.delete(path, localHash);

    await this.acceptReviewedEntries({...snapshot, commitId}, [entry, ...(copy ? [copy] : [])]);
    return copy?.path;
  }

  // A manual action accepts only its reviewed Entries, never the rest of a new device's files.
  private async acceptReviewedEntries(snapshot: VaultSnapshot, entries: VaultEntry[]): Promise<void> {
    const current = await this.options.cache.load();
    const next: CachedSyncState = current ? structuredClone(current) : {
      bootstrapPending: true,
      files: {}, snapshot: {vaultId: snapshot.vaultId, protocolVersion: 1, commitId: snapshot.commitId, entries: {}},
      unmaterializedEntryIds: [],
    };
    for (const accepted of entries) {
      next.snapshot.entries[accepted.entryId] = accepted;
      for (const [cachedPath, cachedFile] of Object.entries(next.files)) {
        if (cachedFile.entryId === accepted.entryId) delete next.files[cachedPath];
      }
      const expectedHash = accepted.kind === "live" ? accepted.revision.contentHash
        : accepted.kind === "conflicted" ? accepted.materializedContentHash : undefined;
      const info = await this.options.local.stat(accepted.path);
      if (info && expectedHash) {
        await this.assertLocalContent(accepted.path, expectedHash);
        next.files[accepted.path] = {...info, entryId: accepted.entryId, contentHash: expectedHash};
      }
      next.unmaterializedEntryIds = next.unmaterializedEntryIds?.filter(id => id !== accepted.entryId);
    }
    await this.options.cache.save(next);
  }

  async readConflictCandidate(entryId: string, revisionId: string): Promise<Uint8Array> {
    const head = await this.options.remote.readHead();
    if (!head) throw new Error("远端存储尚未初始化");
    const snapshot = await this.options.remote.readSnapshot(head.value);
    const entry = snapshot.entries[entryId];
    if (entry?.kind !== "conflicted") throw new Error("这个冲突已有变化。请刷新同步状态。");
    const revision = entry.candidates.find(candidate => candidate.revisionId === revisionId);
    if (!revision) throw new Error("这个版本已不是冲突候选版本。请刷新同步状态。");
    if (revision.size > 1024 * 1024) throw new Error("这个版本超过了文字预览限制。");
    const body = await this.options.remote.readBlob(revision.blobId);
    if (!body || body.byteLength !== revision.size || await sha256(body) !== revision.contentHash) {
      throw new RemoteStateError("冲突预览未通过内容校验", undefined, {kind: "blob", blobId: revision.blobId});
    }
    await this.reportVerifiedContent(entry, revision);
    return body;
  }

  async resolveConflict(
    entryId: string,
    resolution: ConflictResolution,
  ): Promise<void> {
    const versionedHead = await this.options.remote.readHead();
    if (!versionedHead) {
      throw new Error("远端存储尚未初始化");
    }
    const snapshot = await this.options.remote.readSnapshot(versionedHead.value);
    const conflicted = snapshot.entries[entryId];
    if (conflicted?.kind !== "conflicted") {
      throw new Error(`文件 ${entryId} 没有冲突`);
    }
    if (this.options.local.supportsPath?.(conflicted.path) === false) {
      throw new Error(`本设备不支持这个路径：${conflicted.path}`);
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
          `冲突候选版本 ${resolution.revisionId} 不存在`,
        );
      }
      materializedContent = await this.options.remote.readBlob(candidate.blobId);
      if (
        !materializedContent ||
        materializedContent.byteLength !== candidate.size ||
        (await sha256(materializedContent)) !== candidate.contentHash
      ) {
        throw new Error(`冲突候选版本 ${resolution.revisionId} 已损坏`);
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
        throw new Error("这个冲突里没有删除决定");
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
    await this.acceptReviewedEntries({...snapshot, commitId}, [resolvedEntry]);
  }

  async readHistoricalRevision(entryId: string, revisionId: string): Promise<Uint8Array> {
    const head = await this.options.remote.readHead();
    if (!head) throw new Error("远端存储尚未初始化");
    const snapshot = await this.options.remote.readSnapshot(head.value);
    const entry = snapshot.entries[entryId];
    const revision = entry?.kind === "live" ? entry.history?.find(value => value.revisionId === revisionId) : undefined;
    if (entry?.kind !== "live" || !revision) throw new Error("这个历史版本已不可用。请刷新历史版本。");
    if (this.exceedsAutomaticFileLimit(entry.path, revision.size)) throw new Error("这次预览超过了本设备的传输限制。");
    return this.readDeletedRevisionCopy(entry, revision, head.serverDate);
  }

  async restoreRevision(entryId: string, revisionId: string): Promise<void> {
    const versionedHead = await this.options.remote.readHead();
    if (!versionedHead) {
      throw new Error("远端存储尚未初始化");
    }
    const snapshot = await this.options.remote.readSnapshot(versionedHead.value);
    const entry = snapshot.entries[entryId];
    if (entry?.kind !== "live") {
      throw new Error(`文件 ${entryId} 已不是当前版本`);
    }
    if (this.options.local.supportsPath?.(entry.path) === false) {
      throw new Error(`本设备不支持这个路径：${entry.path}`);
    }
    const historical = entry.history?.find(
      (revision) => revision.revisionId === revisionId,
    );
    if (!historical) {
      throw new Error(`历史版本 ${revisionId} 不存在`);
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
      throw new Error(`历史版本 ${revisionId} 已损坏`);
    }
    await this.reportVerifiedContent(entry, historical);
    if (
      historical.expiresAt !== undefined &&
      Date.parse(historical.expiresAt) <= Date.parse(versionedHead.serverDate)
    ) {
      throw new Error(`历史版本 ${revisionId} 已过期`);
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
    await this.acceptReviewedEntries({...snapshot, commitId}, [restoredEntry]);
  }

  /**
   * 「待清理」的列表，只读：只用同一次 readHead 读到的 Head、它的快照和数据块列表计算，不读本机缓存、不写 S3。
   * 过期内容的判定和清理提交相同（AWS 时间；冲突不出现；缺到期时间的不出现）；
   * 没有对应文件的数据块按数据块删除的前三条判定（不被引用、上传满 30 天、早于 Head 对象）。
   */
  async listCleanupCandidates(vaultId: string): Promise<CleanupCandidates> {
    const remote = this.options.remote;
    const versionedHead = await remote.readHead();
    if (!versionedHead || versionedHead.value.vaultId !== vaultId) {
      throw new Error("远端 Head 指针缺失，或属于另一个仓库");
    }
    const snapshot = await remote.readSnapshot(versionedHead.value);
    const plan = planExpiredContentCleanup(snapshot, versionedHead.serverDate);
    // 每个数据块被哪些项引用（范围和读 Head 时的存在性检查一样）；key 认出过期项本身，livePath 认出现有文件的当前版本
    const referrers = new Map<string, Array<{ key?: string; livePath?: string }>>();
    const addReferrer = (blobId: string, referrer: { key?: string; livePath?: string }): void => {
      referrers.set(blobId, [...(referrers.get(blobId) ?? []), referrer]);
    };
    for (const entry of Object.values(snapshot.entries)) {
      if (entry.kind === "live") addReferrer(entry.revision.blobId, { livePath: entry.path });
      if (entry.kind === "conflicted") for (const candidate of entry.candidates) addReferrer(candidate.blobId, {});
      if (entry.kind !== "live" && entry.recovery) {
        addReferrer(entry.recovery.blobId,
          entry.kind === "deleted" ? { key: expiredContentKey("recovery", entry.entryId, entry.recovery.revisionId) } : {});
      }
      for (const revision of entry.history ?? []) {
        addReferrer(revision.blobId,
          entry.kind === "conflicted" ? {} : { key: expiredContentKey("history", entry.entryId, revision.revisionId) });
      }
    }
    const expired = plan.removals.map((removal): Extract<CleanupCandidate, { kind: "history" | "recovery" }> => {
      const others = (referrers.get(removal.revision.blobId) ?? []).filter((referrer) => referrer.key !== removal.key);
      const livePath = others.flatMap((referrer) => referrer.livePath === undefined ? [] : [referrer.livePath]).sort()[0];
      return {
        blobId: removal.revision.blobId,
        ...(removal.deletedAt === undefined ? {} : { deletedAt: removal.deletedAt }),
        entryId: removal.entryId,
        expiresAt: removal.revision.expiresAt ?? "",
        key: removal.key,
        kind: removal.kind,
        path: removal.path,
        revisionId: removal.revision.revisionId,
        ...(others.length === 0 ? {} : { sharedWith: livePath === undefined ? {} : { path: livePath } }),
        size: removal.revision.size,
      };
    });
    // 备份按删除时间、旧版本按到期时间，从早到晚
    expired.sort((left, right) =>
      Date.parse(left.deletedAt ?? left.expiresAt) - Date.parse(right.deletedAt ?? right.expiresAt) ||
      (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    // 没有任何第一次判定记录时，满足前三条的数据块都落在 waiting 里。
    // 引用集和读 Head 时的存在性检查、数据块删除用同一个函数，免得规则以后改了这里对不上
    const unreferenced = planUnreferencedBlobDeletion({
      headLastModified: versionedHead.lastModified,
      objects: await remote.listBlobObjects(),
      referenced: new Set(snapshotBlobReferences(snapshot).keys()),
      serverDate: versionedHead.serverDate,
    });
    const orphans: CleanupCandidate[] = [...unreferenced.deletable, ...unreferenced.waiting].map((object) => ({
      blobId: object.blobId, key: orphanBlobKey(object.blobId), kind: "orphan", size: object.size, uploadedAt: object.lastModified,
    }));
    return { items: [...expired, ...orphans], serverDate: versionedHead.serverDate };
  }

  /**
   * 删除本仓库文件夹里没人用的数据块（见 unreferenced-blob-cleanup.ts 的四条判据）。
   * 引用集只用同一次 readHead 读到的 Head 和它的快照计算，绝不读本机缓存；删除前重读 Head、重算引用，
   * 这期间被新提交引用的候选不删。每次最多 200 个。任何一步出错都直接抛出：宁可少删。
   * marks 是上一次检查留下的第一次判定记录（调用方保存在本地，绑定目标和 vaultId）。
   * 给了 onlyBlobIds 时只考虑其中的数据块，列表里别的对象一概不看、不记。
   */
  async deleteUnreferencedBlobs(
    vaultId: string,
    marks?: Readonly<UnreferencedBlobMarks>,
    onlyBlobIds?: ReadonlySet<string>,
  ): Promise<UnreferencedBlobCleanupResult> {
    const remote = this.options.remote;
    const versionedHead = await remote.readHead();
    if (!versionedHead || versionedHead.value.vaultId !== vaultId) {
      return { kind: "no-head" };
    }
    const snapshot = await remote.readSnapshot(versionedHead.value);
    // 列表照旧整批核对 key 格式，有一个对不上就整批作废；之后才按 onlyBlobIds 筛
    const listed = await remote.listBlobObjects();
    const plan = planUnreferencedBlobDeletion({
      headLastModified: versionedHead.lastModified,
      marks,
      objects: onlyBlobIds ? listed.filter((object) => onlyBlobIds.has(object.blobId)) : listed,
      referenced: new Set(snapshotBlobReferences(snapshot).keys()),
      serverDate: versionedHead.serverDate,
    });
    const nextMarks = { ...plan.marks };
    let deletedBlobs = 0;
    let deletedBytes = 0;
    if (plan.deletable.length > 0) {
      const current = await remote.readHead();
      if (!current || current.value.vaultId !== vaultId) {
        throw new Error("删除数据块前重读 Head 指针失败，这次不删除数据块。");
      }
      const stillReferenced = snapshotBlobReferences(await remote.readSnapshot(current.value));
      for (const blobId of stillReferenced.keys()) delete nextMarks[blobId];
      const batch = plan.deletable
        .filter((object) => !stillReferenced.has(object.blobId))
        .slice(0, MAX_BLOB_DELETIONS_PER_RUN);
      for (const object of batch) {
        await remote.deleteBlob(object.blobId);
        delete nextMarks[object.blobId];
        deletedBlobs += 1;
        deletedBytes += object.size;
      }
    }
    return { deletedBlobs, deletedBytes, kind: "checked", marks: nextMarks, serverDate: versionedHead.serverDate };
  }

  // 清理提交：只用同一次 readHead 读到的 Head 和它的快照计算，CAS 也对这个 Head，绝不拿本机缓存构造
  // （否则会把别的设备的新改动覆盖回旧版本）。被别的设备抢先时抛 HeadChangedError，由调用方重读重算。
  // 给了 selected 时只去掉其中这些确切的项目（expiredContentKey），并报告每一项的结果
  async cleanupExpiredContent(vaultId: string, selected?: ReadonlySet<string>): Promise<ExpiredContentCleanupResult> {
    const versionedHead = await this.options.remote.readHead();
    if (!versionedHead || versionedHead.value.vaultId !== vaultId) {
      return { kind: "no-head" };
    }
    const snapshot = await this.options.remote.readSnapshot(versionedHead.value);
    const plan = planExpiredContentCleanup(snapshot, versionedHead.serverDate, selected);
    const counts = {
      ...(selected ? { outcomes: cleanupOutcomes(snapshot, selected, plan.removals.map((removal) => removal.key)) } : {}),
      removedHistory: plan.removedHistory,
      removedRecoveries: plan.removedRecoveries.length,
      serverDate: versionedHead.serverDate,
    };
    if (plan.changedEntries.length === 0) {
      return { kind: "nothing-to-clean", ...counts };
    }
    // 清理只去掉引用；发布前总检查照样适用
    this.assertCommitReferencesAcceptedOrUploaded(snapshot, plan.changedEntries, new Set());
    const createdAt = versionedHead.serverDate;
    const commitId = crypto.randomUUID();
    const nextSnapshot: VaultSnapshot = {
      commitId,
      entries: {
        ...snapshot.entries,
        ...Object.fromEntries(plan.changedEntries.map((entry) => [entry.entryId, entry])),
      },
      protocolVersion: 1,
      vaultId: snapshot.vaultId,
    };
    const head: HeadRecord = {
      commitId,
      generation: versionedHead.value.generation + 1,
      protocolVersion: 1,
      snapshotId: versionedHead.value.snapshotId,
      vaultId: snapshot.vaultId,
    };
    // 与同步提交同一条规则：每 100 次写一份完整快照
    if (head.generation % 100 === 0) {
      const snapshotId = crypto.randomUUID();
      await this.options.remote.writeSnapshot(snapshotId, nextSnapshot);
      head.snapshotId = snapshotId;
    }
    await this.options.remote.advance({
      commit: {
        changes: plan.changedEntries.map((entry) => ({ entry, kind: "set-entry" })),
        commitId,
        createdAt,
        parentIds: [versionedHead.value.commitId],
        protocolVersion: 1,
        replicaId: this.options.replicaId,
        vaultId: snapshot.vaultId,
      },
      expectedHeadEtag: versionedHead.etag,
      head,
    });
    this.options.onRemotePublished?.(commitId);
    // 本机缓存正好停在这次读到的 Head 时才直接接受清理后的记录（清理不改任何当前版本和路径，
    // 本机文件记录照旧有效）；缓存落后或超前都不碰，留给下一次同步
    const cached = await this.options.cache.load();
    if (cached?.snapshot.commitId === versionedHead.value.commitId && cached.snapshot.vaultId === snapshot.vaultId) {
      await this.options.cache.save({ ...cached, snapshot: nextSnapshot });
    }
    return { commitId, kind: "committed", ...counts };
  }

  async readDeletedRecovery(
    entryId: string,
    revisionId?: string,
  ): Promise<Uint8Array> {
    const versionedHead = await this.options.remote.readHead();
    if (!versionedHead) {
      throw new Error("远端存储尚未初始化");
    }
    const snapshot = await this.options.remote.readSnapshot(versionedHead.value);
    const deleted = snapshot.entries[entryId];
    if (deleted?.kind !== "deleted") {
      throw new Error(`文件 ${entryId} 没有被删除`);
    }
    const revision = revisionId
      ? [deleted.recovery, ...(deleted.history ?? [])].find(
          (candidate) => candidate?.revisionId === revisionId,
        )
      : deleted.recovery;
    if (!revision) {
      throw new Error(`已删除的版本 ${revisionId ?? entryId} 不存在`);
    }
    return this.readDeletedRevisionCopy(
      deleted,
      revision,
      versionedHead.serverDate,
    );
  }

  async restoreDeleted(entryId: string, revisionId?: string): Promise<void> {
    const versionedHead = await this.options.remote.readHead();
    if (!versionedHead) {
      throw new Error("远端存储尚未初始化");
    }
    const snapshot = await this.options.remote.readSnapshot(versionedHead.value);
    const deleted = snapshot.entries[entryId];
    if (deleted?.kind !== "deleted") {
      throw new Error(`文件 ${entryId} 没有被删除`);
    }
    const selected = revisionId
      ? [deleted.recovery, ...(deleted.history ?? [])].find(
          (candidate) => candidate?.revisionId === revisionId,
        )
      : deleted.recovery;
    if (!selected) {
      throw new Error(`已删除的版本 ${revisionId ?? entryId} 不存在`);
    }
    if (this.options.local.supportsPath?.(deleted.path) === false) {
      throw new Error(`本设备不支持这个路径：${deleted.path}`);
    }
    this.assertRemotePathAvailable(snapshot, deleted.entryId, deleted.path);
    await this.assertRemoteEntriesBeforePublication(
      snapshot,
      new Set([entryId]),
      [],
    );
    const plaintext = await this.readDeletedRevisionCopy(
      deleted,
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
    await this.acceptReviewedEntries({...snapshot, commitId}, [restoredEntry]);
  }

  private async readRecoveryCopy(
    deleted: DeletedEntry,
    serverDate: string,
  ): Promise<Uint8Array> {
    const recovery = deleted.recovery;
    if (!recovery) {
      throw new Error(`文件 ${deleted.entryId} 没有恢复副本`);
    }
    return this.readDeletedRevisionCopy(
      deleted,
      recovery,
      serverDate,
    );
  }

  private async readDeletedRevisionCopy(
    entry: VaultEntry,
    revision: RevisionRef,
    serverDate: string,
  ): Promise<Uint8Array> {
    const plaintext = await this.options.remote.readBlob(revision.blobId);
    if (
      !plaintext ||
      plaintext.byteLength !== revision.size ||
      (await sha256(plaintext)) !== revision.contentHash
    ) {
      throw new Error(`文件 ${entry.entryId} 的恢复副本已损坏`);
    }
    await this.reportVerifiedContent(entry, revision);
    if (
      revision.expiresAt !== undefined &&
      Date.parse(revision.expiresAt) <= Date.parse(serverDate)
    ) {
      throw new Error(`文件 ${entry.entryId} 的恢复副本已过期`);
    }
    return plaintext;
  }

  async synchronize(
    approvedBulkDeletionEntryIds: readonly string[] = [],
    syncOptions: SynchronizeOptions = { fullHashVerification: true },
  ): Promise<SyncResult> {
    const versionedHead = await this.options.remote.readHead();
    if (!versionedHead) {
      throw new Error("远端存储尚未初始化");
    }
    this.options.onRemoteHead?.(versionedHead.value.commitId);
    let remote = await this.options.remote.readSnapshot(versionedHead.value);
    const cached = await this.options.cache.load();
    const scan = await this.scanFiles(cached, true, syncOptions);
    syncOptions.assertLocalObservationCurrent?.();
    const scanned = scan.files;
    const localPaths = new Set(scan.localPaths);
    const scannedByPath = new Map(
      scanned.map((file) => [file.path, file] as const),
    );
    const applicablePathRenames = applicableRenames(cached, syncOptions.pathRenames);
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
    const liveOwnersByCanonicalPath = new Map<string, string[]>();
    for (const entry of Object.values(remote.entries)) {
      if (entry.kind !== "live") continue;
      const key = canonicalVaultPath(entry.path);
      liveOwnersByCanonicalPath.set(key, [...(liveOwnersByCanonicalPath.get(key) ?? []), entry.entryId]);
    }
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
    // 同一内容分组里消失的 Entry 或新文件多于一个时，按文件名（含扩展名，NFC 规范化后完全相同）一一配对：
    // 只有某个消失 Entry 恰好有一个同名新文件、且该新文件也只对应它一个时才认定为挪动。
    // 已由 Pending Path Rename 认领的源和目标不参与，避免同一 Entry ID 落到两个路径。
    const sameNameEntryIdByPath = new Map<string, string>();
    const fileName = (path: string) => (path.split("/").pop() ?? path).normalize("NFC");
    for (const [fingerprint, missingEntries] of missingCachedByFingerprint) {
      const claimants = newFilesByFingerprint.get(fingerprint) ?? [];
      if (missingEntries.length === 1 && claimants.length === 1) continue;
      const missingByName = new Map<string, CachedFileState[]>();
      for (const missing of missingEntries) {
        if (renamedSourcePaths.has(missing.path)) continue;
        const name = fileName(missing.path);
        missingByName.set(name, [...(missingByName.get(name) ?? []), missing]);
      }
      const claimantsByName = new Map<string, LocalFileInfo[]>();
      for (const claimant of claimants) {
        if (renamedSourcePaths.has(claimant.path) || renameSourcesByTarget.has(claimant.path)) continue;
        const name = fileName(claimant.path);
        claimantsByName.set(name, [...(claimantsByName.get(name) ?? []), claimant]);
      }
      for (const [name, sameNameMissing] of missingByName) {
        const sameNameClaimants = claimantsByName.get(name);
        if (sameNameMissing.length === 1 && sameNameMissing[0] && sameNameClaimants?.length === 1 && sameNameClaimants[0]) {
          sameNameEntryIdByPath.set(sameNameClaimants[0].path, sameNameMissing[0].entryId);
        }
      }
    }
    for (const file of scanned) {
      const renameSources = renameSourcesByTarget.get(file.path);
      const renamedFile =
        renameSources?.length === 1 && renameSources[0]
          ? applicablePathRenames.get(renameSources[0])
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
      const inferredEntryId =
        renameCandidates?.length === 1 && renameCandidates[0] && newClaimants?.length === 1 &&
        // 与同名配对一致：已由 Pending Path Rename 认领的源和目标不参与一对一推断，避免同一 Entry ID 落到两个路径
        !renamedSourcePaths.has(renameCandidates[0].path) && !renameSourcesByTarget.has(file.path)
          ? renameCandidates[0].entryId
          : sameNameEntryIdByPath.get(file.path);
      if (
        inferredEntryId !== undefined &&
        // Equal bytes are not evidence that an already-owned path changed identity.
        !(liveOwnersByCanonicalPath.get(canonicalVaultPath(file.path)) ?? []).some(id => id !== inferredEntryId)
      ) {
        entryIdByPath.set(file.path, inferredEntryId);
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
      bootstrapPending: cached?.bootstrapPending,
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
    const retiredLocalPaths = new Set<string>();
    const reconciliationBase = this.buildReconciliationBase(cached);
    let plan = await this.reconcileWithRecoverableStaleCopies({
      base: reconciliationBase,
      local: observation,
      remote,
    });
    const possibleRename = plan.conflicts.find(conflict => conflict.kind === "possible-rename");
    const renameIssue: PossibleRenameIssue | undefined = possibleRename ? {
      kind: "possible-rename",
      newPaths: possibleRename.newFiles.map(file => file.path),
      oldPaths: possibleRename.deletedEntries.map(entry => entry.path),
      // 令牌只绑定被扣住的部分：其他文件同步发布新 Commit 后仍然有效，被扣住的文件一变就失效
      reviewToken: await sha256(new TextEncoder().encode(JSON.stringify({
        vaultId: remote.vaultId,
        old: possibleRename.deletedEntries.map(entry => {
          const accepted = reconciliationBase?.entries[entry.entryId];
          return [entry.entryId, entry.path, accepted?.kind === "live" ? accepted.revision.contentHash : null];
        }).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        files: possibleRename.newFiles.map(file => [file.path, file.contentHash, file.size])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      }))),
    } : undefined;
    const resolution = syncOptions.renameResolution;
    if (resolution) {
      if (!renameIssue || resolution.reviewToken !== renameIssue.reviewToken || !possibleRename) {
        throw new Error("审查挪动之后文件或远端状态有变化。请再同步一次并审查新的方案。");
      }
      if (resolution.kind === "moves") {
        // 部分配对：每个消失路径、每个新路径至多出现一次；没列出的消失 Entry 按删除处理，没被选中的新文件按新文件上传
        const sources = new Map(possibleRename.deletedEntries.map(entry => [entry.path, entry.entryId]));
        const targets = new Set(renameIssue.newPaths);
        const assignments = new Map<string, string>();
        for (const pair of resolution.pairs) {
          const entryId = sources.get(pair.fromPath);
          if (!entryId || !targets.delete(pair.toPath)) throw new Error("挪动对应关系不是一对一的。");
          if (fileType(pair.fromPath) !== fileType(pair.toPath)) {
            throw new Error("消失的文件只能挪到同类型的新文件。");
          }
          sources.delete(pair.fromPath);
          assignments.set(pair.toPath, entryId);
        }
        observation.files = observation.files.map(file => assignments.has(file.path)
          ? { ...file, entryId: assignments.get(file.path)! } : file);
      }
      // 配对之外剩下的消失与新增都已由用户审查过，按独立的删除和新增执行
      plan = await this.reconcileWithRecoverableStaleCopies({
        base: reconciliationBase, local: observation, remote,
        allowIndependentCreatesAndDeletes: true,
      });
    }
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
          return renameIssue ? [renameIssue] : [];
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
        downloads: [],
        localIssues,
        status: "action-required",
        unsyncedLocalEntries: scan.unsyncedLocalEntries,
        uploaded: 0,
        uploads: [],
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
        downloads: [],
        localIssues,
        status: "action-required",
        unsyncedLocalEntries: scan.unsyncedLocalEntries,
        uploaded: 0,
        uploads: [],
      };
    }

    const sharedConflicts = plan.conflicts.filter(
      (conflict) =>
        conflict.kind === "delete-edit" ||
        conflict.kind === "edit-delete" ||
        conflict.kind === "edit-edit",
    );
    const newFileEntryIds = new Map(
      plan.remoteChanges.flatMap((change) =>
        change.kind === "upload-new" ? [[change.path, change.entryId] as const] : [],
      ),
    );
    if (newFileEntryIds.size > 0) syncOptions.onNewFilesPlanned?.(newFileEntryIds);
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
          // 已不在远端记录里的 base 不会写进冲突，也就不必核实
          conflict.kind === "delete-edit" && retainedInRecord(remote, conflict.entryId, conflict.baseRevision)
            ? [conflict.baseRevision] : [],
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
    const downloads: SyncFileChange[] = [];
    const recordDownload = (change: SyncFileChange): void => {
      downloads.push(change);
      syncOptions.onDownloadApplied?.(change);
    };
    // 下载落地后就把「这个 Entry 的本地 base = 刚落地的 Revision」记进 Sync Cache，
    // 同步在之后被打断时，下一次同步把这些文件当成没改过，而不是本机修改或首次连接不一致。
    // 与手动审查一样只接受这些 Entry：其余 Entry、Deletion Record 和 Conflict 仍保留上一次接受的状态。
    let downloadProgress: CachedSyncState | undefined;
    let unsavedDownloads = 0;
    let lastDownloadSave = Date.now();
    const pendingRenames = [...(syncOptions.pathRenames ?? new Map<string, PersistedPathRename>()).entries()];
    const pendingRenamePaths = new Set(pendingRenames.flatMap(([fromPath, rename]) => [fromPath, rename.toPath]));
    const pendingRenameEntryIds = new Set(pendingRenames.map(([, rename]) => rename.entryId));
    const saveDownloadProgress = async (): Promise<void> => {
      if (!downloadProgress || unsavedDownloads === 0) return;
      unsavedDownloads = 0;
      lastDownloadSave = Date.now();
      await this.options.cache.save(structuredClone(downloadProgress));
    };
    // 上一次接受的状态里每个路径的拥有者和每个 Entry 的本地记录；每个 Entry 在一次计划里至多下载一次
    let acceptedOwnersByCanonicalPath: Map<string, string[]> | undefined;
    let acceptedPathsByEntryId: Map<string, string[]> | undefined;
    const recordMaterializedDownload = async (entryId: string, path: string, revision: RevisionRef): Promise<void> => {
      const entry = remote.entries[entryId];
      // 只记落在远端当前路径、且不牵涉改名记录的下载；挪动和改名仍由最后的重建与既有恢复规则处理
      if (entry?.kind !== "live" || entry.path !== path || entry.revision.revisionId !== revision.revisionId ||
        pendingRenameEntryIds.has(entryId) || pendingRenamePaths.has(path)) return;
      if (!acceptedOwnersByCanonicalPath || !acceptedPathsByEntryId) {
        acceptedOwnersByCanonicalPath = new Map();
        acceptedPathsByEntryId = new Map();
        for (const accepted of Object.values(cached?.snapshot.entries ?? {})) {
          if (accepted.kind === "deleted") continue;
          const key = canonicalVaultPath(accepted.path);
          acceptedOwnersByCanonicalPath.set(key, [...(acceptedOwnersByCanonicalPath.get(key) ?? []), accepted.entryId]);
        }
        for (const file of Object.values(cached?.files ?? {})) {
          acceptedPathsByEntryId.set(file.entryId, [...(acceptedPathsByEntryId.get(file.entryId) ?? []), file.path]);
        }
      }
      if ((acceptedOwnersByCanonicalPath.get(canonicalVaultPath(path)) ?? []).some(id => id !== entryId)) return;
      const progress = downloadProgress ??= cached ? structuredClone(cached) : {
        bootstrapPending: true,
        files: {},
        snapshot: {commitId: remote.commitId, entries: {}, protocolVersion: 1, vaultId: remote.vaultId},
        unmaterializedEntryIds: [],
      };
      const owner = progress.files[path];
      if (owner && owner.entryId !== entryId) return;
      // 同一 Entry 在别的路径还有记录时，只有那个路径本次已经挪走或删掉才能改记到新路径
      const elsewhere = (acceptedPathsByEntryId.get(entryId) ?? []).filter(other => other !== path);
      if (elsewhere.some(other => !retiredLocalPaths.has(other))) return;
      const file = await this.verifiedMaterializedFile(path, revision);
      if (!file) return;
      for (const stale of elsewhere) delete progress.files[stale];
      progress.files[path] = {...file, contentHash: revision.contentHash, entryId};
      progress.snapshot.entries[entryId] = entry;
      progress.unmaterializedEntryIds = progress.unmaterializedEntryIds?.filter(id => id !== entryId);
      unsavedDownloads += 1;
      if (Date.now() - lastDownloadSave >= DOWNLOAD_PROGRESS_SAVE_INTERVAL_MS) await saveDownloadProgress();
    };
    try {
      for (const action of plan.localActions) {
        if (action.kind === "delete-local") {
          const remoteEntry = remote.entries[action.entryId];
          if (remoteEntry?.kind === "deleted") {
            await this.assertRecoveryBeforeDelete(
              remoteEntry,
              expectedLocalContentByPath.get(action.path) ?? null,
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
          retiredLocalPaths.add(action.path);
          expectedLocalContentByPath.delete(action.path);
          deleted += 1;
          recordDownload({kind: "deleted", path: action.path});
        } else if (action.kind === "move-local") {
          const expectedContentHash =
            expectedLocalContentByPath.get(action.fromPath) ?? null;
          const expectedTargetHash = expectedLocalContentByPath.get(action.toPath) ?? null;
          if (expectedTargetHash !== null) {
            await this.assertRemoteRecoveryForLocalContent(remote, action.entryId, expectedContentHash,
              acceptedContentHash(reconciliationBase, action.entryId));
            await this.assertLocalContent(action.toPath, expectedTargetHash);
          }
          await this.assertLocalContent(action.fromPath, expectedContentHash);
          await this.options.local.move(
            action.fromPath,
            action.toPath,
            expectedContentHash ?? undefined,
            expectedTargetHash,
          );
          locallyMutatedPaths.add(action.fromPath);
          retiredLocalPaths.add(action.fromPath);
          locallyMutatedPaths.add(action.toPath);
          expectedLocalContentByPath.delete(action.fromPath);
          if (expectedContentHash) {
            expectedLocalContentByPath.set(action.toPath, expectedContentHash);
          }
          recordDownload({kind: "moved", fromPath: action.fromPath, path: action.toPath});
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
            throw new Error(`远端缺少数据块 ${action.revision.blobId}`);
          }
          if (
            plaintext.byteLength !== action.revision.size ||
            (await sha256(plaintext)) !== action.revision.contentHash
          ) {
            throw new Error(`远端数据块 ${action.revision.blobId} 未通过哈希校验`);
          }
          const expectedContentHash =
            expectedLocalContentByPath.get(action.path) ?? null;
          await this.assertRemoteRecoveryForLocalContent(
            remote,
            action.entryId,
            expectedContentHash,
            acceptedContentHash(reconciliationBase, action.entryId),
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
          await recordMaterializedDownload(action.entryId, action.path, action.revision);
          downloaded += 1;
          downloadedBytes += action.revision.size;
          // 写入前本机没有这个文件是新增，否则是更新
          recordDownload({kind: expectedContentHash === null ? "added" : "updated", path: action.path});
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
    } catch (error) {
      // 被打断前先记下已经落地的文件；这次保存失败时仍报告原来的错误
      await saveDownloadProgress().catch(() => undefined);
      throw error;
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
    const uploads: SyncFileChange[] = [];
    if (plan.remoteChanges.length > 0 || sharedConflicts.length > 0) {
      // 上传和发布 Head 也可能被打断，先把已落地的下载记下来
      await saveDownloadProgress();
      const createdAt = versionedHead.serverDate;
      const changedEntries: VaultEntry[] = [];
      const nextEntries = { ...remote.entries };
      // 本次尝试新上传并核实过的数据块；新提交只能引用它们或 Head 已引用的数据块
      const uploadedBlobIds = new Set<string>();
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
            throw new Error(`无法挪动不是当前版本的文件 ${change.entryId}`);
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
          uploadedBlobIds.add(blobId);
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
            throw new Error(`文件 ${conflict.entryId} 应为当前版本`);
          }
          // base 已被过期清理出记录时冲突照样记，只是不带这个旧版本：重新引用它会和数据块删除抢时间
          const retainedBase = retainedInRecord(remote, conflict.entryId, conflict.baseRevision);
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
            ...(retainedBase ? { recovery: keepForRecovery(retainedBase, createdAt) } : {}),
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
        uploadedBlobIds.add(blobId);
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
            throw new Error(`文件 ${conflict.entryId} 应为已删除`);
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
            throw new Error(`文件 ${conflict.entryId} 应为当前版本或已恢复`);
          }
          // base 已被过期清理出记录时不读取它（数据块可能已删），也就不合并：两份都进冲突中心
          const mergeBase =
            baseEntry.kind === "live"
              ? retainedInRecord(remote, conflict.entryId, baseEntry.revision)
              : undefined;
          const baseContent = mergeBase
            ? await this.options.remote.readBlob(mergeBase.blobId)
            : undefined;
          const remoteContent = await this.options.remote.readBlob(
            remoteEntry.revision.blobId,
          );
          if ((mergeBase && !baseContent) || !remoteContent) {
            throw new Error(`${conflict.path} 的冲突历史不完整`);
          }
          if (
            (mergeBase &&
              (!baseContent ||
                baseContent.byteLength !== mergeBase.size ||
                (await sha256(baseContent)) !==
                  mergeBase.contentHash)) ||
            remoteContent.byteLength !== remoteEntry.revision.size ||
            (await sha256(remoteContent)) !== remoteEntry.revision.contentHash
          ) {
            throw new Error(`${conflict.path} 的冲突历史已损坏`);
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
            uploadedBlobIds.add(mergedBlobId);
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
      // 发布前总检查：放在写快照和发布 Head 之前、提交后的本地删除和改写之前
      this.assertCommitReferencesAcceptedOrUploaded(remote, changedEntries, uploadedBlobIds);
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
      this.options.onRemotePublished?.(commitId);
      // Head 发布成功（CAS 通过）后才算上传了
      for (const change of plan.remoteChanges) {
        uploads.push(change.kind === "move-remote" ? {kind: "moved", fromPath: change.fromPath, path: change.toPath}
          : {kind: change.kind === "upload-new" ? "added" : change.kind === "upload-local" ? "modified" : "deleted", path: change.path});
      }
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
        retiredLocalPaths.add(pendingDelete.path);
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
    const nextCache = await this.buildCache(
      remote,
      deferredDownloadEntries.map((entry) => entry.entryId),
      {
        forceHashPaths: locallyMutatedPaths,
        fullHashVerification: false,
        hashHints: new Map(scan.files.map((file) => [file.path, file])),
        pathRenames: syncOptions.pathRenames,
      },
    );
    // 被扣住的消失 Entry 保留上一次接受的本地记录，下一次同步仍是「已知、本地缺失」，
    // 既不会被当成删除发布，也不会被当成远端新文件下载回旧路径
    for (const conflict of plan.conflicts) {
      if (conflict.kind !== "possible-rename") continue;
      for (const held of conflict.deletedEntries) {
        const prior = cachedFilesByEntryId.get(held.entryId);
        const entry = remote.entries[held.entryId];
        if (prior && entry?.kind === "live" && entry.path === prior.path &&
          entry.revision.contentHash === prior.contentHash && !nextCache.files[prior.path]) {
          nextCache.files[prior.path] = prior;
        }
      }
    }
    await this.options.cache.save(nextCache);
    const status: SyncResult["status"] =
      unresolvedConflicts > 0 || scan.unsyncedLocalEntries > 0 || deferredLocalEditPaths.length > 0 ||
      deferredDownloadEntries.some(entry => entry.reason === "unsupported-path")
        ? "action-required" : "complete";
    if (status === "complete" && retiredLocalPaths.size) {
      await this.options.local.cleanupEmptyDirectories?.([...retiredLocalPaths]);
    }
    return {
      bulkDeletion: plan.bulkDeletion,
      cacheUpdated: true,
      deferredDownloadEntries,
      deferredDownloads: deferredEntryIds.size,
      deleted,
      downloaded,
      downloads,
      localIssues,
      status,
      unsyncedLocalEntries: scan.unsyncedLocalEntries,
      uploaded: publishedChanges,
      uploads,
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
    const knownPaths = new Set(Object.values(snapshot.entries).map(entry => entry.path));
    const bootstrapPending = (!current || current.bootstrapPending === true) &&
      scan.localPaths.some(path => !knownPaths.has(path));
    return {
      ...(bootstrapPending ? {bootstrapPending: true} : {}),
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
        !unmaterializedEntryIds.has(entry.entryId)
      ) {
        continue;
      }
      const priorRevision =
        entry.revision.contentHash === cachedFile.contentHash
          ? entry.revision
          : entry.history?.find(
              (revision) => revision.contentHash === cachedFile.contentHash,
            ) ?? {
              // 旧 Revision 已被过期清理出记录（缓存接受了清理后的快照）时，仍以缓存记下的本机内容为 base，
              // 否则本机旧内容会被当成本机修改上传。这个 Revision 不在远端记录里、不对应任何数据块：
              // 只用于比对内容，下载覆盖按已清理的 base 处理，合并时不读取它，也不会写进新提交
              blobId: `purged-local-base:${entry.entryId}`,
              contentHash: cachedFile.contentHash,
              createdAt: entry.revision.createdAt,
              revisionId: `purged-local-base:${entry.entryId}`,
              size: cachedFile.size,
            };
      const priorEntry: LiveEntry = {
        ...entry,
        path: cachedFile.path,
        revision: priorRevision,
      };
      entries[entry.entryId] = priorEntry;
    }
    return { ...cached.snapshot, entries };
  }

  // 读回刚落地的文件：前后两次元数据一致、内容哈希等于该 Revision 才算已落地。
  // 落地后马上被编辑的文件不记，交给最后的重建或下一次同步按本机修改处理。
  private async verifiedMaterializedFile(path: string, revision: RevisionRef): Promise<LocalFileInfo | undefined> {
    const before = await this.options.local.stat(path);
    if (!before || before.size !== revision.size) return undefined;
    const contentHash = this.options.local.hashContent
      ? (await this.options.local.hashContent(path, {yieldToHost: this.options.yieldDuringHashing})).contentHash
      : await sha256(await this.options.local.read(path));
    const after = await this.options.local.stat(path);
    if (!after || after.modifiedAt !== before.modifiedAt || after.size !== before.size ||
      contentHash !== revision.contentHash) return undefined;
    return {modifiedAt: before.modifiedAt, path, size: before.size};
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

  // 发布前总检查：新提交里引用的每个数据块，必须已被本次 CAS 所对的 Head 的快照引用，
  // 或者是本次尝试新上传的。从本机缓存带出来的旧版本可能已被过期清理、数据块正被删除，
  // 有了 Head CAS 的先后顺序，这条规则保证被删除的数据块不会再被引用回来
  private assertCommitReferencesAcceptedOrUploaded(
    head: VaultSnapshot,
    entries: readonly VaultEntry[],
    uploadedBlobIds: ReadonlySet<string>,
  ): void {
    const referenced = new Set(
      Object.values(head.entries).flatMap((entry) => retainedRevisions(entry).map((revision) => revision.blobId)),
    );
    for (const entry of entries) {
      for (const revision of retainedRevisions(entry)) {
        if (!referenced.has(revision.blobId) && !uploadedBlobIds.has(revision.blobId)) {
          throw new Error(`新提交引用了 ${entry.path} 一个不在远端当前记录里的版本，已停止发布。请重新同步。`);
        }
      }
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
        `无法恢复 ${path}：这个路径已被文件 ${occupyingEntry.entryId} 占用`,
      );
    }
  }

  // Recheck only known failures; an ordinary no-op sync verifies existence, not content.
  async verifyRemoteIntegrity(checks: readonly RemoteIntegrityCheck[], vaultId: string): Promise<void> {
    const head = await this.options.remote.readHead();
    if (!head || head.value.vaultId !== vaultId) {
      throw new RemoteStateError("远端 Head 指针缺失，或属于另一个仓库");
    }
    const snapshot = await this.options.remote.readSnapshot(head.value);
    for (const check of checks) {
      if (check.kind === "recovery") {
        const entry = snapshot.entries[check.entryId];
        if (entry?.kind === "conflicted" && entry.materializedContentHash &&
          !entry.candidates.some(candidate => candidate.contentHash === entry.materializedContentHash)) {
          throw new RemoteStateError("冲突没有可核实的候选版本", undefined, check);
        }
        if (entry && retainedRevisions(entry).some(revision => revision.contentHash === check.contentHash &&
          this.exceedsAutomaticFileLimit(entry.path, revision.size))) {
          throw new Error(`完整校验超过了本设备的传输限制：${entry.path}。请连接 Wi-Fi 或在桌面端重试。`);
        }
        // 与同步用同一判据：这份内容是本机已接受的 base，而远端当前记录里已没有同内容的 Revision
        // （已被过期清理），这项恢复要求随之失效。之后的同步仍只在本机内容等于 base 时才覆盖
        await this.assertRemoteRecoveryForLocalContent(snapshot, check.entryId, check.contentHash,
          acceptedContentHash(this.buildReconciliationBase(await this.options.cache.load()), check.entryId));
      } else if (check.kind === "blob") {
        for (const entry of Object.values(snapshot.entries)) {
          for (const revision of retainedRevisions(entry).filter(revision => revision.blobId === check.blobId)) {
            if (this.exceedsAutomaticFileLimit(entry.path, revision.size)) {
              throw new Error(`完整校验超过了本设备的传输限制：${entry.path}。请连接 Wi-Fi 或在桌面端重试。`);
            }
            await this.assertRemoteRevision(revision);
          }
        }
        // A failed uncommitted upload may no longer be referenced; it cannot affect this Head.
      }
    }
  }

  private async reportVerifiedContent(entry: VaultEntry, revision: RevisionRef): Promise<void> {
    await this.options.onIntegrityVerified?.({kind: "blob", blobId: revision.blobId});
    // Authenticating history alone does not repair an invalid materialized Conflict pointer.
    if (entry.kind === "conflicted" && entry.materializedContentHash &&
      !entry.candidates.some(candidate => candidate.contentHash === entry.materializedContentHash)) return;
    await this.options.onIntegrityVerified?.({kind: "recovery", entryId: entry.entryId, contentHash: revision.contentHash});
  }

  // 旧副本只有在被替换的本地内容于远端有可认证的恢复副本时才直接取远端；
  // 核实不了（数据块损坏或校验不过）就退回原有的冲突或审查，网络错误照常抛出
  private async reconcileWithRecoverableStaleCopies(input: ReconcileInput): Promise<SyncPlan> {
    const plan = this.engine.reconcile(input);
    const rejected = new Set<string>();
    for (const staleCopy of plan.staleCopies ?? []) {
      try {
        await this.assertRemoteRecoveryForLocalContent(
          input.remote, staleCopy.entryId, staleCopy.contentHash, staleCopy.acceptedBaseContentHash,
        );
      } catch (error) {
        if (!(error instanceof RemoteStateError)) throw error;
        rejected.add(staleCopy.entryId);
      }
    }
    return rejected.size > 0
      ? this.engine.reconcile({...input, rejectedStaleCopyEntryIds: rejected})
      : plan;
  }

  // acceptedBaseContentHash 是这个 Entry 已接受的本机 base 内容。本机内容等于它、
  // 而远端当前记录里已没有任何同内容的 Revision（旧版本已过期并被清理出记录）时，
  // 不再要求远端恢复副本：被替换的本机旧字节由安全写入挪进本机回收站。
  // 远端记录仍引用同内容的 Revision 时照旧逐个核实，读不到或校验失败仍是完整性错误。
  private async assertRemoteRecoveryForLocalContent(
    snapshot: VaultSnapshot,
    entryId: string,
    expectedContentHash: string | null,
    acceptedBaseContentHash?: string,
  ): Promise<void> {
    if (expectedContentHash === null) {
      return;
    }
    const entry = snapshot.entries[entryId];
    if (!entry) {
      throw new Error(`文件 ${entryId} 的本地内容在远端没有可用的恢复副本`);
    }
    if (acceptedContentPurgedFromRecord(entry, expectedContentHash, acceptedBaseContentHash)) {
      return;
    }
    const revisions = retainedRevisions(entry).filter((revision) => revision.contentHash === expectedContentHash);
    for (const revision of revisions) {
      try {
        await this.assertRemoteRevision(revision);
        await this.options.onIntegrityVerified?.({kind: "recovery", entryId, contentHash: expectedContentHash});
        return;
      } catch (error) {
        if (!(error instanceof RemoteStateError)) {
          throw error;
        }
        // Another retained copy with the same plaintext hash may still be valid.
      }
    }
    throw new RemoteStateError(
      `${entry.path} 的本地内容在远端没有可核实的恢复副本（文件 ${entryId}）`,
      undefined,
      {kind: "recovery", entryId, contentHash: expectedContentHash},
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
        `无法核实远端版本 ${revision.revisionId}`,
        error,
        {kind: "blob", blobId: revision.blobId},
      );
    }
    if (
      !plaintext ||
      plaintext.byteLength !== revision.size ||
      (await sha256(plaintext)) !== revision.contentHash
    ) {
      throw new RemoteStateError(
        `远端版本 ${revision.revisionId} 未通过内容校验`,
        undefined,
        {kind: "blob", blobId: revision.blobId},
      );
    }
    await this.options.onIntegrityVerified?.({kind: "blob", blobId: revision.blobId});
  }

  // localContentHash 是本机要删的内容。删除不满 30 天必须有恢复副本，例外同不变量 9：
  // 本机要删的正是这条删除记录的 lastContentHash，而远端当前记录里已没有同内容的 Revision
  // （delete-edit 冲突的 base 已被清理、用户选了「保留删除」），这时照常删，旧字节进本地回收站。
  // 记录里仍有同内容的 Revision 却没有恢复副本，说明记录本身有问题，照旧报错。
  private async assertRecoveryBeforeDelete(
    deleted: DeletedEntry,
    localContentHash: string | null,
    serverDate: string,
  ): Promise<void> {
    const recoveryRequiredUntil = Date.parse(
      expiresInDays(deleted.deletedAt, 30),
    );
    const serverTime = Date.parse(serverDate);
    if (serverTime < recoveryRequiredUntil) {
      if (!deleted.recovery) {
        if (
          localContentHash !== null &&
          acceptedContentPurgedFromRecord(deleted, localContentHash, deleted.lastContentHash)
        ) {
          return;
        }
        throw new Error(
          `已删除的文件 ${deleted.entryId} 缺少恢复副本`,
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
    for (const rename of applicableRenames(cached, options.pathRenames).values()) {
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
