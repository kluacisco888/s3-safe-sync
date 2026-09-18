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
  PossibleRenameIssue,
  PossibleRenameResolution,
} from "../sync/sync-service";
import {
  decodeDeletedPreview,
  MAX_DELETED_PREVIEW_BYTES,
} from "./deleted-preview";
import { copyText } from "./clipboard";

export interface StatusModalController {
  reviewLocalContent(path: string): Promise<LocalContentReview>;
  preserveLocalCopyAndAcceptRemote(path: string, reviewToken: string): Promise<string | undefined>;
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

class LocalContentReviewModal extends Modal {
  constructor(
    app: App,
    private readonly path: string,
    private readonly controller: StatusModalController,
    private readonly refresh: () => void,
  ) { super(app); }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", {text: "Review local and remote versions"});
    this.contentEl.createDiv({cls: "s3-vault-sync-selectable-path", text: this.path});
    const body = this.contentEl.createDiv();
    const status = body.createEl("p", {text: "Reading and verifying both versions…"});
    const actions = this.contentEl.createDiv({cls: "s3-vault-sync-toolbar"});
    actions.createEl("button", {text: "Close"}).addEventListener("click", () => this.close());
    void this.controller.reviewLocalContent(this.path).then(review => {
      status.setText(review.blockedReason ??
        (review.localExists
          ? "Your local version will be kept as a separate local-copy file and verified in S3 before this path receives the remote state. You can compare or merge the two files afterward."
          : "There is no local file to preserve. This path will receive the reviewed remote state."));
      body.createEl("h3", {text: `Local version · ${review.localSize} bytes`});
      body.createEl("pre", {cls: "s3-vault-sync-preview-content", text: review.localPreview ??
        (review.localExists ? "Text preview unavailable (binary file or preview size limit)." : "Local file is missing.")});
      body.createEl("h3", {text: `Remote state: ${review.remoteKind}`});
      if (review.remoteKind === "deleted") body.createEl("p", {text:
        "The remote file is deleted. After your local copy is safely preserved, the original path will remain deleted."});
      if (review.remoteKind === "conflicted") body.createEl("p", {text:
        "Remote conflict candidates remain in the Conflict Center. Preserving your local copy does not discard or select a remote candidate."});
      for (const [index, version] of review.remoteVersions.entries()) {
        const detail = body.createEl("details");
        detail.open = index === 0;
        detail.createEl("summary", {text: `${version.createdAt} · ${version.size} bytes`});
        detail.createEl("pre", {cls: "s3-vault-sync-preview-content", text: version.preview ?? "Text preview unavailable."});
      }
      if (review.blockedReason) return;
      const confirm = actions.createEl("button", {cls: "mod-cta", text:
        review.localExists ? "Preserve local copy and accept remote" : "Accept remote state"});
      confirm.addEventListener("click", () => {
        confirm.disabled = true;
        status.setText("Preserving content and rechecking the reviewed versions…");
        void this.controller.preserveLocalCopyAndAcceptRemote(this.path, review.reviewToken)
          .then(copyPath => {
            this.refresh();
            this.close();
            if (copyPath) new Notice(`Both versions preserved. Local copy: ${copyPath}`);
          }).catch((error: unknown) => {
            status.setText(error instanceof Error ? error.message : "Review failed. Reopen this review to retry.");
            actions.createEl("button", {text: "Reload review"}).addEventListener("click", () => this.onOpen());
          });
      });
    }).catch((error: unknown) => {
      status.setText(error instanceof Error ? error.message : "Could not read the versions.");
      actions.createEl("button", {text: "Retry review"}).addEventListener("click", () => this.onOpen());
    });
  }
}

const localIssueHelp = (issue: LocalSyncIssue): string => {
  switch (issue.kind) {
    case "bootstrap-mismatch": return "This device has no accepted common version for this path. Use Review versions to preserve your local version as a new file, then receive the remote state. Do not clear the cache again; it cannot establish which version you intended.";
    case "resolution-mismatch": return "This file changed after a conflict was recorded. Review versions preserves these additional edits as a separate file before receiving the remote state. Remaining conflict candidates stay in the Conflict Center.";
    case "deferred-local-edit": return "The local file was edited while a newer remote version was deferred. Review versions can preserve both when they fit this device's limit. Otherwise resolve on desktop; switching to Wi-Fi can help attachments below the mobile size limit.";
    case "path-collision": return "These paths collide by case, Unicode normalization, or file ownership. Open the affected files on the device that holds them, give unrelated files distinct names, then Sync now. If the paths differ only by letter case, rename through a temporary distinct name. Do not delete either version to clear the warning.";
    case "unsupported-path": return "This filename cannot be created on this device. Copy the path and rename the file on a compatible desktop, then sync both devices. The original remains on the remote; changing the cache cannot fix a filesystem filename restriction.";
    case "unsynced-local": return "This local file exceeds this device's automatic limit and has not been uploaded. Open it to inspect it. Connect to Wi-Fi if it is an attachment below the mobile limit, or copy it to a desktop and sync there. Split or reduce large files before syncing on mobile.";
    case "import-candidate": return "This local file has no remote identity. Import explicitly uploads it as a new file after checking that its path is still available.";
    case "possible-rename": return "Review and resolve lets you confirm one-to-one moves or explicitly choose separate deletions and additions. Every decision is checked again before publishing.";
  }
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
    actions
      .createEl("button", { cls: "mod-warning", text: "Try anyway" })
      .addEventListener("click", () => {
        void this.confirm().then(() => this.close());
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class DeletedFilePreviewModal extends Modal {
  constructor(
    app: App,
    private readonly entry: DeletedEntry,
    private readonly revision: RevisionRef,
    private readonly loadContent: () => Promise<Uint8Array>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Deleted file preview" });
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
    this.renderActions();
    this.renderBulkDeletion();
    this.renderConflicts();
    const localIssues = this.contentEl.createDiv();
    this.renderLocalIssues(localIssues);
    this.renderDeferredDownloads();
    this.renderDeletedRecoveries();
    this.stopStatusUpdates = this.controller.onStatusChange(display => {
      status.setText(display.text);
      this.pauseButton?.setText(this.controller.isPaused() ? "Resume" : "Pause");
      if (/^(Idle|Action required):/.test(display.text)) {
        localIssues.empty();
        this.renderLocalIssues(localIssues);
      }
    });
  }

  onClose(): void {
    this.stopStatusUpdates?.();
    this.stopStatusUpdates = undefined;
    this.pauseButton = undefined;
    this.contentEl.empty();
  }

  private renderActions(): void {
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.addClass("s3-vault-sync-toolbar");
    actions.createEl("button", { text: "Sync now" }).addEventListener("click", () => {
      void this.controller.syncNow().then(() => this.onOpen());
    });
    this.pauseButton = actions.createEl("button", {
      text: this.controller.isPaused() ? "Resume" : "Pause",
    });
    this.pauseButton.addEventListener("click", () => {
      void this.controller.togglePause().then(() => this.onOpen());
    });
    if (this.controller.getStatusText().includes("Repair Mode")) {
      actions.createEl("button", {text: "Recovery guidance"}).addEventListener("click", () => {
        showGuidance(this.app, "Remote recovery required",
          "The remote state could not be authenticated. Pause sync on all devices and preserve local copies. Check the configured bucket/prefix and AWS permissions. For a missing or damaged Head, inspect S3 Versioning and restore a verified Head with its referenced objects, then retry. Do not initialize a new Vault over the existing prefix.");
      });
    }
    if (this.controller.getPendingBulkDeletion()) {
      actions
        .createEl("button", {
          cls: "mod-warning",
          text: "Confirm bulk deletion",
        })
        .addEventListener("click", () => {
          void this.controller.confirmBulkDeletion().then(() => this.onOpen());
        });
    }
  }

  private renderBulkDeletion(): void {
    const bulk = this.controller.getPendingBulkDeletion();
    if (bulk) {
      this.contentEl.createEl("p", {
        cls: "s3-vault-sync-error",
        text: `Delete ${bulk.count} of ${bulk.totalLiveEntries} entries?`,
      });
    }
  }

  private renderConflicts(): void {
    const conflicts = this.controller.getConflicts();
    if (conflicts.length === 0) {
      return;
    }
    this.contentEl.createEl("h3", { text: "Conflict Center" });
    for (const conflict of conflicts) {
      const item = this.contentEl.createDiv({ cls: "s3-vault-sync-conflict" });
      item.createEl("strong", { text: conflict.path });
      item.createEl("div", {
        cls: "s3-vault-sync-muted",
        text: conflict.reason,
      });
      for (const candidate of conflict.candidates) {
        item
          .createEl("button", { text: `Restore ${candidate.createdAt}` })
          .addEventListener("click", () => {
            void this.controller
              .resolveConflict(conflict.entryId, candidate.revisionId)
              .then(() => this.onOpen());
          });
      }
      if (
        conflict.reason === "delete-edit" ||
        conflict.reason === "edit-delete"
      ) {
        item.createEl("button", { text: "Keep deleted" }).addEventListener(
          "click",
          () => {
            void this.controller
              .keepConflictDeleted(conflict.entryId)
              .then(() => this.onOpen());
          },
        );
      }
    }
  }

  private renderDeferredDownloads(): void {
    const deferred = this.controller.getDeferredDownloads();
    if (deferred.length === 0) {
      return;
    }
    this.contentEl.createEl("h3", {
      text: `${deferred.length} files unavailable on this device`,
    });
    for (const entry of deferred) {
      const item = this.contentEl.createDiv({ cls: "s3-vault-sync-history" });
      item.createSpan({
        text:
          entry.reason === "unsupported-path"
            ? `${entry.path} · rename on another device`
            : `${entry.path} · ${Math.ceil(entry.size / 1024 / 1024)} MB`,
      });
      if (entry.reason === "unsupported-path") {
        item.createEl("button", {text: "How to resolve"}).addEventListener("click", () =>
          showGuidance(this.app, "Unsupported filename", localIssueHelp({kind: "unsupported-path", path: entry.path})));
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

  private renderDeletedRecoveries(): void {
    const deleted = this.controller.getDeletedRecoveries();
    if (deleted.length === 0) {
      return;
    }
    this.contentEl.createEl("h3", { text: "Deleted files (30-day recovery)" });
    for (const entry of deleted) {
      const recovery = entry.recovery;
      const item = this.contentEl.createDiv({ cls: "s3-vault-sync-deleted-row" });
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
        actions.createEl("button", { text: "Restore" }).addEventListener(
          "click",
          () => {
            void this.controller
              .restoreDeleted(entry.entryId)
              .then(() => this.onOpen());
          },
        );
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
      actions.createEl("button", {text: paths.length > 1 ? `Open ${path}` : "Open local file"})
        .addEventListener("click", () => { void this.controller.openLocalFile(path).catch(error => new Notice(String(error))); });
      actions.createEl("button", {text: "Copy path"}).addEventListener("click", () => {
        void copyText(path).then(copied => new Notice(copied ? "Path copied" : "Select the path text to copy it."));
      });
    }
    item.createEl("button", {text: "How to resolve"}).addEventListener("click", () =>
      showGuidance(this.app, "Resolve this sync issue", localIssueHelp(issue)));
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
          }).open();
        });
        this.renderIssueTools(item, issue);
        continue;
      }
      item.createEl("strong", { text: issue.path, cls: "s3-vault-sync-selectable-path" });
      item.createEl("div", {
        text:
          issue.kind === "import-candidate"
              ? "Local file requires import confirmation."
            : issue.kind === "deferred-local-edit"
              ? "This local edit is waiting for the deferred remote Revision before it can be reconciled safely."
            : issue.kind === "bootstrap-mismatch"
              ? "Local content differs from the encrypted remote Revision after cache loss."
              : issue.kind === "resolution-mismatch"
                ? "This file changed while its Conflict was awaiting resolution."
                : issue.kind === "unsupported-path"
                  ? "Rename this file on another device before it can sync here."
                  : "Local file exceeds the automatic mobile limit.",
      });
      if (issue.kind === "import-candidate") {
        item.createEl("button", { text: "Import" }).addEventListener("click", () => {
          void this.controller.importCandidate(issue.path).then(() => this.onOpen());
        });
      }
      if (issue.kind === "bootstrap-mismatch" || issue.kind === "resolution-mismatch" || issue.kind === "deferred-local-edit") {
        item.createEl("button", {text: "Review versions", cls: "mod-cta"}).addEventListener("click", () => {
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
      row.createEl("button", { text: "Restore" }).addEventListener("click", () => {
        void this.controller
          .restoreDeleted(this.entry.entryId, revision.revisionId)
          .then(() => this.close());
      });
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
    for (const revision of history) {
      const row = this.contentEl.createDiv({ cls: "s3-vault-sync-history" });
      row.createSpan({ text: `${revision.createdAt} · ${revision.size} bytes` });
      row.createEl("button", { text: "Restore" }).addEventListener("click", () => {
        void this.controller
          .restoreRevision(this.entry.entryId, revision.revisionId)
          .then(() => this.close());
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
