import { RcloneCompat } from "../crypto/rclone-compat";
import {
  ObjectPreconditionError,
  type ObjectStore,
} from "./object-store";
import type { VaultEntry, VaultSnapshot } from "../sync/sync-engine";

export interface SetEntryChange {
  entry: VaultEntry;
  kind: "set-entry";
}

export type CommitChange = SetEntryChange;

export interface CommitRecord {
  changes: CommitChange[];
  commitId: string;
  createdAt: string;
  parentIds: string[];
  protocolVersion: 1;
  replicaId: string;
  vaultId: string;
}

export interface HeadRecord {
  commitId: string;
  generation: number;
  protocolVersion: 1;
  snapshotId?: string;
  vaultId: string;
}

export interface VersionedHead {
  etag: string;
  lastModified: string;
  serverDate: string;
  value: HeadRecord;
}

export interface RemoteStoreOptions {
  objects: ObjectStore;
  prefix: string;
  vaultKey: Uint8Array;
}

export interface InitializeInput {
  commit: CommitRecord;
  head: HeadRecord;
}

export interface AdvanceInput extends InitializeInput {
  expectedHeadEtag: string;
}

export class HeadChangedError extends Error {
  readonly code = "HEAD_CHANGED" as const;

  constructor() {
    super("发布同步提交期间 Head 指针被改了");
    this.name = "HeadChangedError";
  }
}

export type RemoteIntegrityCheck =
  | { kind: "metadata" }
  | { kind: "blob"; blobId: string }
  | { kind: "recovery"; entryId: string; contentHash: string };

export class RemoteStateError extends Error {
  readonly code = "REMOTE_STATE_INVALID" as const;

  constructor(message: string, readonly cause?: unknown,
    readonly integrityCheck: RemoteIntegrityCheck = {kind: "metadata"}) {
    super(message);
    this.name = "RemoteStateError";
  }
}

const normalizePrefix = (prefix: string): string =>
  prefix.replace(/^\/+|\/+$/gu, "");

// 数据块名一律是小写 UUID（crypto.randomUUID 生成），整串匹配，后面不能再有 /
const BLOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface RemoteBlobObject {
  blobId: string;
  key: string;
  lastModified: string;
  size: number;
}

/**
 * 当前记录引用的数据块（blobId → 引用它的路径）。读 Head 时的存在性检查和
 * 数据块删除用的是这同一套：当前 Revision、冲突候选、Recovery Copy、Version History。
 */
export const snapshotBlobReferences = (
  snapshot: VaultSnapshot,
): Map<string, Set<string>> => {
  const pathsByBlobId = new Map<string, Set<string>>();
  const addReference = (blobId: string, path: string): void => {
    const paths = pathsByBlobId.get(blobId) ?? new Set<string>();
    paths.add(path);
    pathsByBlobId.set(blobId, paths);
  };
  for (const entry of Object.values(snapshot.entries)) {
    if (entry.kind === "live") {
      addReference(entry.revision.blobId, entry.path);
    } else if (entry.kind === "conflicted") {
      for (const candidate of entry.candidates) {
        addReference(candidate.blobId, entry.path);
      }
      if (entry.recovery) {
        addReference(entry.recovery.blobId, entry.path);
      }
    } else if (entry.recovery) {
      addReference(entry.recovery.blobId, entry.path);
    }
    for (const revision of entry.history ?? []) {
      addReference(revision.blobId, entry.path);
    }
  }
  return pathsByBlobId;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOptionalString = (
  record: Record<string, unknown>,
  key: string,
): boolean => record[key] === undefined || typeof record[key] === "string";

const isRevision = (value: unknown, requireExpiry = false): boolean => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.blobId === "string" &&
    typeof value.contentHash === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.revisionId === "string" &&
    typeof value.size === "number" &&
    Number.isFinite(value.size) &&
    value.size >= 0 &&
    (requireExpiry
      ? typeof value.expiresAt === "string"
      : isOptionalString(value, "expiresAt"))
  );
};

const isVaultEntry = (value: unknown): value is VaultEntry => {
  if (
    !isRecord(value) ||
    typeof value.entryId !== "string" ||
    typeof value.path !== "string" ||
    (value.history !== undefined &&
      (!Array.isArray(value.history) ||
        !value.history.every((revision) => isRevision(revision))))
  ) {
    return false;
  }
  if (value.kind === "live") {
    return isRevision(value.revision);
  }
  if (value.kind === "deleted") {
    return (
      typeof value.deletedAt === "string" &&
      typeof value.lastContentHash === "string" &&
      typeof value.lastRevisionId === "string" &&
      (value.recovery === undefined || isRevision(value.recovery, true))
    );
  }
  if (value.kind === "conflicted") {
    return (
      Array.isArray(value.candidates) &&
      value.candidates.every((revision) => isRevision(revision)) &&
      (value.reason === "delete-edit" ||
        value.reason === "edit-delete" ||
        value.reason === "edit-edit") &&
      isOptionalString(value, "deletedAt") &&
      isOptionalString(value, "lastContentHash") &&
      isOptionalString(value, "lastRevisionId") &&
      isOptionalString(value, "materializedContentHash") &&
      (value.recovery === undefined || isRevision(value.recovery, true))
    );
  }
  return false;
};

const assertHeadRecord = (value: unknown): HeadRecord => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("protocolVersion" in value) ||
    value.protocolVersion !== 1 ||
    !("vaultId" in value) ||
    typeof value.vaultId !== "string" ||
    !("commitId" in value) ||
    typeof value.commitId !== "string" ||
    !("generation" in value) ||
    typeof value.generation !== "number" ||
    ("snapshotId" in value && typeof value.snapshotId !== "string")
  ) {
    throw new Error("Head 指针内容无效");
  }
  return value as HeadRecord;
};

const assertVaultSnapshot = (value: unknown): VaultSnapshot => {
  if (!isRecord(value)) {
    throw new Error("快照内容无效");
  }
  if (
    value.protocolVersion !== 1 ||
    typeof value.vaultId !== "string" ||
    typeof value.commitId !== "string" ||
    !isRecord(value.entries) ||
    !Object.entries(value.entries).every(
      ([entryId, entry]) => isVaultEntry(entry) && entry.entryId === entryId,
    )
  ) {
    throw new Error("快照内容无效");
  }
  return value as unknown as VaultSnapshot;
};

const assertCommitRecord = (value: unknown): CommitRecord => {
  if (
    !isRecord(value) ||
    value.protocolVersion !== 1 ||
    typeof value.vaultId !== "string" ||
    typeof value.commitId !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.replicaId !== "string" ||
    !Array.isArray(value.parentIds) ||
    !value.parentIds.every((parentId) => typeof parentId === "string") ||
    !Array.isArray(value.changes) ||
    !value.changes.every(
      (change) =>
        isRecord(change) &&
        change.kind === "set-entry" &&
        isVaultEntry(change.entry),
    )
  ) {
    throw new Error("同步提交内容无效");
  }
  return value as unknown as CommitRecord;
};

export class RemoteStore {
  private readonly headKey: string;

  private constructor(
    private readonly objects: ObjectStore,
    private readonly prefix: string,
    private readonly cipher: RcloneCompat,
  ) {
    this.headKey = this.key("head");
  }

  static async open(options: RemoteStoreOptions): Promise<RemoteStore> {
    return new RemoteStore(
      options.objects,
      normalizePrefix(options.prefix),
      await RcloneCompat.fromVaultKey(options.vaultKey),
    );
  }

  async advance(input: AdvanceInput): Promise<void> {
    this.assertMatchingCommitAndHead(input);
    await this.writeImmutableCommit(input.commit);
    try {
      await this.objects.put(
        this.headKey,
        await this.encryptJson(input.head),
        { ifMatch: input.expectedHeadEtag },
      );
    } catch (error) {
      if (error instanceof ObjectPreconditionError) {
        throw new HeadChangedError();
      }
      throw error;
    }
  }

  async initialize(input: InitializeInput, beforeHeadPublication?: () => Promise<void>): Promise<void> {
    this.assertMatchingCommitAndHead(input);
    await this.writeImmutableCommit(input.commit);
    const encryptedHead = await this.encryptJson(input.head);
    await beforeHeadPublication?.();
    try {
      await this.objects.put(
        this.headKey,
        encryptedHead,
        { ifNoneMatch: true },
      );
    } catch (error) {
      if (error instanceof ObjectPreconditionError) {
        throw new HeadChangedError();
      }
      throw error;
    }
  }

  async readHead(): Promise<VersionedHead | undefined> {
    const stored = await this.objects.get(this.headKey, {
      revalidate: true,
    });
    if (!stored) {
      return undefined;
    }
    try {
      return {
        etag: stored.etag,
        lastModified: stored.lastModified,
        serverDate: stored.serverDate ?? stored.lastModified,
        value: assertHeadRecord(await this.decryptJson(stored.body)),
      };
    } catch (error) {
      throw new RemoteStateError("无法核实 Head 指针", error);
    }
  }

  async readSnapshot(head: HeadRecord): Promise<VaultSnapshot> {
    const commits: CommitRecord[] = [];
    const visited = new Set<string>();
    let baseSnapshot: VaultSnapshot | undefined;
    if (head.snapshotId) {
      const stored = await this.objects.get(
        this.key(`snapshots/${head.snapshotId}`),
      );
      if (!stored) {
        throw new RemoteStateError(
          `Head 指针引用的快照 ${head.snapshotId} 不存在`,
        );
      }
      baseSnapshot = await this.decryptSnapshot(
        head.snapshotId,
        stored.body,
      );
      if (baseSnapshot.vaultId !== head.vaultId) {
        throw new RemoteStateError("快照属于另一个仓库");
      }
    }
    let commitId: string | undefined = head.commitId;
    while (commitId && commitId !== baseSnapshot?.commitId) {
      if (visited.has(commitId)) {
        throw new RemoteStateError("同步提交历史里有循环");
      }
      visited.add(commitId);
      const commit = await this.readCommit(commitId);
      if (!commit) {
        throw new RemoteStateError(
          `Head 指针引用的同步提交 ${commitId} 不存在`,
        );
      }
      if (commit.vaultId !== head.vaultId) {
        throw new RemoteStateError("同步提交属于另一个仓库");
      }
      commits.unshift(commit);
      commitId = commit.parentIds[0];
    }

    if (baseSnapshot && commitId !== baseSnapshot.commitId) {
      throw new RemoteStateError("快照不是 Head 指针的祖先");
    }
    const entries: Record<string, VaultEntry> = {
      ...(baseSnapshot?.entries ?? {}),
    };
    for (const commit of commits) {
      for (const change of commit.changes) {
        if (change.kind === "set-entry") {
          entries[change.entry.entryId] = change.entry;
        }
      }
    }
    const snapshot = {
      commitId: head.commitId,
      entries,
      protocolVersion: 1,
      vaultId: head.vaultId,
    } satisfies VaultSnapshot;
    await this.assertSnapshotBlobReferences(snapshot);
    return snapshot;
  }

  async readBlob(blobId: string): Promise<Uint8Array | undefined> {
    const stored = await this.objects.get(this.key(`blobs/${blobId}`));
    if (!stored) {
      return undefined;
    }
    try {
      return await this.cipher.decryptData(stored.body);
    } catch (error) {
      throw new RemoteStateError(
        `无法核实远端数据块 ${blobId}`,
        error,
        {kind: "blob", blobId},
      );
    }
  }

  async readCommit(commitId: string): Promise<CommitRecord | undefined> {
    const stored = await this.objects.get(this.key(`commits/${commitId}`));
    if (!stored) {
      return undefined;
    }
    let value: unknown;
    try {
      value = await this.decryptJson(stored.body);
    } catch (error) {
      throw new RemoteStateError(
        `无法核实或解码同步提交 ${commitId}`,
        error,
      );
    }
    try {
      return assertCommitRecord(value);
    } catch (error) {
      throw new RemoteStateError(
        `同步提交 ${commitId} 的内容无效`,
        error,
      );
    }
  }

  /**
   * 列出 `<前缀>/v1/blobs/` 下的全部对象。路径只用 key("blobs/") 拼；每个对象名都必须整串是
   * `<前缀>/v1/blobs/<UUID>`，有一个对不上（Head、提交、快照、Key Envelope、别的前缀、子路径、
   * 非 UUID、重复）就整批作废并报错，调用方这次一个也不删。规范化后前缀为空时拒绝。
   */
  async listBlobObjects(): Promise<RemoteBlobObject[]> {
    const blobPrefix = this.blobScope();
    const listed = await this.objects.listObjects(blobPrefix);
    const seen = new Set<string>();
    const unexpected: string[] = [];
    const objects: RemoteBlobObject[] = [];
    for (const object of listed) {
      const blobId = object.key.startsWith(blobPrefix) ? object.key.slice(blobPrefix.length) : "";
      if (!BLOB_ID_PATTERN.test(blobId) || seen.has(object.key)) {
        unexpected.push(object.key);
        continue;
      }
      seen.add(object.key);
      objects.push({ blobId, key: object.key, lastModified: object.lastModified, size: object.size });
    }
    if (unexpected.length > 0) {
      throw new Error(
        `数据块目录 ${blobPrefix} 的列表里有 ${unexpected.length} 个对象名不符合预期（例如 ${unexpected[0]}），这次不删除任何数据块。`,
      );
    }
    return objects;
  }

  // 删除一个数据块：只接受 UUID，路径只用 key("blobs/") 拼；DELETE 不带 versionId
  async deleteBlob(blobId: string): Promise<void> {
    const blobPrefix = this.blobScope();
    if (!BLOB_ID_PATTERN.test(blobId)) {
      throw new Error("要删除的数据块名字不是 UUID，已停止删除。");
    }
    await this.objects.delete(`${blobPrefix}${blobId}`);
  }

  async writeBlob(blobId: string, plaintext: Uint8Array): Promise<void> {
    await this.objects.put(
      this.key(`blobs/${blobId}`),
      await this.cipher.encryptData(plaintext),
      { ifNoneMatch: true },
    );
  }

  async writeSnapshot(snapshotId: string, snapshot: VaultSnapshot): Promise<void> {
    await this.objects.put(
      this.key(`snapshots/${snapshotId}`),
      await this.encryptJson(snapshot),
      { ifNoneMatch: true },
    );
  }

  private assertMatchingCommitAndHead(input: InitializeInput): void {
    if (
      input.commit.commitId !== input.head.commitId ||
      input.commit.vaultId !== input.head.vaultId
    ) {
      throw new Error("同步提交和 Head 指针描述的状态不一致");
    }
  }

  private async assertSnapshotBlobReferences(
    snapshot: VaultSnapshot,
  ): Promise<void> {
    const blobPrefix = this.key("blobs/");
    const available = new Set(await this.objects.list(blobPrefix));
    const pathsByBlobId = snapshotBlobReferences(snapshot);
    const missing = [...pathsByBlobId.keys()].filter(
      (blobId) => !available.has(`${blobPrefix}${blobId}`),
    );
    if (missing.length > 0) {
      const affectedPaths = new Set(
        missing.flatMap((blobId) => [...(pathsByBlobId.get(blobId) ?? [])]),
      );
      throw new RemoteStateError(
        `仓库快照引用的数据块缺失，涉及路径：${[...affectedPaths].sort().join("、")}`,
      );
    }
  }

  private async decryptJson(ciphertext: Uint8Array): Promise<unknown> {
    const plaintext = await this.cipher.decryptData(ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  }

  private async decryptSnapshot(
    snapshotId: string,
    ciphertext: Uint8Array,
  ): Promise<VaultSnapshot> {
    let value: unknown;
    try {
      value = await this.decryptJson(ciphertext);
    } catch (error) {
      throw new RemoteStateError(
        `无法核实或解码快照 ${snapshotId}`,
        error,
      );
    }
    try {
      return assertVaultSnapshot(value);
    } catch (error) {
      throw new RemoteStateError(
        `快照 ${snapshotId} 的内容无效`,
        error,
      );
    }
  }

  private async encryptJson(value: unknown): Promise<Uint8Array> {
    return this.cipher.encryptData(
      new TextEncoder().encode(JSON.stringify(value)),
    );
  }

  private key(suffix: string): string {
    return `${this.prefix}/v1/${suffix}`;
  }

  // 数据块删除的范围；前缀为空（比如设置里填了 /）时拒绝，免得范围落到桶的根上
  private blobScope(): string {
    if (this.prefix === "") {
      throw new Error("同步前缀为空，不清理数据块。");
    }
    return this.key("blobs/");
  }

  private writeImmutableCommit(commit: CommitRecord): Promise<unknown> {
    return this.encryptJson(commit).then((body) =>
      this.objects.put(this.key(`commits/${commit.commitId}`), body, {
        ifNoneMatch: true,
      }),
    );
  }
}
