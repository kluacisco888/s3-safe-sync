import { App, Modal } from "obsidian";

import type { CleanupCandidate } from "../sync/sync-service";
import { formatLocalTime } from "./local-time";
import { actionButton } from "./modal-actions";

// 「已删除，等着从 S3 清掉」里的一项：用户已确认、还在本机队列里
export interface PendingCleanupItem {
  blobId: string;
  // 确认时那次页面读到的 Head serverDate（AWS 时间）
  confirmedAt: string;
  key: string;
  kind: CleanupCandidate["kind"];
  path?: string;
  // 清理提交从记录里去掉它的 AWS 时间；有了就不能再撤销
  recordRemovedAt?: string;
  size: number;
}

export interface CleanupView {
  // 处理的前提暂时不满足时，列表上方说明原因
  blockedReason?: string;
  // 三组可清理的内容（已确认的不在里面）
  candidates: CleanupCandidate[];
  pending: PendingCleanupItem[];
  // 这次列表读到的 Head serverDate（AWS 时间）
  serverDate: string;
}

export interface CleanupController {
  // 可清理的数量：用本机保存的上一次计算结果，不读 S3
  getCleanupCount(): number | undefined;
  // 只读：重读 Head、它的快照和数据块列表
  loadCleanup(): Promise<CleanupView>;
  // 用打开时读到的列表和本机队列重新组合，不读 S3
  getCleanupView(): CleanupView | undefined;
  needsCleanupDeviceConfirmation(): boolean;
  // 不写 S3：只把选中的项目记进本机队列
  confirmCleanup(keys: string[], allDevicesUpdated: boolean): Promise<void>;
  // 不写 S3：只把它从本机队列里拿掉
  undoCleanup(key: string): Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// 恢复期：旧版本在被替换 30 天后到期，所以被替换的时间 = 到期时间 − 30 天
const RECOVERY_MS = 30 * DAY_MS;
// 一组超过这么多项时默认收起
const COLLAPSE_ABOVE = 50;

const GROUPS: Array<{kind: CleanupCandidate["kind"]; label: string; note?: string}> = [
  {kind: "recovery", label: "删掉的文件留下的备份（已过 30 天，不能恢复了）"},
  {kind: "history", label: "文件改动前的旧版本（已过 30 天）"},
  {kind: "orphan", label: "找不到对应文件的数据（同步中断时留下的）",
    note: "多数是同步中断时留下的，也包括记录已经清理过、S3 上还没删的内容。"},
];

// 大小只用于显示，按 1024 进位
const formatSize = (bytes: number): string =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
      : bytes === 0 ? "0 KB" : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const totalSize = (items: ReadonlyArray<{size: number}>): number => items.reduce((sum, item) => sum + item.size, 0);

const titleOf = (item: {kind: CleanupCandidate["kind"]; path?: string; blobId: string}): string =>
  item.kind === "orphan" ? `找不到对应文件的数据（编号 ${item.blobId.slice(0, 8)}）`
    : item.kind === "history" ? `${item.path ?? ""} 的旧版本` : item.path ?? "";

// 恢复期已过几天按这次读到的 AWS 时间算
const metaOf = (item: CleanupCandidate, serverDate: string): string => {
  if (item.kind === "orphan") return `上传于 ${formatLocalTime(item.uploadedAt)}`;
  const overdue = `恢复期已过 ${Math.max(0, Math.floor((Date.parse(serverDate) - Date.parse(item.expiresAt)) / DAY_MS))} 天`;
  if (item.kind === "recovery") return `删除于 ${formatLocalTime(item.deletedAt ?? item.expiresAt)} · ${overdue}`;
  return `${formatLocalTime(new Date(Date.parse(item.expiresAt) - RECOVERY_MS).toISOString())} 被新版本替换 · ${overdue}`;
};

const sharedNote = (item: CleanupCandidate): string | undefined => {
  if (item.kind === "orphan" || !item.sharedWith) return undefined;
  return item.sharedWith.path === undefined
    ? "内容还被别的记录用着：S3 上的数据会保留"
    : `内容和现有文件「${item.sharedWith.path}」相同：S3 上的数据会保留`;
};

// 带文字的勾选框：勾选框和文字放在同一个 label 里
const labeledCheckbox = (
  container: HTMLElement,
  text: string,
  state: {checked: boolean; indeterminate?: boolean},
  onChange: (checked: boolean) => void,
): HTMLElement => {
  const label = container.createEl("label", {cls: "s3-vault-sync-cleanup-check"});
  const box = label.createEl("input", {type: "checkbox"});
  box.checked = state.checked;
  box.indeterminate = state.indeterminate ?? false;
  box.addEventListener("change", () => onChange(box.checked));
  label.createSpan({text});
  return label;
};

// 第一次删除前的确认：没升级的设备在记录被清理后可能卡在修复模式
class CleanupDeviceConfirmModal extends Modal {
  constructor(app: App, private readonly onConfirm: () => Promise<void>) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", {text: "删除之前请确认"});
    this.contentEl.createEl("p", {text: "清理会把选中的内容从同步记录里去掉。没升级的设备在记录被清理后可能卡在修复模式，所以请先在每台设备上把本插件更新到 0.1.10 或更高。"});
    let go: HTMLButtonElement | undefined;
    labeledCheckbox(this.contentEl, "所有设备都已更新到 0.1.10 或更高", {checked: false}, checked => {
      if (go) go.disabled = !checked;
    });
    const actions = this.contentEl.createDiv({cls: "modal-button-container"});
    actions.createEl("button", {text: "取消"}).addEventListener("click", () => this.close());
    go = actionButton(actions, "继续删除", async () => {
      await this.onConfirm();
      this.close();
    });
    go.addClass("mod-warning");
    go.disabled = true;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class CleanupModal extends Modal {
  private view: CleanupView | undefined;
  private readonly selected = new Set<string>();
  private readonly expanded = new Set<CleanupCandidate["kind"]>();
  // 每次打开、关闭都加一；读取回来时对不上就丢掉结果
  private loadGeneration = 0;

  constructor(
    app: App,
    private readonly controller: CleanupController,
    // 窗口关闭时让同步状态窗口刷新「待清理（N）」
    private readonly onClosed?: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.view = undefined;
    this.selected.clear();
    this.contentEl.empty();
    this.contentEl.createEl("h2", {text: "待清理的内容"});
    this.contentEl.createEl("p", {cls: "s3-vault-sync-muted", text: "正在读取远端记录…"});
    // 读取结束时窗口已关或已重新打开：这次的结果不再写进窗口
    const load = ++this.loadGeneration;
    void this.controller.loadCleanup().then(view => {
      if (load !== this.loadGeneration) return;
      this.view = view;
      this.render();
    }).catch((error: unknown) => {
      if (load !== this.loadGeneration) return;
      this.contentEl.empty();
      this.contentEl.createEl("h2", {text: "待清理的内容"});
      this.contentEl.createEl("p", {cls: "s3-vault-sync-error", text: error instanceof Error ? error.message : "读取失败。"});
      this.contentEl.createEl("button", {text: "重试"}).addEventListener("click", () => this.onOpen());
    });
  }

  onClose(): void {
    this.loadGeneration += 1;
    this.contentEl.empty();
    this.onClosed?.();
  }

  // 确认或撤销之后：用本机队列重新组合，不读 S3
  private refresh(): void {
    this.view = this.controller.getCleanupView() ?? this.view;
    this.render();
  }

  private render(): void {
    const view = this.view;
    if (!view) return;
    const candidates = view.candidates;
    for (const key of [...this.selected]) if (!candidates.some(item => item.key === key)) this.selected.delete(key);
    this.contentEl.empty();
    this.contentEl.createEl("h2", {text: "待清理的内容"});
    this.contentEl.createEl("p", {cls: "s3-vault-sync-muted", text:
      `这些已经过了 30 天恢复期，不能再恢复。勾选要删的，点「删除所选」。共 ${candidates.length} 项 · ${formatSize(totalSize(candidates))}。你在用的文件不会出现在这里。`});
    this.contentEl.createEl("p", {cls: "s3-vault-sync-cleanup-flow", text:
      "一个文件的经过：删除后先在「已删除的文件」里留 30 天，可以恢复 → 满 30 天移到这里，等你确认 → 你点删除后 24 小时内可撤销 → 满 24 小时从 S3 清掉，之后 S3 版本控制里还能找回 30 天。"});
    if (view.blockedReason) this.contentEl.createEl("p", {cls: "s3-vault-sync-error", text: view.blockedReason});
    const body = this.contentEl.createDiv({cls: "s3-vault-sync-cleanup-body"});
    let shown = 0;
    for (const group of GROUPS) {
      const items = candidates.filter(item => item.kind === group.kind);
      if (items.length === 0) continue;
      shown += items.length;
      this.renderGroup(body, group, items, view.serverDate);
    }
    if (shown === 0) body.createEl("p", {cls: "s3-vault-sync-muted", text: "现在没有符合删除标准的内容。文件删除满 30 天后会自动出现在这里，等你确认。"});
    this.renderPending(body, view.pending);
    this.renderBar(candidates);
  }

  private renderGroup(container: HTMLElement, group: (typeof GROUPS)[number], items: CleanupCandidate[], serverDate: string): void {
    const section = container.createDiv({cls: "s3-vault-sync-cleanup-group"});
    const head = section.createDiv({cls: "s3-vault-sync-cleanup-group-head"});
    const chosen = items.filter(item => this.selected.has(item.key)).length;
    labeledCheckbox(head, group.label, {checked: chosen === items.length, indeterminate: chosen > 0 && chosen < items.length}, checked => {
      for (const item of items) {
        if (checked) this.selected.add(item.key);
        else this.selected.delete(item.key);
      }
      this.render();
    });
    head.createSpan({cls: "s3-vault-sync-muted", text: `${items.length} 项 · ${formatSize(totalSize(items))}`});
    const collapsible = items.length > COLLAPSE_ABOVE;
    if (collapsible) {
      const open = this.expanded.has(group.kind);
      head.createEl("button", {text: open ? "收起" : "展开"}).addEventListener("click", () => {
        if (open) this.expanded.delete(group.kind);
        else this.expanded.add(group.kind);
        this.render();
      });
    }
    if (group.note) section.createEl("small", {cls: "s3-vault-sync-muted", text: group.note});
    if (collapsible && !this.expanded.has(group.kind)) return;
    for (const item of items) {
      const row = section.createDiv({cls: "s3-vault-sync-cleanup-row"});
      const label = labeledCheckbox(row, titleOf(item), {checked: this.selected.has(item.key)}, checked => {
        if (checked) this.selected.add(item.key);
        else this.selected.delete(item.key);
        this.render();
      });
      label.createDiv({cls: "s3-vault-sync-muted", text: metaOf(item, serverDate)});
      const note = sharedNote(item);
      if (note) label.createDiv({cls: "s3-vault-sync-cleanup-shared", text: note});
      row.createSpan({cls: "s3-vault-sync-muted", text: formatSize(item.size)});
    }
  }

  private renderPending(container: HTMLElement, pending: PendingCleanupItem[]): void {
    if (pending.length === 0) return;
    const section = container.createDiv({cls: "s3-vault-sync-cleanup-group"});
    section.createEl("h3", {text: "已删除，等着从 S3 清掉"});
    for (const item of pending) {
      const row = section.createDiv({cls: "s3-vault-sync-cleanup-row"});
      row.createSpan({cls: "s3-vault-sync-selectable-path", text: titleOf(item)});
      // 剩余小时数只用于显示，按设备时间估算；真正满没满 24 小时由同步之后的处理按 AWS 时间判断
      const left = Date.parse(item.confirmedAt) + DAY_MS - Date.now();
      if (item.recordRemovedAt !== undefined || left <= 0) {
        row.createSpan({cls: "s3-vault-sync-muted", text: "撤销期已过，正在从 S3 清掉"});
        continue;
      }
      row.createSpan({cls: "s3-vault-sync-muted", text: `还剩 ${Math.ceil(left / HOUR_MS)} 小时可撤销`});
      actionButton(row, "撤销", async () => {
        await this.controller.undoCleanup(item.key);
        this.refresh();
      });
    }
  }

  private renderBar(candidates: CleanupCandidate[]): void {
    const bar = this.contentEl.createDiv({cls: "s3-vault-sync-cleanup-bar"});
    const chosen = candidates.filter(item => this.selected.has(item.key));
    labeledCheckbox(bar, "全选", {
      checked: candidates.length > 0 && chosen.length === candidates.length,
      indeterminate: chosen.length > 0 && chosen.length < candidates.length,
    }, checked => {
      for (const item of candidates) {
        if (checked) this.selected.add(item.key);
        else this.selected.delete(item.key);
      }
      this.render();
    });
    bar.createSpan({cls: "s3-vault-sync-muted", text: `已选 ${chosen.length} 项 · ${formatSize(totalSize(chosen))}`});
    const keys = chosen.map(item => item.key);
    const remove = actionButton(bar, `删除所选（${chosen.length}）`, async () => {
      const confirm = async (allDevicesUpdated: boolean): Promise<void> => {
        await this.controller.confirmCleanup(keys, allDevicesUpdated);
        this.selected.clear();
        this.refresh();
      };
      // 第一次删除（按目标记一次）先确认所有设备都已更新
      if (this.controller.needsCleanupDeviceConfirmation()) {
        new CleanupDeviceConfirmModal(this.app, () => confirm(true)).open();
        return;
      }
      await confirm(false);
    });
    remove.addClass("mod-warning");
    remove.disabled = chosen.length === 0;
  }
}
