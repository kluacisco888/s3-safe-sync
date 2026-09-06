import {
  Notice,
  Platform,
  Plugin,
  type TAbstractFile,
} from "obsidian";

import { VaultCrypto } from "./crypto/vault-crypto";
import { RemotelySaveMigration } from "./migration/remotely-save-migration";
import { CredentialStore, type AwsCredentials } from "./plugin/credential-store";
import { StatusModal, VersionHistoryModal } from "./plugin/modals";
import { ObsidianVaultPort, isInSyncScope } from "./plugin/obsidian-vault-port";
import { formatSyncProgress } from "./plugin/sync-progress";
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
  type SyncCachePort,
  type SyncProgress,
} from "./sync/sync-service";
import type {
  ConflictedEntry,
  DeletedEntry,
  LiveEntry,
} from "./sync/sync-engine";
import { SyncRequestQueue } from "./sync/sync-request-queue";
import { AwsS3ObjectStore } from "./storage/aws-s3-object-store";
import { BootstrapStore } from "./storage/bootstrap-store";
import { executeObsidianHttpRequest } from "./storage/obsidian-http";
import { probeObjectStore } from "./storage/object-store-probe";
import {
  HeadChangedError,
  RemoteStateError,
  RemoteStore,
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

interface PersistedPluginData {
  cache?: CachedSyncState;
  settings: S3VaultSyncSettings;
}

const normalizePrefix = (prefix: string): string =>
  prefix.replace(/^\/+|\/+$/gu, "");

const ANDROID_DOWNLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const ANDROID_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

const mobileAutomaticFileLimit = (): number | undefined => {
  if (!Platform.isMobile) {
    return undefined;
  }
  const network = (
    navigator as Navigator & { connection?: { type?: string } }
  ).connection;
  return network?.type === "wifi" ? 50 * 1024 * 1024 : 10 * 1024 * 1024;
};

export default class S3VaultSyncPlugin
  extends Plugin
  implements SettingsController
{
  private changeTimer: number | undefined;
  private credentials!: CredentialStore;
  private data!: PersistedPluginData;
  private pendingBulkDeletion:
    | { count: number; totalLiveEntries: number }
    | undefined;
  private pendingLocalIssues: LocalSyncIssue[] = [];
  private pendingDeferredDownloads: DeferredDownloadEntry[] = [];
  private readonly syncRequests = new SyncRequestQueue((allowBulkDeletion) =>
    this.performSync(allowBulkDeletion),
  );
  private status: PluginStatus = "Not configured";
  private statusDetail = "Enter AWS settings and a Vault password.";
  private statusElement: HTMLElement | undefined;
  private readonly statusListeners = new Set<
    (status: SyncStatusDisplay) => void
  >();
  private progressLabel: string | undefined;

  async onload(): Promise<void> {
    await this.loadPluginData();
    this.credentials = new CredentialStore(this.app.secretStorage);
    this.addSettingTab(new S3VaultSyncSettingsTab(this.app, this));
    this.addRibbonIcon("refresh-cw", "Open S3 Vault Sync", () => {
      new StatusModal(this.app, this).open();
    });
    this.addCommand({
      callback: () => new StatusModal(this.app, this).open(),
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
          new VersionHistoryModal(this.app, this, entry).open();
        }
        return true;
      },
      id: "open-version-history",
      name: "Open version history for the current file",
    });
    if (Platform.isDesktop) {
      this.statusElement = this.addStatusBarItem();
      this.statusElement.addClass("s3-vault-sync-status-bar");
    }
    this.refreshConfiguredStatus();
    this.app.workspace.onLayoutReady(() => {
      this.registerVaultEvents();
      if (!this.data.settings.paused) {
        void this.syncNow();
      }
    });
    this.registerInterval(
      window.setInterval(() => {
        if (!this.data.settings.paused && document.visibilityState === "visible") {
          void this.syncNow();
        }
      }, 120_000),
    );
    this.registerDomEvent(document, "visibilitychange", () => {
      if (
        document.visibilityState === "visible" &&
        !this.data.settings.paused
      ) {
        void this.syncNow();
      }
    });
  }

  onunload(): void {
    if (this.changeTimer !== undefined) {
      window.clearTimeout(this.changeTimer);
    }
  }

  getSettings(): S3VaultSyncSettings {
    return this.data.settings;
  }

  getStatusText(): string {
    return `${this.status}: ${this.statusDetail}`;
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
    | { count: number; totalLiveEntries: number }
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
        entry.kind === "deleted" && entry.recovery !== undefined,
    );
  }

  async confirmBulkDeletion(): Promise<void> {
    if (!this.pendingBulkDeletion || this.syncRequests.isRunning) {
      return;
    }
    await this.syncRequests.request({ allowBulkDeletion: true });
  }

  async keepConflictDeleted(entryId: string): Promise<void> {
    await this.resolveConflictWith(entryId, { kind: "keep-deleted" });
  }

  async importCandidate(path: string): Promise<void> {
    try {
      const vaultKey = this.credentials.loadVaultKey();
      if (!vaultKey) {
        throw new Error("Unlock the encrypted Vault first");
      }
      const remote = await RemoteStore.open({
        objects: this.createObjectStore(),
        prefix: this.data.settings.prefix,
        vaultKey,
      });
      await this.createSyncService(remote).importCandidate(path);
      this.pendingLocalIssues = this.pendingLocalIssues.filter(
        (issue) => issue.kind !== "import-candidate" || issue.path !== path,
      );
      this.setStatus("Idle", "Import Candidate added to the shared Vault.");
    } catch (error) {
      this.showError(error);
    }
  }

  async downloadDeferred(entryId: string): Promise<void> {
    try {
      const vaultKey = this.credentials.loadVaultKey();
      if (!vaultKey) {
        throw new Error("Unlock the encrypted Vault first");
      }
      const remote = await RemoteStore.open({
        objects: this.createObjectStore(),
        prefix: this.data.settings.prefix,
        vaultKey,
      });
      await this.createSyncService(remote).downloadDeferred(entryId);
      this.pendingDeferredDownloads = this.pendingDeferredDownloads.filter(
        (entry) => entry.entryId !== entryId,
      );
      this.setStatus("Idle", "Large file downloaded after explicit confirmation.");
    } catch (error) {
      this.showError(error);
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
      const vaultKey = this.credentials.loadVaultKey();
      if (!vaultKey) {
        throw new Error("Unlock the encrypted Vault first");
      }
      const remote = await RemoteStore.open({
        objects: this.createObjectStore(),
        prefix: this.data.settings.prefix,
        vaultKey,
      });
      await this.createSyncService(remote).restoreRevision(entryId, revisionId);
      this.setStatus("Idle", "Historical Revision restored.");
    } catch (error) {
      this.showError(error);
    }
  }

  async restoreDeleted(entryId: string): Promise<void> {
    try {
      const vaultKey = this.credentials.loadVaultKey();
      if (!vaultKey) {
        throw new Error("Unlock the encrypted Vault first");
      }
      const remote = await RemoteStore.open({
        objects: this.createObjectStore(),
        prefix: this.data.settings.prefix,
        vaultKey,
      });
      await this.createSyncService(remote).restoreDeleted(entryId);
      this.setStatus("Idle", "Deleted file restored as a new Revision.");
    } catch (error) {
      this.showError(error);
    }
  }

  async initializeOrUnlock(password: string): Promise<void> {
    try {
      if (!password) {
        throw new Error("Enter the Vault password first");
      }
      this.setStatus("Checking", "Checking S3 and the encrypted Remote Store.");
      const objects = this.createObjectStore();
      const prefix = normalizePrefix(this.data.settings.prefix);
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
        const existingKeys = await objects.list(prefix ? `${prefix}/` : "");
        if (existingKeys.length > 0) {
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
        await probeObjectStore(objects, prefix);
        vaultId = crypto.randomUUID();
        vaultKey = VaultCrypto.generateVaultKey();
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
        if (!isNewRemote) {
          throw new RepairModeError(
            "Key Envelope exists but Head is missing; writes are disabled for repair",
          );
        }
        await this.createSyncService(remote).initializeNew(vaultId);
      }
      this.credentials.saveVaultKey(vaultKey);
      this.data.settings.vaultId = vaultId;
      await this.savePluginData();
      this.setStatus("Idle", "Encrypted Remote Store is ready.");
      new Notice("S3 Vault Sync is ready");
    } catch (error) {
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
    return this.syncRequests.request();
  }

  async togglePause(): Promise<void> {
    this.data.settings.paused = !this.data.settings.paused;
    await this.savePluginData();
    if (this.data.settings.paused) {
      this.setStatus("Paused", "Automatic sync is paused on this device.");
    } else {
      this.setStatus("Checking", "Automatic sync resumed.");
      await this.syncNow();
    }
  }

  private createObjectStore(): AwsS3ObjectStore {
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
      execute: executeObsidianHttpRequest,
      region,
      uploadChunkBytes: Platform.isAndroidApp
        ? ANDROID_UPLOAD_CHUNK_BYTES
        : undefined,
    });
  }

  private createSyncService(
    remote: RemoteStore,
    allowBulkDeletion = false,
  ): SyncService {
    const cache: SyncCachePort = {
      load: () => Promise.resolve(this.data.cache),
      save: async (state) => {
        this.data.cache = state;
        await this.savePluginData();
      },
    };
    return new SyncService({
      allowBulkDeletion,
      cache,
      local: new ObsidianVaultPort(this.app.vault),
      maxAutomaticFileBytes: mobileAutomaticFileLimit(),
      remote,
      onProgress: (progress) => this.updateSyncProgress(progress),
      replicaId: this.data.settings.replicaId,
    });
  }

  private async loadPluginData(): Promise<void> {
    const stored = (await this.loadData()) as Partial<PersistedPluginData> | null;
    this.data = {
      cache: stored?.cache,
      settings: { ...DEFAULT_SETTINGS, ...stored?.settings },
    };
    if (!this.data.settings.replicaId) {
      this.data.settings.replicaId = crypto.randomUUID();
      await this.savePluginData();
    }
  }

  private async performSync(allowBulkDeletion = false): Promise<void> {
    if (this.data.settings.paused) {
      this.setStatus("Paused", "Automatic sync is paused on this device.");
      return;
    }
    const vaultKey = this.credentials.loadVaultKey();
    if (!vaultKey || !this.data.settings.vaultId) {
      this.setStatus("Not configured", "Initialize or unlock the encrypted Vault.");
      return;
    }
    try {
      this.setStatus("Checking", "Reading encrypted remote Head.");
      const objects = this.createObjectStore();
      const remote = await RemoteStore.open({
        objects,
        prefix: this.data.settings.prefix,
        vaultKey,
      });
      const boundHead = await remote.readHead();
      if (
        !boundHead ||
        boundHead.value.vaultId !== this.data.settings.vaultId
      ) {
        throw new RepairModeError(
          "Remote Head is missing or belongs to a different Vault",
        );
      }
      let attempt = 0;
      while (attempt < 3) {
        attempt += 1;
        try {
          this.setStatus("Syncing", `Synchronizing (attempt ${attempt}/3).`);
          const result = await this.createSyncService(
            remote,
            allowBulkDeletion,
          ).synchronize();
          this.pendingBulkDeletion = result.bulkDeletion;
          this.pendingLocalIssues = result.localIssues;
          this.pendingDeferredDownloads = result.deferredDownloadEntries;
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
          return;
        } catch (error) {
          if (error instanceof HeadChangedError && attempt < 3) {
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      this.showError(error);
    }
  }

  private async resolveConflictWith(
    entryId: string,
    resolution:
      | { kind: "keep-deleted" }
      | { kind: "restore-candidate"; revisionId: string },
  ): Promise<void> {
    try {
      const vaultKey = this.credentials.loadVaultKey();
      if (!vaultKey) {
        throw new Error("Unlock the encrypted Vault first");
      }
      const remote = await RemoteStore.open({
        objects: this.createObjectStore(),
        prefix: this.data.settings.prefix,
        vaultKey,
      });
      await this.createSyncService(remote).resolveConflict(entryId, resolution);
      this.setStatus("Idle", "Conflict resolved and shared with every device.");
    } catch (error) {
      this.showError(error);
    }
  }

  private refreshConfiguredStatus(): void {
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
      if (isInSyncScope(file.path)) {
        this.scheduleAfterLocalChange();
      }
    };
    this.registerEvent(this.app.vault.on("create", schedule));
    this.registerEvent(this.app.vault.on("modify", schedule));
    this.registerEvent(this.app.vault.on("delete", schedule));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        const cache = this.data.cache;
        if (cache) {
          const renamed: Array<[string, CachedSyncState["files"][string]]> = [];
          for (const [path, cachedFile] of Object.entries(cache.files)) {
            if (path === oldPath || path.startsWith(`${oldPath}/`)) {
              const suffix = path.slice(oldPath.length);
              renamed.push([
                `${file.path}${suffix}`,
                { ...cachedFile, path: `${file.path}${suffix}` },
              ]);
              delete cache.files[path];
            }
          }
          for (const [path, cachedFile] of renamed) {
            cache.files[path] = cachedFile;
          }
          void this.savePluginData();
        }
        schedule(file);
      }),
    );
  }

  private async savePluginData(): Promise<void> {
    await this.saveData(this.data);
  }

  private scheduleAfterLocalChange(): void {
    if (this.data.settings.paused) {
      return;
    }
    if (this.changeTimer !== undefined) {
      window.clearTimeout(this.changeTimer);
    }
    this.changeTimer = window.setTimeout(() => {
      this.changeTimer = undefined;
      void this.syncNow();
    }, 5_000);
  }

  private setStatus(
    status: PluginStatus,
    detail: string,
    progressLabel?: string,
  ): void {
    this.status = status;
    this.statusDetail = detail;
    this.progressLabel = progressLabel;
    this.statusElement?.setText(`S3 Sync: ${progressLabel ? detail : status}`);
    this.statusElement?.setAttr("aria-label", this.getStatusText());
    this.statusElement?.setAttr("title", this.getStatusText());
    this.statusElement?.toggleClass(
      "s3-vault-sync-error",
      status === "Action required" || status === "Error",
    );
    const display: SyncStatusDisplay = {
      ...(progressLabel ? { progressLabel } : {}),
      text: this.getStatusText(),
    };
    for (const listener of this.statusListeners) {
      listener(display);
    }
  }

  private updateSyncProgress(progress: SyncProgress): void {
    const formatted = formatSyncProgress(progress);
    this.setStatus("Syncing", formatted.detail, formatted.label);
  }

  private showError(error: unknown): void {
    const message = error instanceof Error ? error.message : "Unknown sync error";
    this.setStatus(
      error instanceof RepairModeError || error instanceof RemoteStateError
        ? "Action required"
        : "Error",
      error instanceof RepairModeError || error instanceof RemoteStateError
        ? `Repair Mode: ${message}`
        : message,
    );
    new Notice(`S3 Vault Sync: ${message}`);
  }
}
