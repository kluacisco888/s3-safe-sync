import { App, Modal } from "obsidian";

import type { StatusModalController } from "./modals";
import type { LocalContentChoice } from "../sync/sync-service";
import { actionButton } from "./modal-actions";
import { copyText } from "./clipboard";
import { renderContentDiff } from "./content-diff";

const formatTime = (value: string | number | undefined): string => {
  if (value === undefined) return "未知";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "未知";
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
    this.contentEl.createEl("h2", {text: "对比并处理"});
    this.contentEl.createDiv({cls: "s3-vault-sync-selectable-path", text: this.path});
    const status = this.contentEl.createEl("p", {text: "正在读取并核实两个版本…"});
    const metadata = this.contentEl.createDiv();
    const decisions = this.contentEl.createDiv({cls: "s3-vault-sync-toolbar"});
    const actions = this.contentEl.createDiv({cls: "s3-vault-sync-toolbar"});
    const later = actions.createEl("button", {text: "稍后再决定"});
    later.addEventListener("click", () => this.close());
    actions.createEl("button", {text: "打开设置"}).addEventListener("click", () => {this.controller.openSettings(); this.close();});
    actionButton(actions, "打开本地文件", async () => {await this.controller.openLocalFile(this.path); this.close();});
    actionButton(actions, "复制路径", async () => {
      if (!await copyText(this.path)) throw new Error("剪贴板不可用，请选中显示的路径手动复制。");
    });
    const body = this.contentEl.createDiv();
    void this.controller.reviewLocalContent(this.path).then(review => {
      status.setText(review.blockedReason ??
        (review.localExists && review.remoteKind === "live"
          ? "请选择哪份内容留在原路径。替换之前会先保存另一个版本。这里不会合并两份内容。拿不准时，请两份都保留或稍后再决定。"
          : review.localExists
          ? "接收审查过的远端状态之前，你的本地版本会先另存成一个单独的文件。"
          : "没有需要保存的本地文件。这个路径会接收审查过的远端状态。"));
      metadata.createEl("p", {text: `本地最后修改：${formatTime(review.localModifiedAt)} · ${review.localSize} 字节`});
      for (const version of review.remoteVersions) {
        metadata.createEl("p", {text: `S3 版本记录时间：${formatTime(version.createdAt)} · ${version.size} 字节`});
      }
      metadata.createEl("p", {text: "本地修改时间可能在复制或迁移时改变。S3 时间记录的是同步版本的时间，而不是作者最后编辑的时间。时间和文件大小都不能证明哪个版本是对的。"});
      body.createEl("h3", {text: review.remoteKind === "live" ? "远端文件存在（未删除）" : `远端状态：${review.remoteKind === "deleted" ? "已删除" : "冲突中"}`});
      if (review.remoteKind === "deleted") body.createEl("p", {text:
        "远端文件已删除。你的本地副本安全保存之后，原路径会保持删除状态。"});
      if (review.remoteKind === "conflicted") body.createEl("p", {text:
        "远端的冲突候选版本仍留在冲突中心。保存本地副本不会丢弃或选定任何远端候选版本。"});
      for (const [index, version] of review.remoteVersions.entries()) {
        body.createEl("h3", {text: `差异 · S3 版本 ${index + 1} · ${formatTime(version.createdAt)}`});
        if (review.localPreview !== undefined && version.preview !== undefined) {
          renderContentDiff(body, review.localPreview, version.preview);
        } else {
          body.createEl("p", {text: review.localExists
            ? "无法逐行对比：有一个版本是二进制文件、超过文字预览限制，或被本设备的限制挡住了。"
            : "没有可与这个远端版本对比的本地文件。"});
        }
      }
      const local = body.createEl("details");
      local.createEl("summary", {text: `完整本地版本 · ${review.localSize} 字节`});
      local.createEl("pre", {cls: "s3-vault-sync-preview-content", text: review.localPreview ??
        (review.localExists ? "无法预览文字（二进制文件或超过预览大小限制）。" : "本地文件不存在。")});
      for (const version of review.remoteVersions) {
        const detail = body.createEl("details");
        detail.createEl("summary", {text: `完整远端版本 · ${version.createdAt} · ${version.size} 字节`});
        detail.createEl("pre", {cls: "s3-vault-sync-preview-content", text: version.preview ?? "无法预览文字。"});
      }
      if (review.blockedReason) return;
      const choices: Array<{choice: LocalContentChoice; label: string; description: string}> = review.localExists && review.remoteKind === "live" ? [
        {choice: "local", label: "使用本地版本", description: "保留这个文件的本地内容并发布到 S3。之前的 S3 版本会在历史版本里保留 30 天。"},
        {choice: "remote", label: "使用 S3 版本", description: "先把本地内容备份到加密的历史版本（保留 30 天），再用 S3 内容替换这个文件。不会额外生成笔记。"},
        {choice: "both", label: "两份都保留（本地副本）", description: "原路径使用 S3 内容；本地内容另存为一篇可见的笔记，也会同步。不会自动合并。"},
      ] : [{choice: "both", label: review.localExists ? "保存本地副本并接受远端" : "接受远端状态",
        description: "已有的远端冲突和删除决定不会被丢弃。"}];
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
          status.setText("正在保存内容并重新核对审查过的版本…");
          void this.controller.resolveLocalContent(this.path, review.reviewToken, choice)
            .then(copyPath => { this.refresh(); this.showCompleted(choice, copyPath); })
            .catch((error: unknown) => {
              later.disabled = false;
              status.setText(error instanceof Error ? error.message : "审查失败。请重新打开审查后重试。");
              decisions.createEl("button", {text: "重新加载审查"}).addEventListener("click", () => this.onOpen());
            });
        });
      }
    }).catch((error: unknown) => {
      status.setText(error instanceof Error ? error.message : "无法读取这两个版本。");
      actions.createEl("button", {text: "重试审查"}).addEventListener("click", () => this.onOpen());
    });
  }

  private showCompleted(choice: LocalContentChoice, copyPath: string | undefined): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", {text: "处理完成"});
    this.contentEl.createDiv({cls: "s3-vault-sync-selectable-path", text: this.path});
    this.contentEl.createEl("p", {text: copyPath ? `本地内容已另存为单独的文件：${copyPath}`
      : choice === "both" ? "已接受审查过的远端状态。"
      : `原路径现在使用${choice === "local" ? "本地" : " S3 "}内容。另一个版本可在 30 天内从加密的历史版本中恢复。`});
    if (choice !== "both") {
      actionButton(this.contentEl, "打开历史版本", async () => {this.controller.openVersionHistory(this.path);});
      this.contentEl.createEl("p", {text: "之后也可以打开这个文件，在命令面板里运行「S3 Safe Sync：打开当前文件的历史版本」。"});
    }
    this.contentEl.createEl("button", {text: "关闭"}).addEventListener("click", () => this.close());
  }
}
