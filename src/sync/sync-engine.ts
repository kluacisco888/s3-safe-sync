import { canonicalVaultPath } from "./canonical-path";

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
  unmaterializedEntryIds?: string[];
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
  bulkDeletion?: BulkDeletionPlan;
  conflicts: SyncConflict[];
  localActions: LocalAction[];
  remoteChanges: RemoteChange[];
}

export interface BulkDeletionPlan {
  count: number;
  entryIds: string[];
  totalLiveEntries: number;
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
    const localFilesByCanonicalPath = new Map<string, ObservedFile[]>();
    const boundLocalEntryIds = new Set<string>();
    for (const file of local.files) {
      const canonical = canonicalVaultPath(file.path);
      const paths = pathsByCanonicalForm.get(canonical) ?? [];
      paths.push(file.path);
      pathsByCanonicalForm.set(canonical, paths);
      const files = localFilesByCanonicalPath.get(canonical) ?? [];
      files.push(file);
      localFilesByCanonicalPath.set(canonical, files);
      if (file.entryId !== undefined) {
        boundLocalEntryIds.add(file.entryId);
      }
    }
    for (const entry of Object.values(remote.entries)) {
      if (entry.kind !== "live") {
        continue;
      }
      const canonical = canonicalVaultPath(entry.path);
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
    const liveRemoteEntries = Object.values(remote.entries).filter(
      (entry): entry is LiveEntry => entry.kind === "live",
    );
    const remoteEntriesByCanonicalPath = new Map<string, LiveEntry[]>();
    for (const entry of liveRemoteEntries) {
      const canonical = canonicalVaultPath(entry.path);
      const owners = remoteEntriesByCanonicalPath.get(canonical) ?? [];
      owners.push(entry);
      remoteEntriesByCanonicalPath.set(canonical, owners);
    }
    for (const [canonical, owners] of remoteEntriesByCanonicalPath) {
      if (owners.length > 1) {
        pathCollisions.push({
          kind: "path-collision",
          paths: owners.map((entry) => entry.path),
        });
        continue;
      }
      const remoteEntry = owners[0];
      if (!remoteEntry) {
        continue;
      }
      const baseEntry = base?.entries[remoteEntry.entryId];
      const hasBoundLocalClaimant = boundLocalEntryIds.has(remoteEntry.entryId);
      for (const file of localFilesByCanonicalPath.get(canonical) ?? []) {
        const belongsToRemoteEntry = file.entryId === remoteEntry.entryId;
        const occupiesItsPreviousPath =
          file.entryId === undefined &&
          !hasBoundLocalClaimant &&
          baseEntry !== undefined &&
          canonicalVaultPath(baseEntry.path) === canonical;
        const cachelessSamePath = file.entryId === undefined && !baseEntry;
        if (
          !belongsToRemoteEntry &&
          !occupiesItsPreviousPath &&
          !cachelessSamePath
        ) {
          pathCollisions.push({
            kind: "path-collision",
            paths: [...new Set([file.path, remoteEntry.path])],
          });
        }
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
    const unmaterializedEntryIds = new Set(
      local.unmaterializedEntryIds ?? [],
    );

    for (const file of local.files) {
      const remoteEntry = file.entryId
        ? remote.entries[file.entryId]
        : remoteByPath.get(file.path);
      const baseEntry = remoteEntry
        ? base?.entries[remoteEntry.entryId]
        : undefined;
      if (
        remoteEntry?.kind === "live" &&
        (!base ||
          (!baseEntry && !file.entryId) ||
          (unmaterializedEntryIds.has(remoteEntry.entryId) && !file.entryId)) &&
        file.contentHash !== remoteEntry.revision.contentHash
      ) {
        conflicts.push({
          kind: "bootstrap-mismatch",
          localFile: file,
          path: remoteEntry.path,
          remoteRevision: remoteEntry.revision,
        });
        continue;
      }
      if (
        remoteEntry?.kind === "live" &&
        deferredEntryIds.has(remoteEntry.entryId)
      ) {
        continue;
      }
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
        if (
          baseEntry?.kind === "live" &&
          file.path !== baseEntry.path &&
          remoteEntry.path !== baseEntry.path &&
          file.path !== remoteEntry.path &&
          !(
            file.contentHash !== baseEntry.revision.contentHash &&
            remoteEntry.revision.contentHash !==
              baseEntry.revision.contentHash &&
            file.contentHash !== remoteEntry.revision.contentHash
          )
        ) {
          conflicts.push({
            kind: "path-collision",
            paths: [file.path, remoteEntry.path],
          });
          continue;
        }
        if (
          baseEntry?.kind === "live" &&
          file.path === baseEntry.path &&
          remoteEntry.path !== baseEntry.path &&
          file.contentHash === remoteEntry.revision.contentHash
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
          file.contentHash === remoteEntry.revision.contentHash
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
          const targetPath =
            remoteEntry.path !== baseEntry.path
              ? remoteEntry.path
              : file.path;
          if (file.path !== targetPath) {
            localActions.push({
              entryId: remoteEntry.entryId,
              fromPath: file.path,
              kind: "move-local",
              toPath: targetPath,
            });
          }
          remoteChanges.push({
            entryId: remoteEntry.entryId,
            file,
            kind: "upload-local",
            path: targetPath,
            replacesRevisionId: remoteEntry.revision.revisionId,
          });
        } else if (
          baseEntry?.kind === "live" &&
          file.contentHash === baseEntry.revision.contentHash &&
          remoteEntry.revision.contentHash !== baseEntry.revision.contentHash
        ) {
          if (file.path !== remoteEntry.path) {
            if (
              file.path !== baseEntry.path &&
              remoteEntry.path === baseEntry.path
            ) {
              remoteChanges.push({
                entryId: remoteEntry.entryId,
                fromPath: remoteEntry.path,
                kind: "move-remote",
                toPath: file.path,
              });
            } else {
              localActions.push({
                entryId: remoteEntry.entryId,
                fromPath: file.path,
                kind: "move-local",
                toPath: remoteEntry.path,
              });
            }
          }
          localActions.push({
            entryId: remoteEntry.entryId,
            kind: "download-remote",
            path:
              file.path !== baseEntry.path &&
              remoteEntry.path === baseEntry.path
                ? file.path
                : remoteEntry.path,
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
      if (
        baseEntry.kind === "deleted" &&
        remoteEntry.kind === "live" &&
        localFile &&
        localFile.contentHash !== remoteEntry.revision.contentHash
      ) {
        conflicts.push({
          entryId: remoteEntry.entryId,
          kind: "edit-edit",
          localFile,
          path: remoteEntry.path,
          remoteRevision: remoteEntry.revision,
        });
        continue;
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
      const isPresent =
        localByEntryId.has(baseEntry.entryId) ||
        localByPath.has(baseEntry.path);
      const absenceIsNotDeletion =
        deferredEntryIds.has(baseEntry.entryId) ||
        unmaterializedEntryIds.has(baseEntry.entryId);
      const remoteEntry = remote.entries[baseEntry.entryId];
      if (
        !isPresent &&
        !absenceIsNotDeletion &&
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
        !absenceIsNotDeletion &&
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
        !unmaterializedEntryIds.has(remoteEntry.entryId) ||
        deferredEntryIds.has(remoteEntry.entryId)
      ) {
        continue;
      }
      const isPresent =
        localByEntryId.has(remoteEntry.entryId) ||
        localByPath.has(remoteEntry.path);
      if (!isPresent) {
        localActions.push({
          entryId: remoteEntry.entryId,
          kind: "download-remote",
          path: remoteEntry.path,
          revision: remoteEntry.revision,
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

    const remoteChangeCounts = new Map<string, number>();
    for (const change of remoteChanges) {
      remoteChangeCounts.set(
        change.entryId,
        (remoteChangeCounts.get(change.entryId) ?? 0) + 1,
      );
    }
    const duplicateRemoteChangeEntryIds = new Set(
      [...remoteChangeCounts].flatMap(([entryId, count]) =>
        count > 1 ? [entryId] : [],
      ),
    );
    for (const entryId of duplicateRemoteChangeEntryIds) {
      const paths = remoteChanges.flatMap((change) => {
        if (change.entryId !== entryId) {
          return [];
        }
        return change.kind === "move-remote"
          ? [change.fromPath, change.toPath]
          : [change.path];
      });
      conflicts.push({
        kind: "path-collision",
        paths: [...new Set(paths)],
      });
    }
    if (duplicateRemoteChangeEntryIds.size > 0) {
      for (let index = remoteChanges.length - 1; index >= 0; index -= 1) {
        const change = remoteChanges[index];
        if (change && duplicateRemoteChangeEntryIds.has(change.entryId)) {
          remoteChanges.splice(index, 1);
        }
      }
      for (let index = localActions.length - 1; index >= 0; index -= 1) {
        const action = localActions[index];
        if (action && duplicateRemoteChangeEntryIds.has(action.entryId)) {
          localActions.splice(index, 1);
        }
      }
    }

    const totalLiveEntries = Object.values(base?.entries ?? {}).filter(
      (entry) => entry.kind === "live",
    ).length;
    const deletionEntryIds = remoteChanges.flatMap((change) =>
      change.kind === "delete-remote" ? [change.entryId] : [],
    );
    const deletionCount = deletionEntryIds.length;
    const isBulkDeletion =
      deletionCount > 100 ||
      (totalLiveEntries > 0 && deletionCount / totalLiveEntries > 0.2);

    return {
      bulkDeletion: isBulkDeletion
        ? {
            count: deletionCount,
            entryIds: deletionEntryIds.sort(),
            totalLiveEntries,
          }
        : undefined,
      conflicts,
      localActions,
      remoteChanges,
    };
  }
}
