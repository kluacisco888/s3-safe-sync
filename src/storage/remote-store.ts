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
    super("Head changed while the Sync Commit was being published");
    this.name = "HeadChangedError";
  }
}

export class RemoteStateError extends Error {
  readonly code = "REMOTE_STATE_INVALID" as const;

  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "RemoteStateError";
  }
}

const normalizePrefix = (prefix: string): string =>
  prefix.replace(/^\/+|\/+$/gu, "");

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
    throw new Error("Head payload is invalid");
  }
  return value as HeadRecord;
};

const assertVaultSnapshot = (value: unknown): VaultSnapshot => {
  if (!isRecord(value)) {
    throw new Error("Snapshot payload is invalid");
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
    throw new Error("Snapshot payload is invalid");
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
    throw new Error("Sync Commit payload is invalid");
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

  async initialize(input: InitializeInput): Promise<void> {
    this.assertMatchingCommitAndHead(input);
    await this.writeImmutableCommit(input.commit);
    try {
      await this.objects.put(
        this.headKey,
        await this.encryptJson(input.head),
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
      throw new RemoteStateError("Head cannot be authenticated", error);
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
          `Head references missing Snapshot ${head.snapshotId}`,
        );
      }
      baseSnapshot = await this.decryptSnapshot(
        head.snapshotId,
        stored.body,
      );
      if (baseSnapshot.vaultId !== head.vaultId) {
        throw new RemoteStateError("Snapshot belongs to a different Vault");
      }
    }
    let commitId: string | undefined = head.commitId;
    while (commitId && commitId !== baseSnapshot?.commitId) {
      if (visited.has(commitId)) {
        throw new RemoteStateError("Sync Commit history contains a cycle");
      }
      visited.add(commitId);
      const commit = await this.readCommit(commitId);
      if (!commit) {
        throw new RemoteStateError(
          `Head references missing Sync Commit ${commitId}`,
        );
      }
      if (commit.vaultId !== head.vaultId) {
        throw new RemoteStateError("Sync Commit belongs to a different Vault");
      }
      commits.unshift(commit);
      commitId = commit.parentIds[0];
    }

    if (baseSnapshot && commitId !== baseSnapshot.commitId) {
      throw new RemoteStateError("Snapshot is not an ancestor of Head");
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
        `Remote Blob ${blobId} cannot be authenticated`,
        error,
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
        `Sync Commit ${commitId} cannot be authenticated or decoded`,
        error,
      );
    }
    try {
      return assertCommitRecord(value);
    } catch (error) {
      throw new RemoteStateError(
        `Sync Commit ${commitId} payload is invalid`,
        error,
      );
    }
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
      throw new Error("Sync Commit and Head do not describe the same state");
    }
  }

  private async assertSnapshotBlobReferences(
    snapshot: VaultSnapshot,
  ): Promise<void> {
    const blobPrefix = this.key("blobs/");
    const available = new Set(await this.objects.list(blobPrefix));
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
    const missing = [...pathsByBlobId.keys()].filter(
      (blobId) => !available.has(`${blobPrefix}${blobId}`),
    );
    if (missing.length > 0) {
      const affectedPaths = new Set(
        missing.flatMap((blobId) => [...(pathsByBlobId.get(blobId) ?? [])]),
      );
      throw new RemoteStateError(
        `Vault Snapshot references missing blobs for paths: ${[...affectedPaths].sort().join(", ")}`,
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
        `Snapshot ${snapshotId} cannot be authenticated or decoded`,
        error,
      );
    }
    try {
      return assertVaultSnapshot(value);
    } catch (error) {
      throw new RemoteStateError(
        `Snapshot ${snapshotId} payload is invalid`,
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

  private writeImmutableCommit(commit: CommitRecord): Promise<unknown> {
    return this.encryptJson(commit).then((body) =>
      this.objects.put(this.key(`commits/${commit.commitId}`), body, {
        ifNoneMatch: true,
      }),
    );
  }
}
