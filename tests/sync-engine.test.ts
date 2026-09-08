import { describe, expect, it } from "vitest";

import {
  SyncEngine,
  type ReplicaObservation,
  type VaultSnapshot,
} from "../src/sync/sync-engine";

const liveSnapshot = (): VaultSnapshot => ({
  commitId: "commit-1",
  entries: {
    "entry-1": {
      entryId: "entry-1",
      kind: "live",
      path: "notes/example.md",
      revision: {
        blobId: "blob-1",
        contentHash: "sha256:old",
        createdAt: "2026-09-01T00:00:00.000Z",
        revisionId: "revision-1",
        size: 3,
      },
    },
  },
  protocolVersion: 1,
  vaultId: "vault-1",
});

describe("SyncEngine", () => {
  it("bounds path inspections when one note changes in a large Vault", () => {
    const count = 1_521;
    const entries: VaultSnapshot["entries"] = {};
    let pathReads = 0;
    const files = Array.from({ length: count }, (_, index) => {
      const entryId = `entry-${index}`;
      const path = `1-Projects/项目-${index}/文章.md`;
      entries[entryId] = {
        entryId,
        kind: "live",
        path,
        revision: {
          blobId: `blob-${index}`,
          contentHash: "sha256:original",
          createdAt: "2026-09-08T00:00:00.000Z",
          revisionId: `revision-${index}`,
          size: 50,
        },
      };
      return {
        contentHash: index === 0 ? "sha256:edited" : "sha256:original",
        entryId,
        get path() {
          pathReads += 1;
          return path;
        },
        size: 50,
      };
    });
    const snapshot: VaultSnapshot = {
      commitId: "base", entries, protocolVersion: 1, vaultId: "vault-1",
    };
    const plan = new SyncEngine().reconcile({
      base: snapshot,
      local: { basedOnCommitId: "base", files, replicaId: "desktop" },
      remote: snapshot,
    });

    expect(plan.localActions).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.remoteChanges).toMatchObject([
      { kind: "upload-local", entryId: "entry-0", path: "1-Projects/项目-0/文章.md" },
    ]);
    // Bound repeated work without depending on machine speed or a specific index.
    expect(pathReads).toBeLessThan(count * 20);
  });

  it("does not resurrect an entry deleted while a Replica was offline", () => {
    const base = liveSnapshot();
    const remote: VaultSnapshot = {
      ...base,
      commitId: "commit-2",
      entries: {
        "entry-1": {
          deletedAt: "2026-09-02T00:00:00.000Z",
          entryId: "entry-1",
          kind: "deleted",
          lastContentHash: "sha256:old",
          lastRevisionId: "revision-1",
          path: "notes/example.md",
        },
      },
    };
    const local: ReplicaObservation = {
      basedOnCommitId: "commit-1",
      files: [
        {
          contentHash: "sha256:old",
          entryId: "entry-1",
          path: "notes/example.md",
          size: 3,
        },
      ],
      replicaId: "phone",
    };

    const plan = new SyncEngine().reconcile({ base, local, remote });

    expect(plan.remoteChanges).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.localActions).toEqual([
      {
        entryId: "entry-1",
        kind: "delete-local",
        path: "notes/example.md",
      },
    ]);
  });

  it("rebuilds deletion knowledge after the local Sync Cache is lost", () => {
    const remote: VaultSnapshot = {
      commitId: "commit-2",
      entries: {
        "entry-1": {
          deletedAt: "2026-09-02T00:00:00.000Z",
          entryId: "entry-1",
          kind: "deleted",
          lastContentHash: "sha256:old",
          lastRevisionId: "revision-1",
          path: "notes/example.md",
        },
      },
      protocolVersion: 1,
      vaultId: "vault-1",
    };
    const local: ReplicaObservation = {
      basedOnCommitId: undefined,
      files: [
        {
          contentHash: "sha256:old",
          entryId: undefined,
          path: "notes/example.md",
          size: 3,
        },
      ],
      replicaId: "reinstalled-phone",
    };

    const plan = new SyncEngine().reconcile({
      base: undefined,
      local,
      remote,
    });

    expect(plan.remoteChanges).toEqual([]);
    expect(plan.localActions).toEqual([
      {
        entryId: "entry-1",
        kind: "delete-local",
        path: "notes/example.md",
      },
    ]);
  });

  it("surfaces an edit-delete Conflict without restoring the deleted path", () => {
    const base = liveSnapshot();
    const remote: VaultSnapshot = {
      ...base,
      commitId: "commit-2",
      entries: {
        "entry-1": {
          deletedAt: "2026-09-02T00:00:00.000Z",
          entryId: "entry-1",
          kind: "deleted",
          lastContentHash: "sha256:old",
          lastRevisionId: "revision-1",
          path: "notes/example.md",
        },
      },
    };
    const local: ReplicaObservation = {
      basedOnCommitId: "commit-1",
      files: [
        {
          contentHash: "sha256:phone-edit",
          entryId: "entry-1",
          path: "notes/example.md",
          size: 9,
        },
      ],
      replicaId: "phone",
    };

    const plan = new SyncEngine().reconcile({ base, local, remote });

    expect(plan.localActions).toEqual([]);
    expect(plan.remoteChanges).toEqual([]);
    expect(plan.conflicts).toEqual([
      {
        deletedAt: "2026-09-02T00:00:00.000Z",
        entryId: "entry-1",
        kind: "edit-delete",
        localFile: local.files[0],
        path: "notes/example.md",
      },
    ]);
  });

  it("keeps a local draft as a Conflict when another Replica restores the path", () => {
    const deleted: VaultSnapshot = {
      commitId: "commit-deleted",
      entries: {
        "entry-1": {
          deletedAt: "2026-09-02T00:00:00.000Z",
          entryId: "entry-1",
          kind: "deleted",
          lastContentHash: "sha256:old",
          lastRevisionId: "revision-1",
          path: "notes/example.md",
        },
      },
      protocolVersion: 1,
      vaultId: "vault-1",
    };
    const restoredRevision = {
      blobId: "blob-restored",
      contentHash: "sha256:restored",
      createdAt: "2026-09-03T00:00:00.000Z",
      revisionId: "revision-restored",
      size: 8,
    };
    const remote: VaultSnapshot = {
      ...deleted,
      commitId: "commit-restored",
      entries: {
        "entry-1": {
          entryId: "entry-1",
          kind: "live",
          path: "notes/example.md",
          revision: restoredRevision,
        },
      },
    };
    const local: ReplicaObservation = {
      basedOnCommitId: deleted.commitId,
      files: [
        {
          contentHash: "sha256:new-draft",
          path: "notes/example.md",
          size: 9,
        },
      ],
      replicaId: "phone",
    };

    const plan = new SyncEngine().reconcile({
      base: deleted,
      local,
      remote,
    });

    expect(plan.localActions).toEqual([]);
    expect(plan.remoteChanges).toEqual([]);
    expect(plan.conflicts).toEqual([
      {
        entryId: "entry-1",
        kind: "edit-edit",
        localFile: local.files[0],
        path: "notes/example.md",
        remoteRevision: restoredRevision,
      },
    ]);
  });

  it("records a local deletion instead of downloading the remote Revision", () => {
    const base = liveSnapshot();
    const local: ReplicaObservation = {
      basedOnCommitId: "commit-1",
      files: [],
      replicaId: "desktop",
    };

    const plan = new SyncEngine().reconcile({
      base,
      local,
      remote: liveSnapshot(),
    });

    expect(plan.localActions).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.remoteChanges).toEqual([
      {
        entryId: "entry-1",
        kind: "delete-remote",
        lastContentHash: "sha256:old",
        lastRevisionId: "revision-1",
        path: "notes/example.md",
        recoveryRevision:
          base.entries["entry-1"]?.kind === "live"
            ? base.entries["entry-1"].revision
            : undefined,
      },
    ]);
  });

  it("does not treat a Deferred Download as a local deletion", () => {
    const base = liveSnapshot();
    const local: ReplicaObservation = {
      basedOnCommitId: "commit-1",
      deferredEntryIds: ["entry-1"],
      files: [],
      replicaId: "phone",
    };

    const plan = new SyncEngine().reconcile({
      base,
      local,
      remote: liveSnapshot(),
    });

    expect(plan.remoteChanges).toEqual([]);
    expect(plan.localActions).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("preserves both sides when the same Entry is edited concurrently", () => {
    const base = liveSnapshot();
    const remoteRevision = {
      blobId: "blob-remote",
      contentHash: "sha256:remote-edit",
      createdAt: "2026-09-02T00:00:00.000Z",
      revisionId: "revision-remote",
      size: 10,
    };
    const remote: VaultSnapshot = {
      ...base,
      commitId: "commit-2",
      entries: {
        "entry-1": {
          entryId: "entry-1",
          kind: "live",
          path: "notes/example.md",
          revision: remoteRevision,
        },
      },
    };
    const local: ReplicaObservation = {
      basedOnCommitId: "commit-1",
      files: [
        {
          contentHash: "sha256:local-edit",
          entryId: "entry-1",
          path: "notes/example.md",
          size: 9,
        },
      ],
      replicaId: "phone",
    };

    const plan = new SyncEngine().reconcile({ base, local, remote });

    expect(plan.localActions).toEqual([]);
    expect(plan.remoteChanges).toEqual([]);
    expect(plan.conflicts).toEqual([
      {
        entryId: "entry-1",
        kind: "edit-edit",
        localFile: local.files[0],
        path: "notes/example.md",
        remoteRevision,
      },
    ]);
  });

  it("uploads a local edit when the accepted remote Revision is unchanged", () => {
    const base = liveSnapshot();
    const localFile = {
      contentHash: "sha256:desktop-edit",
      entryId: "entry-1",
      path: "notes/example.md",
      size: 12,
    };
    const local: ReplicaObservation = {
      basedOnCommitId: "commit-1",
      files: [localFile],
      replicaId: "desktop",
    };

    const plan = new SyncEngine().reconcile({
      base,
      local,
      remote: liveSnapshot(),
    });

    expect(plan.localActions).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.remoteChanges).toEqual([
      {
        entryId: "entry-1",
        file: localFile,
        kind: "upload-local",
        path: "notes/example.md",
        replacesRevisionId: "revision-1",
      },
    ]);
  });

  it("downloads a remote edit when the local file is unchanged", () => {
    const base = liveSnapshot();
    const remoteRevision = {
      blobId: "blob-remote",
      contentHash: "sha256:remote-edit",
      createdAt: "2026-09-02T00:00:00.000Z",
      revisionId: "revision-remote",
      size: 11,
    };
    const remote: VaultSnapshot = {
      ...base,
      commitId: "commit-2",
      entries: {
        "entry-1": {
          entryId: "entry-1",
          kind: "live",
          path: "notes/example.md",
          revision: remoteRevision,
        },
      },
    };
    const local: ReplicaObservation = {
      basedOnCommitId: "commit-1",
      files: [
        {
          contentHash: "sha256:old",
          entryId: "entry-1",
          path: "notes/example.md",
          size: 3,
        },
      ],
      replicaId: "phone",
    };

    const plan = new SyncEngine().reconcile({ base, local, remote });

    expect(plan.remoteChanges).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.localActions).toEqual([
      {
        entryId: "entry-1",
        kind: "download-remote",
        path: "notes/example.md",
        revision: remoteRevision,
      },
    ]);
  });

  it("downloads live Entries when a new Replica has no Sync Cache", () => {
    const remote = liveSnapshot();
    const remoteEntry = remote.entries["entry-1"];
    if (remoteEntry?.kind !== "live") {
      throw new Error("Expected live fixture");
    }
    const local: ReplicaObservation = {
      files: [],
      replicaId: "new-phone",
    };

    const plan = new SyncEngine().reconcile({
      base: undefined,
      local,
      remote,
    });

    expect(plan.remoteChanges).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.localActions).toEqual([
      {
        entryId: "entry-1",
        kind: "download-remote",
        path: "notes/example.md",
        revision: remoteEntry.revision,
      },
    ]);
  });

  it("assigns a stable Entry identity when a local file is new", () => {
    const empty: VaultSnapshot = {
      commitId: "commit-1",
      entries: {},
      protocolVersion: 1,
      vaultId: "vault-1",
    };
    const localFile = {
      contentHash: "sha256:new",
      entryId: undefined,
      path: "notes/new.md",
      size: 3,
    };
    const local: ReplicaObservation = {
      basedOnCommitId: "commit-1",
      files: [localFile],
      replicaId: "desktop",
    };

    const plan = new SyncEngine(() => "entry-new").reconcile({
      base: empty,
      local,
      remote: empty,
    });

    expect(plan.localActions).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.remoteChanges).toEqual([
      {
        entryId: "entry-new",
        file: localFile,
        kind: "upload-new",
        path: "notes/new.md",
      },
    ]);
  });

  it("preserves Entry identity across a local rename", () => {
    const base = liveSnapshot();
    const localFile = {
      contentHash: "sha256:old",
      entryId: "entry-1",
      path: "notes/renamed.md",
      size: 3,
    };
    const local: ReplicaObservation = {
      basedOnCommitId: "commit-1",
      files: [localFile],
      replicaId: "desktop",
    };

    const plan = new SyncEngine().reconcile({
      base,
      local,
      remote: liveSnapshot(),
    });

    expect(plan.localActions).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.remoteChanges).toEqual([
      {
        entryId: "entry-1",
        fromPath: "notes/example.md",
        kind: "move-remote",
        toPath: "notes/renamed.md",
      },
    ]);
  });

  it("surfaces an unknown local file as an Import Candidate during bootstrap", () => {
    const remote = liveSnapshot();
    const localFile = {
      contentHash: "sha256:unknown",
      entryId: undefined,
      path: "notes/local-only.md",
      size: 7,
    };
    const local: ReplicaObservation = {
      files: [localFile],
      replicaId: "new-phone",
    };

    const plan = new SyncEngine(() => "must-not-be-used").reconcile({
      base: undefined,
      local,
      remote,
    });

    expect(plan.remoteChanges).toEqual([]);
    expect(plan.conflicts).toEqual([
      {
        kind: "import-candidate",
        localFile,
        path: "notes/local-only.md",
      },
    ]);
  });

  it("requires confirmation before a Bulk Deletion is published", () => {
    const entries = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => {
        const number = index + 1;
        return [
          `entry-${number}`,
          {
            entryId: `entry-${number}`,
            kind: "live" as const,
            path: `notes/${number}.md`,
            revision: {
              blobId: `blob-${number}`,
              contentHash: `sha256:${number}`,
              createdAt: "2026-09-01T00:00:00.000Z",
              revisionId: `revision-${number}`,
              size: 1,
            },
          },
        ];
      }),
    );
    const snapshot: VaultSnapshot = {
      commitId: "commit-1",
      entries,
      protocolVersion: 1,
      vaultId: "vault-1",
    };
    const local: ReplicaObservation = {
      basedOnCommitId: "commit-1",
      files: Object.values(entries)
        .slice(2)
        .map((entry) => ({
          contentHash: entry.revision.contentHash,
          entryId: entry.entryId,
          path: entry.path,
          size: entry.revision.size,
        })),
      replicaId: "desktop",
    };

    const plan = new SyncEngine().reconcile({
      base: snapshot,
      local,
      remote: snapshot,
    });

    expect(plan.bulkDeletion).toEqual({
      count: 2,
      entryIds: ["entry-1", "entry-2"],
      totalLiveEntries: 5,
    });
  });

  it("stops on a cross-platform Path Collision", () => {
    const empty: VaultSnapshot = {
      commitId: "commit-1",
      entries: {},
      protocolVersion: 1,
      vaultId: "vault-1",
    };
    const local: ReplicaObservation = {
      basedOnCommitId: "commit-1",
      files: [
        {
          contentHash: "sha256:upper",
          path: "Notes/Example.md",
          size: 1,
        },
        {
          contentHash: "sha256:lower",
          path: "notes/example.md",
          size: 1,
        },
      ],
      replicaId: "desktop",
    };

    const plan = new SyncEngine().reconcile({ base: empty, local, remote: empty });

    expect(plan.remoteChanges).toEqual([]);
    expect(plan.localActions).toEqual([]);
    expect(plan.conflicts).toEqual([
      {
        kind: "path-collision",
        paths: ["Notes/Example.md", "notes/example.md"],
      },
    ]);
  });

  it("surfaces a local delete against a remote edit", () => {
    const base = liveSnapshot();
    const remoteRevision = {
      blobId: "blob-remote",
      contentHash: "sha256:remote-edit",
      createdAt: "2026-09-02T00:00:00.000Z",
      revisionId: "revision-remote",
      size: 9,
    };
    const remote: VaultSnapshot = {
      ...base,
      commitId: "commit-2",
      entries: {
        "entry-1": {
          entryId: "entry-1",
          kind: "live",
          path: "notes/example.md",
          revision: remoteRevision,
        },
      },
    };
    const local: ReplicaObservation = {
      basedOnCommitId: "commit-1",
      files: [],
      replicaId: "desktop",
    };

    const plan = new SyncEngine().reconcile({ base, local, remote });

    expect(plan.remoteChanges).toEqual([]);
    expect(plan.localActions).toEqual([]);
    expect(plan.conflicts).toEqual([
      {
        baseContentHash: "sha256:old",
        baseRevision:
          base.entries["entry-1"]?.kind === "live"
            ? base.entries["entry-1"].revision
            : undefined,
        baseRevisionId: "revision-1",
        entryId: "entry-1",
        kind: "delete-edit",
        path: "notes/example.md",
        remoteRevision,
      },
    ]);
  });

  it("does not bind stale same-path content after Sync Cache loss", () => {
    const remote = liveSnapshot();
    const localFile = {
      contentHash: "sha256:stale-or-different",
      path: "notes/example.md",
      size: 3,
    };
    const local: ReplicaObservation = {
      files: [localFile],
      replicaId: "reinstalled-phone",
    };

    const plan = new SyncEngine().reconcile({
      base: undefined,
      local,
      remote,
    });

    expect(plan.remoteChanges).toEqual([]);
    expect(plan.localActions).toEqual([]);
    expect(plan.conflicts).toEqual([
      {
        kind: "bootstrap-mismatch",
        localFile,
        path: "notes/example.md",
        remoteRevision:
          remote.entries["entry-1"]?.kind === "live"
            ? remote.entries["entry-1"].revision
            : undefined,
      },
    ]);
  });

  it("downloads an Entry created remotely after the last local sync", () => {
    const base = liveSnapshot();
    const remoteRevision = {
      blobId: "blob-2",
      contentHash: "sha256:remote-new",
      createdAt: "2026-09-02T00:00:00.000Z",
      revisionId: "revision-2",
      size: 4,
    };
    const remote: VaultSnapshot = {
      ...base,
      commitId: "commit-2",
      entries: {
        ...base.entries,
        "entry-2": {
          entryId: "entry-2",
          kind: "live",
          path: "notes/remote-new.md",
          revision: remoteRevision,
        },
      },
    };
    const local: ReplicaObservation = {
      basedOnCommitId: "commit-1",
      files: [
        {
          contentHash: "sha256:old",
          entryId: "entry-1",
          path: "notes/example.md",
          size: 3,
        },
      ],
      replicaId: "phone",
    };

    const plan = new SyncEngine().reconcile({ base, local, remote });

    expect(plan.remoteChanges).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.localActions).toEqual([
      {
        entryId: "entry-2",
        kind: "download-remote",
        path: "notes/remote-new.md",
        revision: remoteRevision,
      },
    ]);
  });

  it("moves the local path when the Entry was renamed remotely", () => {
    const base = liveSnapshot();
    const baseEntry = base.entries["entry-1"];
    if (baseEntry?.kind !== "live") {
      throw new Error("Expected live fixture");
    }
    const remote: VaultSnapshot = {
      ...base,
      commitId: "commit-2",
      entries: {
        "entry-1": { ...baseEntry, path: "notes/renamed.md" },
      },
    };
    const local: ReplicaObservation = {
      basedOnCommitId: "commit-1",
      files: [
        {
          contentHash: "sha256:old",
          entryId: "entry-1",
          path: "notes/example.md",
          size: 3,
        },
      ],
      replicaId: "phone",
    };

    const plan = new SyncEngine().reconcile({ base, local, remote });

    expect(plan.remoteChanges).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.localActions).toEqual([
      {
        entryId: "entry-1",
        fromPath: "notes/example.md",
        kind: "move-local",
        toPath: "notes/renamed.md",
      },
    ]);
  });

  it("blocks a remote rename whose target is occupied by another local file", () => {
    const base = liveSnapshot();
    const baseEntry = base.entries["entry-1"];
    if (baseEntry?.kind !== "live") {
      throw new Error("Expected live fixture");
    }
    const remote: VaultSnapshot = {
      ...base,
      commitId: "commit-2",
      entries: {
        "entry-1": { ...baseEntry, path: "notes/occupied.md" },
      },
    };
    const local: ReplicaObservation = {
      basedOnCommitId: base.commitId,
      files: [
        {
          contentHash: baseEntry.revision.contentHash,
          entryId: baseEntry.entryId,
          path: baseEntry.path,
          size: baseEntry.revision.size,
        },
        {
          contentHash: "sha256:local-draft",
          path: "notes/occupied.md",
          size: 11,
        },
      ],
      replicaId: "phone",
    };

    const plan = new SyncEngine().reconcile({ base, local, remote });

    expect(plan.localActions).toEqual([]);
    expect(plan.remoteChanges).toEqual([]);
    expect(plan.conflicts).toEqual([
      {
        kind: "path-collision",
        paths: ["notes/occupied.md"],
      },
    ]);
  });

  it("moves then downloads when an Entry was renamed and edited remotely", () => {
    const base = liveSnapshot();
    const baseEntry = base.entries["entry-1"];
    if (baseEntry?.kind !== "live") {
      throw new Error("Expected live fixture");
    }
    const remoteRevision = {
      blobId: "blob-remote",
      contentHash: "sha256:remote-edit",
      createdAt: "2026-09-02T00:00:00.000Z",
      revisionId: "revision-remote",
      size: 9,
    };
    const remote: VaultSnapshot = {
      ...base,
      commitId: "commit-2",
      entries: {
        "entry-1": {
          ...baseEntry,
          path: "notes/renamed.md",
          revision: remoteRevision,
        },
      },
    };
    const local: ReplicaObservation = {
      basedOnCommitId: "commit-1",
      files: [
        {
          contentHash: "sha256:old",
          entryId: "entry-1",
          path: "notes/example.md",
          size: 3,
        },
      ],
      replicaId: "phone",
    };

    const plan = new SyncEngine().reconcile({ base, local, remote });

    expect(plan.localActions).toEqual([
      {
        entryId: "entry-1",
        fromPath: "notes/example.md",
        kind: "move-local",
        toPath: "notes/renamed.md",
      },
      {
        entryId: "entry-1",
        kind: "download-remote",
        path: "notes/renamed.md",
        revision: remoteRevision,
      },
    ]);
  });

  it("does not overwrite edits made while a Conflict awaited resolution", () => {
    const base: VaultSnapshot = {
      commitId: "commit-conflict",
      entries: {
        "entry-1": {
          candidates: [
            {
              blobId: "blob-materialized",
              contentHash: "sha256:materialized",
              createdAt: "2026-09-02T00:00:00.000Z",
              revisionId: "revision-materialized",
              size: 4,
            },
          ],
          entryId: "entry-1",
          kind: "conflicted",
          materializedContentHash: "sha256:materialized",
          path: "notes/example.md",
          reason: "edit-edit",
        },
      },
      protocolVersion: 1,
      vaultId: "vault-1",
    };
    const resolvedRevision = {
      blobId: "blob-resolved",
      contentHash: "sha256:resolved",
      createdAt: "2026-09-03T00:00:00.000Z",
      revisionId: "revision-resolved",
      size: 4,
    };
    const remote: VaultSnapshot = {
      ...base,
      commitId: "commit-resolved",
      entries: {
        "entry-1": {
          entryId: "entry-1",
          kind: "live",
          path: "notes/example.md",
          revision: resolvedRevision,
        },
      },
    };
    const local: ReplicaObservation = {
      basedOnCommitId: "commit-conflict",
      files: [
        {
          contentHash: "sha256:edited-while-waiting",
          entryId: "entry-1",
          path: "notes/example.md",
          size: 8,
        },
      ],
      replicaId: "desktop",
    };

    const plan = new SyncEngine().reconcile({ base, local, remote });

    expect(plan.localActions).toEqual([]);
    expect(plan.remoteChanges).toEqual([]);
    expect(plan.conflicts).toEqual([
      {
        entryId: "entry-1",
        kind: "resolution-mismatch",
        path: "notes/example.md",
      },
    ]);
  });

  it("does not guess when an offline rename also changed content", () => {
    const base = liveSnapshot();
    const localFile = {
      contentHash: "sha256:renamed-and-edited",
      path: "notes/renamed.md",
      size: 9,
    };
    const local: ReplicaObservation = {
      basedOnCommitId: "commit-1",
      files: [localFile],
      replicaId: "desktop",
    };

    const plan = new SyncEngine().reconcile({
      base,
      local,
      remote: liveSnapshot(),
    });

    expect(plan.remoteChanges).toEqual([]);
    expect(plan.conflicts).toEqual([
      {
        deletedEntries: [
          { entryId: "entry-1", path: "notes/example.md" },
        ],
        kind: "possible-rename",
        newFiles: [localFile],
      },
    ]);
  });
});
