import { App, Modal } from "obsidian";

import type {
  ConflictedEntry,
  DeletedEntry,
  LiveEntry,
} from "../sync/sync-engine";
import type { LocalSyncIssue } from "../sync/sync-service";

export interface StatusModalController {
  confirmBulkDeletion(): Promise<void>;
  downloadDeferred(entryId: string): Promise<void>;
  getConflicts(): ConflictedEntry[];
  getDeferredDownloads(): Array<{
    entryId: string;
    path: string;
    size: number;
  }>;
  getDeletedRecoveries(): DeletedEntry[];
  getLocalIssues(): LocalSyncIssue[];
  getPendingBulkDeletion():
    | { count: number; totalLiveEntries: number }
    | undefined;
  getStatusText(): string;
  importCandidate(path: string): Promise<void>;
  isPaused(): boolean;
  keepConflictDeleted(entryId: string): Promise<void>;
  resolveConflict(entryId: string, revisionId: string): Promise<void>;
  restoreDeleted(entryId: string): Promise<void>;
  syncNow(): Promise<void>;
  togglePause(): Promise<void>;
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

export class StatusModal extends Modal {
  constructor(
    app: App,
    private readonly controller: StatusModalController,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "S3 Vault Sync" });
    this.contentEl.createEl("p", { text: this.controller.getStatusText() });
    this.renderBulkDeletion();
    this.renderConflicts();
    this.renderLocalIssues();
    this.renderDeferredDownloads();
    this.renderDeletedRecoveries();
    this.renderActions();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderActions(): void {
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "Sync now" }).addEventListener("click", () => {
      void this.controller.syncNow().then(() => this.onOpen());
    });
    actions
      .createEl("button", {
        text: this.controller.isPaused() ? "Resume" : "Pause",
      })
      .addEventListener("click", () => {
        void this.controller.togglePause().then(() => this.onOpen());
      });
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
      text: `${deferred.length} large files unavailable on this device`,
    });
    for (const entry of deferred) {
      const item = this.contentEl.createDiv({ cls: "s3-vault-sync-history" });
      item.createSpan({
        text: `${entry.path} · ${Math.ceil(entry.size / 1024 / 1024)} MB`,
      });
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
      const item = this.contentEl.createDiv({ cls: "s3-vault-sync-history" });
      item.createSpan({ text: entry.path });
      item.createEl("button", { text: "Restore" }).addEventListener("click", () => {
        void this.controller.restoreDeleted(entry.entryId).then(() => this.onOpen());
      });
    }
  }

  private renderLocalIssues(): void {
    const issues = this.controller.getLocalIssues();
    if (issues.length === 0) {
      return;
    }
    this.contentEl.createEl("h3", { text: "This device needs attention" });
    for (const issue of issues) {
      const item = this.contentEl.createDiv({ cls: "s3-vault-sync-conflict" });
      if (issue.kind === "path-collision") {
        item.createEl("strong", { text: "Path collision" });
        item.createEl("div", { text: issue.paths.join(" · ") });
        continue;
      }
      if (issue.kind === "possible-rename") {
        item.createEl("strong", { text: "Possible offline rename" });
        item.createEl("div", {
          text: `Missing: ${issue.oldPaths.join(", ")} · New: ${issue.newPaths.join(", ")}`,
        });
        continue;
      }
      item.createEl("strong", { text: issue.path });
      item.createEl("div", {
        text:
          issue.kind === "import-candidate"
            ? "Local file requires import confirmation."
            : issue.kind === "bootstrap-mismatch"
              ? "Local content differs from the encrypted remote Revision after cache loss."
              : issue.kind === "resolution-mismatch"
                ? "This file changed while its Conflict was awaiting resolution."
              : "Local file exceeds the automatic mobile limit.",
      });
      if (issue.kind === "import-candidate") {
        item.createEl("button", { text: "Import" }).addEventListener("click", () => {
          void this.controller.importCandidate(issue.path).then(() => this.onOpen());
        });
      }
    }
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
