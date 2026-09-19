import {
  Notice,
  Platform,
  Plugin,
  TFile,
  type App,
  type TAbstractFile,
} from "obsidian";

import { VaultCrypto } from "./crypto/vault-crypto";
import { RemotelySaveMigration } from "./migration/remotely-save-migration";
import { CredentialStore, type AwsCredentials } from "./plugin/credential-store";
import { createCooperativeYield } from "./plugin/cooperative-yield";
import { StatusModal, VersionHistoryModal } from "./plugin/modals";
import { ObsidianVaultPort, isInSyncScope } from "./plugin/obsidian-vault-port";
import { SerializedDataWriter } from "./plugin/serialized-data-writer";
import { SyncSession, SyncStoppedError } from "./plugin/sync-session";
import { formatSyncProgress } from "./plugin/sync-progress";
import { SyncProgressThrottle } from "./plugin/sync-progress-throttle";
import { SyncDiagnostics, type SyncDiagnosticsView, type SyncRunRecord, type SyncTrigger } from "./plugin/sync-diagnostics";
import {
  DEFAULT_SETTINGS,
  S3VaultSyncSettingsTab,
  type S3VaultSyncSettings,
  type SettingsController,
  type SyncStatusDisplay,
} from "./plugin/settings";
import {
  SyncService,
  type CachedSyncState,
  type DeferredDownloadEntry,
  type LocalSyncIssue,
  type LocalContentReview,
  type LocalContentChoice,
  type PossibleRenameResolution,
  type SyncCachePort,
  type SyncProgress,
  type VerifiedLocalFile,
} from "./sync/sync-service";
import { DirtyPathTracker } from "./sync/dirty-path-tracker";
import { LocalStateChangedError } from "./sync/errors";
import type { PathCollisionReview, PathCollisionResolution } from "./sync/path-collision-review";
import { CollisionRenameJournal, type PendingCollisionRename } from "./sync/collision-rename-journal";
import { isSafeTargetPath } from "./plugin/safe-vault-write";
import {
  isFullHashVerificationDue,
  normalizeFullHashVerificationIntervalDays,
} from "./sync/full-hash-verification-policy";
import type {
  BulkDeletionPlan,
  ConflictedEntry,
  DeletedEntry,
  LiveEntry,
} from "./sync/sync-engine";
import { retryHeadChanges } from "./sync/head-change-retry";
import {
  isInternalStagingRename,
  PathRenameTracker,
  type PersistedPathRenames,
} from "./sync/path-rename-tracker";
import {
  SyncRequestQueue,
  type SyncRequestOptions,
  type SyncRunOptions,
} from "./sync/sync-request-queue";
import { AwsS3ObjectStore, S3RequestError } from "./storage/aws-s3-object-store";
import { BootstrapStore } from "./storage/bootstrap-store";
import { executeObsidianHttpRequest } from "./storage/obsidian-http";
import { S3TransportError } from "./storage/obsidian-request-adapter";
import { isProbeObjectKey, probeObjectStore } from "./storage/object-store-probe";
import {
  HeadChangedError,
  RemoteStateError,
  RemoteStore,
  type RemoteIntegrityCheck,
} from "./storage/remote-store";

type PluginStatus =
  | "Action required"
  | "Checking"
  | "Error"
  | "Idle"
  | "Not configured"
  | "Paused"
  | "Syncing";

class RepairModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepairModeError";
  }
}

interface PendingIntegrityIssue {
  target: string;
  message: string;
  check: RemoteIntegrityCheck;
}

interface PersistedPluginData {
  cache?: CachedSyncState;
  fullHashVerificationRequired?: boolean;
  lastFullHashVerificationAt?: number;
  pendingPathRenames?: PersistedPathRenames;
  pendingCollisionRename?: PendingCollisionRename;
  pendingIntegrityChecks?: PendingIntegrityIssue[];
  pendingInitialization?: {
    bucket: string;
    region: string;
    prefix: string;
    vaultId: string;
    phase: "uploading" | "publishing";
  };
  pendingProbes?: Array<{ bucket: string; region: string; prefix: string; key: string }>;
  settings: S3VaultSyncSettings;
}

const normalizePrefix = (prefix: string): string =>
  prefix.replace(/^\/+|\/+$/gu, "");

const ANDROID_DOWNLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const ANDROID_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

export default class S3VaultSyncPlugin
  extends Plugin
  implements SettingsController
{
  private session!: SyncSession;
  private changeTimer: number | undefined;
  private readonly dirtyPaths = new DirtyPathTracker();
  private headRetryAttempt = 0;
  private headRetryTimer: number | undefined;
  private headRetryAt: number | undefined;
  private networkRetryAttempt = 0;
  private networkRetryTimer: number | undefined;
  private networkRetryAt: number | undefined;
  private networkFailureTarget: string | undefined;
  private pathRenames = new PathRenameTracker();
  private credentials!: CredentialStore;
  private data!: PersistedPluginData;
  private diagnostics!: SyncDiagnostics;
  private activeRun: SyncRunRecord | undefined;
  private acceptedCommit: string | undefined;
  private readonly pendingTriggers = new Set<SyncTrigger>();
  private pendingSyncTarget: string | undefined;
  private pendingBulkDeletion:
    | BulkDeletionPlan
    | undefined;
  private approvedBulkDeletionEntryIds: string[] | undefined;
  private pendingLocalIssues: LocalSyncIssue[] = [];
  private approvedRenameResolution: PossibleRenameResolution | undefined;
  private pendingDeferredDownloads: DeferredDownloadEntry[] = [];
  private readonly pluginDataWriter = new SerializedDataWriter(
    () => this.data,
    (snapshot) => {
      this.session.assertActive();
      return this.saveData(snapshot);
    },
  );
  private readonly syncRequests = new SyncRequestQueue((options) =>
    this.session.run(() => this.performSync(options)),
  );
  private readonly syncProgressThrottle = new SyncProgressThrottle();
  private readonly yieldDuringHashing = createCooperativeYield();
  private status: PluginStatus = "Not configured";
  private statusDetail = "Enter AWS settings and a Vault password.";
  private statusElement: HTMLElement | undefined;
  private readonly statusListeners = new Set<
    (status: SyncStatusDisplay) => void
  >();
  private progressLabel: string | undefined;

  async onload(): Promise<void> {
    this.session = new SyncSession(this.app.vault);
    await this.session.ready;
    this.session.assertActive();
    await this.session.run(() => this.loadPluginData());
    this.session.assertActive();
    const diagnosticPath = `${this.app.vault.configDir}/plugins/${this.manifest.id}/diagnostics.json`;
    this.diagnostics = new SyncDiagnostics({
      read: async () => {
        const exists = await this.app.vault.adapter.exists(diagnosticPath);
        this.session.assertActive();
        if (!exists) return undefined;
        const body = await this.app.vault.adapter.read(diagnosticPath);
        this.session.assertActive();
        return JSON.parse(body) as unknown;
      },
      write: value => this.session.run(() => this.app.vault.adapter.write(diagnosticPath, JSON.stringify(value))),
    });
    await this.session.run(() => this.diagnostics.load());
    this.session.assertActive();
    this.credentials = new CredentialStore(this.app.secretStorage);
    this.addSettingTab(new S3VaultSyncSettingsTab(this.app, this));
    this.addRibbonIcon("refresh-cw", "Open S3 Vault Sync", () => {
      this.openStatus();
    });
    this.addCommand({
      callback: () => this.openStatus(),
      id: "open-status",
      name: "Open sync status",
    });
    this.addCommand({
      callback: () => {
        void this.syncNow();
      },
      id: "sync-now",
      name: "Sync now",
    });
    this.addCommand({
      callback: () => {
        void this.verifyAllFiles();
      },
      id: "run-full-integrity-check",
      name: "Run full integrity check",
    });
    this.addCommand({
      callback: () => {
        void this.togglePause();
      },
      id: "toggle-pause",
      name: "Pause or resume automatic sync",
    });
    this.addCommand({
      checkCallback: (checking) => {
        const activeFile = this.app.workspace.getActiveFile();
        const entry = activeFile ? this.getLiveEntry(activeFile.path) : undefined;
        if (!entry?.history?.length) {
          return false;
        }
        if (!checking) {
          this.openVersionHistory(entry.path);
        }
        return true;
      },
      id: "open-version-history",
      name: "Open version history for the current file",
    });
    if (Platform.isDesktop) {
      this.statusElement = this.addStatusBarItem();
      this.statusElement.addClass("s3-vault-sync-status-bar");
      this.statusElement.setAttr("role", "button");
      this.statusElement.setAttr("tabindex", "0");
      this.registerDomEvent(this.statusElement, "click", () => this.openStatus());
      this.registerDomEvent(this.statusElement, "keydown", event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.openStatus(); }
      });
    }
    this.refreshConfiguredStatus();
    this.app.workspace.onLayoutReady(() => {
      if (this.session.signal.aborted) return;
      this.registerVaultEvents();
      if (!this.data.settings.paused) {
        void this.requestAutomaticSync("startup");
      }
    });
    this.registerInterval(
      window.setInterval(() => {
        if (!this.data.settings.paused && document.visibilityState === "visible") {
          void this.requestPeriodicSync();
        }
      }, 120_000),
    );
    this.registerDomEvent(document, "visibilitychange", () => {
      if (this.data.settings.paused) {
        return;
      }
      if (document.visibilityState === "visible") {
        void this.requestPeriodicSync("foreground");
      } else {
        this.requestFinalSync();
      }
    });
    this.registerDomEvent(window, "pagehide", () => {
      this.requestFinalSync();
    });
    this.registerDomEvent(window, "online", () => {
      if (this.session.signal.aborted || this.data.settings.paused || this.syncRequests.isRunning ||
        this.networkFailureTarget !== this.integrityTarget()) return;
      this.networkFailureTarget = undefined;
      void this.requestSync({}, "online");
    });
    this.registerDomEvent(window, "beforeunload", () => {
      this.requestFinalSync();
    });
  }

  onunload(): void {
    void this.session.close();
    if (this.changeTimer !== undefined) {
      window.clearTimeout(this.changeTimer);
    }
    this.clearHeadRetryTimer();
    this.clearNetworkRetryTimer();
  }

  getSettings(): S3VaultSyncSettings {
    return this.data.settings;
  }

  openStatus(): void {
    new StatusModal(this.app, this).open();
  }

  openSettings(): void {
    const host = this.app as App & {setting: {open(): void; openTabById(id: string): void}};
    host.setting.open();
    host.setting.openTabById(this.manifest.id);
  }

  readConflictCandidate(entryId: string, revisionId: string): Promise<Uint8Array> {
    return this.runExclusiveSyncService(service => service.readConflictCandidate(entryId, revisionId));
  }

  getStatusText(): string {
    return `${this.status}: ${this.statusDetail}`;
  }

  getDiagnostics(limit = 20): SyncDiagnosticsView {
    const snapshot = this.diagnostics.snapshot(this.data.settings.vaultId ?? "", limit);
    return {...snapshot, acceptedCommit: this.data.cache?.snapshot.vaultId === this.data.settings.vaultId ? this.acceptedCommit : undefined,
      nextRetryAt: this.networkRetryAt ?? this.headRetryAt, queued: this.pendingTriggers.size > 0,
      pendingLocalChanges: this.dirtyPaths.capture().size};
  }

  exportDiagnostics(): string {
    return JSON.stringify({version: 1, ...this.getDiagnostics(1_000)}, null, 2);
  }

  getProgressLabel(): string | undefined {
    return this.progressLabel;
  }

  onStatusChange(
    listener: (status: SyncStatusDisplay) => void,
  ): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  isPaused(): boolean {
    return this.data.settings.paused;
  }

  getPendingBulkDeletion():
    | BulkDeletionPlan
    | undefined {
    return this.pendingBulkDeletion;
  }

  getConflicts(): ConflictedEntry[] {
    return Object.values(this.data.cache?.snapshot.entries ?? {}).filter(
      (entry): entry is ConflictedEntry => entry.kind === "conflicted",
    );
  }

  getLiveEntry(path: string): LiveEntry | undefined {
    return Object.values(this.data.cache?.snapshot.entries ?? {}).find(
      (entry): entry is LiveEntry =>
        entry.kind === "live" && entry.path === path,
    );
  }

  getLocalIssues(): LocalSyncIssue[] {
    return this.pendingLocalIssues;
  }

  getDeferredDownloads(): DeferredDownloadEntry[] {
    return this.pendingDeferredDownloads;
  }

  getDeletedRecoveries(): DeletedEntry[] {
    return Object.values(this.data.cache?.snapshot.entries ?? {}).filter(
      (entry): entry is DeletedEntry =>
        entry.kind === "deleted" &&
        (entry.recovery !== undefined || (entry.history?.length ?? 0) > 0),
    );
  }

  async confirmBulkDeletion(): Promise<void> {
    if (!this.pendingBulkDeletion || this.syncRequests.isRunning) {
      return;
    }
    this.approvedBulkDeletionEntryIds = [
      ...this.pendingBulkDeletion.entryIds,
    ];
    try {
      await this.requestSync({
        allowBulkDeletion: true,
        fullHashVerification: true,
      });
    } finally {
      this.approvedBulkDeletionEntryIds = undefined;
      this.approvedRenameResolution = undefined;
    }
  }

  async resolvePossibleRename(resolution: PossibleRenameResolution): Promise<void> {
    if (this.syncRequests.isRunning) {
      throw new Error("Synchronization is running. Wait for it to finish, then review again.");
    }
    if (this.isPaused()) throw new Error("Resume synchronization before resolving a rename.");
    this.approvedRenameResolution = resolution;
    try {
      await this.requestSync({ fullHashVerification: true });
      if (this.status === "Error") throw new Error(this.statusDetail);
    } finally {
      // A separate delete/add decision may still need the existing bulk-delete confirmation.
      if (!this.pendingBulkDeletion) this.approvedRenameResolution = undefined;
    }
  }

  reviewLocalContent(path: string): Promise<LocalContentReview> {
    return this.runExclusiveSyncService(service => service.reviewLocalContent(path));
  }

  reviewPathCollision(paths: string[]): Promise<PathCollisionReview> {
    return this.runExclusiveSyncService(async service => {
      const pending = this.data.pendingCollisionRename;
      const review = await service.reviewPathCollision(pending ? [...new Set([...paths, pending.from, pending.to])] : paths,
        this.pathRenames.toPathMap(this.pathRenames.capture()));
      return pending ? {...review, interruptedRename: pending,
        reviewToken: JSON.stringify({base: review.reviewToken, pending})} : review;
    }, true);
  }

  async resolvePathCollision(request: PathCollisionResolution): Promise<string> {
    try {
      const newPath = await this.runExclusiveSyncService(service => {
        const expectedRenames = JSON.stringify(this.pathRenames.serialize());
        return service.resolvePathCollision(request, this.pathRenames.toPathMap(this.pathRenames.capture()),
          this.collisionRenameJournal(expectedRenames));
      });
      await this.requestSync();
      return newPath;
    } catch (error) { this.showError(error); throw error; }
  }

  async confirmInterruptedCollisionRename(paths: string[], reviewToken: string, side: "source" | "target"): Promise<void> {
    await this.runExclusiveSyncService(async service => {
      const pending = this.data.pendingCollisionRename;
      if (!pending) throw new Error("The interrupted rename has already changed. Refresh sync status.");
      const review = await service.reviewPathCollision(paths, this.pathRenames.toPathMap(this.pathRenames.capture()));
      if (JSON.stringify({base: review.reviewToken, pending}) !== reviewToken) throw new Error("Recovery files changed. Reload the collision review.");
      const path = side === "source" ? pending.from : pending.to;
      const file = review.localFiles.find(file => file.path === path);
      if (!file?.contentHash) throw new Error("The selected recovery file cannot be verified on this device.");
      await this.collisionRenameJournal().recover({side, hash: file.contentHash});
    }, true);
    await this.requestSync();
  }

  private collisionRenameJournal(expectedRenames?: string): CollisionRenameJournal {
    return new CollisionRenameJournal(new ObsidianVaultPort(this.app.vault, () => this.session.assertActive()), {
      read: () => this.data.pendingCollisionRename,
      prepare: async intent => {
        this.session.assertActive();
        if (expectedRenames !== undefined && JSON.stringify(this.pathRenames.serialize()) !== expectedRenames) {
          throw new Error("Local rename records changed. Reload the collision review.");
        }
        const identitySourcePath = intent.entryId
          ? [...this.pathRenames.capture()].find(([, rename]) => rename.entryId === intent.entryId)?.[0] ??
            Object.values(this.data.cache?.files ?? {}).find(file => file.entryId === intent.entryId)?.path
          : undefined;
        if (intent.entryId && !identitySourcePath) throw new Error("The file identity changed. Reload the collision review.");
        this.data.pendingCollisionRename = {...intent, identitySourcePath};
        await this.savePluginData();
      },
      finish: async (intent, moved) => {
        this.session.assertActive();
        if (intent.entryId && intent.identitySourcePath) {
          const dirty = this.pathRenames.setReviewedRename(intent.entryId, intent.identitySourcePath, moved ? intent.to : intent.from);
          for (const path of dirty) this.dirtyPaths.mark(path);
        }
        this.data.pendingPathRenames = this.pathRenames.serialize();
        this.dirtyPaths.mark(intent.from); this.dirtyPaths.mark(intent.to);
        this.data.pendingCollisionRename = undefined;
        try { await this.savePluginData(); }
        catch (error) { this.data.pendingCollisionRename = intent; throw error; }
      },
    });
  }

  private async recoverCollisionRename(allowReview = false): Promise<void> {
    const pending = this.data.pendingCollisionRename;
    if (!pending) return;
    if (!isSafeTargetPath(pending.from) || !isSafeTargetPath(pending.to)) throw new Error("An interrupted rename contains an unsafe path.");
    if (await this.collisionRenameJournal().recover() === "needs-review") {
      if (!this.pendingLocalIssues.some(issue => issue.kind === "path-collision" && issue.paths.includes(pending.to))) {
        this.pendingLocalIssues.push({kind: "path-collision", paths: [pending.from, pending.to]});
      }
      if (!allowReview) throw new Error("An interrupted rename needs confirmation. Open sync status and choose Review path collision.");
    }
  }

  openVersionHistory(path: string): void {
    const entry = this.getLiveEntry(path);
    if (!entry?.history?.length) throw new Error("No recoverable versions are available for this file. Sync to refresh its history.");
    new VersionHistoryModal(this.app, this, entry).open();
  }

  readHistoricalRevision(entryId: string, revisionId: string): Promise<Uint8Array> {
    return this.runExclusiveSyncService(service => service.readHistoricalRevision(entryId, revisionId));
  }

  async resolveLocalContent(path: string, reviewToken: string, choice: LocalContentChoice): Promise<string | undefined> {
    try {
      const copyPath = await this.runExclusiveSyncService(service =>
        service.resolveLocalContent(path, reviewToken, choice),
      );
      this.pendingLocalIssues = this.pendingLocalIssues.filter(issue => !("path" in issue && issue.path === path));
      await this.requestSync();
      return copyPath;
    } catch (error) {
      this.showError(error);
      throw error;
    }
  }

  async openLocalFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      throw new Error("This file is not present on this device. Copy the path and use the device that holds it.");
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  async keepConflictDeleted(entryId: string): Promise<void> {
    await this.resolveConflictWith(entryId, { kind: "keep-deleted" });
  }

  async importCandidate(path: string): Promise<void> {
    try {
      await this.runExclusiveSyncService((service) =>
        service.importCandidate(path),
      );
      this.pendingLocalIssues = this.pendingLocalIssues.filter(
        (issue) => issue.kind !== "import-candidate" || issue.path !== path,
      );
      this.reportManualCompletion("Local file uploaded to S3 as a new file.");
    } catch (error) {
      this.showError(error);
      throw error;
    }
  }

  async downloadDeferred(entryId: string): Promise<void> {
    try {
      await this.runExclusiveSyncService((service) =>
        service.downloadDeferred(entryId),
      );
      this.pendingDeferredDownloads = this.pendingDeferredDownloads.filter(
        (entry) => entry.entryId !== entryId,
      );
      this.reportManualCompletion("Large file downloaded after explicit confirmation.");
    } catch (error) {
      this.showError(error);
      throw error;
    }
  }

  async resolveConflict(entryId: string, revisionId: string): Promise<void> {
    await this.resolveConflictWith(entryId, {
      kind: "restore-candidate",
      revisionId,
    });
  }

  async restoreRevision(entryId: string, revisionId: string): Promise<void> {
    try {
      await this.runExclusiveSyncService((service) =>
        service.restoreRevision(entryId, revisionId),
      );
      this.reportManualCompletion("Historical Revision restored.");
    } catch (error) {
      this.showError(error);
      throw error;
    }
  }

  async readDeletedRecovery(
    entryId: string,
    revisionId?: string,
  ): Promise<Uint8Array> {
    return this.runExclusiveSyncService((service) =>
      service.readDeletedRecovery(entryId, revisionId),
    );
  }

  async restoreDeleted(entryId: string, revisionId?: string): Promise<void> {
    try {
      await this.runExclusiveSyncService((service) =>
        service.restoreDeleted(entryId, revisionId),
      );
      this.reportManualCompletion("Deleted file restored as a new Revision.");
    } catch (error) {
      this.showError(error);
      throw error;
    }
  }

  async initializeOrUnlock(password: string): Promise<void> {
    return this.syncRequests.runExclusive(() =>
      this.session.run(() => this.initializeOrUnlockExclusive(password)),
    );
  }

  hasAwsCredentials(): boolean {
    return this.credentials.loadAwsCredentials() !== undefined;
  }

  isVaultUnlocked(): boolean {
    return Boolean(
      this.data.settings.vaultId && this.credentials.loadVaultKey(),
    );
  }

  private async initializeOrUnlockExclusive(password: string): Promise<void> {
    await this.recoverCollisionRename(true);
    const needsRenameReview = this.data.pendingCollisionRename !== undefined;
    const assertTarget = this.captureTargetGuard();
    const { bucket, region } = this.data.settings;
    const integrityTarget = this.integrityTarget();
    try {
      if (!password) {
        throw new Error("Enter the Vault password first");
      }
      this.setStatus("Checking", "Checking S3 and the encrypted Remote Store.");
      assertTarget();
      const objects = this.createObjectStore();
      const prefix = normalizePrefix(this.data.settings.prefix);
      const ownedProbeKeys = new Set((this.data.pendingProbes ?? [])
        .filter(probe => probe.bucket === bucket && probe.region === region && probe.prefix === prefix &&
          isProbeObjectKey(probe.key, prefix))
        .map(probe => probe.key));
      if (!needsRenameReview) for (const key of ownedProbeKeys) await objects.delete(key);
      const bootstrap = new BootstrapStore(objects, prefix);
      const existing = await bootstrap.read();
      const isNewRemote = existing === undefined;
      let vaultId: string;
      let vaultKey: Uint8Array;
      if (existing) {
        if (
          this.data.settings.vaultId &&
          this.data.settings.vaultId !== existing.vaultId
        ) {
          throw new Error(
            "This local Vault is already bound to a different Remote Store",
          );
        }
        vaultId = existing.vaultId;
        vaultKey = await VaultCrypto.unwrapKey(password, existing.envelope);
      } else {
        if (needsRenameReview) throw new Error("Resolve the interrupted rename before initializing a new Remote Store.");
        const existingKeys = await objects.list(prefix ? `${prefix}/` : "");
        if (existingKeys.some(key => !ownedProbeKeys.has(key))) {
          throw new Error("The selected S3 prefix is not empty");
        }
        const legacyPrefix = normalizePrefix(
          this.data.settings.remotelySavePrefix,
        );
        if (legacyPrefix) {
          if (!this.data.settings.confirmedRemotelySaveDisabled) {
            throw new Error(
              "Confirm that Remotely Save is disabled before migration",
            );
          }
          if (!Platform.isDesktopApp) {
            throw new Error("Remotely Save migration must run on desktop");
          }
          if (legacyPrefix === prefix) {
            throw new Error("The new prefix must differ from Remotely Save");
          }
          const comparison = await (
            await RemotelySaveMigration.open({
              objects,
              password,
              prefix: legacyPrefix,
            })
          ).compare(new ObsidianVaultPort(this.app.vault));
          if (comparison.status !== "clean") {
            const examples = comparison.differences
              .slice(0, 5)
              .map((difference) => `${difference.kind}: ${difference.path}`)
              .join("; ");
            throw new Error(
              `Remotely Save differs from this Vault (${comparison.differences.length} differences). ${examples}`,
            );
          }
        }
        await probeObjectStore(objects, prefix, async key => {
          ownedProbeKeys.add(key);
          this.data.pendingProbes = [...(this.data.pendingProbes ?? []), { bucket, region, prefix, key }];
          await this.savePluginData();
        });
        vaultId = crypto.randomUUID();
        vaultKey = VaultCrypto.generateVaultKey();
        this.data.pendingInitialization = {
          bucket,
          region,
          prefix,
          vaultId,
          phase: "uploading",
        };
        await this.savePluginData();
        await bootstrap.initialize({
          envelope: await VaultCrypto.wrapKey({ password, vaultKey }),
          protocolVersion: 1,
          vaultId,
        });
      }

      const remote = await RemoteStore.open({ objects, prefix, vaultKey });
      const currentHead = await remote.readHead();
      if (currentHead && currentHead.value.vaultId !== vaultId) {
        throw new Error("The selected prefix belongs to a different Vault");
      }
      if (!currentHead) {
        if (needsRenameReview) throw new RepairModeError("The existing Head must be recovered before path repair can continue");
        const pending = this.data.pendingInitialization;
        const canResume = pending?.phase === "uploading" &&
          pending.vaultId === vaultId && pending.prefix === prefix &&
          pending.bucket === this.data.settings.bucket && pending.region === this.data.settings.region &&
          (await objects.list(`${prefix ? `${prefix}/` : ""}v1/commits/`)).length === 0;
        if (!isNewRemote && !canResume) {
          throw new RepairModeError(
            "Key Envelope exists but Head is missing; writes are disabled for repair",
          );
        }
        await this.createSyncService(remote).initializeNew(vaultId, async () => {
          this.session.assertActive();
          const previous = this.data.pendingInitialization;
          if (!previous) throw new Error("Initialization checkpoint is missing");
          this.data.pendingInitialization = { ...previous, phase: "publishing" };
          try {
            await this.savePluginData();
          } catch (error) {
            this.data.pendingInitialization = previous;
            throw error;
          }
        });
        this.data.fullHashVerificationRequired = false;
        this.data.lastFullHashVerificationAt = Date.now();
        this.data.pendingPathRenames = {};
        this.pathRenames = new PathRenameTracker();
      }
      assertTarget();
      this.session.assertActive();
      this.credentials.saveVaultKey(vaultKey);
      this.data.settings.vaultId = vaultId;
      if (!needsRenameReview) {
        this.data.pendingInitialization = undefined;
        this.data.pendingProbes = (this.data.pendingProbes ?? []).filter(probe =>
          !(probe.bucket === bucket && probe.region === region && probe.prefix === prefix && ownedProbeKeys.has(probe.key)));
      }
      await this.savePluginData();
      this.setStatus(needsRenameReview ? "Action required" : "Idle", needsRenameReview
        ? "Unlocked. Open sync status to review the interrupted rename."
        : "Encrypted Remote Store is ready.");
      new Notice(needsRenameReview ? "Vault unlocked. Review the interrupted rename to resume sync." : "S3 Vault Sync is ready");
    } catch (error) {
      await this.rememberIntegrityFailure(error, integrityTarget);
      this.showError(error);
      throw error;
    }
  }

  async saveAwsCredentials(credentials: AwsCredentials): Promise<void> {
    if (!credentials.accessKeyId || !credentials.secretAccessKey) {
      const error = new Error("Enter both AWS credential fields");
      this.showError(error);
      throw error;
    }
    this.credentials.saveAwsCredentials(credentials);
    this.refreshConfiguredStatus();
    new Notice("AWS credentials saved in SecretStorage");
  }

  saveSettings(): Promise<void> {
    this.refreshConfiguredStatus();
    return this.savePluginData();
  }

  async syncNow(): Promise<void> {
    this.networkRetryAttempt = 0;
    return this.requestSync();
  }

  async verifyAllFiles(): Promise<void> {
    this.networkRetryAttempt = 0;
    return this.requestSync({ fullHashVerification: true }, "integrity-check");
  }

  async togglePause(): Promise<void> {
    this.data.settings.paused = !this.data.settings.paused;
    await this.savePluginData();
    if (this.data.settings.paused) {
      this.clearHeadRetryTimer();
      this.clearNetworkRetryTimer();
      this.setStatus("Paused", "Automatic sync is paused on this device.");
    } else {
      this.networkRetryAttempt = 0;
      this.setStatus("Checking", "Automatic sync resumed.");
      await this.requestAutomaticSync("resume");
    }
  }

  private createObjectStore(): AwsS3ObjectStore {
    const assertTarget = this.captureTargetGuard();
    const { bucket, region } = this.data.settings;
    const credentials = this.credentials.loadAwsCredentials();
    if (!bucket || !region || !this.data.settings.prefix) {
      throw new Error("AWS region, bucket, and prefix are required");
    }
    if (!credentials) {
      throw new Error("AWS credentials are not configured");
    }
    return new AwsS3ObjectStore({
      ...credentials,
      bucket,
      downloadChunkBytes: Platform.isAndroidApp
        ? ANDROID_DOWNLOAD_CHUNK_BYTES
        : undefined,
      execute: async (request) => {
        this.session.assertActive();
        assertTarget();
        const diagnostic = this.activeRun;
        if (diagnostic) {diagnostic.requests += 1; diagnostic.sentBytes += request.body?.byteLength ?? 0;}
        const response = await executeObsidianHttpRequest(request, this.session.signal);
        if (diagnostic) diagnostic.receivedBytes += response.body.byteLength;
        this.session.assertActive();
        assertTarget();
        return response;
      },
      region,
      uploadChunkBytes: Platform.isAndroidApp
        ? ANDROID_UPLOAD_CHUNK_BYTES
        : undefined,
    });
  }

  private createSyncService(
    remote: RemoteStore,
  ): SyncService {
    const assertTarget = this.captureTargetGuard();
    const integrityTarget = this.integrityTarget();
    const diagnostic = this.activeRun;
    const cache: SyncCachePort = {
      load: () => Promise.resolve(this.data.cache),
      save: async (state) => {
        this.session.assertActive();
        assertTarget();
        this.data.cache = state;
        if (diagnostic) this.diagnostics.phase(diagnostic, "saving");
        await this.savePluginData();
        this.acceptedCommit = state.snapshot.commitId;
        if (diagnostic) diagnostic.acceptedAfter = state.snapshot.commitId;
      },
    };
    return new SyncService({
      cache,
      local: new ObsidianVaultPort(this.app.vault, () => {
        this.session.assertActive();
        assertTarget();
      }),
      remote,
      onProgress: (progress) => this.updateSyncProgress(progress),
      onRemoteHead: commitId => { if (diagnostic) {diagnostic.observedRemote = commitId; diagnostic.remoteCheckedAt = Date.now();} },
      onRemotePublished: commitId => { if (diagnostic) diagnostic.publishedCommit = commitId; },
      onIntegrityVerified: check => this.clearVerifiedIntegrityIssue(integrityTarget, check),
      replicaId: this.data.settings.replicaId,
      yieldDuringHashing: this.yieldDuringHashing,
    });
  }

  private runExclusiveSyncService<T>(
    operation: (service: SyncService) => Promise<T>,
    allowCollisionReview = false,
  ): Promise<T> {
    return this.syncRequests.runExclusive(() => this.session.run(async () => {
      const integrityTarget = this.integrityTarget();
      await this.recoverCollisionRename(allowCollisionReview);
      const vaultKey = this.credentials.loadVaultKey();
      if (!vaultKey) {
        throw new Error("Unlock the encrypted Vault first");
      }
      const remote = await RemoteStore.open({
        objects: this.createObjectStore(),
        prefix: this.data.settings.prefix,
        vaultKey,
      });
      try {
        const pendingBefore = this.currentIntegrityChecks().length;
        const result = await operation(this.createSyncService(remote));
        if (this.integrityTarget() === integrityTarget && this.currentIntegrityChecks().length < pendingBefore) {
          this.reportManualCompletion("Previously reported remote content has been verified.");
        }
        return result;
      } catch (error) {
        await this.rememberIntegrityFailure(error, integrityTarget);
        throw error;
      }
    }));
  }

  private async loadPluginData(): Promise<void> {
    const stored = (await this.loadData()) as Partial<PersistedPluginData> | null;
    const settings = { ...DEFAULT_SETTINGS, ...stored?.settings };
    settings.fullHashVerificationIntervalDays =
      normalizeFullHashVerificationIntervalDays(
        settings.fullHashVerificationIntervalDays,
      );
    this.data = {
      cache: stored?.cache,
      fullHashVerificationRequired:
        stored?.fullHashVerificationRequired ?? false,
      lastFullHashVerificationAt: stored?.lastFullHashVerificationAt,
      pendingPathRenames: stored?.pendingPathRenames ?? {},
      pendingCollisionRename: stored?.pendingCollisionRename,
      pendingIntegrityChecks: stored?.pendingIntegrityChecks ?? [],
      pendingInitialization: stored?.pendingInitialization,
      pendingProbes: stored?.pendingProbes ?? [],
      settings,
    };
    this.acceptedCommit = this.data.cache?.snapshot.commitId;
    const pendingRenames = Object.entries(this.data.pendingPathRenames ?? {});
    const userRenames = pendingRenames.filter(([fromPath, rename]) =>
      typeof rename?.toPath !== "string" ||
      !isInternalStagingRename(fromPath, rename.toPath, this.app.vault.configDir),
    );
    this.data.pendingPathRenames = Object.fromEntries(userRenames);
    this.pathRenames = new PathRenameTracker(this.data.pendingPathRenames);
    if (!this.data.settings.replicaId || userRenames.length !== pendingRenames.length) {
      this.data.settings.replicaId ||= crypto.randomUUID();
      await this.savePluginData();
    }
  }

  private captureTargetGuard(): () => void {
    const { bucket, region, prefix } = this.data.settings;
    return () => {
      const current = this.data.settings;
      if (current.bucket !== bucket || current.region !== region ||
          normalizePrefix(current.prefix) !== normalizePrefix(prefix)) {
        throw new Error("S3 target changed during synchronization. Check the target and retry.");
      }
    };
  }

  private integrityTarget(): string {
    const {bucket, region, prefix, vaultId} = this.data.settings;
    return JSON.stringify([bucket, region, normalizePrefix(prefix), vaultId]);
  }

  private currentIntegrityChecks(): PendingIntegrityIssue[] {
    const target = this.integrityTarget();
    return (this.data.pendingIntegrityChecks ?? []).filter(issue => issue.target === target);
  }

  private async clearVerifiedIntegrityIssue(target: string, check: RemoteIntegrityCheck): Promise<void> {
    this.session.assertActive();
    if (target !== this.integrityTarget()) throw new Error("Vault changed during integrity recheck. Retry synchronization.");
    const previous = this.data.pendingIntegrityChecks ?? [];
    const remaining = previous.filter(issue => issue.target !== target || JSON.stringify(issue.check) !== JSON.stringify(check));
    if (remaining.length === previous.length) return;
    this.data.pendingIntegrityChecks = remaining;
    try { await this.savePluginData(); }
    catch (error) { this.data.pendingIntegrityChecks = previous; throw error; }
  }

  private async rememberIntegrityFailure(error: unknown, target: string): Promise<void> {
    if (this.session.signal.aborted || !(error instanceof RemoteStateError || error instanceof RepairModeError)) return;
    const check: RemoteIntegrityCheck = error instanceof RemoteStateError ? error.integrityCheck : {kind: "metadata"};
    const issues = this.data.pendingIntegrityChecks ?? [];
    this.data.pendingIntegrityChecks = issues.filter(issue => issue.target !== target || JSON.stringify(issue.check) !== JSON.stringify(check));
    this.data.pendingIntegrityChecks.push({target, check, message: error.message});
    if (target === this.integrityTarget()) this.setStatus("Action required", `Repair Mode: ${error.message}`);
    await this.savePluginData();
  }

  private async performSync({
    allowBulkDeletion,
    fullHashVerification: requestedFullHashVerification,
  }: SyncRunOptions): Promise<void> {
    const triggers = [...this.pendingTriggers];
    this.pendingTriggers.clear();
    const requestedTarget = this.pendingSyncTarget;
    this.pendingSyncTarget = undefined;
    // A queued/manual run consumes any recovery timer created by the preceding run.
    this.clearNetworkRetryTimer();
    if (triggers.some(trigger => trigger === "manual" || trigger === "resume" || trigger === "integrity-check")) this.networkRetryAttempt = 0;
    const integrityTarget = this.integrityTarget();
    const assertIntegrityTarget = this.captureTargetGuard();
    if (requestedTarget !== undefined && requestedTarget !== integrityTarget) {
      this.networkRetryAttempt = 0;
      this.networkFailureTarget = undefined;
      this.setStatus("Error", "S3 target changed while synchronization was queued. Check settings and sync again.");
      return;
    }
    if (this.networkFailureTarget !== undefined && this.networkFailureTarget !== integrityTarget) {
      this.clearNetworkRetryTimer();
      this.networkRetryAttempt = 0;
      this.networkFailureTarget = undefined;
    }
    if (this.data.settings.paused) {
      this.setStatus("Paused", "Automatic sync is paused on this device.");
      return;
    }
    const vaultKey = this.credentials.loadVaultKey();
    if (!vaultKey || !this.data.settings.vaultId) {
      this.setStatus("Not configured", "Initialize or unlock the encrypted Vault.");
      return;
    }
    if (this.headRetryTimer !== undefined) {
      this.clearHeadRetryTimer();
    }
    const diagnostic = await this.diagnostics.start(this.acceptedCommit, this.data.settings.vaultId, triggers);
    this.activeRun = diagnostic;
    let fullHashVerification = false;
    try {
      this.session.assertActive();
      assertIntegrityTarget();
      await this.recoverCollisionRename();
      const dirtySnapshot = this.dirtyPaths.capture();
      const pathRenameSnapshot = this.pathRenames.capture();
      fullHashVerification =
        requestedFullHashVerification ||
        (document.visibilityState === "visible" &&
          isFullHashVerificationDue(
            this.data.lastFullHashVerificationAt,
            this.data.cache !== undefined,
            Date.now(),
            this.data.fullHashVerificationRequired === true,
            this.data.settings.fullHashVerificationIntervalDays *
              24 *
              60 *
              60 *
              1_000,
          ));
      if (
        fullHashVerification &&
        this.data.fullHashVerificationRequired !== true
      ) {
        this.data.fullHashVerificationRequired = true;
        await this.savePluginData();
      }
      this.setStatus("Checking", "Reading encrypted remote Head.");
      this.diagnostics.phase(diagnostic, "remote");
      const objects = this.createObjectStore();
      const remote = await RemoteStore.open({
        objects,
        prefix: this.data.settings.prefix,
        vaultKey,
      });
      const boundHead = await remote.readHead();
      diagnostic.observedRemote = boundHead?.value.commitId;
      diagnostic.remoteCheckedAt = Date.now();
      if (
        !boundHead ||
        boundHead.value.vaultId !== this.data.settings.vaultId
      ) {
        throw new RepairModeError(
          "Remote Head is missing or belongs to a different Vault",
        );
      }
      const integrityChecks = this.currentIntegrityChecks();
      for (const issue of integrityChecks) {
        await this.createSyncService(remote).verifyRemoteIntegrity([issue.check], this.data.settings.vaultId);
        this.session.assertActive();
        assertIntegrityTarget();
        await this.clearVerifiedIntegrityIssue(integrityTarget, issue.check);
      }
      const retryHashMemo = new Map<string, VerifiedLocalFile>();
      const result = await retryHeadChanges(
        async (attempt, totalAttempts) => {
          this.setStatus(
            "Syncing",
            `Synchronizing (attempt ${attempt}/${totalAttempts}).`,
          );
          return this.createSyncService(
            remote,
          ).synchronize(
            allowBulkDeletion
              ? this.approvedBulkDeletionEntryIds
              : undefined,
            {
              assertLocalObservationCurrent: () => {
                const changedPath =
                  this.dirtyPaths.changedPathSince(dirtySnapshot);
                if (changedPath) {
                  throw new LocalStateChangedError(changedPath);
                }
              },
              forceHashPaths: new Set(dirtySnapshot.keys()),
              fullHashVerification:
                fullHashVerification && attempt === 1,
              pathRenames: this.pathRenames.toPathMap(pathRenameSnapshot),
              renameResolution: this.approvedRenameResolution,
              retryHashMemo,
            },
          );
        },
        {
          baseDelaysMs: allowBulkDeletion ? [] : undefined,
        },
      );
      this.clearHeadRetryTimer();
      this.headRetryAttempt = 0;
      this.networkRetryAttempt = 0;
      this.networkFailureTarget = undefined;
      this.pendingBulkDeletion = result.bulkDeletion;
      this.pendingLocalIssues = result.localIssues;
      this.pendingDeferredDownloads = result.deferredDownloadEntries;
      diagnostic.outcome = result.status;
      diagnostic.counts = {uploaded: result.uploaded, downloaded: result.downloaded, deleted: result.deleted,
        deferred: result.deferredDownloads, unsynced: result.unsyncedLocalEntries};
      if (result.cacheUpdated) {diagnostic.pendingUploads = 0; diagnostic.pendingDownloads = 0;}
      if (result.cacheUpdated) {
        this.approvedRenameResolution = undefined;
        const unverifiedLocalPaths = new Set(
          result.localIssues.flatMap((issue) =>
            issue.kind === "unsynced-local" ? [issue.path] : [],
          ),
        );
        const previousVerificationAt =
          this.data.lastFullHashVerificationAt;
        const previousVerificationRequired =
          this.data.fullHashVerificationRequired;
        this.pathRenames.acknowledge(
          pathRenameSnapshot,
          unverifiedLocalPaths,
        );
        this.data.pendingPathRenames = this.pathRenames.serialize();
        if (fullHashVerification) {
          this.data.fullHashVerificationRequired = false;
          this.data.lastFullHashVerificationAt = Date.now();
        }
        try {
          if (fullHashVerification || pathRenameSnapshot.size > 0) {
            await this.savePluginData();
          }
        } catch (error) {
          this.data.pendingPathRenames = this.pathRenames.serialize();
          this.data.lastFullHashVerificationAt = previousVerificationAt;
          this.data.fullHashVerificationRequired =
            previousVerificationRequired;
          throw error;
        }
        this.dirtyPaths.acknowledge(dirtySnapshot, unverifiedLocalPaths);
      }
      if (result.status === "action-required") {
        this.setStatus(
          "Action required",
          result.bulkDeletion
            ? "Review and confirm the Bulk Deletion."
            : "Open sync status to review items that need attention.",
        );
      } else {
        this.pendingBulkDeletion = undefined;
        this.setStatus(
          "Idle",
          `Downloaded ${result.downloaded}, uploaded ${result.uploaded}, deleted ${result.deleted}, deferred ${result.deferredDownloads}, unsynced ${result.unsyncedLocalEntries}.`,
        );
      }
    } catch (error) {
      const retryableNetwork = error instanceof S3TransportError ||
        (error instanceof S3RequestError && [408, 429, 500, 502, 503, 504].includes(error.status));
      if (!retryableNetwork) {this.networkFailureTarget = undefined; this.networkRetryAttempt = 0;}
      diagnostic.errorCategory = error instanceof S3TransportError ? error.kind
        : error instanceof S3RequestError ? ([401, 403].includes(error.status) ? "authentication" : "service")
        : error instanceof RemoteStateError || error instanceof RepairModeError ? "remote-integrity"
        : error instanceof HeadChangedError ? "head-race" : error instanceof LocalStateChangedError ? "local-change"
        : error instanceof SyncStoppedError ? "cancelled" : "unknown";
      if (error instanceof S3RequestError) diagnostic.httpStatus = error.status;
      if (error instanceof S3TransportError) diagnostic.writeResultUncertain = error.writeMayHaveSucceeded;
      this.approvedRenameResolution = undefined;
      if (error instanceof SyncStoppedError) { diagnostic.outcome = "interrupted"; return; }
      if (error instanceof HeadChangedError) {
        diagnostic.outcome = "retrying";
        this.scheduleHeadRetry(fullHashVerification);
      } else if (error instanceof LocalStateChangedError) {
        diagnostic.outcome = "retrying";
        this.dirtyPaths.mark(error.path);
        this.setStatus(
          "Checking",
          "A local file changed during synchronization. Retrying after edits settle.",
        );
        this.scheduleAfterLocalChange();
      } else if (retryableNetwork && this.scheduleNetworkRetry(integrityTarget)) {
        diagnostic.outcome = "retrying";
      } else {
        diagnostic.outcome = "error";
        await this.rememberIntegrityFailure(error, integrityTarget);
        this.showError(error);
      }
    } finally {
      diagnostic.nextRetryAt = this.networkRetryAt ?? this.headRetryAt;
      this.activeRun = undefined;
      await this.diagnostics.finish(diagnostic);
      this.emitStatus();
      if (
        !this.session.signal.aborted &&
        this.data.settings.paused &&
        this.status !== "Error" &&
        this.status !== "Action required"
      ) {
        this.setStatus("Paused", "Automatic sync is paused on this device.");
      }
    }
  }

  private clearHeadRetryTimer(): void {
    if (this.headRetryTimer !== undefined) {
      window.clearTimeout(this.headRetryTimer);
      this.headRetryTimer = undefined;
    }
    this.headRetryAt = undefined;
  }

  private clearNetworkRetryTimer(): void {
    if (this.networkRetryTimer !== undefined) window.clearTimeout(this.networkRetryTimer);
    this.networkRetryTimer = undefined;
    this.networkRetryAt = undefined;
  }

  private scheduleNetworkRetry(target: string): boolean {
    if (this.integrityTarget() !== target) {
      this.networkFailureTarget = undefined;
      this.networkRetryAttempt = 0;
      return false;
    }
    this.networkFailureTarget = target;
    const delays = [2_000, 5_000, 15_000];
    const baseDelay = delays[this.networkRetryAttempt];
    if (this.session.signal.aborted || this.data.settings.paused || baseDelay === undefined) return false;
    const delay = baseDelay + Math.floor(Math.random() * baseDelay / 4);
    this.networkRetryAttempt += 1;
    this.networkRetryAt = Date.now() + delay;
    this.setStatus(this.currentIntegrityChecks().length ? "Error" : "Checking",
      `Temporary network failure. Retrying automatically in ${Math.ceil(delay / 1_000)} seconds (${this.networkRetryAttempt}/3).`);
    this.networkRetryTimer = window.setTimeout(() => {
      this.networkRetryTimer = undefined;
      this.networkRetryAt = undefined;
      if (this.session.signal.aborted || this.data.settings.paused || this.integrityTarget() !== target) return;
      void this.requestSync({}, "network-retry");
    }, delay);
    return true;
  }

  private scheduleHeadRetry(fullHashVerification = false): void {
    if (this.session.signal.aborted) return;
    this.data.fullHashVerificationRequired ||= fullHashVerification;
    if (this.data.settings.paused || this.headRetryTimer !== undefined) {
      return;
    }
    const baseDelay = Math.min(30_000, 1_000 * 2 ** this.headRetryAttempt);
    const delay = baseDelay + Math.floor(Math.random() * baseDelay);
    this.headRetryAttempt += 1;
    this.headRetryAt = Date.now() + delay;
    this.setStatus(
      "Checking",
      `Another device published first. Retrying automatically in ${Math.ceil(delay / 1_000)} seconds.`,
    );
    this.headRetryTimer = window.setTimeout(() => {
      this.headRetryTimer = undefined;
      this.headRetryAt = undefined;
      const retryFullHashVerification =
        this.data.fullHashVerificationRequired === true;
      void this.requestSync({
        fullHashVerification: retryFullHashVerification,
      }, "head-retry");
    }, delay);
  }

  private async resolveConflictWith(
    entryId: string,
    resolution:
      | { kind: "keep-deleted" }
      | { kind: "restore-candidate"; revisionId: string },
  ): Promise<void> {
    try {
      await this.runExclusiveSyncService((service) =>
        service.resolveConflict(entryId, resolution),
      );
      this.reportManualCompletion("Conflict resolution saved to S3.");
    } catch (error) {
      this.showError(error);
      throw error;
    }
  }

  private reportManualCompletion(detail: string): void {
    // A queued/running sync owns its status; one manual success cannot declare the whole Vault settled.
    if (this.syncRequests.isRunning) return;
    if (this.pendingLocalIssues.length || this.getConflicts().length ||
      this.pendingDeferredDownloads.some(entry => entry.reason === "unsupported-path") ||
      this.pendingBulkDeletion || this.data.pendingCollisionRename) {
      this.setStatus("Action required", `${detail} Other items still need attention. Open sync status to review them.`);
    } else {
      const deferred = this.pendingDeferredDownloads.length
        ? ` Deferred downloads: ${this.pendingDeferredDownloads.length}.`
        : "";
      this.setStatus(
        this.data.settings.paused ? "Paused" : "Idle",
        `${detail}${deferred}${this.data.settings.paused ? " Automatic sync remains paused." : ""}`,
      );
    }
  }

  private refreshConfiguredStatus(): void {
    if (this.syncRequests.isRunning || !["Idle", "Paused", "Not configured"].includes(this.status)) return;
    if (this.data.settings.paused) {
      this.setStatus("Paused", "Automatic sync is paused on this device.");
    } else if (
      this.data.settings.vaultId &&
      this.credentials?.loadAwsCredentials() &&
      this.credentials.loadVaultKey()
    ) {
      this.setStatus("Idle", "Ready to sync.");
    } else {
      this.setStatus("Not configured", "Complete the plugin settings.");
    }
  }

  private registerVaultEvents(): void {
    const schedule = (file: TAbstractFile): void => {
      if (this.session.signal.aborted) return;
      if (isInSyncScope(file.path)) {
        this.dirtyPaths.mark(file.path);
        this.scheduleAfterLocalChange();
      }
    };
    this.registerEvent(this.app.vault.on("create", schedule));
    this.registerEvent(this.app.vault.on("modify", schedule));
    this.registerEvent(this.app.vault.on("delete", schedule));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.session.signal.aborted) return;
        if (isInternalStagingRename(oldPath, file.path, this.app.vault.configDir)) return;
        const dirtyRenamePaths = this.pathRenames.record(
          Object.values(this.data.cache?.files ?? {}),
          oldPath,
          file.path,
        );
        this.data.pendingPathRenames = this.pathRenames.serialize();
        void this.savePluginData().catch((error: unknown) => {
          this.showError(error);
        });
        for (const path of dirtyRenamePaths) {
          if (isInSyncScope(path)) {
            this.dirtyPaths.mark(path);
          }
        }
        if (isInSyncScope(oldPath) || isInSyncScope(file.path)) {
          this.scheduleAfterLocalChange();
        }
      }),
    );
  }

  private async savePluginData(): Promise<void> {
    await this.session.run(() => this.pluginDataWriter.save());
  }

  private scheduleAfterLocalChange(): void {
    if (this.session.signal.aborted || this.data.settings.paused) {
      return;
    }
    if (this.changeTimer !== undefined) {
      window.clearTimeout(this.changeTimer);
    }
    this.changeTimer = window.setTimeout(() => {
      this.changeTimer = undefined;
      void this.requestAutomaticSync();
    }, 5_000);
  }

  private requestFinalSync(): void {
    if (!this.session.signal.aborted && this.data && !this.data.settings.paused) {
      void this.requestAutomaticSync("shutdown");
    }
  }

  private requestAutomaticSync(trigger: SyncTrigger = "edit"): Promise<void> {
    return this.requestSync({}, trigger);
  }

  private requestPeriodicSync(trigger: SyncTrigger = "periodic"): Promise<void> {
    if (this.session.signal.aborted) return Promise.resolve();
    if (!this.syncRequests.isRunning && this.headRetryTimer === undefined && this.networkRetryTimer === undefined) {
      this.pendingTriggers.add(trigger);
      this.pendingSyncTarget = this.integrityTarget();
    }
    return this.syncRequests.requestPeriodic(
      this.headRetryTimer !== undefined || this.networkRetryTimer !== undefined,
    ).catch((error: unknown) => {
      if (!(error instanceof SyncStoppedError)) throw error;
    });
  }

  private requestSync(
    options: SyncRequestOptions = {},
    trigger: SyncTrigger = "manual",
  ): Promise<void> {
    if (this.session.signal.aborted) return Promise.resolve();
    this.pendingTriggers.add(trigger);
    this.pendingSyncTarget = this.integrityTarget();
    this.clearHeadRetryTimer();
    this.clearNetworkRetryTimer();
    return this.syncRequests.request(options).catch((error: unknown) => {
      if (!(error instanceof SyncStoppedError)) throw error;
    });
  }

  private setStatus(
    status: PluginStatus,
    detail: string,
    progressLabel?: string,
  ): void {
    const integrityChecks = this.data ? this.currentIntegrityChecks() : [];
    if (integrityChecks.length && status !== "Checking" && status !== "Syncing") {
      const lastError = status === "Error" ? ` Last attempt: ${detail}` : "";
      status = "Action required";
      detail = `Repair Mode: ${integrityChecks[0]!.message} (${integrityChecks.length} pending integrity checks). Resolve the reported problem, then sync to recheck.` +
        (this.data.settings.paused ? " Automatic sync remains paused." : "") + lastError;
    }
    if (this.session.signal.aborted) return;
    if (status !== "Syncing") {
      this.syncProgressThrottle.reset();
    }
    this.status = status;
    this.statusDetail = detail;
    this.progressLabel = progressLabel;
    this.statusElement?.setText(`S3 Sync: ${detail}`);
    this.statusElement?.setAttr("aria-label", this.getStatusText());
    this.statusElement?.setAttr("title", this.getStatusText());
    this.statusElement?.toggleClass(
      "s3-vault-sync-error",
      status === "Action required" || status === "Error",
    );
    this.emitStatus();
  }

  private emitStatus(): void {
    if (this.session.signal.aborted) return;
    const display: SyncStatusDisplay = {
      ...(this.progressLabel ? { progressLabel: this.progressLabel } : {}),
      text: this.getStatusText(),
    };
    for (const listener of this.statusListeners) {
      listener(display);
    }
  }

  private updateSyncProgress(progress: SyncProgress): void {
    if (this.activeRun) {
      this.diagnostics.phase(this.activeRun, progress.phase);
      if (progress.phase === "uploading") this.activeRun.pendingUploads = Math.max(0, progress.total - progress.completed);
      if (progress.phase === "downloading") this.activeRun.pendingDownloads = Math.max(0, progress.total - progress.completed);
    }
    if (!this.syncProgressThrottle.shouldRender(progress, performance.now())) {
      return;
    }
    const formatted = formatSyncProgress(progress);
    this.setStatus("Syncing", formatted.detail, formatted.label);
  }

  private showError(error: unknown): void {
    if (this.session.signal.aborted || error instanceof SyncStoppedError) return;
    const message = error instanceof Error ? error.message : "Unknown sync error";
    this.setStatus(
      error instanceof RepairModeError || error instanceof RemoteStateError
        ? "Action required"
        : "Error",
      error instanceof RepairModeError || error instanceof RemoteStateError
        ? `Repair Mode: ${message}`
        : message,
    );
    const notice = new Notice(`S3 Vault Sync: ${message}`, 12_000);
    notice.messageEl.createEl("button", {text: "Open sync status", cls: "s3-vault-sync-notice-action"}).addEventListener("click", event => {
      event.stopPropagation();
      this.openStatus();
      notice.hide();
    });
  }
}
