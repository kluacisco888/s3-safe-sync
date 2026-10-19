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
import type { CleanupController, CleanupView, PendingCleanupItem } from "./plugin/cleanup-modal";
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
  orphanBlobKey,
  type CleanupCandidates,
  type DeferredDownloadEntry,
  type ExpiredContentCleanupResult,
  type LocalSyncIssue,
  type LocalContentReview,
  type LocalContentChoice,
  type PossibleRenameResolution,
  type SyncCachePort,
  type SyncProgress,
  type SyncResult,
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

// 状态的内部取值保持英文（逻辑判断用），界面只显示这里的中文名
const statusLabels: Record<PluginStatus, string> = {
  "Action required": "需要处理",
  Checking: "检查中",
  Error: "出错",
  Idle: "空闲",
  "Not configured": "未配置",
  Paused: "已暂停",
  Syncing: "同步中",
};

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
  // 「待清理」：用户确认过的项目队列和上一次算出的可清理数量，只存在电脑本地，绑定仓库目标（桶、区域、前缀、vaultId）
  manualCleanup?: ManualCleanupState;
  settings: S3VaultSyncSettings;
}

const normalizePrefix = (prefix: string): string =>
  prefix.replace(/^\/+|\/+$/gu, "");

interface ManualCleanupState {
  target: string;
  // 用户已确认所有设备都更新到 0.1.10 或更高；同一目标之后不再问
  devicesConfirmed?: boolean;
  queue: PendingCleanupItem[];
  // 上一次算出的可清理项目（key）和那次读到的 AWS 时间；状态窗口的数字只用它，不读 S3
  candidates?: { keys: string[]; serverDate: string };
  // 处理出错后，这个 AWS 时间之前不再处理
  pausedUntil?: string;
}

const isAwsTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

const isPendingCleanupItem = (value: unknown): value is PendingCleanupItem => {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.key === "string" && typeof item.blobId === "string" && typeof item.size === "number" &&
    (item.kind === "recovery" || item.kind === "history" || item.kind === "orphan") && isAwsTime(item.confirmedAt) &&
    (item.path === undefined || typeof item.path === "string") && (item.recordRemovedAt === undefined || isAwsTime(item.recordRemovedAt));
};

// 读回本地保存的「待清理」状态；读不懂的项目丢掉（只会让删除更晚或不删，不会更早）
const parseManualCleanup = (value: unknown): ManualCleanupState | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const stored = value as Record<string, unknown>;
  if (typeof stored.target !== "string") return undefined;
  const candidates = stored.candidates as Record<string, unknown> | undefined;
  return {
    target: stored.target,
    ...(stored.devicesConfirmed === true ? { devicesConfirmed: true } : {}),
    queue: Array.isArray(stored.queue) ? stored.queue.filter(isPendingCleanupItem) : [],
    ...(candidates && Array.isArray(candidates.keys) && isAwsTime(candidates.serverDate) ? { candidates: {
      keys: candidates.keys.filter((key): key is string => typeof key === "string"), serverDate: candidates.serverDate,
    } } : {}),
    ...(isAwsTime(stored.pausedUntil) ? { pausedUntil: stored.pausedUntil } : {}),
  };
};

const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const ANDROID_DOWNLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const ANDROID_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
// 网络类可重试错误从这一轮第一次失败起连续满这么久仍未成功，才自动弹出同步状态窗口
const NETWORK_FAILURE_POPUP_DELAY_MS = 30 * 60_000;

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
  // 这一轮网络类可重试错误第一次失败的时间；同步成功或出现非网络错误时清空
  private networkFailureSince: number | undefined;
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
  // 这次打开「待清理」时读到的列表（只在内存里），确认删除只能从它里面选
  private loadedCleanup: { target: string; listed: CleanupCandidates } | undefined;
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
  private statusDetail = "请填写 AWS 设置和仓库密码。";
  private statusElement: HTMLElement | undefined;
  private readonly statusListeners = new Set<
    (status: SyncStatusDisplay) => void
  >();
  private progressLabel: string | undefined;
  // 已自动弹过同步状态窗口的问题指纹；一次同步成功后清空
  private readonly shownStopFingerprints = new Set<string>();
  // 当前开着的同步状态窗口
  private readonly openStatusModals = new Set<StatusModal>();

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
    this.addRibbonIcon("refresh-cw", "打开 S3 Vault Sync", () => {
      this.openStatus();
    });
    this.addCommand({
      callback: () => this.openStatus(),
      id: "open-status",
      name: "打开同步状态",
    });
    this.addCommand({
      callback: () => {
        void this.syncNow();
      },
      id: "sync-now",
      name: "立即同步",
    });
    this.addCommand({
      callback: () => {
        void this.verifyAllFiles();
      },
      id: "run-full-integrity-check",
      name: "运行完整校验",
    });
    this.addCommand({
      callback: () => {
        void this.togglePause();
      },
      id: "toggle-pause",
      name: "暂停或恢复自动同步",
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
      name: "打开当前文件的历史版本",
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
    const modal: StatusModal = new StatusModal(this.app, this, () => this.openStatusModals.delete(modal));
    this.openStatusModals.add(modal);
    modal.open();
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
    return `${statusLabels[this.status]}：${this.statusDetail}`;
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

  // 同步状态窗口里的「待清理」只在电脑上有；手机上没有按钮，也不运行任何处理
  cleanupController(): CleanupController | undefined {
    return Platform.isDesktopApp ? this : undefined;
  }

  // 「待清理」的数字：电脑上用本机保存的上一次计算结果，减去已经确认删除的项目，不读 S3；手机上没有这个入口
  getCleanupCount(): number | undefined {
    if (!Platform.isDesktopApp) return undefined;
    const state = this.cleanupState();
    const queued = this.queuedCleanup(state);
    return (state.candidates?.keys ?? []).filter(key => !queued(key)).length;
  }

  // 打开「待清理」：只读，重读 Head、它的快照和数据块列表，只用这一次读到的内容计算；顺便刷新状态窗口的数字
  async loadCleanup(): Promise<CleanupView> {
    if (!Platform.isDesktopApp) throw new Error("清理只能在电脑上使用。");
    const vaultId = this.data.settings.vaultId;
    if (!vaultId || !this.credentials.loadVaultKey()) throw new Error("请先初始化或解锁加密仓库。");
    const target = this.integrityTarget();
    await this.runExclusiveSyncService(async service => {
      const listed = await service.listCleanupCandidates(vaultId);
      this.session.assertActive();
      if (this.integrityTarget() !== target) throw new Error("读取期间 S3 目标被改了。请重新打开「待清理」。");
      this.loadedCleanup = {target, listed};
      this.data.manualCleanup = {...this.cleanupState(), candidates: {keys: listed.items.map(item => item.key), serverDate: listed.serverDate}};
      await this.savePluginData();
    });
    const view = this.getCleanupView();
    if (!view) throw new Error("读取期间 S3 目标被改了。请重新打开「待清理」。");
    return view;
  }

  // 用这次打开时读到的列表和本机队列重新组合，不读 S3
  getCleanupView(): CleanupView | undefined {
    const loaded = this.loadedCleanup;
    if (!Platform.isDesktopApp || !loaded || loaded.target !== this.integrityTarget()) return undefined;
    const state = this.cleanupState();
    const queued = this.queuedCleanup(state);
    const blockedReason = this.cleanupBlockedReason(state);
    return {
      ...(blockedReason ? {blockedReason} : {}),
      candidates: loaded.listed.items.filter(item => !queued(item.key)),
      pending: state.queue,
      serverDate: loaded.listed.serverDate,
    };
  }

  needsCleanupDeviceConfirmation(): boolean {
    return this.cleanupState().devicesConfirmed !== true;
  }

  // 点「删除所选」：不写 S3，只把选中的项目记进本机队列，确认时间用这次页面读到的 Head serverDate（AWS 时间）
  async confirmCleanup(keys: string[], allDevicesUpdated: boolean): Promise<void> {
    await this.syncRequests.runExclusive(() => this.session.run(async () => {
      if (!Platform.isDesktopApp) throw new Error("清理只能在电脑上使用。");
      const loaded = this.loadedCleanup;
      if (!loaded || loaded.target !== this.integrityTarget()) throw new Error("请重新打开「待清理」再删除。");
      const state = this.cleanupState();
      if (!state.devicesConfirmed && !allDevicesUpdated) throw new Error("请先确认所有设备都已更新到 0.1.10 或更高。");
      const queued = this.queuedCleanup(state);
      const wanted = new Set(keys);
      const added = loaded.listed.items.filter(item => wanted.has(item.key) && !queued(item.key)).map((item): PendingCleanupItem => ({
        blobId: item.blobId, confirmedAt: loaded.listed.serverDate, key: item.key, kind: item.kind,
        ...(item.kind === "orphan" ? {} : {path: item.path}), size: item.size,
      }));
      this.data.manualCleanup = {...state, devicesConfirmed: true, queue: [...state.queue, ...added]};
      await this.savePluginData();
    }));
  }

  // 撤销只是把它从本机队列里拿掉，不写 S3；记录已经改过的不能再撤销
  async undoCleanup(key: string): Promise<void> {
    await this.syncRequests.runExclusive(() => this.session.run(async () => {
      const state = this.cleanupState();
      const item = state.queue.find(queued => queued.key === key);
      if (!item) return;
      if (item.recordRemovedAt !== undefined) throw new Error("它已经从同步记录里去掉了，不能再撤销。");
      this.data.manualCleanup = {...state, queue: state.queue.filter(queued => queued.key !== key)};
      await this.savePluginData();
    }));
  }

  // 当前目标的「待清理」状态；目标变了就当作没有
  private cleanupState(): ManualCleanupState {
    const target = this.integrityTarget();
    const stored = this.data.manualCleanup;
    return stored?.target === target ? stored : {target, queue: []};
  }

  // 已确认的项目盖住的候选：同一个 key，或同一个数据块（备份改完记录后，它的数据块会以「无对应文件的数据」出现）
  private queuedCleanup(state: ManualCleanupState): (key: string) => boolean {
    const keys = new Set(state.queue.map(item => item.key));
    const blobKeys = new Set(state.queue.map(item => orphanBlobKey(item.blobId)));
    return key => keys.has(key) || blobKeys.has(key);
  }

  // 处理的前提暂时不满足时，列表上方说明原因（仍然可以勾选和确认）
  private cleanupBlockedReason(state: ManualCleanupState): string | undefined {
    if (this.data.settings.paused) return "本设备已暂停同步，恢复同步后清理才会继续。";
    if (this.currentIntegrityChecks().length > 0 || this.getStatusText().includes("修复模式")) {
      return "同步处于修复模式，修复完成后清理才会继续。";
    }
    if (this.getConflicts().length > 0) return "有冲突还没处理，清理会等你处理完再继续。";
    if (this.pendingBulkDeletion) return "有批量删除等你确认，清理会等你确认后再继续。";
    if (this.pendingLocalIssues.length > 0 || this.data.pendingCollisionRename) return "有需要处理的项目，清理会等你处理完再继续。";
    // 只用于显示，按设备时间估算
    if (state.pausedUntil !== undefined && Date.now() < Date.parse(state.pausedUntil)) return "上次清理出错，1 小时内不再重试，之后同步时会再试。";
    return undefined;
  }

  // 处理完或不再处理的项目，也从这次打开时读到的列表里拿掉，免得窗口里又出现
  private forgetLoadedCleanup(items: readonly PendingCleanupItem[]): void {
    const loaded = this.loadedCleanup;
    if (!loaded || items.length === 0) return;
    const keys = new Set(items.flatMap(item => [item.key, orphanBlobKey(item.blobId)]));
    this.loadedCleanup = {...loaded, listed: {...loaded.listed, items: loaded.listed.items.filter(item => !keys.has(item.key))}};
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
      throw new Error("同步正在进行。请等它结束后再审查一次。");
    }
    if (this.isPaused()) throw new Error("请先恢复同步，再处理挪动。");
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
      if (!pending) throw new Error("这次中断的改名已经变化。请刷新同步状态。");
      const review = await service.reviewPathCollision(paths, this.pathRenames.toPathMap(this.pathRenames.capture()));
      if (JSON.stringify({base: review.reviewToken, pending}) !== reviewToken) throw new Error("用于恢复的文件有变化。请重新加载路径撞名审查。");
      const path = side === "source" ? pending.from : pending.to;
      const file = review.localFiles.find(file => file.path === path);
      if (!file?.contentHash) throw new Error("所选的恢复文件无法在本设备上校验。");
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
          throw new Error("本地改名记录有变化。请重新加载路径撞名审查。");
        }
        const identitySourcePath = intent.entryId
          ? [...this.pathRenames.capture()].find(([, rename]) => rename.entryId === intent.entryId)?.[0] ??
            Object.values(this.data.cache?.files ?? {}).find(file => file.entryId === intent.entryId)?.path
          : undefined;
        if (intent.entryId && !identitySourcePath) throw new Error("文件身份有变化。请重新加载路径撞名审查。");
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
    if (!isSafeTargetPath(pending.from) || !isSafeTargetPath(pending.to)) throw new Error("中断的改名里包含不安全的路径。");
    if (await this.collisionRenameJournal().recover() === "needs-review") {
      if (!this.pendingLocalIssues.some(issue => issue.kind === "path-collision" && issue.paths.includes(pending.to))) {
        this.pendingLocalIssues.push({kind: "path-collision", paths: [pending.from, pending.to]});
      }
      if (!allowReview) throw new Error("有一次中断的改名需要确认。请打开同步状态，选择「审查路径撞名」。");
    }
  }

  openVersionHistory(path: string): void {
    const entry = this.getLiveEntry(path);
    if (!entry?.history?.length) throw new Error("这个文件没有可恢复的版本。同步一次可刷新它的历史。");
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
      throw new Error("本设备上没有这个文件。请复制路径，到存有它的设备上操作。");
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
      this.reportManualCompletion("本地文件已作为新文件上传到 S3。");
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
      this.reportManualCompletion("已按你的确认下载大文件。");
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
      this.reportManualCompletion("历史版本已恢复。");
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
      this.reportManualCompletion("已删除的文件已作为新版本恢复。");
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
        throw new Error("请先输入仓库密码");
      }
      this.setStatus("Checking", "正在检查 S3 和加密的远端存储。");
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
            "这个本地仓库已绑定到另一个远端存储",
          );
        }
        vaultId = existing.vaultId;
        vaultKey = await VaultCrypto.unwrapKey(password, existing.envelope);
      } else {
        if (needsRenameReview) throw new Error("请先处理中断的改名，再初始化新的远端存储。");
        const existingKeys = await objects.list(prefix ? `${prefix}/` : "");
        if (existingKeys.some(key => !ownedProbeKeys.has(key))) {
          throw new Error("所选的 S3 前缀不是空的");
        }
        const legacyPrefix = normalizePrefix(
          this.data.settings.remotelySavePrefix,
        );
        if (legacyPrefix) {
          if (!this.data.settings.confirmedRemotelySaveDisabled) {
            throw new Error(
              "迁移前请确认已停用 Remotely Save",
            );
          }
          if (!Platform.isDesktopApp) {
            throw new Error("Remotely Save 迁移必须在桌面端运行");
          }
          if (legacyPrefix === prefix) {
            throw new Error("新前缀必须和 Remotely Save 的前缀不同");
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
              `Remotely Save 的内容与这个仓库不一致（${comparison.differences.length} 处差异）。${examples}`,
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
        throw new Error("所选前缀属于另一个仓库");
      }
      if (!currentHead) {
        if (needsRenameReview) throw new RepairModeError("必须先恢复现有的 Head 指针，才能继续修复路径");
        const pending = this.data.pendingInitialization;
        const canResume = pending?.phase === "uploading" &&
          pending.vaultId === vaultId && pending.prefix === prefix &&
          pending.bucket === this.data.settings.bucket && pending.region === this.data.settings.region &&
          (await objects.list(`${prefix ? `${prefix}/` : ""}v1/commits/`)).length === 0;
        if (!isNewRemote && !canResume) {
          throw new RepairModeError(
            "密钥信封存在但 Head 指针缺失；为便于修复，已禁止写入",
          );
        }
        await this.createSyncService(remote).initializeNew(vaultId, async () => {
          this.session.assertActive();
          const previous = this.data.pendingInitialization;
          if (!previous) throw new Error("初始化检查点缺失");
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
        ? "已解锁。请打开同步状态审查中断的改名。"
        : "加密的远端存储已就绪。");
      if (needsRenameReview) this.openStatusWhenStopped(this.actionFingerprint());
      new Notice(needsRenameReview ? "仓库已解锁。审查完中断的改名后即可继续同步。" : "S3 Vault Sync 已就绪");
    } catch (error) {
      await this.rememberIntegrityFailure(error, integrityTarget);
      this.showError(error);
      throw error;
    }
  }

  async saveAwsCredentials(credentials: AwsCredentials): Promise<void> {
    if (!credentials.accessKeyId || !credentials.secretAccessKey) {
      const error = new Error("请把两项 AWS 凭证都填上");
      this.showError(error);
      throw error;
    }
    this.credentials.saveAwsCredentials(credentials);
    this.refreshConfiguredStatus();
    new Notice("AWS 凭证已保存到 SecretStorage");
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
      this.setStatus("Paused", "本设备已暂停自动同步。");
    } else {
      this.networkRetryAttempt = 0;
      this.setStatus("Checking", "已恢复自动同步。");
      await this.requestAutomaticSync("resume");
    }
  }

  private createObjectStore(): AwsS3ObjectStore {
    const assertTarget = this.captureTargetGuard();
    const { bucket, region } = this.data.settings;
    const credentials = this.credentials.loadAwsCredentials();
    if (!bucket || !region || !this.data.settings.prefix) {
      throw new Error("必须填写 AWS 区域、存储桶和前缀");
    }
    if (!credentials) {
      throw new Error("尚未配置 AWS 凭证");
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
        throw new Error("请先解锁加密仓库");
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
          this.reportManualCompletion("之前报告的远端内容已通过校验。");
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
      manualCleanup: parseManualCleanup(stored?.manualCleanup),
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
    // 0.1.10 自动清理留下的开关和第一次判定记录：不再使用，加载时丢弃
    const droppedAutomaticCleanup = stored !== null && stored !== undefined &&
      ("expiredContentCleanup" in stored || "unreferencedBlobMarks" in stored);
    if (!this.data.settings.replicaId || userRenames.length !== pendingRenames.length || droppedAutomaticCleanup) {
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
        throw new Error("同步过程中 S3 目标被改了。请检查目标后重试。");
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
    if (target !== this.integrityTarget()) throw new Error("重新校验期间仓库有变化。请重试同步。");
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
    if (target === this.integrityTarget()) this.setStatus("Action required", `修复模式：${error.message}`);
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
      this.setStatus("Error", "同步排队期间 S3 目标被改了。请检查设置后再同步。");
      return;
    }
    if (this.networkFailureTarget !== undefined && this.networkFailureTarget !== integrityTarget) {
      this.clearNetworkRetryTimer();
      this.networkRetryAttempt = 0;
      this.networkFailureTarget = undefined;
    }
    if (this.data.settings.paused) {
      this.setStatus("Paused", "本设备已暂停自动同步。");
      return;
    }
    const vaultKey = this.credentials.loadVaultKey();
    if (!vaultKey || !this.data.settings.vaultId) {
      this.setStatus("Not configured", "请初始化或解锁加密仓库。");
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
      this.setStatus("Checking", "正在读取加密的远端 Head 指针。");
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
          "远端 Head 指针缺失，或属于另一个仓库",
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
            `正在同步（第 ${attempt}/${totalAttempts} 次尝试）。`,
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
      this.networkFailureSince = undefined;
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
            ? "请审查并确认这次批量删除。"
            : "请打开同步状态，查看需要处理的项目。",
        );
        this.openStatusWhenStopped(this.actionFingerprint());
      } else {
        this.pendingBulkDeletion = undefined;
        // 同步成功一次后清空弹窗记录，同一问题再出现时会再弹
        this.shownStopFingerprints.clear();
        this.setStatus(
          "Idle",
          `下载 ${result.downloaded}，上传 ${result.uploaded}，删除 ${result.deleted}，暂缓下载 ${result.deferredDownloads}，未同步 ${result.unsyncedLocalEntries}。`,
        );
        await this.runManualCleanup(remote, boundHead.serverDate, result, diagnostic, assertIntegrityTarget);
      }
    } catch (error) {
      const retryableNetwork = error instanceof S3TransportError ||
        (error instanceof S3RequestError && [408, 429, 500, 502, 503, 504].includes(error.status));
      if (!retryableNetwork) {this.networkFailureTarget = undefined; this.networkRetryAttempt = 0;}
      if (retryableNetwork) this.networkFailureSince ??= Date.now();
      else this.networkFailureSince = undefined;
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
          "同步过程中有本地文件被改动。等编辑停下后会自动重试。",
        );
        this.scheduleAfterLocalChange();
      } else if (retryableNetwork && this.scheduleNetworkRetry(integrityTarget)) {
        diagnostic.outcome = "retrying";
      } else {
        diagnostic.outcome = "error";
        await this.rememberIntegrityFailure(error, integrityTarget);
        this.showError(error);
        // 网络类可重试错误未连续满 30 分钟时，只显示状态栏和通知，不自动弹窗
        if (!retryableNetwork ||
          Date.now() - (this.networkFailureSince ?? Date.now()) >= NETWORK_FAILURE_POPUP_DELAY_MS) {
          // 网络类可重试错误用固定指纹：S3 错误信息含操作名，一次断网里不同操作失败也只弹一次
          this.openStatusWhenStopped(this.repairFingerprint() ?? (retryableNetwork ? "error:network"
            : `error:${error instanceof Error ? error.message : String(error)}`));
        }
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
        this.setStatus("Paused", "本设备已暂停自动同步。");
      }
    }
  }

  // 「待清理」的处理：只在电脑上、紧跟一次完全成功的同步运行，只处理用户确认过的项目。
  // 有待处理的审查、冲突、Bulk Deletion 确认或待复查的完整性检查时不运行：清理提交会改 Head，
  // 让还没处理的审查失效。之后刷新状态窗口的数字（按 AWS 时间每 24 小时最多一次）。
  // 出错照旧在同步状态里报告，之后 1 小时内（AWS 时间）不再处理
  private async runManualCleanup(
    remote: RemoteStore,
    observedServerDate: string,
    result: SyncResult,
    diagnostic: SyncRunRecord,
    assertTarget: () => void,
  ): Promise<void> {
    if (!Platform.isDesktopApp) return;
    const vaultId = this.data.settings.vaultId;
    if (!vaultId || result.status !== "complete" || !result.cacheUpdated || result.bulkDeletion ||
      result.localIssues.length > 0 || this.pendingBulkDeletion || this.pendingLocalIssues.length > 0 ||
      this.getConflicts().length > 0 || this.currentIntegrityChecks().length > 0 ||
      this.data.pendingCollisionRename) return;
    const target = this.integrityTarget();
    const observed = Date.parse(observedServerDate);
    const pausedUntil = this.cleanupState().pausedUntil;
    if (!Number.isFinite(observed) || (pausedUntil !== undefined && observed < Date.parse(pausedUntil))) return;
    try {
      await this.processConfirmedCleanup(remote, vaultId, observed, diagnostic, assertTarget);
      await this.refreshCleanupCount(remote, vaultId, observed, assertTarget);
    } catch (error) {
      if (!(error instanceof SyncStoppedError) && this.integrityTarget() === target) {
        this.data.manualCleanup = {...this.cleanupState(), pausedUntil: new Date(observed + HOUR_MS).toISOString()};
        // 记不下暂停时间也要把原来的错误报出去
        await this.savePluginData().catch(() => undefined);
      }
      throw error;
    }
  }

  private async processConfirmedCleanup(
    remote: RemoteStore,
    vaultId: string,
    observed: number,
    diagnostic: SyncRunRecord,
    assertTarget: () => void,
  ): Promise<void> {
    const target = this.integrityTarget();
    const elapsed = (time: string | undefined): number => time === undefined ? Number.NEGATIVE_INFINITY : observed - Date.parse(time);
    const queue = this.cleanupState().queue;
    // 第一步：确认满 24 小时、还没改记录的备份和旧版本
    const dueRecord = queue.filter(item => item.kind !== "orphan" && item.recordRemovedAt === undefined && elapsed(item.confirmedAt) >= DAY_MS);
    // 第二步：无对应文件的数据确认满 24 小时；备份和旧版本改记录后又满 24 小时
    const dueBlob = queue.filter(item => elapsed(item.kind === "orphan" ? item.confirmedAt : item.recordRemovedAt) >= DAY_MS);
    // 没有到时间的项目时什么都不做，不发任何请求
    if (dueRecord.length === 0 && dueBlob.length === 0) return;
    if (dueRecord.length > 0) {
      let cleanup: ExpiredContentCleanupResult;
      try {
        cleanup = await retryHeadChanges(() =>
          this.createSyncService(remote).cleanupExpiredContent(vaultId, new Set(dueRecord.map(item => item.key))));
      } catch (error) {
        // 几次都被别的设备抢先：留到下一次同步之后再试
        if (error instanceof HeadChangedError) return;
        throw error;
      }
      this.session.assertActive();
      assertTarget();
      if (cleanup.kind === "no-head" || this.integrityTarget() !== target) return;
      const outcomes = cleanup.outcomes ?? {};
      const state = this.cleanupState();
      // 已去掉、或记录里已经没有了：记下改记录的时间；成了冲突或不再算过期：从队列移除，等以后重新出现在列表里
      const skipped = state.queue.filter(item => outcomes[item.key] === "skipped");
      const queueAfterRecord = state.queue.flatMap((item): PendingCleanupItem[] =>
        outcomes[item.key] === "skipped" ? []
          : outcomes[item.key] === "removed" || outcomes[item.key] === "gone" ? [{...item, recordRemovedAt: cleanup.serverDate}] : [item]);
      diagnostic.expiredContentCleanup = {at: Date.now(), removedHistory: cleanup.removedHistory, removedRecoveries: cleanup.removedRecoveries};
      this.data.manualCleanup = {...state, queue: queueAfterRecord};
      this.forgetLoadedCleanup(skipped);
      await this.savePluginData();
    }
    if (dueBlob.length === 0) return;
    // 同一个数据块可能对应队列里几项：每一项都到时间才删，按最晚的那个时间算
    const marks: Record<string, string> = {};
    const current = this.cleanupState().queue;
    for (const blobId of new Set(dueBlob.map(item => item.blobId))) {
      const times = current.filter(item => item.blobId === blobId)
        .map(item => item.kind === "orphan" ? item.confirmedAt : item.recordRemovedAt);
      if (times.every((time): time is string => time !== undefined && elapsed(time) >= DAY_MS)) {
        marks[blobId] = times.reduce((latest, time) => Date.parse(time) > Date.parse(latest) ? time : latest);
      }
    }
    if (Object.keys(marks).length === 0) return;
    // 和同步同一个 remote（同一个独占队列、同一个目标守卫），目标一变 createObjectStore 的守卫就拦下之后的每个请求，
    // 不再发出 DELETE。删前重读 Head、重算引用；key 对不上整批不删；每次最多 200 个
    const blobs = await this.createSyncService(remote).deleteUnreferencedBlobs(vaultId, marks, new Set(Object.keys(marks)));
    this.session.assertActive();
    assertTarget();
    if (blobs.kind === "no-head" || this.integrityTarget() !== target) return;
    const state = this.cleanupState();
    // 删掉的、仍被引用的（内容和别的文件相同）、S3 上已经没有的：从队列移除；还没轮到的留着
    const finished = state.queue.filter(item => marks[item.blobId] !== undefined && blobs.marks[item.blobId] === undefined);
    diagnostic.blobCleanup = {deletedBlobs: blobs.deletedBlobs, deletedBytes: blobs.deletedBytes};
    this.data.manualCleanup = {...state, queue: state.queue.filter(item => !finished.includes(item))};
    this.forgetLoadedCleanup(finished);
    await this.savePluginData();
  }

  // 刷新状态窗口「待清理（N）」用的结果：按 AWS 时间每 24 小时最多一次
  private async refreshCleanupCount(remote: RemoteStore, vaultId: string, observed: number, assertTarget: () => void): Promise<void> {
    const target = this.integrityTarget();
    const computed = Date.parse(this.cleanupState().candidates?.serverDate ?? "");
    if (Number.isFinite(computed) && observed - computed < DAY_MS) return;
    const listed = await this.createSyncService(remote).listCleanupCandidates(vaultId);
    this.session.assertActive();
    assertTarget();
    if (this.integrityTarget() !== target) return;
    this.data.manualCleanup = {...this.cleanupState(), candidates: {keys: listed.items.map(item => item.key), serverDate: listed.serverDate}};
    await this.savePluginData();
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
      `网络暂时出错。${Math.ceil(delay / 1_000)} 秒后自动重试（${this.networkRetryAttempt}/3）。`);
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
      `另一台设备先发布了更改。${Math.ceil(delay / 1_000)} 秒后自动重试。`,
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
      this.reportManualCompletion("冲突处理结果已保存到 S3。");
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
      this.setStatus("Action required", `${detail}还有其他项目需要处理，请打开同步状态查看。`);
    } else {
      const deferred = this.pendingDeferredDownloads.length
        ? `暂缓下载：${this.pendingDeferredDownloads.length} 个。`
        : "";
      this.setStatus(
        this.data.settings.paused ? "Paused" : "Idle",
        `${detail}${deferred}${this.data.settings.paused ? "自动同步仍处于暂停状态。" : ""}`,
      );
    }
  }

  private refreshConfiguredStatus(): void {
    if (this.syncRequests.isRunning || !["Idle", "Paused", "Not configured"].includes(this.status)) return;
    if (this.data.settings.paused) {
      this.setStatus("Paused", "本设备已暂停自动同步。");
    } else if (
      this.data.settings.vaultId &&
      this.credentials?.loadAwsCredentials() &&
      this.credentials.loadVaultKey()
    ) {
      this.setStatus("Idle", "可以同步。");
    } else {
      this.setStatus("Not configured", "请完成插件设置。");
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
      const lastError = status === "Error" ? `上次尝试：${detail}` : "";
      status = "Action required";
      detail = `修复模式：${integrityChecks[0]!.message}（${integrityChecks.length} 项校验待完成）。请先解决报告的问题，再同步一次重新校验。` +
        (this.data.settings.paused ? "自动同步仍处于暂停状态。" : "") + lastError;
    }
    if (this.session.signal.aborted) return;
    if (status !== "Syncing") {
      this.syncProgressThrottle.reset();
    }
    this.status = status;
    this.statusDetail = detail;
    this.progressLabel = progressLabel;
    this.statusElement?.setText(`S3 同步：${detail}`);
    this.statusElement?.setAttr("aria-label", this.getStatusText());
    this.statusElement?.setAttr("title", this.getStatusText());
    this.statusElement?.toggleClass(
      "s3-vault-sync-error",
      status === "Action required" || status === "Error",
    );
    this.emitStatus();
  }

  // 停住就弹窗：只在一次同步运行结束后、或解锁时发现中断的改名时调用；同一问题指纹只弹一次
  private openStatusWhenStopped(fingerprint: string | undefined): void {
    if (fingerprint === undefined || this.shownStopFingerprints.has(fingerprint)) return;
    // 窗口已开着时问题已经展示给用户，同样记为弹过，不再叠一个新窗口
    this.shownStopFingerprints.add(fingerprint);
    if (this.openStatusModals.size === 0) this.openStatus();
  }

  // 修复模式的问题指纹；没有待完成的校验时返回 undefined
  private repairFingerprint(): string | undefined {
    const integrityChecks = this.data ? this.currentIntegrityChecks() : [];
    return integrityChecks.length
      ? `repair:${integrityChecks.map(issue => JSON.stringify(issue.check)).sort().join("\n")}`
      : undefined;
  }

  // 需要用户做决定的问题指纹 = 问题种类 + 涉及路径（排序后）；
  // 纯信息类问题（未同步的本地文件、暂缓的本地编辑、不支持的路径）不计入，只有它们时返回 undefined
  private actionFingerprint(): string | undefined {
    const repair = this.repairFingerprint();
    if (repair) return repair;
    const items = [
      ...this.pendingLocalIssues.flatMap(issue => {
        if (issue.kind === "unsynced-local" || issue.kind === "deferred-local-edit" ||
          issue.kind === "unsupported-path") return [];
        const paths = issue.kind === "path-collision" ? issue.paths
          : issue.kind === "possible-rename" ? [...issue.oldPaths, ...issue.newPaths]
          : [issue.path];
        return [`${issue.kind}:${[...paths].sort().join("|")}`];
      }),
      ...this.getConflicts().map(entry => `conflict:${entry.path}`),
      ...(this.pendingBulkDeletion ? [`bulk-deletion:${[...this.pendingBulkDeletion.entryIds].sort().join("|")}`] : []),
      ...(this.data?.pendingCollisionRename
        ? [`collision-rename:${this.data.pendingCollisionRename.from}|${this.data.pendingCollisionRename.to}`] : []),
    ].sort();
    return items.length ? `action:${items.join("\n")}` : undefined;
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
    const message = error instanceof Error ? error.message : "未知的同步错误";
    this.setStatus(
      error instanceof RepairModeError || error instanceof RemoteStateError
        ? "Action required"
        : "Error",
      error instanceof RepairModeError || error instanceof RemoteStateError
        ? `修复模式：${message}`
        : message,
    );
    const notice = new Notice(`S3 Vault Sync：${message}`, 12_000);
    notice.messageEl.createEl("button", {text: "打开同步状态", cls: "s3-vault-sync-notice-action"}).addEventListener("click", event => {
      event.stopPropagation();
      this.openStatus();
      notice.hide();
    });
  }
}
