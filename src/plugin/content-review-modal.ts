import { App, Modal } from "obsidian";

import type { StatusModalController } from "./modals";
import type { LocalContentChoice } from "../sync/sync-service";
import { actionButton } from "./modal-actions";
import { copyText } from "./clipboard";
import { renderContentDiff } from "./content-diff";

const formatTime = (value: string | number | undefined): string => {
  if (value === undefined) return "Unknown";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unknown";
};

export class LocalContentReviewModal extends Modal {
  constructor(
    app: App,
    private readonly path: string,
    private readonly controller: StatusModalController,
    private readonly refresh: () => void,
  ) { super(app); }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", {text: "Compare and resolve"});
    this.contentEl.createDiv({cls: "s3-vault-sync-selectable-path", text: this.path});
    const status = this.contentEl.createEl("p", {text: "Reading and verifying both versions…"});
    const metadata = this.contentEl.createDiv();
    const decisions = this.contentEl.createDiv({cls: "s3-vault-sync-toolbar"});
    const actions = this.contentEl.createDiv({cls: "s3-vault-sync-toolbar"});
    const later = actions.createEl("button", {text: "Decide later"});
    later.addEventListener("click", () => this.close());
    actions.createEl("button", {text: "Open settings"}).addEventListener("click", () => {this.controller.openSettings(); this.close();});
    actionButton(actions, "Open local file", async () => {await this.controller.openLocalFile(this.path); this.close();});
    actionButton(actions, "Copy path", async () => {
      if (!await copyText(this.path)) throw new Error("Clipboard unavailable; select the displayed path to copy it.");
    });
    const body = this.contentEl.createDiv();
    void this.controller.reviewLocalContent(this.path).then(review => {
      status.setText(review.blockedReason ??
        (review.localExists && review.remoteKind === "live"
          ? "Choose which content stays at the original path. The other version is preserved before any replacement. This does not merge the contents. If unsure, keep both or decide later."
          : review.localExists
          ? "Your local version will be saved as a separate file before receiving the reviewed remote state."
          : "There is no local file to preserve. This path will receive the reviewed remote state."));
      metadata.createEl("p", {text: `Local last modified: ${formatTime(review.localModifiedAt)} · ${review.localSize} bytes`});
      for (const version of review.remoteVersions) {
        metadata.createEl("p", {text: `S3 version recorded: ${formatTime(version.createdAt)} · ${version.size} bytes`});
      }
      metadata.createEl("p", {text: "Local modification time can change during copying or migration. S3 time records the sync version, not the author's last edit. Neither time nor file size proves which version is correct."});
      body.createEl("h3", {text: review.remoteKind === "live" ? "Remote file exists (not deleted)" : `Remote state: ${review.remoteKind}`});
      if (review.remoteKind === "deleted") body.createEl("p", {text:
        "The remote file is deleted. After your local copy is safely preserved, the original path will remain deleted."});
      if (review.remoteKind === "conflicted") body.createEl("p", {text:
        "Remote conflict candidates remain in the Conflict Center. Preserving your local copy does not discard or select a remote candidate."});
      for (const [index, version] of review.remoteVersions.entries()) {
        body.createEl("h3", {text: `Differences · S3 version ${index + 1} · ${formatTime(version.createdAt)}`});
        if (review.localPreview !== undefined && version.preview !== undefined) {
          renderContentDiff(body, review.localPreview, version.preview);
        } else {
          body.createEl("p", {text: review.localExists
            ? "Line comparison unavailable: a version is binary, exceeds the text preview limit, or is blocked by this device's restrictions."
            : "There is no local file to compare with this remote version."});
        }
      }
      const local = body.createEl("details");
      local.createEl("summary", {text: `Full local version · ${review.localSize} bytes`});
      local.createEl("pre", {cls: "s3-vault-sync-preview-content", text: review.localPreview ??
        (review.localExists ? "Text preview unavailable (binary file or preview size limit)." : "Local file is missing.")});
      for (const version of review.remoteVersions) {
        const detail = body.createEl("details");
        detail.createEl("summary", {text: `Full remote version · ${version.createdAt} · ${version.size} bytes`});
        detail.createEl("pre", {cls: "s3-vault-sync-preview-content", text: version.preview ?? "Text preview unavailable."});
      }
      if (review.blockedReason) return;
      const choices: Array<{choice: LocalContentChoice; label: string; description: string}> = review.localExists && review.remoteKind === "live" ? [
        {choice: "local", label: "Use local version", description: "Keep this file's local content and publish it to S3. Keep the previous S3 version in history for 30 days."},
        {choice: "remote", label: "Use S3 version", description: "Replace this file with S3 content only after backing up the local content in encrypted history for 30 days. No extra note is created."},
        {choice: "both", label: "Keep both (local copy)", description: "Use S3 content at the original path; save local content as a separate visible note that also syncs. No automatic merge."},
      ] : [{choice: "both", label: review.localExists ? "Preserve local copy and accept remote" : "Accept remote state",
        description: "Existing remote conflicts and deletion decisions are not discarded."}];
      const buttons: HTMLButtonElement[] = [];
      for (const {choice, label, description} of choices) {
        const option = decisions.createDiv({cls: "s3-vault-sync-review-choice"});
        const confirm = option.createEl("button", {text: label});
        option.createEl("p", {text: description});
        buttons.push(confirm);
        confirm.addEventListener("click", () => {
          if (confirm.disabled) return;
          for (const button of buttons) button.disabled = true;
          later.disabled = true;
          status.setText("Preserving content and rechecking the reviewed versions…");
          void this.controller.resolveLocalContent(this.path, review.reviewToken, choice)
            .then(copyPath => { this.refresh(); this.showCompleted(choice, copyPath); })
            .catch((error: unknown) => {
              later.disabled = false;
              status.setText(error instanceof Error ? error.message : "Review failed. Reopen this review to retry.");
              decisions.createEl("button", {text: "Reload review"}).addEventListener("click", () => this.onOpen());
            });
        });
      }
    }).catch((error: unknown) => {
      status.setText(error instanceof Error ? error.message : "Could not read the versions.");
      actions.createEl("button", {text: "Retry review"}).addEventListener("click", () => this.onOpen());
    });
  }

  private showCompleted(choice: LocalContentChoice, copyPath: string | undefined): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", {text: "Resolution complete"});
    this.contentEl.createDiv({cls: "s3-vault-sync-selectable-path", text: this.path});
    this.contentEl.createEl("p", {text: copyPath ? `Local content saved as a separate file: ${copyPath}`
      : choice === "both" ? "The reviewed remote state was accepted."
      : `${choice === "local" ? "Local" : "S3"} content is now used at the original path. The other version is recoverable from encrypted version history for 30 days.`});
    if (choice !== "both") {
      actionButton(this.contentEl, "Open version history", async () => {this.controller.openVersionHistory(this.path);});
      this.contentEl.createEl("p", {text: "You can also open this file later and run “S3 Safe Sync: Open version history for the current file” from the command palette."});
    }
    this.contentEl.createEl("button", {text: "Close"}).addEventListener("click", () => this.close());
  }
}
