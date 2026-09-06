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
  if (typeof value !== "object" || value === null) {
    throw new Error("Snapshot payload is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    record.protocolVersion !== 1 ||
    typeof record.vaultId !== "string" ||
    typeof record.commitId !== "string" ||
    typeof record.entries !== "object" ||
    record.entries === null
  ) {
    throw new Error("Snapshot payload is invalid");
  }
  return value as VaultSnapshot;
};

const assertCommitRecord = (value: unknown): CommitRecord => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("protocolVersion" in value) ||
    value.protocolVersion !== 1 ||
    !("vaultId" in value) ||
    typeof value.vaultId !== "string" ||
    !("commitId" in value) ||
    typeof value.commitId !== "string" ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "string" ||
    !("replicaId" in value) ||
    typeof value.replicaId !== "string" ||
    !("parentIds" in value) ||
    !Array.isArray(value.parentIds) ||
    !value.parentIds.every((parentId) => typeof parentId === "string") ||
    !("changes" in value) ||
    !Array.isArray(value.changes)
  ) {
    throw new Error("Sync Commit payload is invalid");
  }
  return value as CommitRecord;
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
    const stored = await this.objects.get(this.headKey);
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
      baseSnapshot = assertVaultSnapshot(await this.decryptJson(stored.body));
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
    return this.cipher.decryptData(stored.body);
  }

  async readCommit(commitId: string): Promise<CommitRecord | undefined> {
    const stored = await this.objects.get(this.key(`commits/${commitId}`));
    if (!stored) {
      return undefined;
    }
    return assertCommitRecord(await this.decryptJson(stored.body));
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
    const referencedBlobIds = new Set<string>();
    for (const entry of Object.values(snapshot.entries)) {
      if (entry.kind === "live") {
        referencedBlobIds.add(entry.revision.blobId);
      } else if (entry.kind === "conflicted") {
        for (const candidate of entry.candidates) {
          referencedBlobIds.add(candidate.blobId);
        }
        if (entry.recovery) {
          referencedBlobIds.add(entry.recovery.blobId);
        }
      } else if (entry.recovery) {
        referencedBlobIds.add(entry.recovery.blobId);
      }
      for (const revision of entry.history ?? []) {
        referencedBlobIds.add(revision.blobId);
      }
    }
    const missing = [...referencedBlobIds].filter(
      (blobId) => !available.has(`${blobPrefix}${blobId}`),
    );
    if (missing.length > 0) {
      throw new RemoteStateError(
        `Vault Snapshot references missing blobs: ${missing.sort().join(", ")}`,
      );
    }
  }

  private async decryptJson(ciphertext: Uint8Array): Promise<unknown> {
    const plaintext = await this.cipher.decryptData(ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
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
