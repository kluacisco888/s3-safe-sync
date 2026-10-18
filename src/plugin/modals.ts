import { App, Modal, Notice, Setting } from "obsidian";

import type {
  BulkDeletionPlan,
  ConflictedEntry,
  DeletedEntry,
  LiveEntry,
  RevisionRef,
} from "../sync/sync-engine";
import { fileType } from "../sync/sync-engine";
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
  if (status.includes("修复模式")) return "请在所有设备上暂停同步并保留本地副本。在设置里检查存储桶、前缀和权限。如果远端 Head 指针缺失或损坏，请检查 S3 版本控制，把经过核实的 Head 指针连同它引用的对象一起恢复，然后重试。不要在现有前缀上重新初始化。";
  if (status.startsWith("未配置")) return "打开设置，填好 AWS 区域、存储桶和前缀，保存两项 AWS 凭证，然后用共用的仓库密码解锁。解锁成功后密码框变空是正常的，仓库密钥已保存在本设备上。";
  if (status.startsWith("已暂停")) return "点「继续」即可恢复自动同步。暂停期间本地的编辑会留在本设备上。";
  // 关键词同时匹配中文提示和 AWS 返回的英文原文
  if (/expired|已过期/i.test(status)) return "这个版本已超出插件的恢复期限。请查看你自己的独立备份或 S3 保留的版本。重试无法延长已过期的恢复期限。";
  if (/password|envelope|密码|密钥信封/i.test(status)) return "打开设置，使用和最初那台设备相同的仓库密码。它和 AWS 的 Secret Access Key 不是一回事。请核对区域、存储桶和前缀确实属于要同步的仓库。如果密钥信封损坏，请从经过核实的 S3 版本恢复，不要在已有数据上重新初始化。";
  if (/Remotely Save|prefix.*not empty|bound.*different|前缀|另一个远端存储|另一个仓库/i.test(status)) return "打开设置，检查所选的存储桶和前缀。迁移时，先在所有设备上完成旧的同步，核对源文件，再停用 Remotely Save。新的同步前缀必须是空的，并且和旧前缀不同。修正设置期间请保留旧前缀。";
  if (/403|AccessDenied|Signature|credentials|credential|凭证/i.test(status)) return "打开设置，核对 AWS 区域、存储桶、前缀和已保存的凭证。确认这把 AWS 密钥能列出该前缀并读写其中的对象。改正配置后重试。分享报错时不要贴出你的 AK 或 SK。";
  if (/timeout|network|connection|HTTP.*5\d\d|status 5\d\d|超时|网络|连接/i.test(status)) return "请检查网络以及代理或 VPN，然后重试。中断的同步会重新检查远端状态。排查连接期间请保留本地文件和配置。";
  if (status.includes("另一台设备先发布了")) return "另一台设备先完成了同步，已经安排好自动重试。你可以点「立即同步」提前重试，或点「暂停」停止重试。";
  if (status.includes("本地文件被改动")) return "同步过程中文件被改动了。编辑后稍等片刻，同步会自动重试。这是为了保护你最新保存的文字。";
  return "请查看下方受影响的项目。配置问题用「打开设置」，要分享报错文字用「复制状态」，排除原因后点「立即同步」。文件冲突需要你明确选择；远端修复和操作系统的文件名限制可能需要在插件之外处理。";
};


const localIssueHelp = (issue: LocalSyncIssue): string => {
  switch (issue.kind) {
    case "bootstrap-mismatch": return "本设备对这个路径没有双方都认可的共同版本，首次连接、重装插件或丢失本地同步记录后都可能出现。「对比并处理」会显示差异，让你选择用本地内容、用 S3 内容，或在两个文件都存在时两份都保留。没选中的版本会保存在 30 天的历史版本里，或保存成一个单独同步的文件。清除缓存无法判断你想要哪个版本。";
    case "resolution-mismatch": return "记录冲突之后这个文件又被改过。「对比并处理」会显示差异，并能在接收远端状态前把这些新的编辑另存成一个单独的文件。其余冲突候选版本仍留在冲突中心。";
    case "deferred-local-edit": return "较新的远端版本暂缓下载期间，本地文件被编辑了。「对比并处理」会显示差异，在不超过本设备限制时可以两份都保留。否则请在桌面端处理；对于低于移动端大小限制的附件，切换到 Wi-Fi 可能会有帮助。";
    case "path-collision": return "这些路径因大小写、Unicode 写法或文件归属而撞名。只显示一个路径时，可能是改名目标已被占用，或对应多条 S3 记录，并不是文件名非法。用「审查路径撞名」查看相关路径，并安全地给选中的本地文件或 S3 记录改名，两个版本都不会丢。";
    case "unsupported-path": return "本设备无法创建这个文件名。请复制路径，在兼容的桌面设备上给文件改名，然后两台设备都同步一次。原文件仍保留在远端；改缓存解决不了文件系统的文件名限制。";
    case "unsynced-local": return "这个本地文件超过本设备的自动同步限制，尚未上传。可以打开它查看。如果是低于移动端限制的附件，请连接 Wi-Fi；否则把它复制到桌面设备上同步。在移动端同步前，请拆分或缩小大文件。";
    case "import-candidate": return "这个本地文件在远端没有对应记录。「作为新文件上传」会先确认路径仍可用，再把它传到 S3。如果它是从别的文件夹挪过来的，请先确认远端的旧路径是不是同一篇笔记；导入不会把它和旧记录重新关联。";
    case "possible-rename": return "「审查并处理」让你为每个消失的文件选择它挪到了哪个新文件，或按删除处理；没被选中的新文件会作为新文件上传。发布前每个决定都会再核对一遍。";
  }
};

// 冲突原因的内部取值保持不变，界面只显示这里的中文说明
const conflictReasonLabels: Record<ConflictedEntry["reason"], string> = {
  "delete-edit": "本地已删除，远端有修改",
  "edit-delete": "本地有修改，远端已删除",
  "edit-edit": "本地和远端都有修改",
};

// 下面几项只用于显示，按设备时间判断；恢复操作仍按 AWS 时间判断 30 天期限。
// 与恢复规则一致：没有到期时间的版本不算过期。
const isUnexpired = (revision: RevisionRef, now: number): boolean =>
  revision.expiresAt === undefined || Date.parse(revision.expiresAt) > now;

/** 已删除文件里仍未过期的可恢复内容（恢复副本和历史版本） */
const unexpiredRecoveries = (entry: DeletedEntry, now: number): RevisionRef[] =>
  [...(entry.recovery ? [entry.recovery] : []), ...(entry.history ?? [])]
    .filter(revision => isUnexpired(revision, now));

const renderIssueGuidance = (container: HTMLElement, issue: LocalSyncIssue): void => {
  const detail = container.createEl("details");
  detail.createEl("summary", {text: "为什么需要处理"});
  detail.createEl("p", {text: localIssueHelp(issue)});
};

const showGuidance = (app: App, title: string, text: string): void => {
  const modal = new Modal(app);
  modal.contentEl.createEl("h2", {text: title});
  modal.contentEl.createEl("p", {text});
  modal.contentEl.createEl("button", {text: "关闭"}).addEventListener("click", () => modal.close());
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
    this.contentEl.createEl("h2", { text: "审查消失的文件和新文件" });
    this.contentEl.createEl("p", { text:
      "为每个消失的文件选择它挪到了哪个新文件，或按删除处理。" +
      "挪动的文件保留原有历史；没被选中的新文件会作为新文件上传。",
    });
    const oldFolder = commonFolder(this.issue.oldPaths);
    const newFolder = commonFolder(this.issue.newPaths);
    this.contentEl.createDiv({ cls: "s3-vault-sync-selectable-path", text:
      `${oldFolder || "仓库根目录"} → ${newFolder || "仓库根目录"}`,
    });
    // 每个消失路径对应的选择；空字符串表示「按删除处理」
    const pairs = new Map<string, string>();
    const details = this.contentEl.createEl("details");
    details.open = this.issue.oldPaths.length <= 5;
    details.createEl("summary", { text: `审查 ${this.issue.oldPaths.length} 条路径对应` });
    let updateButton = (): void => {};
    const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1).normalize("NFC");
    for (const fromPath of this.issue.oldPaths) {
      // 只列同类型的被扣住新文件；默认：唯一同名候选 → 唯一候选 → 按删除处理
      const candidates = this.issue.newPaths.filter(toPath => fileType(toPath) === fileType(fromPath));
      const sameName = candidates.filter(toPath => baseName(toPath) === baseName(fromPath));
      const initial = sameName.length === 1 ? sameName[0]! : candidates.length === 1 ? candidates[0]! : "";
      pairs.set(fromPath, initial);
      new Setting(details)
        .setName(fromPath.slice(oldFolder.length))
        .setDesc(fromPath)
        .addDropdown(dropdown => {
          dropdown.addOption("", "按删除处理");
          for (const toPath of candidates) dropdown.addOption(toPath, toPath.slice(newFolder.length));
          dropdown.setValue(initial).onChange(value => { pairs.set(fromPath, value); updateButton(); });
        });
    }
    const message = this.contentEl.createEl("p");
    const duplicateNotice = this.contentEl.createEl("p");
    const actions = this.contentEl.createDiv({ cls: "s3-vault-sync-toolbar" });
    const confirmMoves = actions.createEl("button", { text: "确认挪动", cls: "mod-cta" });
    updateButton = () => {
      const chosen = [...pairs.values()].filter(Boolean);
      const duplicated = new Set(chosen).size !== chosen.length;
      confirmMoves.disabled = duplicated;
      duplicateNotice.setText(duplicated ? "两个消失的文件不能挪到同一个新文件。" : "");
    };
    updateButton();
    this.contentEl.createEl("p", { text:
      "如果消失的文件是你有意删除的，而新文件与它们无关，请选「分别按删除和新增处理」。" +
      "这会为消失的文件发布删除记录，并上传新文件。" +
      "删除的内容仍在恢复期限内可找回；大量删除仍需要再确认一次。",
    });
    const separate = this.contentEl.createEl("button", {
      cls: "mod-warning", text: "确认分别按删除和新增处理",
    });
    const run = async (resolution: PossibleRenameResolution): Promise<void> => {
      confirmMoves.disabled = true;
      separate.disabled = true;
      message.setText("正在重新检查文件和远端状态…");
      try {
        await this.resolve(resolution);
        this.close();
      } catch (error) {
        message.setText(error instanceof Error ? error.message : "无法处理这次挪动。");
        updateButton();
        separate.disabled = false;
        actionButton(actions, "刷新方案", async () => { await this.refresh(); this.close(); });
      }
    };
    confirmMoves.addEventListener("click", () => { void run({
      kind: "moves", reviewToken: this.issue.reviewToken,
      pairs: [...pairs].filter(([, toPath]) => toPath).map(([fromPath, toPath]) => ({ fromPath, toPath })),
    }); });
    separate.addEventListener("click", () => { void run({ kind: "separate", reviewToken: this.issue.reviewToken }); });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
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
    this.contentEl.createEl("h2", { text: "移动端大文件传输" });
    this.contentEl.createEl("p", { text: this.message });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => {
      this.close();
    });
    actionButton(actions, "仍然尝试", async () => {
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
    private readonly title = "已删除文件预览",
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.title });
    const actions = this.contentEl.createDiv({cls: "s3-vault-sync-toolbar"});
    actions.createEl("button", {text: "返回"}).addEventListener("click", () => this.close());
    actionButton(actions, "复制路径", async () => {
      if (!await copyText(this.entry.path)) throw new Error("剪贴板不可用，请选中下方路径手动复制。");
    });
    this.contentEl.createDiv({
      cls: "s3-vault-sync-selectable-path",
      text: this.entry.path,
    });
    this.contentEl.createEl("p", {
      cls: "s3-vault-sync-muted",
      text: `${this.revision.size} 字节${
        this.revision.expiresAt
          ? ` · 可恢复至 ${this.revision.expiresAt}`
          : ""
      }`,
    });
    const preview = this.contentEl.createDiv({
      cls: "s3-vault-sync-preview-content",
    });
    if (this.revision.size > MAX_DELETED_PREVIEW_BYTES) {
      preview.setText("文件太大，无法预览，但仍可以恢复。");
      return;
    }
    preview.setText("正在读取加密的恢复内容…");
    void this.loadContent()
      .then((body) => {
        preview.empty();
        const text = decodeDeletedPreview(body);
        if (text === undefined) {
          preview.setText("这是二进制文件，无法以文字显示。");
          return;
        }
        preview.createEl("pre", { text });
      })
      .catch((error: unknown) => {
        preview.empty();
        preview.createDiv({
          cls: "s3-vault-sync-error",
          text: error instanceof Error ? error.message : "预览失败。",
        });
        preview.createEl("button", {text: "重试预览"}).addEventListener("click", () => this.onOpen());
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
    // 窗口关闭时通知插件，用于判断同步状态窗口是否已开着
    private readonly onClosed?: () => void,
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
      this.pauseButton?.setText(this.controller.isPaused() ? "继续" : "暂停");
      // 状态文字以中文状态名开头：空闲 / 需要处理 / 出错 / 未配置 / 已暂停
      if (/^(空闲|需要处理|出错|未配置|已暂停)：/.test(display.text)) render();
      else this.renderDiagnostics(diagnostics);
    });
  }

  onClose(): void {
    this.stopStatusUpdates?.();
    this.stopStatusUpdates = undefined;
    this.pauseButton = undefined;
    this.contentEl.empty();
    this.onClosed?.();
  }

  private renderActions(container: HTMLElement): void {
    const actions = container.createDiv({ cls: "modal-button-container" });
    actions.addClass("s3-vault-sync-toolbar");
    actionButton(actions, "立即同步", async () => { await this.controller.syncNow(); this.onOpen(); })
      .disabled = this.controller.isPaused();
    this.pauseButton = actionButton(actions, this.controller.isPaused() ? "继续" : "暂停",
      async () => { await this.controller.togglePause(); this.onOpen(); });
    actions.createEl("button", {text: "打开设置"}).addEventListener("click", () => {this.controller.openSettings(); this.close();});
    actions.createEl("button", {text: "故障排查"}).addEventListener("click", () =>
      showGuidance(this.app, "同步故障排查", statusHelp(this.controller.getStatusText())));
    actionButton(actions, "复制状态", async () => {
      if (!await copyText(this.controller.getStatusText())) throw new Error("剪贴板不可用，请选中显示的状态手动复制。");
    });
    if (this.controller.exportDiagnostics) actionButton(actions, "复制诊断数据", async () => {
      const text = this.controller.exportDiagnostics!();
      if (await copyText(text)) return;
      const dialog = new Modal(this.app);
      dialog.contentEl.createEl("h2", {text: "复制诊断数据"});
      dialog.contentEl.createEl("p", {text: "剪贴板不可用。请选中并复制下方数据。其中不含笔记内容、路径或凭证。"});
      const output = dialog.contentEl.createEl("textarea", {cls: "s3-vault-sync-diagnostic-export"});
      output.value = text;
      output.readOnly = true;
      dialog.open();
    });
    if (this.controller.getStatusText().includes("修复模式")) {
      actions.createEl("button", {text: "恢复指引"}).addEventListener("click", () => {
        showGuidance(this.app, "需要修复远端",
          statusHelp(this.controller.getStatusText()));
      });
    }
    if (this.controller.getPendingBulkDeletion()) {
      actionButton(actions, "确认批量删除", async () => { await this.controller.confirmBulkDeletion(); this.onOpen(); })
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
    const publication = [...view.records].reverse().find(record => record.publishedCommit);
    const date = (time?: number): string => time === undefined ? "未记录" : new Date(time).toLocaleString();
    container.createEl("h3", {text: "同步诊断"});
    container.createEl("p", {text: `上次记录的成功同步：${date(view.lastSuccessAt)}`});
    container.createEl("p", {text: `本地已接受的提交：${view.acceptedCommit ?? "尚未接受"}`});
    container.createEl("p", {text: `本设备上次确认发布的提交：${publication?.publishedCommit ?? "无记录"}`});
    container.createEl("p", {text: `上次检查的 S3 Head 指针：${observed?.observedRemote ?? "尚未检查"} · ${date(observed?.remoteCheckedAt)}`});
    container.createEl("p", {text: `排队中的检查：${view.queued ? "有" : "无"} · 待检查的本地路径：${view.pendingLocalChanges}`});
    container.createEl("p", {text: `最近的同步计划 — 待上传：${last?.pendingUploads ?? "尚未计划"} · 待下载：${last?.pendingDownloads ?? "尚未计划"}`});
    if (result) container.createEl("p", {text: `最近的结果 — 已发布更改：${result.uploaded} · 已下载：${result.downloaded} · 暂缓下载：${result.deferred} · 未同步的本地文件：${result.unsynced}`});
    if (last) container.createEl("p", {text: `阶段：${last.phase} · HTTP 请求：${last.requests} · 发送/接收字节：${last.sentBytes}/${last.receivedBytes}`});
    container.createEl("p", {text: `下次计划重试：${view.nextRetryAt === undefined ? "无" : date(view.nextRetryAt)}`});
    if (last?.errorCategory) container.createEl("p", {text: `上次运行的错误：${last.errorCategory}${last.httpStatus ? `（HTTP ${last.httpStatus}）` : ""}${last.writeResultUncertain ? "。远端写入可能已经完成，重试时会重新检查 Head 指针。" : ""}`});
    if (view.persistenceWarning) container.createEl("p", {text: view.persistenceWarning, cls: "s3-vault-sync-error"});
    container.createEl("small", {text: "这些记录只描述本设备。发布到 S3 并不代表其他设备已收到文件。即使提交 ID 一致，也可能还有暂缓下载的文件。"});
  }

  private renderDiagnosticHistory(container: HTMLElement): void {
    container.empty();
    const view = this.controller.getDiagnostics?.(20);
    if (!view?.records.length) return;
    const details = container.createEl("details");
    details.createEl("summary", {text: "最近的同步记录（最多 20 条）"});
    for (const record of [...view.records].reverse()) {
      const elapsed = record.finishedAt === undefined ? "未完成" : `${Math.max(0, record.finishedAt - record.startedAt)} 毫秒`;
      details.createEl("p", {text: `${new Date(record.startedAt).toLocaleString()} · ${record.triggers.join(", ")} · ${record.outcome} · ${record.phase} · ${elapsed} · ${record.requests} 次请求${record.errorCategory ? ` · ${record.errorCategory}` : ""}`});
    }
  }

  private renderBulkDeletion(container: HTMLElement): void {
    const bulk = this.controller.getPendingBulkDeletion();
    if (bulk) {
      container.createEl("p", {
        cls: "s3-vault-sync-error",
        text: `要删除 ${bulk.totalLiveEntries} 个文件中的 ${bulk.count} 个吗？`,
      });
    }
  }

  private renderConflicts(container: HTMLElement): void {
    const conflicts = this.controller.getConflicts();
    if (conflicts.length === 0) {
      return;
    }
    container.createEl("h3", { text: "冲突中心" });
    for (const conflict of conflicts) {
      const item = container.createDiv({ cls: "s3-vault-sync-conflict" });
      item.createEl("strong", { text: conflict.path });
      item.createEl("div", {
        cls: "s3-vault-sync-muted",
        text: conflictReasonLabels[conflict.reason],
      });
      for (const candidate of conflict.candidates) {
        const row = item.createDiv({cls: "s3-vault-sync-toolbar"});
        row.createSpan({text: `${candidate.createdAt} · ${candidate.size} 字节`});
        row.createEl("button", {text: "预览版本"}).addEventListener("click", () => {
          new DeletedFilePreviewModal(this.app, conflict, candidate,
            () => this.controller.readConflictCandidate(conflict.entryId, candidate.revisionId), "冲突版本预览").open();
        });
        actionButton(row, "使用这个版本", async () => {
          await this.controller.resolveConflict(conflict.entryId, candidate.revisionId); this.onOpen();
        });
      }
      if (
        conflict.reason === "delete-edit" ||
        conflict.reason === "edit-delete"
      ) {
        actionButton(item, "保持删除", async () => {await this.controller.keepConflictDeleted(conflict.entryId); this.onOpen();});
      }
    }
  }

  private renderDeferredDownloads(container: HTMLElement): void {
    const deferred = this.controller.getDeferredDownloads();
    if (deferred.length === 0) {
      return;
    }
    container.createEl("h3", {
      text: `本设备上有 ${deferred.length} 个文件暂不可用`,
    });
    for (const entry of deferred) {
      const item = container.createDiv({ cls: "s3-vault-sync-history" });
      item.createSpan({
        text:
          entry.reason === "unsupported-path"
            ? `${entry.path} · 请在其他设备上改名`
            : `${entry.path} · ${Math.ceil(entry.size / 1024 / 1024)} MB`,
      });
      if (entry.reason === "unsupported-path") {
        renderIssueGuidance(item, {kind: "unsupported-path", path: entry.path});
        continue;
      }
      item.createEl("button", { text: "仍然尝试" }).addEventListener(
        "click",
        () => {
          new RiskConfirmationModal(
            this.app,
            "这次传输超过了经过测试的移动端限制，可能导致 Obsidian 闪退。",
            () => this.controller.downloadDeferred(entry.entryId),
          ).open();
        },
      );
    }
  }

  private renderDeletedRecoveries(container: HTMLElement): void {
    const now = Date.now();
    const deleted = this.controller.getDeletedRecoveries()
      .filter(entry => unexpiredRecoveries(entry, now).length > 0);
    if (deleted.length === 0) {
      return;
    }
    container.createEl("h3", { text: "已删除的文件（30 天内可恢复）" });
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
          ? "点击预览"
          : "恢复副本不可用，请打开历史版本",
      });
      if (recovery) {
        previewTarget.setAttr("role", "button");
        previewTarget.setAttr("tabindex", "0");
        previewTarget.setAttr("aria-label", `预览已删除的文件 ${entry.path}`);
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
      actions.createEl("button", { text: "复制路径" }).addEventListener(
        "click",
        () => {
          void copyText(entry.path).then((copied) => {
            new Notice(
              copied
                ? "已复制已删除文件的路径"
                : "剪贴板不可用，请选中路径手动复制",
            );
          });
        },
      );
      if (recovery) {
        actionButton(actions, "恢复", async () => {await this.controller.restoreDeleted(entry.entryId); this.onOpen();});
      }
      if ((entry.history?.length ?? 0) > 0) {
        actions
          .createEl("button", { text: "历史版本" })
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
      actionButton(actions, paths.length > 1 ? `打开 ${path}` : "打开本地文件", async () => {
        await this.controller.openLocalFile(path);
        this.close();
      });
      actions.createEl("button", {text: "复制路径"}).addEventListener("click", () => {
        void copyText(path).then(copied => new Notice(copied ? "已复制路径" : "请选中路径文字手动复制。"));
      });
    }
    renderIssueGuidance(item, issue);
  }

  private renderLocalIssues(container: HTMLElement): void {
    const issues = this.controller.getLocalIssues();
    if (issues.length === 0) {
      return;
    }
    container.createEl("h3", { text: "本设备有需要处理的项目" });
    for (const issue of issues) {
      const item = container.createDiv({ cls: "s3-vault-sync-conflict" });
      if (issue.kind === "path-collision") {
        item.createEl("strong", { text: "路径撞名" });
        item.createEl("div", { text: issue.paths.join(" · "), cls: "s3-vault-sync-selectable-path" });
        item.createEl("button", {text: "审查路径撞名", cls: "mod-cta"}).addEventListener("click", () => {
          new PathCollisionModal(this.app, issue.paths, this.controller, () => this.onOpen()).open();
        });
        this.renderIssueTools(item, issue);
        continue;
      }
      if (issue.kind === "possible-rename") {
        item.createEl("strong", { text: "疑似离线挪动" });
        item.createEl("p", {
          text: `${issue.oldPaths.length} 个路径消失 · ${issue.newPaths.length} 个新路径。同步正在等你审查。`,
        });
        item.createDiv({ cls: "s3-vault-sync-selectable-path", text:
          `${commonFolder(issue.oldPaths) || "仓库根目录"} → ${commonFolder(issue.newPaths) || "仓库根目录"}`,
        });
        const details = item.createEl("details");
        details.createEl("summary", { text: "显示全部路径" });
        for (const [label, paths] of [["消失的", issue.oldPaths], ["新出现的", issue.newPaths]] as const) {
          details.createEl("strong", { text: label });
          const list = details.createEl("ul", { cls: "s3-vault-sync-selectable-path" });
          for (const path of paths) list.createEl("li", { text: path });
        }
        item.createEl("button", { text: "审查并处理", cls: "mod-cta" }).addEventListener("click", () => {
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
              ? "S3 上没有这个本地路径的记录。只有确认它不是从别的路径挪过来的已有笔记时，才把它作为新文件上传。"
            : issue.kind === "deferred-local-edit"
              ? "这处本地编辑要等暂缓下载的远端版本到达后，才能安全合并。"
            : issue.kind === "bootstrap-mismatch"
              ? "本地和远端内容不同，而本设备对这个文件没有双方都认可的共同版本。请先对比两个版本，再决定怎么继续。"
              : issue.kind === "resolution-mismatch"
                ? "这个文件在冲突等待处理期间又被改过。"
                : issue.kind === "unsupported-path"
                  ? "请先在其他设备上给这个文件改名，才能同步到这里。"
                  : "本地文件超过了移动端的自动同步限制。",
      });
      if (issue.kind === "import-candidate") {
        actionButton(item, "作为新文件上传", async () => {await this.controller.importCandidate(issue.path); this.onOpen();});
      }
      if (issue.kind === "bootstrap-mismatch" || issue.kind === "resolution-mismatch" || issue.kind === "deferred-local-edit") {
        item.createEl("button", {text: "对比并处理", cls: "mod-cta"}).addEventListener("click", () => {
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
      text: `已删除文件的历史版本：${this.entry.path}`,
    });
    for (const revision of this.entry.history ?? []) {
      const row = this.contentEl.createDiv({ cls: "s3-vault-sync-history" });
      row.createSpan({ text: `${revision.createdAt} · ${revision.size} 字节` });
      row.createEl("button", { text: "预览" }).addEventListener("click", () => {
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
      actionButton(row, "恢复", async () => {await this.controller.restoreDeleted(this.entry.entryId, revision.revisionId); this.close();});
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
    this.contentEl.createEl("h2", { text: `历史版本：${this.entry.path}` });
    const history = this.entry.history ?? [];
    if (history.length === 0) {
      this.contentEl.createEl("p", { text: "没有可恢复的版本。" });
      return;
    }
    this.contentEl.createEl("p", {text: "被替换或手动选择后保留下来的版本可在 30 天内恢复。恢复前请先预览；恢复时也会保留当前版本。"});
    for (const revision of history) {
      const row = this.contentEl.createDiv({ cls: "s3-vault-sync-history" });
      row.createSpan({ text: `版本记录时间：${revision.createdAt} · ${revision.size} 字节${revision.expiresAt ? ` · 可恢复至 ${revision.expiresAt}` : ""}` });
      row.createEl("button", {text: "预览"}).addEventListener("click", () => {
        new DeletedFilePreviewModal(this.app, this.entry, revision,
          () => this.controller.readHistoricalRevision(this.entry.entryId, revision.revisionId), "历史版本预览").open();
      });
      actionButton(row, "恢复", async () => {await this.controller.restoreRevision(this.entry.entryId, revision.revisionId); this.close();});
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
