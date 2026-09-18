import { App, Modal, Notice } from "obsidian";

import type { StatusModalController } from "./modals";
import { renderContentDiff } from "./content-diff";
import { actionButton } from "./modal-actions";

export class PathCollisionModal extends Modal {
  constructor(app: App, private readonly paths: string[], private readonly controller: StatusModalController,
    private readonly refresh: () => void) { super(app); }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", {text: "Review path collision"});
    this.contentEl.createEl("p", {text: "Different file identities or equivalent names are competing for a path. Even one displayed filename can have multiple owners. Rename one item to keep the contents separate; do not delete files or clear the cache."});
    const message = this.contentEl.createEl("p", {text: "Reading current paths and verifying previews…"});
    const top = this.contentEl.createDiv({cls: "s3-vault-sync-toolbar"});
    top.createEl("button", {text: "Decide later"}).addEventListener("click", () => this.close());
    top.createEl("button", {text: "Reload collision review"}).addEventListener("click", () => this.onOpen());
    actionButton(top, "Refresh sync status", async () => {await this.controller.syncNow(); this.refresh(); this.close();});
    const body = this.contentEl.createDiv();
    void this.controller.reviewPathCollision(this.paths).then(review => {
      message.setText("Choose the item to rename and review its new filename. Local renames keep tracked identities and pending moves; S3 renames keep the selected record's content and history. Links using the old path may need updating. No content winner is chosen here.");
      for (const move of review.pendingMoves) body.createEl("p", {text: `Pending local move: ${move.from} → ${move.to}`});
      for (const path of review.relatedPaths) body.createEl("p", {text: `Related tracked path: ${path}`});
      if (review.interruptedRename) {
        const pending = review.interruptedRename;
        const recovery = body.createDiv({cls: "s3-vault-sync-conflict"});
        recovery.createEl("h3", {text: "Interrupted rename needs confirmation"});
        recovery.createEl("p", {text: `${pending.from} → ${pending.to}. Contents changed during an interrupted move, so no identity has been guessed. Preview the files below, then choose which path continues the original file. Any other file is left untouched.`});
        const available = (["source", "target"] as const).filter(side => review.localFiles.some(file =>
          file.path === (side === "source" ? pending.from : pending.to) && file.contentHash));
        for (const side of available) {
          actionButton(recovery, side === "source" ? "Keep original identity at source" : "Confirm target is the renamed original", async () => {
            await this.controller.confirmInterruptedCollisionRename(review.paths, review.reviewToken, side);
            this.refresh(); this.close();
          });
        }
        if (!available.length) recovery.createEl("p", {text: "Neither recoverable file is available on this device. Restore one of the displayed paths from Obsidian Trash or your backup, then retry this review. No remote deletion has been published by this recovery."});
      }
      if (!review.localFiles.length && !review.remoteFiles.length) {
        body.createEl("p", {text: "No current files were found at these paths. Refresh sync status to remove stale warnings."});
      }
      const buttons: HTMLButtonElement[] = [];
      const inputs: HTMLInputElement[] = [];
      for (const [side, files] of [["local", review.localFiles], ["remote", review.remoteFiles]] as const) {
        for (const file of files) {
          const item = body.createDiv({cls: "s3-vault-sync-conflict"});
          item.createEl("h3", {text: side === "local" ? "Local file" : "S3 file record"});
          item.createDiv({cls: "s3-vault-sync-selectable-path", text: file.path});
          item.createEl("p", {text: `${file.size} bytes · ${file.entryId ? `Record ${file.entryId}` : "No confirmed local identity"}`});
          if (file.previousPath && file.previousPath !== file.path) item.createEl("p", {text: `Previously accepted path: ${file.previousPath}`});
          const preview = item.createEl("details");
          preview.createEl("summary", {text: "Preview contents"});
          preview.createEl("pre", {cls: "s3-vault-sync-preview-content", text: file.preview ?? "Text preview unavailable (binary, size limit, or device restriction)."});
          if (side === "remote" && review.localFiles.length === 1 && review.localFiles[0]?.preview !== undefined && file.preview !== undefined) {
            const diff = item.createEl("details");
            diff.createEl("summary", {text: "Compare with the local file"});
            renderContentDiff(diff, review.localFiles[0].preview, file.preview);
          }
          item.createEl("p", {text: side === "local"
            ? file.preserveAsNew
              ? "This local identity was deleted in S3. Preserve its current contents as a new encrypted, synced file before moving it. The old deletion record remains valid."
              : "Rename only this device's file, without overwriting another file, then retry sync."
            : "Rename only this S3 record. Its stable identity, encrypted content and version history remain intact; other devices will receive the move."});
          if (file.blockedReason) { item.createEl("p", {text: file.blockedReason}); continue; }
          if (review.interruptedRename) continue;
          const input = item.createEl("input", {type: "text", attr: {"aria-label": `New filename for ${side}: ${file.path}`}});
          input.value = file.suggestedName;
          inputs.push(input);
          const button = item.createEl("button", {text: side === "local"
            ? file.preserveAsNew ? "Preserve as new file and sync" : "Rename local file and sync"
            : "Rename S3 record and sync"});
          buttons.push(button);
          button.addEventListener("click", () => {
            if (button.disabled) return;
            for (const value of [...buttons, ...inputs]) value.disabled = true;
            message.setText("Rechecking the selected file and destination before renaming…");
            void this.controller.resolvePathCollision({paths: review.paths, reviewToken: review.reviewToken,
              side, path: file.path, entryId: file.entryId, newName: input.value})
              .then(newPath => {this.refresh(); this.close(); new Notice(`Renamed to ${newPath}. Sync status has been refreshed; review any remaining items.`);})
              .catch((error: unknown) => {
                message.setText(error instanceof Error ? error.message : "Rename failed. Reload this review.");
              });
          });
        }
      }
    }).catch((error: unknown) => {
      message.setText(error instanceof Error ? error.message : "Could not review the current paths.");
      top.createEl("button", {text: "Retry collision review"}).addEventListener("click", () => this.onOpen());
    });
  }
}
