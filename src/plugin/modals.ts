import { App, Modal, Notice, Setting } from "obsidian";

import type {
  BulkDeletionPlan,
  ConflictedEntry,
  DeletedEntry,
  LiveEntry,
  RevisionRef,
} from "../sync/sync-engine";
import type {
  DeferredDownloadEntry,
  LocalSyncIssue,
  LocalContentReview,
  LocalContentChoice,
  PossibleRenameIssue,
  PossibleRenameResolution,
} from "../sync/sync-service";
import {
  decodeDeletedPreview,
  MAX_DELETED_PREVIEW_BYTES,
} from "./deleted-preview";
import { copyText } from "./clipboard";
import { actionButton } from "./modal-actions";
import { LocalContentReviewModal } from "./content-review-modal";
import { PathCollisionModal } from "./path-collision-modal";
import type { PathCollisionReview, PathCollisionResolution } from "../sync/path-collision-review";
import type { SyncDiagnosticsView } from "./sync-diagnostics";

export interface StatusModalController {
  getDiagnostics?(limit?: number): SyncDiagnosticsView;
  exportDiagnostics?(): string;
  reviewPathCollision(paths: string[]): Promise<PathCollisionReview>;
  resolvePathCollision(request: PathCollisionResolution): Promise<string>;
  confirmInterruptedCollisionRename(paths: string[], reviewToken: string, side: "source" | "target"): Promise<void>;
  openSettings(): void;
  readConflictCandidate(entryId: string, revisionId: string): Promise<Uint8Array>;
  reviewLocalContent(path: string): Promise<LocalContentReview>;
  resolveLocalContent(path: string, reviewToken: string, choice: LocalContentChoice): Promise<string | undefined>;
  openVersionHistory(path: string): void;
  openLocalFile(path: string): Promise<void>;
  resolvePossibleRename(resolution: PossibleRenameResolution): Promise<void>;
  confirmBulkDeletion(): Promise<void>;
  downloadDeferred(entryId: string): Promise<void>;
  getConflicts(): ConflictedEntry[];
  getDeferredDownloads(): DeferredDownloadEntry[];
  getDeletedRecoveries(): DeletedEntry[];
  getLocalIssues(): LocalSyncIssue[];
  getPendingBulkDeletion():
    | BulkDeletionPlan
    | undefined;
  getStatusText(): string;
  onStatusChange(listener: (status: { text: string }) => void): () => void;
  importCandidate(path: string): Promise<void>;
  isPaused(): boolean;
  keepConflictDeleted(entryId: string): Promise<void>;
  resolveConflict(entryId: string, revisionId: string): Promise<void>;
  readDeletedRecovery(entryId: string, revisionId?: string): Promise<Uint8Array>;
  restoreDeleted(entryId: string, revisionId?: string): Promise<void>;
  syncNow(): Promise<void>;
  togglePause(): Promise<void>;
}


const statusHelp = (status: string): string => {
  if (status.includes("Repair Mode")) return "Pause sync on all devices and preserve local copies. Check the bucket, prefix, and permissions in Settings. If the remote Head is missing or damaged, inspect S3 Versioning and recover a verified Head together with its referenced objects, then retry. Do not initialize over the existing prefix.";
  if (status.startsWith("Not configured")) return "Open settings, complete AWS region, bucket and prefix, save both AWS credentials, then unlock with the shared Vault password. An empty password field after a successful unlock is normal; the Vault Key is saved on this device.";
  if (status.startsWith("Paused")) return "Use Resume to restart automatic synchronization. Local edits remain on this device while paused.";
  if (/expired/i.test(status)) return "This version is outside the plugin's recovery window. Check your independent backup or retained S3 versions. Retrying cannot extend an expired recovery deadline.";
  if (/password|envelope/i.test(status)) return "Open settings and use the same Vault password as the original device. This is separate from the AWS Secret Access Key. Verify the region, bucket and prefix belong to the intended Vault. If the Key Envelope is damaged, recover it from a verified S3 version; do not initialize over existing data.";
  if (/Remotely Save|prefix.*not empty|bound.*different/i.test(status)) return "Open settings and check the selected bucket and prefixes. For migration, finish the old sync on all devices, compare the source files and disable Remotely Save. The new sync prefix must be empty and distinct from the old one. Preserve the old prefix while correcting the setup.";
  if (/403|AccessDenied|Signature|credentials|credential/i.test(status)) return "Open settings and verify the AWS region, bucket, prefix, and saved credentials. Check that the AWS key can list the prefix and read/write its objects. After correcting the configuration, retry. Do not post your AK or SK when sharing an error.";
  if (/timeout|network|connection|HTTP.*5\d\d|status 5\d\d/i.test(status)) return "Check the network and any proxy or VPN, then retry. Interrupted synchronization will recheck the remote state. Keep local files and configuration while diagnosing the connection.";
  if (status.includes("Another device published")) return "Another device completed a sync first. Automatic retry is already scheduled. You can use Sync now to retry sooner or Pause to stop retrying.";
  if (status.includes("local file changed")) return "The file changed during synchronization. Wait briefly after editing; synchronization will retry. This protects your latest saved text.";
  return "Review the affected items below. Use Open settings for configuration issues, Copy status to share the error text, or Sync now after addressing the cause. File conflicts require an explicit choice; remote repair and operating-system filename restrictions may require action outside the plugin.";
};


const localIssueHelp = (issue: LocalSyncIssue): string => {
  switch (issue.kind) {
    case "bootstrap-mismatch": return "This device has no accepted common version for this path, which can happen on first connection, after reinstalling, or after losing local sync records. Compare and resolve shows the differences and lets you use local content, use S3 content, or keep both when both files exist. The unchosen version is preserved in 30-day history or a separate synced file. Clearing the cache cannot establish which version you intended.";
    case "resolution-mismatch": return "This file changed after a conflict was recorded. Compare and resolve shows the differences and can preserve these additional edits as a separate file before receiving the remote state. Remaining conflict candidates stay in the Conflict Center.";
    case "deferred-local-edit": return "The local file was edited while a newer remote version was deferred. Compare and resolve shows the differences and can preserve both when they fit this device's limit. Otherwise resolve on desktop; switching to Wi-Fi can help attachments below the mobile size limit.";
    case "path-collision": return "These paths collide by case, Unicode normalization, or file ownership. A single displayed path can be an occupied rename target or multiple S3 records, not an invalid filename. Use Review path collision to inspect the related paths and safely rename a selected local file or S3 record without discarding either version.";
    case "unsupported-path": return "This filename cannot be created on this device. Copy the path and rename the file on a compatible desktop, then sync both devices. The original remains on the remote; changing the cache cannot fix a filesystem filename restriction.";
    case "unsynced-local": return "This local file exceeds this device's automatic limit and has not been uploaded. Open it to inspect it. Connect to Wi-Fi if it is an attachment below the mobile limit, or copy it to a desktop and sync there. Split or reduce large files before syncing on mobile.";
    case "import-candidate": return "This local file has no remote identity. Upload as new file sends it to S3 after checking that its path is still available. If it was moved from another folder, first check whether the old remote path is the same note; importing does not reconnect its old identity.";
    case "possible-rename": return "Review and resolve lets you confirm one-to-one moves or explicitly choose separate deletions and additions. Every decision is checked again before publishing.";
  }
};

const renderIssueGuidance = (container: HTMLElement, issue: LocalSyncIssue): void => {
  const detail = container.createEl("details");
  detail.createEl("summary", {text: "Why this needs attention"});
  detail.createEl("p", {text: localIssueHelp(issue)});
};

const showGuidance = (app: App, title: string, text: string): void => {
  const modal = new Modal(app);
  modal.contentEl.createEl("h2", {text: title});
  modal.contentEl.createEl("p", {text});
  modal.contentEl.createEl("button", {text: "Close"}).addEventListener("click", () => modal.close());
  modal.open();
};

const commonFolder = (paths: string[]): string => {
  const parts = paths[0]?.split("/").slice(0, -1) ?? [];
  for (const path of paths.slice(1)) {
    const other = path.split("/").slice(0, -1);
    while (parts.some((part, index) => other[index] !== part)) parts.pop();
  }
  return parts.length ? `${parts.join("/")}/` : "";
};

class RenameReviewModal extends Modal {
  constructor(
    app: App,
    private readonly issue: PossibleRenameIssue,
    private readonly resolve: (resolution: PossibleRenameResolution) => Promise<void>,
    private readonly refresh: () => Promise<void>,
  ) { super(app); }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("s3-vault-sync-rename-review");
    this.contentEl.createEl("h2", { text: "Review missing and new files" });
    this.contentEl.createEl("p", { text:
      "If these are the same files moved or renamed, select each matching new path and confirm the moves. " +
      "Their existing history will be kept, and content changes will be reconciled normally.",
    });
    const oldFolder = commonFolder(this.issue.oldPaths);
    const newFolder = commonFolder(this.issue.newPaths);
    this.contentEl.createDiv({ cls: "s3-vault-sync-selectable-path", text:
      `${oldFolder || "Vault root"} → ${newFolder || "Vault root"}`,
    });
    const pairs = new Map<string, string>();
    const details = this.contentEl.createEl("details");
    details.open = this.issue.oldPaths.length <= 5;
    details.createEl("summary", { text: `Review ${this.issue.oldPaths.length} path mappings` });
    let updateButton = (): void => {};
    for (const fromPath of this.issue.oldPaths) {
      const proposed = this.issue.oldPaths.length === 1 && this.issue.newPaths.length === 1
        ? this.issue.newPaths[0]!
        : `${newFolder}${fromPath.slice(oldFolder.length)}`;
      const initial = this.issue.newPaths.includes(proposed) ? proposed : "";
      pairs.set(fromPath, initial);
      new Setting(details)
        .setName(fromPath.slice(oldFolder.length))
        .setDesc(fromPath)
        .addDropdown(dropdown => {
          dropdown.addOption("", "Choose the matching new path");
          for (const toPath of this.issue.newPaths) dropdown.addOption(toPath, toPath.slice(newFolder.length));
          dropdown.setValue(initial).onChange(value => { pairs.set(fromPath, value); updateButton(); });
        });
    }
    const message = this.contentEl.createEl("p");
    const actions = this.contentEl.createDiv({ cls: "s3-vault-sync-toolbar" });
    const confirmMoves = actions.createEl("button", { text: "Confirm moves", cls: "mod-cta" });
    updateButton = () => {
      confirmMoves.disabled = pairs.size !== this.issue.newPaths.length ||
        [...pairs.values()].some(value => !value) || new Set(pairs.values()).size !== pairs.size;
    };
    updateButton();
    this.contentEl.createEl("p", { text:
      "If the missing files were intentionally deleted and the new files are unrelated, use the separate-deletions option. " +
      "This publishes deletion records for the missing files and uploads the new files. " +
      "Deleted content retains its recovery window; large deletions still require a second confirmation.",
    });
    const separate = this.contentEl.createEl("button", {
      cls: "mod-warning", text: "Confirm separate deletions and additions",
    });
    const run = async (resolution: PossibleRenameResolution): Promise<void> => {
      confirmMoves.disabled = true;
      separate.disabled = true;
      message.setText("Rechecking files and remote state…");
      try {
        await this.resolve(resolution);
        this.close();
      } catch (error) {
        message.setText(error instanceof Error ? error.message : "Could not resolve the rename.");
        updateButton();
        separate.disabled = false;
        actionButton(actions, "Refresh plan", async () => { await this.refresh(); this.close(); });
      }
    };
    confirmMoves.addEventListener("click", () => { void run({
      kind: "moves", reviewToken: this.issue.reviewToken,
      pairs: [...pairs].map(([fromPath, toPath]) => ({ fromPath, toPath })),
    }); });
    separate.addEventListener("click", () => { void run({ kind: "separate", reviewToken: this.issue.reviewToken }); });
    actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
  }
}

export interface VersionHistoryController {
  readHistoricalRevision(entryId: string, revisionId: string): Promise<Uint8Array>;
  restoreRevision(entryId: string, revisionId: string): Promise<void>;
}

class RiskConfirmationModal extends Modal {
  constructor(
    app: App,
    private readonly message: string,
    private readonly confirm: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Large mobile transfer" });
    this.contentEl.createEl("p", { text: this.message });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
      this.close();
    });
    actionButton(actions, "Try anyway", async () => {
      await this.confirm();
      this.close();
    }).addClass("mod-warning");
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class DeletedFilePreviewModal extends Modal {
  constructor(
    app: App,
    private readonly entry: {path: string},
    private readonly revision: RevisionRef,
    private readonly loadContent: () => Promise<Uint8Array>,
    private readonly title = "Deleted file preview",
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.title });
    const actions = this.contentEl.createDiv({cls: "s3-vault-sync-toolbar"});
    actions.createEl("button", {text: "Back"}).addEventListener("click", () => this.close());
    actionButton(actions, "Copy path", async () => {
      if (!await copyText(this.entry.path)) throw new Error("Clipboard unavailable; select the path below to copy it.");
    });
    this.contentEl.createDiv({
      cls: "s3-vault-sync-selectable-path",
      text: this.entry.path,
    });
    this.contentEl.createEl("p", {
      cls: "s3-vault-sync-muted",
      text: `${this.revision.size} bytes${
        this.revision.expiresAt
          ? ` · recoverable until ${this.revision.expiresAt}`
          : ""
      }`,
    });
    const preview = this.contentEl.createDiv({
      cls: "s3-vault-sync-preview-content",
    });
    if (this.revision.size > MAX_DELETED_PREVIEW_BYTES) {
      preview.setText("This file is too large to preview. You can still restore it.");
      return;
    }
    preview.setText("Loading encrypted recovery content…");
    void this.loadContent()
      .then((body) => {
        preview.empty();
        const text = decodeDeletedPreview(body);
        if (text === undefined) {
          preview.setText("This binary file cannot be shown as text.");
          return;
        }
        preview.createEl("pre", { text });
      })
      .catch((error: unknown) => {
        preview.empty();
        preview.createDiv({
          cls: "s3-vault-sync-error",
          text: error instanceof Error ? error.message : "Preview failed.",
        });
        preview.createEl("button", {text: "Retry preview"}).addEventListener("click", () => this.onOpen());
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class StatusModal extends Modal {
  private stopStatusUpdates: (() => void) | undefined;
  private pauseButton: HTMLButtonElement | undefined;
  constructor(
    app: App,
    private readonly controller: StatusModalController,
  ) {
    super(app);
  }

  onOpen(): void {
    this.stopStatusUpdates?.();
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "S3 Vault Sync" });
    const status = this.contentEl.createEl("p", { text: this.controller.getStatusText() });
    const controls = this.contentEl.createDiv();
    const diagnostics = this.contentEl.createDiv({cls: "s3-vault-sync-diagnostics"});
    const details = this.contentEl.createDiv();
    const history = this.contentEl.createDiv({cls: "s3-vault-sync-diagnostics"});
    const render = (): void => {
      controls.empty();
      details.empty();
      this.renderActions(controls);
      this.renderDiagnostics(diagnostics);
      this.renderDiagnosticHistory(history);
      this.renderBulkDeletion(details);
      this.renderConflicts(details);
      this.renderLocalIssues(details);
      this.renderDeferredDownloads(details);
      this.renderDeletedRecoveries(details);
    };
    render();
    this.stopStatusUpdates = this.controller.onStatusChange(display => {
      status.setText(display.text);
      this.pauseButton?.setText(this.controller.isPaused() ? "Resume" : "Pause");
      if (/^(Idle|Action required|Error|Not configured|Paused):/.test(display.text)) render();
      else this.renderDiagnostics(diagnostics);
    });
  }

  onClose(): void {
    this.stopStatusUpdates?.();
    this.stopStatusUpdates = undefined;
    this.pauseButton = undefined;
    this.contentEl.empty();
  }

  private renderActions(container: HTMLElement): void {
    const actions = container.createDiv({ cls: "modal-button-container" });
    actions.addClass("s3-vault-sync-toolbar");
    actionButton(actions, "Sync now", async () => { await this.controller.syncNow(); this.onOpen(); })
      .disabled = this.controller.isPaused();
    this.pauseButton = actionButton(actions, this.controller.isPaused() ? "Resume" : "Pause",
      async () => { await this.controller.togglePause(); this.onOpen(); });
    actions.createEl("button", {text: "Open settings"}).addEventListener("click", () => {this.controller.openSettings(); this.close();});
    actions.createEl("button", {text: "Troubleshooting"}).addEventListener("click", () =>
      showGuidance(this.app, "Sync troubleshooting", statusHelp(this.controller.getStatusText())));
    actionButton(actions, "Copy status", async () => {
      if (!await copyText(this.controller.getStatusText())) throw new Error("Clipboard unavailable; select the displayed status to copy it.");
    });
    if (this.controller.exportDiagnostics) actionButton(actions, "Copy diagnostics", async () => {
      const text = this.controller.exportDiagnostics!();
      if (await copyText(text)) return;
      const dialog = new Modal(this.app);
      dialog.contentEl.createEl("h2", {text: "Copy diagnostic data"});
      dialog.contentEl.createEl("p", {text: "Clipboard unavailable. Select and copy the data below. It contains no note content, paths or credentials."});
      const output = dialog.contentEl.createEl("textarea", {cls: "s3-vault-sync-diagnostic-export"});
      output.value = text;
      output.readOnly = true;
      dialog.open();
    });
    if (this.controller.getStatusText().includes("Repair Mode")) {
      actions.createEl("button", {text: "Recovery guidance"}).addEventListener("click", () => {
        showGuidance(this.app, "Remote recovery required",
          statusHelp(this.controller.getStatusText()));
      });
    }
    if (this.controller.getPendingBulkDeletion()) {
      actionButton(actions, "Confirm bulk deletion", async () => { await this.controller.confirmBulkDeletion(); this.onOpen(); })
        .addClass("mod-warning");
    }
  }

  private renderDiagnostics(container: HTMLElement): void {
    container.empty();
    const view = this.controller.getDiagnostics?.(20);
    if (!view) return;
    const last = view.records.at(-1);
    const result = [...view.records].reverse().find(record => record.counts)?.counts;
    const observed = [...view.records].reverse().find(record => record.observedRemote);
    const date = (time?: number): string => time === undefined ? "Not recorded" : new Date(time).toLocaleString();
    container.createEl("h3", {text: "Sync diagnostics"});
    container.createEl("p", {text: `Last recorded successful sync: ${date(view.lastSuccessAt)}`});
    container.createEl("p", {text: `Local accepted Commit: ${view.acceptedCommit ?? "Not yet accepted"}`});
    container.createEl("p", {text: `Last checked S3 Head: ${observed?.observedRemote ?? "Not yet checked"} · ${date(observed?.remoteCheckedAt)}`});
    container.createEl("p", {text: `Queued check: ${view.queued ? "Yes" : "No"} · Local paths awaiting check: ${view.pendingLocalChanges}`});
    container.createEl("p", {text: `Last known plan — Pending uploads: ${last?.pendingUploads ?? "Not yet planned"} · Pending downloads: ${last?.pendingDownloads ?? "Not yet planned"}`});
    if (result) container.createEl("p", {text: `Last result — Published changes: ${result.uploaded} · Downloaded: ${result.downloaded} · Deferred: ${result.deferred} · Unsynced local: ${result.unsynced}`});
    if (last) container.createEl("p", {text: `Phase: ${last.phase} · HTTP requests: ${last.requests} · Payload bytes sent/received: ${last.sentBytes}/${last.receivedBytes}`});
    container.createEl("p", {text: `Next scheduled retry: ${view.nextRetryAt === undefined ? "None" : date(view.nextRetryAt)}`});
    if (last?.errorCategory) container.createEl("p", {text: `Last run error: ${last.errorCategory}${last.httpStatus ? ` (HTTP ${last.httpStatus})` : ""}${last.writeResultUncertain ? ". A remote write may have completed; retry rechecks Head." : ""}`});
    if (view.persistenceWarning) container.createEl("p", {text: view.persistenceWarning, cls: "s3-vault-sync-error"});
    container.createEl("small", {text: "These records describe this device. Publishing to S3 does not confirm that another device has received the files. Deferred files can remain even when Commit IDs match."});
  }

  private renderDiagnosticHistory(container: HTMLElement): void {
    container.empty();
    const view = this.controller.getDiagnostics?.(20);
    if (!view?.records.length) return;
    const details = container.createEl("details");
    details.createEl("summary", {text: "Recent sync runs (up to 20)"});
    for (const record of [...view.records].reverse()) {
      const elapsed = record.finishedAt === undefined ? "unfinished" : `${Math.max(0, record.finishedAt - record.startedAt)} ms`;
      details.createEl("p", {text: `${new Date(record.startedAt).toLocaleString()} · ${record.triggers.join(", ")} · ${record.outcome} · ${record.phase} · ${elapsed} · ${record.requests} requests${record.errorCategory ? ` · ${record.errorCategory}` : ""}`});
    }
  }

  private renderBulkDeletion(container: HTMLElement): void {
    const bulk = this.controller.getPendingBulkDeletion();
    if (bulk) {
      container.createEl("p", {
        cls: "s3-vault-sync-error",
        text: `Delete ${bulk.count} of ${bulk.totalLiveEntries} entries?`,
      });
    }
  }

  private renderConflicts(container: HTMLElement): void {
    const conflicts = this.controller.getConflicts();
    if (conflicts.length === 0) {
      return;
    }
    container.createEl("h3", { text: "Conflict Center" });
    for (const conflict of conflicts) {
      const item = container.createDiv({ cls: "s3-vault-sync-conflict" });
      item.createEl("strong", { text: conflict.path });
      item.createEl("div", {
        cls: "s3-vault-sync-muted",
        text: conflict.reason,
      });
      for (const candidate of conflict.candidates) {
        const row = item.createDiv({cls: "s3-vault-sync-toolbar"});
        row.createSpan({text: `${candidate.createdAt} · ${candidate.size} bytes`});
        row.createEl("button", {text: "Preview version"}).addEventListener("click", () => {
          new DeletedFilePreviewModal(this.app, conflict, candidate,
            () => this.controller.readConflictCandidate(conflict.entryId, candidate.revisionId), "Conflict version preview").open();
        });
        actionButton(row, "Use this version", async () => {
          await this.controller.resolveConflict(conflict.entryId, candidate.revisionId); this.onOpen();
        });
      }
      if (
        conflict.reason === "delete-edit" ||
        conflict.reason === "edit-delete"
      ) {
        actionButton(item, "Keep deleted", async () => {await this.controller.keepConflictDeleted(conflict.entryId); this.onOpen();});
      }
    }
  }

  private renderDeferredDownloads(container: HTMLElement): void {
    const deferred = this.controller.getDeferredDownloads();
    if (deferred.length === 0) {
      return;
    }
    container.createEl("h3", {
      text: `${deferred.length} files unavailable on this device`,
    });
    for (const entry of deferred) {
      const item = container.createDiv({ cls: "s3-vault-sync-history" });
      item.createSpan({
        text:
          entry.reason === "unsupported-path"
            ? `${entry.path} · rename on another device`
            : `${entry.path} · ${Math.ceil(entry.size / 1024 / 1024)} MB`,
      });
      if (entry.reason === "unsupported-path") {
        renderIssueGuidance(item, {kind: "unsupported-path", path: entry.path});
        continue;
      }
      item.createEl("button", { text: "Try anyway" }).addEventListener(
        "click",
        () => {
          new RiskConfirmationModal(
            this.app,
            "This transfer exceeds the tested mobile limit and may cause Obsidian to close.",
            () => this.controller.downloadDeferred(entry.entryId),
          ).open();
        },
      );
    }
  }

  private renderDeletedRecoveries(container: HTMLElement): void {
    const deleted = this.controller.getDeletedRecoveries();
    if (deleted.length === 0) {
      return;
    }
    container.createEl("h3", { text: "Deleted files (30-day recovery)" });
    for (const entry of deleted) {
      const recovery = entry.recovery;
      const item = container.createDiv({ cls: "s3-vault-sync-deleted-row" });
      const previewTarget = item.createDiv({
        cls: "s3-vault-sync-deleted-preview",
      });
      previewTarget.createDiv({
        cls: "s3-vault-sync-selectable-path",
        text: entry.path,
      });
      previewTarget.createDiv({
        cls: "s3-vault-sync-muted",
        text: recovery
          ? "Click to preview"
          : "Primary recovery unavailable; open version history",
      });
      if (recovery) {
        previewTarget.setAttr("role", "button");
        previewTarget.setAttr("tabindex", "0");
        previewTarget.setAttr("aria-label", `Preview deleted file ${entry.path}`);
        const openPreview = (): void => {
          new DeletedFilePreviewModal(
            this.app,
            entry,
            recovery,
            () => this.controller.readDeletedRecovery(entry.entryId),
          ).open();
        };
        previewTarget.addEventListener("click", () => {
          if (!previewTarget.ownerDocument.getSelection()?.toString()) {
            openPreview();
          }
        });
        previewTarget.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openPreview();
          }
        });
      }
      const actions = item.createDiv({ cls: "s3-vault-sync-deleted-actions" });
      actions.createEl("button", { text: "Copy path" }).addEventListener(
        "click",
        () => {
          void copyText(entry.path).then((copied) => {
            new Notice(
              copied
                ? "Deleted file path copied"
                : "Clipboard unavailable; select the path to copy it",
            );
          });
        },
      );
      if (recovery) {
        actionButton(actions, "Restore", async () => {await this.controller.restoreDeleted(entry.entryId); this.onOpen();});
      }
      if ((entry.history?.length ?? 0) > 0) {
        actions
          .createEl("button", { text: "Version history" })
          .addEventListener("click", () => {
            new DeletedVersionHistoryModal(
              this.app,
              this.controller,
              entry,
            ).open();
          });
      }
    }
  }

  private renderIssueTools(item: HTMLElement, issue: LocalSyncIssue): void {
    const paths = "path" in issue ? [issue.path] : issue.kind === "path-collision" ? issue.paths : [];
    for (const path of paths) {
      const actions = item.createDiv({cls: "s3-vault-sync-toolbar"});
      actionButton(actions, paths.length > 1 ? `Open ${path}` : "Open local file", async () => {
        await this.controller.openLocalFile(path);
        this.close();
      });
      actions.createEl("button", {text: "Copy path"}).addEventListener("click", () => {
        void copyText(path).then(copied => new Notice(copied ? "Path copied" : "Select the path text to copy it."));
      });
    }
    renderIssueGuidance(item, issue);
  }

  private renderLocalIssues(container: HTMLElement): void {
    const issues = this.controller.getLocalIssues();
    if (issues.length === 0) {
      return;
    }
    container.createEl("h3", { text: "This device needs attention" });
    for (const issue of issues) {
      const item = container.createDiv({ cls: "s3-vault-sync-conflict" });
      if (issue.kind === "path-collision") {
        item.createEl("strong", { text: "Path collision" });
        item.createEl("div", { text: issue.paths.join(" · "), cls: "s3-vault-sync-selectable-path" });
        item.createEl("button", {text: "Review path collision", cls: "mod-cta"}).addEventListener("click", () => {
          new PathCollisionModal(this.app, issue.paths, this.controller, () => this.onOpen()).open();
        });
        this.renderIssueTools(item, issue);
        continue;
      }
      if (issue.kind === "possible-rename") {
        item.createEl("strong", { text: "Possible offline rename" });
        item.createEl("p", {
          text: `${issue.oldPaths.length} missing paths · ${issue.newPaths.length} new paths. Sync is waiting for your review.`,
        });
        item.createDiv({ cls: "s3-vault-sync-selectable-path", text:
          `${commonFolder(issue.oldPaths) || "Vault root"} → ${commonFolder(issue.newPaths) || "Vault root"}`,
        });
        const details = item.createEl("details");
        details.createEl("summary", { text: "Show all paths" });
        for (const [label, paths] of [["Missing", issue.oldPaths], ["New", issue.newPaths]] as const) {
          details.createEl("strong", { text: label });
          const list = details.createEl("ul", { cls: "s3-vault-sync-selectable-path" });
          for (const path of paths) list.createEl("li", { text: path });
        }
        item.createEl("button", { text: "Review and resolve", cls: "mod-cta" }).addEventListener("click", () => {
          new RenameReviewModal(this.app, issue, async resolution => {
            await this.controller.resolvePossibleRename(resolution);
            this.onOpen();
          }, async () => { await this.controller.syncNow(); this.onOpen(); }).open();
        });
        this.renderIssueTools(item, issue);
        continue;
      }
      item.createEl("strong", { text: issue.path, cls: "s3-vault-sync-selectable-path" });
      item.createEl("div", {
        text:
          issue.kind === "import-candidate"
              ? "This local path is not known to S3. Upload it as a new file only if it is not an existing note moved from another path."
            : issue.kind === "deferred-local-edit"
              ? "This local edit is waiting for the deferred remote Revision before it can be reconciled safely."
            : issue.kind === "bootstrap-mismatch"
              ? "Local and remote contents differ, and this device has no accepted common version for this file. Compare the versions before choosing how to continue."
              : issue.kind === "resolution-mismatch"
                ? "This file changed while its Conflict was awaiting resolution."
                : issue.kind === "unsupported-path"
                  ? "Rename this file on another device before it can sync here."
                  : "Local file exceeds the automatic mobile limit.",
      });
      if (issue.kind === "import-candidate") {
        actionButton(item, "Upload as new file", async () => {await this.controller.importCandidate(issue.path); this.onOpen();});
      }
      if (issue.kind === "bootstrap-mismatch" || issue.kind === "resolution-mismatch" || issue.kind === "deferred-local-edit") {
        item.createEl("button", {text: "Compare and resolve", cls: "mod-cta"}).addEventListener("click", () => {
          new LocalContentReviewModal(this.app, issue.path, this.controller, () => this.onOpen()).open();
        });
      }
      this.renderIssueTools(item, issue);
    }
  }
}

class DeletedVersionHistoryModal extends Modal {
  constructor(
    app: App,
    private readonly controller: StatusModalController,
    private readonly entry: DeletedEntry,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", {
      text: `Deleted version history: ${this.entry.path}`,
    });
    for (const revision of this.entry.history ?? []) {
      const row = this.contentEl.createDiv({ cls: "s3-vault-sync-history" });
      row.createSpan({ text: `${revision.createdAt} · ${revision.size} bytes` });
      row.createEl("button", { text: "Preview" }).addEventListener("click", () => {
        new DeletedFilePreviewModal(
          this.app,
          this.entry,
          revision,
          () =>
            this.controller.readDeletedRecovery(
              this.entry.entryId,
              revision.revisionId,
            ),
        ).open();
      });
      actionButton(row, "Restore", async () => {await this.controller.restoreDeleted(this.entry.entryId, revision.revisionId); this.close();});
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class VersionHistoryModal extends Modal {
  constructor(
    app: App,
    private readonly controller: VersionHistoryController,
    private readonly entry: LiveEntry,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: `Version history: ${this.entry.path}` });
    const history = this.entry.history ?? [];
    if (history.length === 0) {
      this.contentEl.createEl("p", { text: "No recoverable revisions." });
      return;
    }
    this.contentEl.createEl("p", {text: "Versions kept after replacement or a manual choice are recoverable for 30 days. Preview before restoring; restoring also preserves the current version."});
    for (const revision of history) {
      const row = this.contentEl.createDiv({ cls: "s3-vault-sync-history" });
      row.createSpan({ text: `Version recorded: ${revision.createdAt} · ${revision.size} bytes${revision.expiresAt ? ` · recoverable until ${revision.expiresAt}` : ""}` });
      row.createEl("button", {text: "Preview"}).addEventListener("click", () => {
        new DeletedFilePreviewModal(this.app, this.entry, revision,
          () => this.controller.readHistoricalRevision(this.entry.entryId, revision.revisionId), "Version history preview").open();
      });
      actionButton(row, "Restore", async () => {await this.controller.restoreRevision(this.entry.entryId, revision.revisionId); this.close();});
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
