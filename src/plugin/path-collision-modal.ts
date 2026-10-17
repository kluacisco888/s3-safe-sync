import { App, Modal, Notice } from "obsidian";

import type { StatusModalController } from "./modals";
import { renderContentDiff } from "./content-diff";
import { actionButton } from "./modal-actions";

export class PathCollisionModal extends Modal {
  constructor(app: App, private readonly paths: string[], private readonly controller: StatusModalController,
    private readonly refresh: () => void) { super(app); }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", {text: "审查路径撞名"});
    this.contentEl.createEl("p", {text: "有不同的文件或写法等价的文件名在争用同一个路径。即使只显示一个文件名，它也可能对应多个文件。请给其中一个改名，让内容分开；不要删除文件，也不要清除缓存。"});
    const message = this.contentEl.createEl("p", {text: "正在读取当前路径并核实预览…"});
    const top = this.contentEl.createDiv({cls: "s3-vault-sync-toolbar"});
    top.createEl("button", {text: "稍后再决定"}).addEventListener("click", () => this.close());
    top.createEl("button", {text: "重新加载撞名审查"}).addEventListener("click", () => this.onOpen());
    actionButton(top, "刷新同步状态", async () => {await this.controller.syncNow(); this.refresh(); this.close();});
    const body = this.contentEl.createDiv();
    void this.controller.reviewPathCollision(this.paths).then(review => {
      message.setText("请选择要改名的项目并确认新文件名。本地改名会保留已跟踪的文件身份和待处理的挪动；S3 改名会保留所选记录的内容和历史。使用旧路径的链接可能需要更新。这里不会判定哪份内容胜出。");
      for (const move of review.pendingMoves) body.createEl("p", {text: `待处理的本地挪动：${move.from} → ${move.to}`});
      for (const path of review.relatedPaths) body.createEl("p", {text: `相关的已跟踪路径：${path}`});
      if (review.interruptedRename) {
        const pending = review.interruptedRename;
        const recovery = body.createDiv({cls: "s3-vault-sync-conflict"});
        recovery.createEl("h3", {text: "中断的改名需要确认"});
        recovery.createEl("p", {text: `${pending.from} → ${pending.to}。挪动中断期间内容有变化，所以没有去猜哪个是原文件。请预览下方的文件，再选择由哪个路径延续原文件。其他文件都不会被动到。`});
        const available = (["source", "target"] as const).filter(side => review.localFiles.some(file =>
          file.path === (side === "source" ? pending.from : pending.to) && file.contentHash));
        for (const side of available) {
          actionButton(recovery, side === "source" ? "原文件仍在原路径" : "确认目标路径就是改名后的原文件", async () => {
            await this.controller.confirmInterruptedCollisionRename(review.paths, review.reviewToken, side);
            this.refresh(); this.close();
          });
        }
        if (!available.length) recovery.createEl("p", {text: "本设备上两个可恢复的文件都不在。请从 Obsidian 回收站或你的备份中恢复其中一个显示的路径，然后重试这次审查。这次恢复没有发布任何远端删除。"});
      }
      if (!review.localFiles.length && !review.remoteFiles.length) {
        body.createEl("p", {text: "这些路径上已经找不到文件。请刷新同步状态，清掉过时的提示。"});
      }
      const buttons: HTMLButtonElement[] = [];
      const inputs: HTMLInputElement[] = [];
      for (const [side, files] of [["local", review.localFiles], ["remote", review.remoteFiles]] as const) {
        for (const file of files) {
          const item = body.createDiv({cls: "s3-vault-sync-conflict"});
          item.createEl("h3", {text: side === "local" ? "本地文件" : "S3 文件记录"});
          item.createDiv({cls: "s3-vault-sync-selectable-path", text: file.path});
          item.createEl("p", {text: `${file.size} 字节 · ${file.entryId ? `记录 ${file.entryId}` : "本地文件身份未确认"}`});
          if (file.previousPath && file.previousPath !== file.path) item.createEl("p", {text: `之前认可的路径：${file.previousPath}`});
          const preview = item.createEl("details");
          preview.createEl("summary", {text: "预览内容"});
          preview.createEl("pre", {cls: "s3-vault-sync-preview-content", text: file.preview ?? "无法预览文字（二进制文件、超过大小限制或受设备限制）。"});
          if (side === "remote" && review.localFiles.length === 1 && review.localFiles[0]?.preview !== undefined && file.preview !== undefined) {
            const diff = item.createEl("details");
            diff.createEl("summary", {text: "与本地文件对比"});
            renderContentDiff(diff, review.localFiles[0].preview, file.preview);
          }
          item.createEl("p", {text: side === "local"
            ? file.preserveAsNew
              ? "这个本地文件在 S3 上已被删除。挪动之前，请把它当前的内容另存为一个新的加密同步文件。原来的删除记录仍然有效。"
              : "只给本设备上的这个文件改名，不会覆盖其他文件，然后重新同步。"
            : "只给这条 S3 记录改名。它的文件身份、加密内容和历史版本都保持不变；其他设备会收到这次挪动。"});
          if (file.blockedReason) { item.createEl("p", {text: file.blockedReason}); continue; }
          if (review.interruptedRename) continue;
          const input = item.createEl("input", {type: "text", attr: {"aria-label": `${side === "local" ? "本地" : "S3"}新文件名：${file.path}`}});
          input.value = file.suggestedName;
          inputs.push(input);
          const button = item.createEl("button", {text: side === "local"
            ? file.preserveAsNew ? "另存为新文件并同步" : "给本地文件改名并同步"
            : "给 S3 记录改名并同步"});
          buttons.push(button);
          button.addEventListener("click", () => {
            if (button.disabled) return;
            for (const value of [...buttons, ...inputs]) value.disabled = true;
            message.setText("改名前正在重新检查所选文件和目标路径…");
            void this.controller.resolvePathCollision({paths: review.paths, reviewToken: review.reviewToken,
              side, path: file.path, entryId: file.entryId, newName: input.value})
              .then(newPath => {this.refresh(); this.close(); new Notice(`已改名为 ${newPath}。同步状态已刷新，请查看是否还有其他项目。`);})
              .catch((error: unknown) => {
                message.setText(error instanceof Error ? error.message : "改名失败。请重新加载这次审查。");
              });
          });
        }
      }
    }).catch((error: unknown) => {
      message.setText(error instanceof Error ? error.message : "无法审查当前路径。");
      top.createEl("button", {text: "重试撞名审查"}).addEventListener("click", () => this.onOpen());
    });
  }
}
