export interface RevisionRef {
  blobId: string;
  contentHash: string;
  createdAt: string;
  expiresAt?: string;
  revisionId: string;
  size: number;
}

export interface RecoverableRevision extends RevisionRef {
  expiresAt: string;
}

export interface LiveEntry {
  entryId: string;
  history?: RevisionRef[];
  kind: "live";
  path: string;
  revision: RevisionRef;
}

export interface DeletedEntry {
  deletedAt: string;
  entryId: string;
  history?: RevisionRef[];
  kind: "deleted";
  lastContentHash: string;
  lastRevisionId: string;
  path: string;
  recovery?: RecoverableRevision;
}

export interface ConflictedEntry {
  candidates: RevisionRef[];
  deletedAt?: string;
  entryId: string;
  history?: RevisionRef[];
  kind: "conflicted";
  lastContentHash?: string;
  lastRevisionId?: string;
  materializedContentHash?: string;
  path: string;
  reason: "delete-edit" | "edit-delete" | "edit-edit";
  recovery?: RecoverableRevision;
}

export type VaultEntry = ConflictedEntry | DeletedEntry | LiveEntry;

export interface VaultSnapshot {
  commitId: string;
  entries: Record<string, VaultEntry>;
  protocolVersion: 1;
  vaultId: string;
}

export interface ObservedFile {
  contentHash: string;
  entryId?: string;
  path: string;
  size: number;
}

export interface ReplicaObservation {
  basedOnCommitId?: string;
  deferredEntryIds?: string[];
  files: ObservedFile[];
  replicaId: string;
}

export interface DeleteLocalAction {
  entryId: string;
  kind: "delete-local";
  path: string;
}

export interface DownloadRemoteAction {
  entryId: string;
  kind: "download-remote";
  path: string;
  revision: RevisionRef;
}

export interface MoveLocalAction {
  entryId: string;
  fromPath: string;
  kind: "move-local";
  toPath: string;
}

export type LocalAction =
  | DeleteLocalAction
  | DownloadRemoteAction
  | MoveLocalAction;

export interface EditDeleteConflict {
  deletedAt: string;
  entryId: string;
  kind: "edit-delete";
  localFile: ObservedFile;
  path: string;
}

export interface EditEditConflict {
  entryId: string;
  kind: "edit-edit";
  localFile: ObservedFile;
  path: string;
  remoteRevision: RevisionRef;
}

export interface DeleteEditConflict {
  baseContentHash: string;
  baseRevision: RevisionRef;
  baseRevisionId: string;
  entryId: string;
  kind: "delete-edit";
  path: string;
  remoteRevision: RevisionRef;
}

export interface ImportCandidateConflict {
  kind: "import-candidate";
  localFile: ObservedFile;
  path: string;
}

export interface PathCollisionConflict {
  kind: "path-collision";
  paths: string[];
}

export interface BootstrapMismatchConflict {
  kind: "bootstrap-mismatch";
  localFile: ObservedFile;
  path: string;
  remoteRevision: RevisionRef;
}

export interface ResolutionMismatchConflict {
  entryId: string;
  kind: "resolution-mismatch";
  path: string;
}

export interface PossibleRenameConflict {
  deletedEntries: Array<{ entryId: string; path: string }>;
  kind: "possible-rename";
  newFiles: ObservedFile[];
}

export type SyncConflict =
  | BootstrapMismatchConflict
  | DeleteEditConflict
  | EditDeleteConflict
  | EditEditConflict
  | ImportCandidateConflict
  | PathCollisionConflict
  | PossibleRenameConflict
  | ResolutionMismatchConflict;

export interface DeleteRemoteChange {
  entryId: string;
  history?: RevisionRef[];
  kind: "delete-remote";
  lastContentHash: string;
  lastRevisionId: string;
  path: string;
  recoveryRevision: RevisionRef;
}

export interface UploadLocalChange {
  entryId: string;
  file: ObservedFile;
  kind: "upload-local";
  path: string;
  replacesRevisionId: string;
}

export interface UploadNewChange {
  entryId: string;
  file: ObservedFile;
  kind: "upload-new";
  path: string;
}

export interface MoveRemoteChange {
  entryId: string;
  fromPath: string;
  kind: "move-remote";
  toPath: string;
}

export type RemoteChange =
  | DeleteRemoteChange
  | MoveRemoteChange
  | UploadLocalChange
  | UploadNewChange;

export interface SyncPlan {
  bulkDeletion?: {
    count: number;
    totalLiveEntries: number;
  };
  conflicts: SyncConflict[];
  localActions: LocalAction[];
  remoteChanges: RemoteChange[];
}

export interface ReconcileInput {
  base?: VaultSnapshot;
  local: ReplicaObservation;
  remote: VaultSnapshot;
}

export class SyncEngine {
  constructor(private readonly createId: () => string = () => crypto.randomUUID()) {}

  reconcile({ base, local, remote }: ReconcileInput): SyncPlan {
    const pathsByCanonicalForm = new Map<string, string[]>();
    for (const file of local.files) {
      const canonical = file.path.normalize("NFC").toLocaleLowerCase("en-US");
      const paths = pathsByCanonicalForm.get(canonical) ?? [];
      paths.push(file.path);
      pathsByCanonicalForm.set(canonical, paths);
    }
    for (const entry of Object.values(remote.entries)) {
      if (entry.kind !== "live") {
        continue;
      }
      const canonical = entry.path.normalize("NFC").toLocaleLowerCase("en-US");
      const paths = pathsByCanonicalForm.get(canonical) ?? [];
      paths.push(entry.path);
      pathsByCanonicalForm.set(canonical, paths);
    }
    const pathCollisions: PathCollisionConflict[] = [];
    for (const paths of pathsByCanonicalForm.values()) {
      if (new Set(paths).size > 1) {
        pathCollisions.push({ kind: "path-collision", paths });
      }
    }
    if (pathCollisions.length > 0) {
      return {
        conflicts: pathCollisions,
        localActions: [],
        remoteChanges: [],
      };
    }
    const conflicts: SyncConflict[] = [];
    const localActions: LocalAction[] = [];
    const remoteChanges: RemoteChange[] = [];
    const remoteEntries = Object.values(remote.entries);
    const remoteByPath = new Map(
      remoteEntries.map((entry) => [entry.path, entry] as const),
    );
    const localByEntryId = new Map(
      local.files.flatMap((file) =>
        file.entryId ? ([[file.entryId, file]] as const) : [],
      ),
    );
    const localByPath = new Map(
      local.files.map((file) => [file.path, file] as const),
    );
    const deferredEntryIds = new Set(local.deferredEntryIds ?? []);

    for (const file of local.files) {
      const remoteEntry = file.entryId
        ? remote.entries[file.entryId]
        : remoteByPath.get(file.path);
      if (
        remoteEntry?.kind === "deleted" &&
        remoteEntry.lastContentHash === file.contentHash
      ) {
        localActions.push({
          entryId: remoteEntry.entryId,
          kind: "delete-local",
          path: file.path,
        });
      } else if (remoteEntry?.kind === "deleted") {
        conflicts.push({
          deletedAt: remoteEntry.deletedAt,
          entryId: remoteEntry.entryId,
          kind: "edit-delete",
          localFile: file,
          path: remoteEntry.path,
        });
      } else if (remoteEntry?.kind === "live") {
        const baseEntry = base?.entries[remoteEntry.entryId];
        if (
          (!base || (!baseEntry && !file.entryId)) &&
          file.contentHash !== remoteEntry.revision.contentHash
        ) {
          conflicts.push({
            kind: "bootstrap-mismatch",
            localFile: file,
            path: remoteEntry.path,
            remoteRevision: remoteEntry.revision,
          });
        } else if (
          baseEntry?.kind === "live" &&
          file.path === baseEntry.path &&
          remoteEntry.path !== baseEntry.path &&
          file.contentHash === baseEntry.revision.contentHash &&
          remoteEntry.revision.contentHash === baseEntry.revision.contentHash
        ) {
          localActions.push({
            entryId: remoteEntry.entryId,
            fromPath: file.path,
            kind: "move-local",
            toPath: remoteEntry.path,
          });
        } else if (
          baseEntry?.kind === "live" &&
          file.path !== baseEntry.path &&
          remoteEntry.path === baseEntry.path &&
          file.contentHash === baseEntry.revision.contentHash &&
          remoteEntry.revision.contentHash === baseEntry.revision.contentHash
        ) {
          remoteChanges.push({
            entryId: remoteEntry.entryId,
            fromPath: baseEntry.path,
            kind: "move-remote",
            toPath: file.path,
          });
        } else if (
          baseEntry?.kind === "live" &&
          file.contentHash !== baseEntry.revision.contentHash &&
          remoteEntry.revision.contentHash !== baseEntry.revision.contentHash &&
          file.contentHash !== remoteEntry.revision.contentHash
        ) {
          conflicts.push({
            entryId: remoteEntry.entryId,
            kind: "edit-edit",
            localFile: file,
            path: remoteEntry.path,
            remoteRevision: remoteEntry.revision,
          });
        } else if (
          baseEntry?.kind === "live" &&
          file.contentHash !== baseEntry.revision.contentHash &&
          remoteEntry.revision.contentHash === baseEntry.revision.contentHash
        ) {
          remoteChanges.push({
            entryId: remoteEntry.entryId,
            file,
            kind: "upload-local",
            path: remoteEntry.path,
            replacesRevisionId: remoteEntry.revision.revisionId,
          });
        } else if (
          baseEntry?.kind === "live" &&
          file.contentHash === baseEntry.revision.contentHash &&
          remoteEntry.revision.contentHash !== baseEntry.revision.contentHash
        ) {
          if (file.path !== remoteEntry.path) {
            localActions.push({
              entryId: remoteEntry.entryId,
              fromPath: file.path,
              kind: "move-local",
              toPath: remoteEntry.path,
            });
          }
          localActions.push({
            entryId: remoteEntry.entryId,
            kind: "download-remote",
            path: remoteEntry.path,
            revision: remoteEntry.revision,
          });
        }
      }
    }

    for (const remoteEntry of remoteEntries) {
      const baseEntry = base?.entries[remoteEntry.entryId];
      if (
        baseEntry?.kind !== "deleted" &&
        baseEntry?.kind !== "conflicted"
      ) {
        continue;
      }
      const localFile =
        localByEntryId.get(remoteEntry.entryId) ?? localByPath.get(baseEntry.path);
      const isDeferred = deferredEntryIds.has(remoteEntry.entryId);
      if (baseEntry.kind === "conflicted") {
        const localMatchesMaterializedState = baseEntry.materializedContentHash
          ? localFile?.contentHash === baseEntry.materializedContentHash
          : localFile === undefined;
        if (!localMatchesMaterializedState) {
          conflicts.push({
            entryId: remoteEntry.entryId,
            kind: "resolution-mismatch",
            path: baseEntry.path,
          });
          continue;
        }
      }
      if (remoteEntry.kind === "live" && !isDeferred) {
        if (
          !localFile ||
          localFile.path !== remoteEntry.path ||
          localFile.contentHash !== remoteEntry.revision.contentHash
        ) {
          localActions.push({
            entryId: remoteEntry.entryId,
            kind: "download-remote",
            path: remoteEntry.path,
            revision: remoteEntry.revision,
          });
        }
      } else if (
        remoteEntry.kind === "deleted" &&
        baseEntry.kind === "conflicted" &&
        localFile
      ) {
        localActions.push({
          entryId: remoteEntry.entryId,
          kind: "delete-local",
          path: localFile.path,
        });
      }
    }

    for (const baseEntry of Object.values(base?.entries ?? {})) {
      if (baseEntry.kind !== "live") {
        continue;
      }
      const isPresent = localByEntryId.has(baseEntry.entryId);
      const isDeferred = deferredEntryIds.has(baseEntry.entryId);
      const remoteEntry = remote.entries[baseEntry.entryId];
      if (
        !isPresent &&
        !isDeferred &&
        remoteEntry?.kind === "live" &&
        remoteEntry.revision.revisionId === baseEntry.revision.revisionId
      ) {
        remoteChanges.push({
          entryId: baseEntry.entryId,
          ...(baseEntry.history ? { history: baseEntry.history } : {}),
          kind: "delete-remote",
          lastContentHash: baseEntry.revision.contentHash,
          lastRevisionId: baseEntry.revision.revisionId,
          path: baseEntry.path,
          recoveryRevision: baseEntry.revision,
        });
      } else if (
        !isPresent &&
        !isDeferred &&
        remoteEntry?.kind === "live" &&
        remoteEntry.revision.revisionId !== baseEntry.revision.revisionId
      ) {
        conflicts.push({
          baseContentHash: baseEntry.revision.contentHash,
          baseRevision: baseEntry.revision,
          baseRevisionId: baseEntry.revision.revisionId,
          entryId: baseEntry.entryId,
          kind: "delete-edit",
          path: baseEntry.path,
          remoteRevision: remoteEntry.revision,
        });
      }
    }

    for (const remoteEntry of remoteEntries) {
      if (
        remoteEntry.kind !== "live" ||
        (base && base.entries[remoteEntry.entryId] !== undefined)
      ) {
        continue;
      }
      const isPresent =
        localByEntryId.has(remoteEntry.entryId) ||
        localByPath.has(remoteEntry.path);
      const isDeferred = deferredEntryIds.has(remoteEntry.entryId);
      if (!isPresent && !isDeferred) {
        localActions.push({
          entryId: remoteEntry.entryId,
          kind: "download-remote",
          path: remoteEntry.path,
          revision: remoteEntry.revision,
        });
      }
    }

    for (const file of local.files) {
      if (file.entryId) {
        continue;
      }
      const knownPath = remoteByPath.has(file.path);
      if (!knownPath) {
        if (base) {
          remoteChanges.push({
            entryId: this.createId(),
            file,
            kind: "upload-new",
            path: file.path,
          });
        } else {
          conflicts.push({
            kind: "import-candidate",
            localFile: file,
            path: file.path,
          });
        }
      }
    }

    const possibleRenameDeletions = remoteChanges.filter(
      (change) => change.kind === "delete-remote",
    );
    const possibleRenameCreations = remoteChanges.filter(
      (change) => change.kind === "upload-new",
    );
    if (
      possibleRenameDeletions.length > 0 &&
      possibleRenameCreations.length > 0
    ) {
      conflicts.push({
        deletedEntries: possibleRenameDeletions.map((change) => ({
          entryId: change.entryId,
          path: change.path,
        })),
        kind: "possible-rename",
        newFiles: possibleRenameCreations.map((change) => change.file),
      });
      for (let index = remoteChanges.length - 1; index >= 0; index -= 1) {
        const change = remoteChanges[index];
        if (
          change?.kind === "delete-remote" ||
          change?.kind === "upload-new"
        ) {
          remoteChanges.splice(index, 1);
        }
      }
    }

    const totalLiveEntries = Object.values(base?.entries ?? {}).filter(
      (entry) => entry.kind === "live",
    ).length;
    const deletionCount = remoteChanges.filter(
      (change) => change.kind === "delete-remote",
    ).length;
    const isBulkDeletion =
      deletionCount > 100 ||
      (totalLiveEntries > 0 && deletionCount / totalLiveEntries > 0.2);

    return {
      bulkDeletion: isBulkDeletion
        ? { count: deletionCount, totalLiveEntries }
        : undefined,
      conflicts,
      localActions,
      remoteChanges,
    };
  }
}
