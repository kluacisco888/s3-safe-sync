import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { DeletedEntry } from "../src/sync/sync-engine";

const { Element, opened, dropdowns } = vi.hoisted(() => {
  class Element {
    children: Element[] = [];
    text = "";
    open = false;
    disabled = false;
    value = "";
    type = "";
    checked = false;
    indeterminate = false;
    classes = new Set<string>();
    events = new Map<string, () => void>();
    constructor(readonly tag: string) {}
    empty() { this.children = []; }
    addClass(value: string) { this.classes.add(value); }
    toggleClass(value: string, on: boolean) { if (on) this.classes.add(value); else this.classes.delete(value); }
    attrs = new Map<string, string>();
    setAttr(name: string, value: string | number | boolean) { this.attrs.set(name, String(value)); }
    addEventListener(name: string, handler: () => void) { this.events.set(name, handler); }
    setText(text: string) { this.text = text; }
    createEl(tag: string, options: { text?: string; cls?: string; type?: string } = {}) {
      const element = new Element(tag);
      element.text = options.text ?? "";
      element.type = options.type ?? "";
      for (const value of options.cls?.split(" ") ?? []) if (value) element.classes.add(value);
      this.children.push(element);
      return element;
    }
    createDiv(options: {text?: string; cls?: string} = {}) { return this.createEl("div", options); }
    createSpan(options: {text?: string; cls?: string} = {}) { return this.createEl("span", options); }
  }
  return { Element, opened: [] as Array<{contentEl: Element}>,
    dropdowns: [] as Array<{options: Array<[string, string]>; value: string; change?: (value: string) => void}> };
});

vi.mock("obsidian", () => ({
  App: class {}, Notice: class {},
  Modal: class {
    contentEl = new Element("root");
    closed = false;
    constructor(public app: unknown) {}
    onOpen() {}
    open() { opened.push(this); this.onOpen(); }
    close() { this.closed = true; }
  },
  Setting: class {
    setName() { return this; }
    setDesc() { return this; }
    addDropdown(callback: (dropdown: unknown) => void) {
      const record: (typeof dropdowns)[number] = {options: [], value: ""};
      dropdowns.push(record);
      callback({
        addOption(value: string, label: string) { record.options.push([value, label]); return this; },
        setValue(value: string) { record.value = value; return this; },
        onChange(change: (value: string) => void) { record.change = change; return this; },
      });
      return this;
    }
  },
}));

import { StatusModal, VersionHistoryModal, type StatusModalController } from "../src/plugin/modals";
import type { CleanupController, CleanupView } from "../src/plugin/cleanup-modal";
import type { CleanupCandidate, LocalSyncIssue } from "../src/sync/sync-service";
import type { SyncActivityRecord } from "../src/plugin/sync-activity";
import type { SyncRunRecord } from "../src/plugin/sync-diagnostics";

const reviewActions = {
  reviewPathCollision: async (paths: string[]) => ({paths, reviewToken: "collision-review", localFiles: [], remoteFiles: [], relatedPaths: [], pendingMoves: []}),
  resolvePathCollision: async () => "renamed.md",
  confirmInterruptedCollisionRename: async () => {},
  openSettings: () => {},
  openVersionHistory: () => {},
  readConflictCandidate: async () => new Uint8Array(),
  openLocalFile: async () => {},
  reviewLocalContent: async (path: string) => ({path, reviewToken: "review", localExists: true,
    localSize: 5, localModifiedAt: Date.parse("2026-09-17T10:00:00Z"), localPreview: "local", remoteKind: "live" as const,
    remoteVersions: [{size: 6, createdAt: "2026-09-18", preview: "remote"}]}),
  resolveLocalContent: async () => "article (local copy).md",
};

describe("StatusModal", () => {
  // 时间按本机时区显示，测试固定用上海时区（UTC+8）
  const originalTimeZone = process.env.TZ;
  beforeAll(() => {process.env.TZ = "Asia/Shanghai";});
  afterAll(() => {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
  });

  it.each([true, false])("exports the diagnostic payload when clipboard availability is %s", async available => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", available ? {clipboard: {writeText}} : {});
    try {
      const payload = '{"version":1,"records":[]}';
      const controller = {...issueController([]), exportDiagnostics: () => payload};
      const modal = new StatusModal({} as App, controller);
      modal.onOpen();
      type FakeElement = InstanceType<typeof Element>;
      const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
      all(modal.contentEl as unknown as FakeElement).find(node => node.text === "复制诊断数据")!.events.get("click")!();
      if (available) await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(payload));
      else await vi.waitFor(() => expect(all(opened.at(-1)!.contentEl).some(node => node.tag === "textarea" && node.value === payload)).toBe(true));
    } finally {vi.unstubAllGlobals();}
  });

  it("shows accepted versus observed versions, pending counts and a diagnostics export action", () => {
    const controller = {...issueController([]), exportDiagnostics: () => '{"version":1}', getDiagnostics: () => ({
      acceptedCommit: "accepted-version", lastSuccessAt: 1_700_000_000_000, nextRetryAt: 1_700_000_003_000,
      queued: false, pendingLocalChanges: 2,
      records: [{id: "run", vaultId: "vault", startedAt: 1_700_000_001_000, finishedAt: 1_700_000_002_000,
        outcome: "retrying" as const, triggers: ["manual" as const], phase: "downloading" as const,
        phaseDurations: {downloading: 1000}, observedRemote: "remote-version", publishedCommit: "published-version", remoteCheckedAt: 1_700_000_001_000,
        requests: 3, sentBytes: 0, receivedBytes: 42, pendingDownloads: 4, pendingUploads: 1,
        errorCategory: "service" as const, httpStatus: 503}],
    })};
    const modal = new StatusModal({} as App, controller);
    modal.onOpen();
    type FakeElement = InstanceType<typeof Element>;
    const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
    const texts = all(modal.contentEl as unknown as FakeElement).map(node => node.text);
    expect(texts).toContain("本地已接受的提交：accepted-version");
    expect(texts).toContain("本设备上次确认发布的提交：published-version");
    expect(texts.some(text => text.includes("上次检查的 S3 Head 指针：remote-version"))).toBe(true);
    expect(texts.some(text => text.includes("待上传：1") && text.includes("待下载：4"))).toBe(true);
    expect(texts.some(text => text.includes("S3 服务出错") && text.includes("503"))).toBe(true);
    expect(texts).toContain("复制诊断数据");
  });

  it("shows the diagnostics phase and error in Chinese and every time in the device's 24-hour format", () => {
    const controller = {...issueController([]), getDiagnostics: () => ({
      lastSuccessAt: 1_700_000_000_000, nextRetryAt: 1_700_000_003_000, queued: false, pendingLocalChanges: 0,
      records: [{id: "run", vaultId: "vault", startedAt: 1_700_000_001_000, finishedAt: 1_700_000_002_000,
        outcome: "error" as const, triggers: ["periodic" as const], phase: "saving" as const, phaseDurations: {},
        observedRemote: "remote-version", remoteCheckedAt: 1_700_000_001_000, requests: 3, sentBytes: 0, receivedBytes: 42,
        errorCategory: "service" as const, httpStatus: 503}],
    })};
    const modal = new StatusModal({} as App, controller);
    modal.onOpen();
    type FakeElement = InstanceType<typeof Element>;
    const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
    const texts = all(modal.contentEl as unknown as FakeElement).map(node => node.text);
    // 1_700_000_000_000 是上海时间 2023-11-15 06:13:20
    expect(texts).toContain("上次记录的成功同步：2023-11-15 06:13:20");
    expect(texts).toContain("上次检查的 S3 Head 指针：remote-version · 2023-11-15 06:13:21");
    expect(texts).toContain("下次计划重试：2023-11-15 06:13:23");
    expect(texts).toContain("阶段：保存记录 · HTTP 请求：3 · 发送/接收字节：0/42");
    expect(texts).toContain("上次运行的错误：S3 服务出错（HTTP 503）");
  });

  it("offers a real review action for a collision that lists only one path", () => {
    const modal = new StatusModal({} as App, issueController([{kind: "path-collision", paths: ["weekly.md"]}]));
    modal.onOpen();
    type FakeElement = InstanceType<typeof Element>;
    const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
    expect(all(modal.contentEl as unknown as FakeElement).some(node =>
      node.tag === "button" && node.text === "审查路径撞名")).toBe(true);
  });

  it.each(["local", "remote"] as const)("reviews identities and dispatches only the selected %s rename", async side => {
    const controller = issueController([{kind: "path-collision", paths: ["note.md"]}]);
    controller.reviewPathCollision = async paths => ({paths, reviewToken: "collision", relatedPaths: ["old.md"], pendingMoves: [],
      localFiles: [{path: "note.md", size: 5, entryId: "local-id", preview: "local", suggestedName: "local-copy.md"}],
      remoteFiles: [{path: "note.md", size: 6, entryId: "remote-id", previousPath: "old.md", preview: "remote", suggestedName: "remote-copy.md"}]});
    const rename = vi.fn().mockResolvedValue("chosen.md");
    controller.resolvePathCollision = rename;
    const modal = new StatusModal({} as App, controller);
    modal.onOpen();
    type FakeElement = InstanceType<typeof Element>;
    const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
    all(modal.contentEl as unknown as FakeElement).find(node => node.text === "审查路径撞名")!.events.get("click")!();
    const review = opened.at(-1)!;
    await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text === "给 S3 记录改名并同步")).toBe(true));
    const nodes = all(review.contentEl);
    expect(nodes.some(node => node.text === "local")).toBe(true);
    expect(nodes.some(node => node.text === "remote")).toBe(true);
    expect(nodes.some(node => node.text === "之前认可的路径：old.md")).toBe(true);
    expect(rename).not.toHaveBeenCalled();
    nodes.filter(node => node.tag === "input")[side === "local" ? 0 : 1]!.value = "chosen.md";
    nodes.find(node => node.text === (side === "local" ? "给本地文件改名并同步" : "给 S3 记录改名并同步"))!.events.get("click")!();
    expect(rename).toHaveBeenCalledWith({paths: ["note.md"], reviewToken: "collision", side, path: "note.md",
      entryId: `${side}-id`, newName: "chosen.md"});
    await vi.waitFor(() => expect(rename).toHaveResolved());
  });

  it("offers explicit identity recovery instead of more renames after an interrupted move", async () => {
    const controller = issueController([{kind: "path-collision", paths: ["source.md", "target.md"]}]);
    controller.reviewPathCollision = async paths => ({paths, reviewToken: "recovery", relatedPaths: [], pendingMoves: [], remoteFiles: [],
      interruptedRename: {from: "source.md", to: "target.md", expectedHash: "old-hash"},
      localFiles: [{path: "target.md", size: 5, contentHash: "new-hash", preview: "draft", suggestedName: "unused.md"}]});
    const recover = vi.fn().mockResolvedValue(undefined);
    controller.confirmInterruptedCollisionRename = recover;
    const modal = new StatusModal({} as App, controller);
    modal.onOpen();
    type FakeElement = InstanceType<typeof Element>;
    const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
    all(modal.contentEl as unknown as FakeElement).find(node => node.text === "审查路径撞名")!.events.get("click")!();
    const review = opened.at(-1)!;
    await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text === "确认目标路径就是改名后的原文件")).toBe(true));
    expect(all(review.contentEl).some(node => node.text === "给本地文件改名并同步")).toBe(false);
    expect(all(review.contentEl).some(node => node.text === "重新加载撞名审查")).toBe(true);
    expect(recover).not.toHaveBeenCalled();
    all(review.contentEl).find(node => node.text === "确认目标路径就是改名后的原文件")!.events.get("click")!();
    expect(recover).toHaveBeenCalledWith(["source.md", "target.md"], "recovery", "target");
    await vi.waitFor(() => expect(recover).toHaveResolved());
  });

  it("offers an authenticated backup preview, expiry and an explicit restore action", async () => {
    const revision = {revisionId: "backup", blobId: "blob", contentHash: "hash", size: 14,
      createdAt: "2026-09-18T10:00:00Z", expiresAt: "2026-10-18T10:00:00Z"};
    const read = vi.fn().mockResolvedValue(new TextEncoder().encode("unsynced draft"));
    const restore = vi.fn().mockResolvedValue(undefined);
    const modal = new VersionHistoryModal({} as App, {readHistoricalRevision: read, restoreRevision: restore},
      {kind: "live", entryId: "entry", path: "article.md", revision: {...revision, revisionId: "current"}, history: [revision]});
    modal.onOpen();
    type FakeElement = InstanceType<typeof Element>;
    const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
    const nodes = all(modal.contentEl as unknown as FakeElement);
    expect(nodes.some(node => node.text.includes("可恢复至 2026-10-18 18:00"))).toBe(true);
    nodes.find(node => node.text === "预览")!.events.get("click")!();
    const preview = opened.at(-1)!;
    await vi.waitFor(() => expect(all(preview.contentEl).some(node => node.text === "unsynced draft")).toBe(true));
    expect(read).toHaveBeenCalledWith("entry", "backup");
    expect(restore).not.toHaveBeenCalled();
    nodes.find(node => node.text === "恢复")!.events.get("click")!();
    expect(restore).toHaveBeenCalledWith("entry", "backup");
    await vi.waitFor(() => expect(restore).toHaveResolved());
  });

  it("adds bulk-deletion and repair actions when the already-open status changes", () => {
    const controller = issueController([]);
    let status = "空闲：ready";
    let bulk: ReturnType<StatusModalController["getPendingBulkDeletion"]>;
    let listener: (status: {text: string}) => void = () => {};
    controller.getStatusText = () => status;
    controller.getPendingBulkDeletion = () => bulk;
    controller.onStatusChange = callback => {listener = callback; return () => {};};
    const modal = new StatusModal({} as App, controller);
    modal.onOpen();
    type FakeElement = InstanceType<typeof Element>;
    const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
    bulk = {count: 101, totalLiveEntries: 200, entryIds: ["test-entry"]};
    status = "需要处理：review bulk deletion";
    listener({text: status});
    expect(all(modal.contentEl as unknown as FakeElement).some(node => node.text === "确认批量删除")).toBe(true);
    status = "需要处理：修复模式：Head missing";
    listener({text: status});
    expect(all(modal.contentEl as unknown as FakeElement).some(node => node.text === "恢复指引")).toBe(true);
  });

  it("keeps a failed mobile-transfer confirmation open and allows retry", async () => {
    const controller = issueController([]);
    controller.getDeferredDownloads = () => [{entryId: "entry", path: "large.bin", reason: "device-limit", size: 100}];
    const download = vi.fn().mockRejectedValueOnce(new Error("Network disconnected")).mockResolvedValueOnce(undefined);
    controller.downloadDeferred = download;
    const modal = new StatusModal({} as App, controller);
    modal.onOpen();
    type FakeElement = InstanceType<typeof Element>;
    const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
    all(modal.contentEl as unknown as FakeElement).find(node => node.text === "仍然尝试")!.events.get("click")!();
    const confirmation = opened.at(-1)! as typeof opened[number] & {closed: boolean};
    const button = all(confirmation.contentEl).find(node => node.text === "仍然尝试")!;
    button.events.get("click")!();
    await vi.waitFor(() => expect(all(confirmation.contentEl).some(node => node.text.includes("Network disconnected"))).toBe(true));
    expect(confirmation.closed).toBe(false);
    expect(button.disabled).toBe(false);
    button.events.get("click")!();
    await vi.waitFor(() => expect(confirmation.closed).toBe(true));
    expect(download).toHaveBeenCalledTimes(2);
  });

  it("offers preview, version selection and preview retry for conflicts", async () => {
    const controller = issueController([]);
    const revision = {revisionId: "rev", blobId: "blob", contentHash: "hash", size: 4, createdAt: "2026-09-18"};
    controller.getConflicts = () => [{entryId: "entry", kind: "conflicted", path: "article.md", reason: "edit-edit", candidates: [revision]}];
    controller.readConflictCandidate = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(new TextEncoder().encode("text"));
    const modal = new StatusModal({} as App, controller);
    modal.onOpen();
    type FakeElement = InstanceType<typeof Element>;
    const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
    expect(all(modal.contentEl as unknown as FakeElement).some(node => node.text === "使用这个版本")).toBe(true);
    all(modal.contentEl as unknown as FakeElement).find(node => node.text === "预览版本")!.events.get("click")!();
    const preview = opened.at(-1)!;
    await vi.waitFor(() => expect(all(preview.contentEl).some(node => node.text === "重试预览")).toBe(true));
    all(preview.contentEl).find(node => node.text === "重试预览")!.events.get("click")!();
    await vi.waitFor(() => expect(all(preview.contentEl).some(node => node.text === "text")).toBe(true));
  });

  it.each(["未配置：unlock first", "出错：status 403", "出错：connection closed", "已暂停：sync paused"])(
    "offers settings and troubleshooting for %s", status => {
      const controller = issueController([]);
      controller.getStatusText = () => status;
      controller.isPaused = () => status.startsWith("已暂停");
      const openSettings = vi.fn();
      controller.openSettings = openSettings;
      const modal = new StatusModal({} as App, controller);
      modal.onOpen();
      type FakeElement = InstanceType<typeof Element>;
      const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
      const nodes = all(modal.contentEl as unknown as FakeElement);
      nodes.find(node => node.text === "打开设置")!.events.get("click")!();
      expect(openSettings).toHaveBeenCalledOnce();
      expect(nodes.some(node => node.text === "故障排查")).toBe(true);
      expect(nodes.some(node => node.text === "复制状态")).toBe(true);
      if (status.startsWith("已暂停")) {
        expect(nodes.find(node => node.text === "立即同步")?.disabled).toBe(true);
        expect(nodes.some(node => node.text === "继续")).toBe(true);
      }
    },
  );
  const issueController = (issues: LocalSyncIssue[]): StatusModalController => ({
    ...reviewActions,
    getStatusText: () => "需要处理", isPaused: () => false,
    getConflicts: () => [], getDeferredDownloads: () => [], getDeletedRecoveries: () => [],
    getLocalIssues: () => issues, getPendingBulkDeletion: () => undefined,
    confirmBulkDeletion: async () => {}, downloadDeferred: async () => {}, importCandidate: async () => {},
    resolvePossibleRename: async () => {}, keepConflictDeleted: async () => {},
    resolveConflict: async () => {}, restoreDeleted: async () => {},
    readDeletedRecovery: async () => new Uint8Array(), syncNow: async () => {}, togglePause: async () => {},
    onStatusChange: () => () => {},
  });

  it("provides specific resolution guidance for every local issue type", () => {
    const issues: LocalSyncIssue[] = [
      {kind: "bootstrap-mismatch", path: "a.md"},
      {kind: "resolution-mismatch", path: "b.md"},
      {kind: "deferred-local-edit", path: "c.md"},
      {kind: "import-candidate", path: "d.md"},
      {kind: "unsupported-path", path: "a:b.md"},
      {kind: "unsynced-local", path: "large.bin"},
      {kind: "path-collision", paths: ["Upper.md", "upper.md"]},
      {kind: "possible-rename", oldPaths: ["old.md"], newPaths: ["new.md"], reviewToken: "token"},
    ];
    const modal = new StatusModal({} as App, issueController(issues));
    modal.onOpen();
    type FakeElement = InstanceType<typeof Element>;
    const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
    const buttons = all(modal.contentEl as unknown as FakeElement).filter(node => node.tag === "button");
    expect(buttons.filter(button => button.text === "How to resolve")).toHaveLength(0);
    const help = all(modal.contentEl as unknown as FakeElement).filter(node =>
      node.tag === "details" && node.children.some(child => child.text === "为什么需要处理"));
    expect(help).toHaveLength(8);
    expect(help.every(node => !node.open)).toBe(true);
    expect(buttons.filter(button => button.text === "复制路径")).toHaveLength(8);
    expect(buttons.filter(button => button.text === "对比并处理")).toHaveLength(3);
  });

  it("shows both previews before dispatching an explicitly confirmed preservation", async () => {
    const controller = issueController([{kind: "bootstrap-mismatch", path: "article.md"}]);
    const preserve = vi.fn(async () => "article (local copy).md");
    controller.resolveLocalContent = preserve;
    const modal = new StatusModal({} as App, controller);
    modal.onOpen();
    type FakeElement = InstanceType<typeof Element>;
    const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
    all(modal.contentEl as unknown as FakeElement).find(node => node.text === "对比并处理")!.events.get("click")!();
    const review = opened.at(-1)!;
    await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text === "remote")).toBe(true));
    expect(all(review.contentEl).some(node => node.text === "local")).toBe(true);
    expect(preserve).not.toHaveBeenCalled();
    const nodes = all(review.contentEl);
    expect(nodes.findIndex(node => node.text === "两份都保留（本地副本）"))
      .toBeLessThan(nodes.findIndex(node => node.tag === "pre"));
    all(review.contentEl).find(node => node.text === "两份都保留（本地副本）")!.events.get("click")!();
    expect(preserve).toHaveBeenCalledWith("article.md", "review", "both");
    await vi.waitFor(() => expect(preserve).toHaveResolved());
  });

  it("highlights local and remote differences without writing either version", async () => {
    const controller = issueController([{kind: "bootstrap-mismatch", path: "article.md"}]);
    controller.reviewLocalContent = async path => ({path, reviewToken: "review", localExists: true,
      localSize: 27, localPreview: "# Article\nshared\nlocal edit\n", remoteKind: "live",
      remoteVersions: [{size: 28, createdAt: "2026-09-18", preview: "# Article\nshared\nremote edit\n"}]});
    const preserve = vi.fn();
    controller.resolveLocalContent = preserve;
    const modal = new StatusModal({} as App, controller);
    modal.onOpen();
    type FakeElement = InstanceType<typeof Element>;
    const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
    all(modal.contentEl as unknown as FakeElement).find(node => node.text === "对比并处理")!.events.get("click")!();
    const review = opened.at(-1)!;
    await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text === "− remote edit")).toBe(true));
    expect(all(review.contentEl).some(node => node.text === "+ local edit")).toBe(true);
    expect(all(review.contentEl).some(node => node.text === "仅远端有 1 行 · 仅本地有 1 行")).toBe(true);
    const fullVersions = all(review.contentEl).filter(node => node.tag === "details");
    expect(fullVersions).toHaveLength(2);
    expect(fullVersions.every(node => !node.open)).toBe(true);
    expect(preserve).not.toHaveBeenCalled();
  });

  it.each([["使用本地版本", "local"], ["使用 S3 版本", "remote"], ["两份都保留（本地副本）", "both"]] as const)(
    "offers %s with clear consequences, timestamps and access to recovery", async (label, choice) => {
      const controller = issueController([{kind: "bootstrap-mismatch", path: "article.md"}]);
      const resolve = vi.fn().mockResolvedValue(choice === "both" ? "article (local copy).md" : undefined);
      const history = vi.fn();
      controller.resolveLocalContent = resolve;
      controller.openVersionHistory = history;
      const modal = new StatusModal({} as App, controller);
      modal.onOpen();
      type FakeElement = InstanceType<typeof Element>;
      const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
      all(modal.contentEl as unknown as FakeElement).find(node => node.text === "对比并处理")!.events.get("click")!();
      const review = opened.at(-1)!;
      await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text === label)).toBe(true));
      const nodes = all(review.contentEl);
      expect(nodes.some(node => node.text.startsWith("本地最后修改："))).toBe(true);
      expect(nodes.some(node => node.text.startsWith("S3 版本记录时间："))).toBe(true);
      expect(nodes.some(node => node.text.includes("30 天"))).toBe(true);
      expect(nodes.some(node => node.text === "稍后再决定")).toBe(true);
      expect(resolve).not.toHaveBeenCalled();
      nodes.find(node => node.text === label)!.events.get("click")!();
      expect(resolve).toHaveBeenCalledWith("article.md", "review", choice);
      expect(nodes.filter(node => ["使用本地版本", "使用 S3 版本", "两份都保留（本地副本）"].includes(node.text))
        .every(node => node.disabled)).toBe(true);
      await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text === "处理完成")).toBe(true));
      if (choice !== "both") {
        all(review.contentEl).find(node => node.text === "打开历史版本")!.events.get("click")!();
        expect(history).toHaveBeenCalledWith("article.md");
      } else expect(all(review.contentEl).some(node => node.text.includes("article (local copy).md"))).toBe(true);
    },
  );

  it("can postpone the choice without accepting either version", async () => {
    const controller = issueController([{kind: "bootstrap-mismatch", path: "article.md"}]);
    const resolve = vi.fn();
    controller.resolveLocalContent = resolve;
    const modal = new StatusModal({} as App, controller);
    modal.onOpen();
    type FakeElement = InstanceType<typeof Element>;
    const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
    all(modal.contentEl as unknown as FakeElement).find(node => node.text === "对比并处理")!.events.get("click")!();
    const review = opened.at(-1)! as typeof opened[number] & {closed: boolean};
    await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text === "使用本地版本")).toBe(true));
    all(review.contentEl).find(node => node.text === "稍后再决定")!.events.get("click")!();
    expect(review.closed).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([false, true])("explains unavailable text comparisons and respects device restrictions (blocked=%s)", async blocked => {
    const controller = issueController([{kind: "deferred-local-edit", path: "large.bin"}]);
    controller.reviewLocalContent = async path => ({path, reviewToken: "review", localExists: true,
      localSize: 300_000, remoteKind: "live", remoteVersions: [{size: 300_000, createdAt: "2026-09-18"}],
      blockedReason: blocked ? "This review exceeds this device's transfer limit." : undefined});
    const preserve = vi.fn();
    controller.resolveLocalContent = preserve;
    const modal = new StatusModal({} as App, controller);
    modal.onOpen();
    type FakeElement = InstanceType<typeof Element>;
    const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
    all(modal.contentEl as unknown as FakeElement).find(node => node.text === "对比并处理")!.events.get("click")!();
    const review = opened.at(-1)!;
    await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text.startsWith("无法逐行对比："))).toBe(true));
    expect(all(review.contentEl).some(node => node.text === "两份都保留（本地副本）")).toBe(!blocked);
    expect(preserve).not.toHaveBeenCalled();
  });

  it("reloads a failed comparison and requires fresh confirmation after either version changes", async () => {
    const controller = issueController([{kind: "bootstrap-mismatch", path: "article.md"}]);
    controller.reviewLocalContent = vi.fn().mockRejectedValueOnce(new Error("Network disconnected"))
      .mockResolvedValueOnce(await reviewActions.reviewLocalContent("article.md"))
      .mockResolvedValueOnce({...await reviewActions.reviewLocalContent("article.md"), reviewToken: "fresh", localPreview: "fresh local"});
    const preserve = vi.fn().mockRejectedValueOnce(new Error("Local or remote content changed. Review the versions again."))
      .mockResolvedValueOnce("article (local copy).md");
    controller.resolveLocalContent = preserve;
    const modal = new StatusModal({} as App, controller);
    modal.onOpen();
    type FakeElement = InstanceType<typeof Element>;
    const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
    all(modal.contentEl as unknown as FakeElement).find(node => node.text === "对比并处理")!.events.get("click")!();
    const review = opened.at(-1)!;
    await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text === "重试审查")).toBe(true));
    expect(preserve).not.toHaveBeenCalled();
    all(review.contentEl).find(node => node.text === "重试审查")!.events.get("click")!();
    await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text === "两份都保留（本地副本）")).toBe(true));
    const confirm = all(review.contentEl).find(node => node.text === "两份都保留（本地副本）")!;
    confirm.events.get("click")!();
    await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text === "重新加载审查")).toBe(true));
    expect(confirm.disabled).toBe(true);
    confirm.events.get("click")!();
    expect(preserve).toHaveBeenCalledTimes(1);
    all(review.contentEl).find(node => node.text === "重新加载审查")!.events.get("click")!();
    await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text === "+ fresh local")).toBe(true));
    expect(preserve).toHaveBeenCalledTimes(1);
    all(review.contentEl).find(node => node.text === "两份都保留（本地副本）")!.events.get("click")!();
    expect(preserve).toHaveBeenLastCalledWith("article.md", "fresh", "both");
    await vi.waitFor(() => expect(preserve).toHaveResolved());
  });
  it.each(["bootstrap-mismatch", "resolution-mismatch", "deferred-local-edit"] as const)(
    "provides a review action for %s instead of a dead-end warning", kind => {
      const controller: StatusModalController = {
        ...reviewActions,
        getStatusText: () => "需要处理", isPaused: () => false,
        getConflicts: () => [], getDeferredDownloads: () => [], getDeletedRecoveries: () => [],
        getLocalIssues: () => [{kind, path: "article.md"}], getPendingBulkDeletion: () => undefined,
        confirmBulkDeletion: async () => {}, downloadDeferred: async () => {}, importCandidate: async () => {},
        resolvePossibleRename: async () => {}, keepConflictDeleted: async () => {},
        resolveConflict: async () => {}, restoreDeleted: async () => {},
        readDeletedRecovery: async () => new Uint8Array(), syncNow: async () => {}, togglePause: async () => {},
        onStatusChange: () => () => {},
      };
      const modal = new StatusModal({} as App, controller);
      modal.onOpen();
      type FakeElement = InstanceType<typeof Element>;
      const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
      expect(all(modal.contentEl as unknown as FakeElement).some(node =>
        node.tag === "button" && node.text === "对比并处理",
      )).toBe(true);
    },
  );
  it("updates visible status and pause controls without reopening, then unsubscribes", () => {
    let text = "出错：old failure";
    let paused = false;
    const listeners = new Set<(status: { text: string }) => void>();
    const controller: StatusModalController = {
      ...reviewActions,
      getStatusText: () => text, isPaused: () => paused,
      getConflicts: () => [], getDeferredDownloads: () => [], getDeletedRecoveries: () => [],
      getLocalIssues: () => [], getPendingBulkDeletion: () => undefined,
      confirmBulkDeletion: async () => {}, downloadDeferred: async () => {}, importCandidate: async () => {},
      resolvePossibleRename: async () => {},
      keepConflictDeleted: async () => {}, resolveConflict: async () => {}, restoreDeleted: async () => {},
      readDeletedRecovery: async () => new Uint8Array(), syncNow: async () => {}, togglePause: async () => {},
      onStatusChange: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    };
    const modal = new StatusModal({} as App, controller);
    modal.onOpen();
    const root = modal.contentEl as unknown as InstanceType<typeof Element>;
    const statusNode = root.children.find(e => e.tag === "p");
    expect(statusNode?.text).toBe(text);
    text = "空闲：all changes synchronized";
    for (const listener of listeners) listener({ text });
    expect(statusNode?.text).toBe(text);
    paused = true;
    text = "已暂停：automatic sync is paused";
    for (const listener of listeners) listener({ text });
    expect(statusNode?.text).toBe(text);
    const all = (node: InstanceType<typeof Element>): InstanceType<typeof Element>[] => [node, ...node.children.flatMap(all)];
    expect(all(root).some(e => e.text === "继续")).toBe(true);
    modal.onOpen();
    expect(listeners.size).toBe(1);
    modal.onClose();
    expect(listeners.size).toBe(0);
  });

  it("offers a collapsed folder summary and an actionable review that preserves the selected mapping", async () => {
    type FakeElement = InstanceType<typeof Element>;
    const all = (root: FakeElement): FakeElement[] => [root, ...root.children.flatMap(all)];
    const issue = {kind: "possible-rename" as const, oldPaths: ["before/a.md", "before/b.md"],
      newPaths: ["after/a.md", "after/b.md"], reviewToken: "review-1"};
    const resolvePossibleRename = vi.fn(async () => {});
    const controller: StatusModalController = {
      ...reviewActions,
      getStatusText: () => "需要处理：review files", isPaused: () => false,
      getConflicts: () => [], getDeferredDownloads: () => [], getDeletedRecoveries: () => [],
      getLocalIssues: () => [issue], getPendingBulkDeletion: () => undefined,
      confirmBulkDeletion: async () => {}, downloadDeferred: async () => {}, importCandidate: async () => {},
      keepConflictDeleted: async () => {}, resolveConflict: async () => {}, restoreDeleted: async () => {},
      readDeletedRecovery: async () => new Uint8Array(), syncNow: async () => {}, togglePause: async () => {},
      onStatusChange: () => () => {}, resolvePossibleRename,
    };
    const modal = new StatusModal({} as App, controller);
    modal.onOpen();
    const root = modal.contentEl as unknown as FakeElement;
    expect(all(root).find(node => node.text === "before/ → after/")).toBeDefined();
    expect(all(root).find(node => node.tag === "details")?.open).toBe(false);
    all(root).find(node => node.text === "审查并处理")!.events.get("click")!();
    const review = opened.at(-1)!;
    const confirm = all(review.contentEl).find(node => node.text === "确认挪动")!;
    expect(confirm.disabled).toBe(false);
    confirm.events.get("click")!();
    expect(resolvePossibleRename).toHaveBeenCalledWith({kind: "moves", reviewToken: "review-1",
      pairs: [{fromPath: "before/a.md", toPath: "after/a.md"}, {fromPath: "before/b.md", toPath: "after/b.md"}]});
    await vi.waitFor(() => expect(resolvePossibleRename).toHaveResolved());
  });

  describe("partial move review", () => {
    type FakeElement = InstanceType<typeof Element>;
    const all = (root: FakeElement): FakeElement[] => [root, ...root.children.flatMap(all)];
    const openReview = (oldPaths: string[], newPaths: string[]) => {
      const issue = {kind: "possible-rename" as const, oldPaths, newPaths, reviewToken: "review-2"};
      const resolvePossibleRename = vi.fn(async () => {});
      const controller: StatusModalController = {...issueController([issue]), resolvePossibleRename};
      const modal = new StatusModal({} as App, controller);
      modal.onOpen();
      dropdowns.length = 0;
      all(modal.contentEl as unknown as FakeElement).find(node => node.text === "审查并处理")!.events.get("click")!();
      const review = opened.at(-1)!;
      const confirm = all(review.contentEl).find(node => node.text === "确认挪动")!;
      return {review, confirm, resolvePossibleRename};
    };

    it("lists only same-type candidates and preselects the unique same-name or only candidate", async () => {
      const {confirm, resolvePossibleRename} = openReview(
        ["old/report.pdf", "old/plan.pdf", "old/memo.md"],
        ["new/report.pdf", "new/a.pdf", "new/b.pdf", "new/memo v2.md"],
      );
      const [report, plan, memo] = dropdowns;
      expect(plan!.options).toEqual([["", "按删除处理"], ["new/report.pdf", "report.pdf"],
        ["new/a.pdf", "a.pdf"], ["new/b.pdf", "b.pdf"]]);
      expect(memo!.options).toEqual([["", "按删除处理"], ["new/memo v2.md", "memo v2.md"]]);
      expect(report!.value).toBe("new/report.pdf");
      expect(plan!.value).toBe("");
      expect(memo!.value).toBe("new/memo v2.md");
      expect(confirm.disabled).toBe(false);
      confirm.events.get("click")!();
      expect(resolvePossibleRename).toHaveBeenCalledWith({kind: "moves", reviewToken: "review-2",
        pairs: [{fromPath: "old/report.pdf", toPath: "new/report.pdf"}, {fromPath: "old/memo.md", toPath: "new/memo v2.md"}]});
      await vi.waitFor(() => expect(resolvePossibleRename).toHaveResolved());
    });

    it("keeps confirm available for one missing file with three candidates", () => {
      const {confirm} = openReview(["old/report.pdf"], ["new/a.pdf", "new/b.pdf", "new/c.pdf"]);
      expect(dropdowns[0]!.value).toBe("");
      expect(confirm.disabled).toBe(false);
    });

    it("blocks confirmation while two missing files choose the same new file", () => {
      const {review, confirm, resolvePossibleRename} = openReview(["old/a.pdf", "old/b.pdf"], ["new/x.pdf", "new/y.pdf"]);
      dropdowns[0]!.change!("new/x.pdf");
      dropdowns[1]!.change!("new/x.pdf");
      expect(confirm.disabled).toBe(true);
      expect(all(review.contentEl).some(node => node.text === "两个消失的文件不能挪到同一个新文件。")).toBe(true);
      dropdowns[1]!.change!("new/y.pdf");
      expect(confirm.disabled).toBe(false);
      expect(all(review.contentEl).some(node => node.text === "两个消失的文件不能挪到同一个新文件。")).toBe(false);
      confirm.events.get("click")!();
      expect(resolvePossibleRename).toHaveBeenCalledWith({kind: "moves", reviewToken: "review-2",
        pairs: [{fromPath: "old/a.pdf", toPath: "new/x.pdf"}, {fromPath: "old/b.pdf", toPath: "new/y.pdf"}]});
    });
  });

  describe("deleted files list", () => {
    type FakeElement = InstanceType<typeof Element>;
    const all = (root: FakeElement): FakeElement[] => [root, ...root.children.flatMap(all)];
    const revision = (id: string, expiresAt: string) => ({revisionId: id, blobId: `${id}-blob`, contentHash: `${id}-hash`,
      size: 5, createdAt: "2026-09-01T00:00:00Z", expiresAt});
    // 设备时间 2026-10-18 10:00（上海时区），只影响显示
    const now = "2026-10-18T02:00:00Z";
    const expired: DeletedEntry = {kind: "deleted", entryId: "expired", path: "expired.md", deletedAt: "2026-09-01T00:00:00Z",
      lastContentHash: "h1", lastRevisionId: "r1", recovery: revision("r1", "2026-10-01T00:00:00Z"),
      history: [revision("old1", "2026-09-30T00:00:00Z")]};
    const fresh: DeletedEntry = {kind: "deleted", entryId: "fresh", path: "fresh.md", deletedAt: "2026-10-06T01:11:26.000Z",
      lastContentHash: "h2", lastRevisionId: "r2", recovery: revision("r2", "2026-11-05T01:11:26.000Z")};
    const candidateOnly: DeletedEntry = {kind: "deleted", entryId: "candidate", path: "candidate.md",
      deletedAt: "2026-09-10T00:00:00Z", lastContentHash: "h3", lastRevisionId: "r3",
      recovery: revision("r3", "2026-10-10T00:00:00Z"), history: [revision("conflict-candidate", "2026-10-18T12:00:00Z")]};
    const openWith = (deleted: DeletedEntry[]) => {
      const controller = {...issueController([]), getDeletedRecoveries: () => deleted};
      const modal = new StatusModal({} as App, controller);
      modal.onOpen();
      return all(modal.contentEl as unknown as FakeElement);
    };
    beforeEach(() => {vi.useFakeTimers({toFake: ["Date"]}); vi.setSystemTime(new Date(now));});
    afterEach(() => {vi.useRealTimers();});

    it("lists only deleted files that still have unexpired recovery content", () => {
      const texts = openWith([expired, fresh, candidateOnly]).map(node => node.text);
      expect(texts).toContain("已删除的文件（30 天内可恢复）");
      expect(texts).not.toContain("expired.md");
      expect(texts).toContain("fresh.md");
      expect(texts).toContain("candidate.md");
    });

    it("folds the list by default under a title that says how many files there are", () => {
      const nodes = openWith([expired, fresh, candidateOnly]);
      const section = nodes.find(node => node.tag === "details" &&
        all(node).some(child => child.text === "已删除的文件（30 天内可恢复）"))!;
      expect(section.open).toBe(false);
      const title = section.children.find(child => child.tag === "summary")!;
      expect(all(title).map(child => child.text)).toEqual(expect.arrayContaining(["已删除的文件（30 天内可恢复）", "2 个"]));
      expect(title.classes.has("s3-vault-sync-section-title")).toBe(true);
      expect(all(section).some(child => child.text === "fresh.md")).toBe(true);
    });

    it("keeps the list open after the status refresh redraws the window", () => {
      const listeners = new Set<(status: {text: string}) => void>();
      const controller = {...issueController([]), getDeletedRecoveries: () => [fresh],
        onStatusChange: (listener: (status: {text: string}) => void) => {listeners.add(listener); return () => listeners.delete(listener);}};
      const modal = new StatusModal({} as App, controller);
      modal.onOpen();
      const section = () => all(modal.contentEl as unknown as FakeElement).find(node => node.tag === "details" &&
        all(node).some(child => child.text === "已删除的文件（30 天内可恢复）"))!;
      const first = section();
      first.open = true;
      first.events.get("toggle")!();
      for (const listener of listeners) listener({text: "空闲：同步完成"});
      expect(section()).not.toBe(first);
      expect(section().open).toBe(true);
      section().open = false;
      section().events.get("toggle")!();
      modal.onOpen();
      expect(section().open).toBe(false);
    });

    it("shows each deletion time in the device time zone with the days left", () => {
      const texts = openWith([fresh, candidateOnly]).map(node => node.text).filter(text => text.startsWith("删除于"));
      // fresh 还剩 17 天 23 小时 11 分，向下取整；candidate 只剩 10 小时
      expect(texts).toEqual(["删除于 2026-10-06 09:11 · 还剩 17 天", "删除于 2026-09-10 08:00 · 不到 1 天"]);
    });

    it("hides the section when every deleted file is past its recovery period", () => {
      const texts = openWith([expired]).map(node => node.text);
      expect(texts).not.toContain("已删除的文件（30 天内可恢复）");
      expect(texts).not.toContain("expired.md");
    });

    it("offers version history but not the expired recovery copy", () => {
      const nodes = openWith([candidateOnly]);
      expect(nodes.some(node => node.text === "恢复副本不可用，请打开历史版本")).toBe(true);
      expect(nodes.some(node => node.text === "点击预览")).toBe(false);
      expect(nodes.some(node => node.tag === "button" && node.text === "恢复")).toBe(false);
      expect(nodes.some(node => node.tag === "button" && node.text === "历史版本")).toBe(true);
    });

    it("shows the recovery deadline in the deleted preview in local time", () => {
      const nodes = openWith([fresh]);
      const target = nodes.find(node => node.events.has("keydown"))!;
      (target.events.get("keydown") as unknown as (event: {key: string; preventDefault(): void}) => void)(
        {key: "Enter", preventDefault() {}});
      expect(all(opened.at(-1)!.contentEl).some(node => node.text === "5 字节 · 可恢复至 2026-11-05 09:11")).toBe(true);
    });
  });

  describe("sync records", () => {
    type FakeElement = InstanceType<typeof Element>;
    const all = (root: FakeElement): FakeElement[] => [root, ...root.children.flatMap(all)];
    // 设备时间 2026-10-25 周日 16:20（上海时区）
    const now = "2026-10-25T08:20:00Z";
    const at = (local: string): number => Date.parse(`${local}+08:00`);
    const sync = (id: string, startedAt: number, extra: Partial<SyncActivityRecord> = {}): SyncActivityRecord => ({
      id, vaultId: "vault", kind: "sync", startedAt, finishedAt: startedAt + 1_737, triggers: ["edit"], outcome: "complete",
      uploads: [], downloads: [], phase: "saving", phaseDurations: {}, requests: 98, sentBytes: 14_540, receivedBytes: 53_043, ...extra,
    });
    const manual = (id: string, startedAt: number, summary: string, files: SyncActivityRecord["uploads"]): SyncActivityRecord => ({
      id, vaultId: "vault", kind: "manual", startedAt, finishedAt: startedAt + 20, triggers: [], outcome: "complete",
      uploads: [], downloads: [], files, summary,
    });
    const run = (id: string, startedAt: number, extra: Partial<SyncRunRecord> = {}): SyncRunRecord => ({
      id, vaultId: "vault", startedAt, finishedAt: startedAt + 500, outcome: "complete", triggers: ["periodic"], phase: "saving",
      phaseDurations: {}, requests: 90, sentBytes: 0, receivedBytes: 0,
      counts: {uploaded: 0, downloaded: 0, deleted: 0, deferred: 0, unsynced: 0}, ...extra,
    });
    const controllerWith = (records: SyncActivityRecord[], runs: SyncRunRecord[] = [], persistenceWarning?: string): StatusModalController => ({
      ...issueController([]),
      getSyncActivity: () => ({records, ...(persistenceWarning ? {persistenceWarning} : {})}),
      getDiagnostics: () => ({records: runs, queued: false, pendingLocalChanges: 0}),
    });
    const open = (controller: StatusModalController): StatusModal => {
      const modal = new StatusModal({} as App, controller);
      modal.onOpen();
      return modal;
    };
    const nodesOf = (modal: StatusModal): FakeElement[] => all(modal.contentEl as unknown as FakeElement);
    const sectionOf = (modal: StatusModal): FakeElement | undefined => nodesOf(modal).find(node => node.tag === "details" &&
      node.children.some(child => child.tag === "summary" && all(child).some(part => part.text === "同步记录（最近 30 天）")));
    const rowsOf = (modal: StatusModal): FakeElement[] => all(sectionOf(modal)!).filter(node => node.classes.has("s3-vault-sync-record"));
    const lineOf = (row: FakeElement): FakeElement => row.children.find(child => child.classes.has("s3-vault-sync-record-line"))!;
    const lineTexts = (row: FakeElement): string[] => lineOf(row).children.map(child => child.text);
    const textsIn = (node: FakeElement): string[] => all(node).map(child => child.text).filter(text => text !== "");
    const click = (node: FakeElement): void => node.events.get("click")!();
    const press = (node: FakeElement, key: string): void =>
      (node.events.get("keydown") as unknown as (event: {key: string; preventDefault(): void}) => void)({key, preventDefault() {}});
    beforeEach(() => {vi.useFakeTimers({toFake: ["Date"]}); vi.setSystemTime(new Date(now));});
    afterEach(() => {vi.useRealTimers();});

    it("folds the records by default under a title that counts them, and replaces the old 20-line history", () => {
      const modal = open(controllerWith([
        sync("one", at("2026-10-25T16:55:36"), {uploads: [{kind: "modified", path: "1-Projects/日志.md"}]}),
        sync("two", at("2026-10-24T22:41:17"), {downloads: [{kind: "added", path: "录音/周会.md"}]}),
      ], [run("quiet", at("2026-10-25T16:00:00"))]));
      const section = sectionOf(modal)!;
      expect(section.open).toBe(false);
      const title = section.children.find(child => child.tag === "summary")!;
      expect(title.classes.has("s3-vault-sync-section-title")).toBe(true);
      expect(textsIn(title)).toEqual(expect.arrayContaining(["同步记录（最近 30 天）", "本设备 · 2 次有改动或需要注意"]));
      expect(textsIn(section)).toContain("只列出动过文件、出错、需要重试的同步，以及你的手动操作。点一行查看这次同步的详情，再点一次收起。没有改动任何文件的检查，每天合成一行，只保留 7 天。");
      expect(nodesOf(modal).some(node => node.text.startsWith("最近的同步记录"))).toBe(false);
    });

    it("groups the records by local day, newest first, and labels today and yesterday", () => {
      const modal = open(controllerWith([
        sync("old", at("2026-10-21T15:03:47"), {uploads: [{kind: "added", path: "图纸/新.pdf"}]}),
        sync("late", at("2026-10-24T23:59:58"), {uploads: [{kind: "added", path: "a.md"}]}),
        sync("early", at("2026-10-25T00:00:03"), {uploads: [{kind: "added", path: "b.md"}]}),
        sync("noon", at("2026-10-25T12:00:00"), {uploads: [{kind: "added", path: "c.md"}]}),
      ]));
      const days = all(sectionOf(modal)!).filter(node => node.classes.has("s3-vault-sync-records-day"));
      expect(days.map(day => day.children[0]!.text)).toEqual(["今天 · 10月25日 周日", "昨天 · 10月24日 周六", "10月21日 周三"]);
      // 两次同步隔着本机的午夜，分在两天（按 UTC 它们都在 10 月 24 日）
      expect(days.map(day => all(day).filter(node => node.classes.has("s3-vault-sync-record")).map(row => lineTexts(row)[0])))
        .toEqual([["12:00:00", "00:00:03"], ["23:59:58"], ["15:03:47"]]);
    });

    it("writes the time, trigger, what changed and the result on each row", () => {
      const modal = open(controllerWith([
        sync("one", at("2026-10-25T16:55:36"), {uploads: [{kind: "modified", path: "1-Projects/日志.md"}]}),
        sync("two", at("2026-10-25T16:54:10"), {uploads: [{kind: "modified", path: "1-Projects/日志.md"}, {kind: "added", path: "附件/图.png"}],
          downloads: [{kind: "updated", path: "待办.md"}]}),
        sync("three", at("2026-10-25T07:42:05"), {triggers: ["startup"], downloads: [{kind: "moved", fromPath: "旧/甲.md", path: "新/甲.md"}]}),
      ]));
      expect(rowsOf(modal).map(lineTexts)).toEqual([
        ["16:55:36", "编辑后同步", "上传 1 个：修改 日志.md", "完成", "›"],
        ["16:54:10", "编辑后同步", "上传 2 个 · 下载 1 个：日志.md 等", "完成", "›"],
        ["07:42:05", "启动时同步", "下载 1 个：挪动 甲.md", "完成", "›"],
      ]);
    });

    const bodyOf = (row: FakeElement): FakeElement => row.children.find(child => child.classes.has("s3-vault-sync-record-body"))!;
    const groupsOf = (row: FakeElement): Array<{title: string; files: string[][]; note?: string}> =>
      all(bodyOf(row)).filter(node => node.classes.has("s3-vault-sync-record-group")).map(group => ({
        title: group.children[0]!.text,
        files: all(group).filter(node => node.tag === "li").map(item => item.children.map(part => part.text)),
        ...(group.children.find(child => child.tag === "p") ? {note: group.children.find(child => child.tag === "p")!.text} : {}),
      }));

    it("opens a row on click to list every uploaded and downloaded file with its kind, and closes it on the next click", () => {
      const modal = open(controllerWith([sync("mixed", at("2026-10-25T16:55:36"), {
        uploads: [{kind: "modified", path: "1-Projects/日志.md"}, {kind: "added", path: "附件/图.png"},
          {kind: "moved", fromPath: "图纸/旧.pdf", path: "图纸/过程文档/旧.pdf"}, {kind: "deleted", path: "WX/旧.md"}],
        downloads: [{kind: "updated", path: "2-Areas/待办.md"}, {kind: "added", path: "录音/周会.md"},
          {kind: "deleted", path: "录音/草稿.md"}, {kind: "moved", fromPath: "甲/乙.md", path: "丙/乙.md"}],
        phaseDurations: {remote: 310, scanning: 180, uploading: 640, publishing: 290, saving: 190},
      })]));
      const [row] = rowsOf(modal);
      expect(groupsOf(row!)).toEqual([]);
      expect(row!.classes.has("is-open")).toBe(false);
      click(lineOf(row!));
      expect(row!.classes.has("is-open")).toBe(true);
      expect(groupsOf(row!)).toEqual([
        {title: "上传到 S3（4 个）", files: [["修改", "1-Projects/日志.md"], ["新增", "附件/图.png"],
          ["挪动", "图纸/旧.pdf → 图纸/过程文档/旧.pdf"], ["删除", "WX/旧.md"]]},
        {title: "从 S3 下载（4 个）", files: [["更新", "2-Areas/待办.md"], ["新增", "录音/周会.md"],
          ["删除", "录音/草稿.md"], ["挪动", "甲/乙.md → 丙/乙.md"]]},
      ]);
      const body = textsIn(bodyOf(row!));
      expect(body).toContain("开始 16:55:36 · 用时 1.7 秒 · 98 次请求 · 发送 14.2 KB / 接收 51.8 KB");
      expect(body).toContain("各阶段：读取远端 310 毫秒、扫描本地 180 毫秒、上传 640 毫秒、发布 290 毫秒、保存记录 190 毫秒");
      // 每种类型的标签各带自己的样式类，颜色在样式表里按类型给
      const tags = all(bodyOf(row!)).filter(node => node.classes.has("s3-vault-sync-record-file-kind"));
      expect(tags.map(tag => [...tag.classes].find(name => name.startsWith("mod-")))).toEqual(
        ["mod-modified", "mod-added", "mod-moved", "mod-deleted", "mod-updated", "mod-added", "mod-deleted", "mod-moved"]);
      click(lineOf(row!));
      expect(row!.classes.has("is-open")).toBe(false);
      expect(groupsOf(row!)).toEqual([]);
    });

    it("lists the one changed file with its full path, and writes short times in milliseconds and large sizes in MB", () => {
      const modal = open(controllerWith([sync("one", at("2026-10-25T16:54:40"), {finishedAt: at("2026-10-25T16:54:40") + 777,
        sentBytes: 1_887_437, receivedBytes: 0, uploads: [{kind: "modified", path: "1-Projects/Raycloud/日志.md"}]})]));
      const [row] = rowsOf(modal);
      expect(lineTexts(row!)[2]).toBe("上传 1 个：修改 日志.md");
      click(lineOf(row!));
      expect(groupsOf(row!)).toEqual([{title: "上传到 S3（1 个）", files: [["修改", "1-Projects/Raycloud/日志.md"]]}]);
      expect(textsIn(bodyOf(row!))).toContain("开始 16:54:40 · 用时 777 毫秒 · 98 次请求 · 发送 1.8 MB / 接收 0 KB");
    });

    it("opens and closes a row with Enter and Space once it has keyboard focus", () => {
      const modal = open(controllerWith([sync("one", at("2026-10-25T16:55:36"), {uploads: [{kind: "added", path: "a.md"}]})]));
      const [row] = rowsOf(modal);
      const line = lineOf(row!);
      expect(line.attrs.get("role")).toBe("button");
      expect(line.attrs.get("tabindex")).toBe("0");
      expect(line.attrs.get("aria-expanded")).toBe("false");
      press(line, "Enter");
      expect(row!.classes.has("is-open")).toBe(true);
      expect(line.attrs.get("aria-expanded")).toBe("true");
      press(line, " ");
      expect(row!.classes.has("is-open")).toBe(false);
      press(line, "a");
      expect(row!.classes.has("is-open")).toBe(false);
    });

    it("keeps the section and the opened rows open after the status refresh redraws the window", () => {
      const listeners = new Set<(status: {text: string}) => void>();
      const controller = {...controllerWith([
        sync("first", at("2026-10-25T16:55:36"), {uploads: [{kind: "added", path: "a.md"}]}),
        sync("second", at("2026-10-25T16:50:00"), {uploads: [{kind: "added", path: "b.md"}]}),
      ]), onStatusChange: (listener: (status: {text: string}) => void) => {listeners.add(listener); return () => listeners.delete(listener);}};
      const modal = open(controller);
      const section = sectionOf(modal)!;
      section.open = true;
      section.events.get("toggle")!();
      click(lineOf(rowsOf(modal)[1]!));
      for (const listener of listeners) listener({text: "空闲：同步完成"});
      expect(sectionOf(modal)).not.toBe(section);
      expect(sectionOf(modal)!.open).toBe(true);
      expect(rowsOf(modal).map(row => row.classes.has("is-open"))).toEqual([false, true]);
      expect(groupsOf(rowsOf(modal)[1]!)).toEqual([{title: "上传到 S3（1 个）", files: [["新增", "b.md"]]}]);
      click(lineOf(rowsOf(modal)[1]!));
      modal.onOpen();
      expect(rowsOf(modal).map(row => row.classes.has("is-open"))).toEqual([false, false]);
    });

    it("counts the files past the 200 kept names and says how many are not listed", () => {
      const uploads = Array.from({length: 200}, (_, index) => ({kind: "added" as const, path: `剪藏/第${String(index + 1).padStart(3, "0")}篇.md`}));
      const modal = open(controllerWith([sync("many", at("2026-10-25T10:00:00"), {uploads, moreFiles: 1})]));
      const [row] = rowsOf(modal);
      expect(lineTexts(row!)[2]).toBe("上传 201 个：第001篇.md 等");
      click(lineOf(row!));
      const [group] = groupsOf(row!);
      expect(group!.title).toBe("上传到 S3（201 个）");
      expect(group!.files).toHaveLength(200);
      expect(group!.note).toBe("只记录了前 200 个文件名，另有 1 个没有列出。");
      expect(all(bodyOf(row!)).find(node => node.tag === "ul")!.classes.has("s3-vault-sync-record-files")).toBe(true);
    });

    it("puts the unlisted files under downloads when some downloads were named", () => {
      const uploads = Array.from({length: 150}, (_, index) => ({kind: "modified" as const, path: `上/${index}.md`}));
      const downloads = Array.from({length: 50}, (_, index) => ({kind: "added" as const, path: `下/${index}.md`}));
      const modal = open(controllerWith([sync("both", at("2026-10-25T10:00:00"), {uploads, downloads, moreFiles: 30})]));
      const [row] = rowsOf(modal);
      expect(lineTexts(row!)[2]).toBe("上传 150 个 · 下载 80 个：0.md 等");
      click(lineOf(row!));
      expect(groupsOf(row!).map(group => [group.title, group.files.length, group.note])).toEqual([
        ["上传到 S3（150 个）", 150, undefined], ["从 S3 下载（80 个）", 50, "只记录了前 200 个文件名，另有 30 个没有列出。"]]);
    });

    it("labels retries, errors, interrupted runs and manual operations, each with its own result style and explanation", () => {
      const modal = open(controllerWith([
        sync("editing", at("2026-10-25T16:53:50"), {outcome: "retrying", errorCategory: "local-change"}),
        sync("offline", at("2026-10-25T16:40:00"), {outcome: "retrying", errorCategory: "network", triggers: ["periodic"]}),
        sync("broken", at("2026-10-25T16:30:00"), {outcome: "error", errorCategory: "service"}),
        sync("review", at("2026-10-25T16:20:00"), {outcome: "action-required", uploads: [{kind: "added", path: "甲.md"}]}),
        sync("stopped", at("2026-10-25T16:10:00"), {outcome: "interrupted", triggers: ["shutdown"]}),
        manual("restore", at("2026-10-25T09:05:12"), "恢复已删除的文件：旧报价.xlsx", [{kind: "restored", path: "4-Archives/旧报价.xlsx"}]),
        sync("pulled", at("2026-10-25T07:42:05"), {triggers: ["startup"], downloads: [{kind: "updated", path: "待办.md"}]}),
      ]));
      const rows = rowsOf(modal);
      expect(rows.map(row => lineTexts(row).slice(1, 4))).toEqual([
        ["编辑后同步", "文件还在被修改，稍后重试", "稍后重试"],
        ["定时检查", "网络出错，稍后重试", "稍后重试"],
        ["编辑后同步", "S3 服务出错", "出错"],
        ["编辑后同步", "上传 1 个：新增 甲.md", "需要处理"],
        ["关闭前同步", "没有改动文件", "被中断"],
        ["手动操作", "恢复已删除的文件：旧报价.xlsx", "手动操作"],
        ["启动时同步", "下载 1 个：更新 待办.md", "完成"],
      ]);
      const styles = rows.map(row => [...lineOf(row).children[3]!.classes].find(name => name.startsWith("mod-")));
      expect(styles).toEqual(["mod-retrying", "mod-retrying", "mod-error", "mod-action-required", "mod-interrupted", "mod-manual", "mod-complete"]);
      const explain = (row: FakeElement): string | undefined => {
        click(lineOf(row));
        return all(bodyOf(row)).find(node => node.classes.has("s3-vault-sync-record-explain"))?.text;
      };
      expect(explain(rows[0]!)).toBe("同步时文件还在被修改，插件先停下，等编辑停下几秒后重新同步。这不算出错，没有丢任何改动。");
      expect(explain(rows[1]!)).toBe("网络出错，连不上 S3。稍后会自动重试。");
      expect(explain(rows[2]!)).toBe("S3 服务出错。");
      expect(explain(rows[6]!)).toBe("下载的文件是别的设备改的。本机只知道从 S3 下载了，看不出是哪台设备改的。");
      explain(rows[5]!);
      expect(groupsOf(rows[5]!)).toEqual([{title: "涉及的文件（1 个）", files: [["恢复", "4-Archives/旧报价.xlsx"]]}]);
      expect(textsIn(bodyOf(rows[5]!)).some(text => text.startsWith("开始"))).toBe(false);
    });

    const dayOf = (modal: StatusModal, title: string): FakeElement => all(sectionOf(modal)!).find(node =>
      node.classes.has("s3-vault-sync-records-day") && node.children[0]!.text === title)!;
    const quietOf = (day: FakeElement): FakeElement | undefined => day.children.at(-1)!.classes.has("s3-vault-sync-records-quiet") ? day.children.at(-1) : undefined;

    it("ends each day with the number of checks that changed nothing, taken from the diagnostics of that day", () => {
      const modal = open(controllerWith([
        sync("one", at("2026-10-25T16:55:36"), {uploads: [{kind: "added", path: "a.md"}]}),
        sync("yday", at("2026-10-24T12:00:00"), {uploads: [{kind: "added", path: "b.md"}]}),
        sync("edge", at("2026-10-18T09:00:00"), {uploads: [{kind: "added", path: "c.md"}]}),
      ], [
        run("q1", at("2026-10-25T00:00:01")), run("q2", at("2026-10-25T08:00:00")), run("q3", at("2026-10-25T16:00:00")),
        run("q4", at("2026-10-25T09:00:00"), {triggers: ["foreground"]}),
        run("one", at("2026-10-25T16:55:36"), {triggers: ["edit"], counts: {uploaded: 1, downloaded: 0, deleted: 0, deferred: 0, unsynced: 0}}),
        run("legacy", at("2026-10-25T10:00:00"), {counts: {uploaded: 0, downloaded: 0, deleted: 1, deferred: 0, unsynced: 0}}),
        run("failed", at("2026-10-25T11:00:00"), {outcome: "error", errorCategory: "network"}),
        run("y1", at("2026-10-24T23:59:59")),
        run("e1", at("2026-10-18T20:00:00")),
      ]));
      const today = quietOf(dayOf(modal, "今天 · 10月25日 周日"))!;
      const line = today.children.find(child => child.classes.has("s3-vault-sync-records-quiet-line"))!;
      expect(textsIn(line)[0]).toBe("另有 4 次检查，没有改动任何文件");
      const body = (): string[] => textsIn(today.children.find(child => child.classes.has("s3-vault-sync-records-quiet-body"))!);
      expect(body()).toEqual([]);
      click(line);
      expect(body()).toEqual(["定时检查 3 次 · 回到前台 1 次。每次都成功完成。"]);
      press(line, "Enter");
      expect(body()).toEqual([]);
      expect(line.attrs.get("role")).toBe("button");
      expect(textsIn(quietOf(dayOf(modal, "昨天 · 10月24日 周六"))!)[0]).toBe("另有 1 次检查，没有改动任何文件");
      // 10 月 18 日下午 4 点 20 分以后的诊断还在，这一天照样数
      expect(textsIn(quietOf(dayOf(modal, "10月18日 周日"))!)[0]).toBe("另有 1 次检查，没有改动任何文件");
    });

    it("says that quiet checks of the days past the 7-day diagnostics are no longer kept", () => {
      const modal = open(controllerWith([
        sync("old", at("2026-10-17T22:36:08"), {uploads: [{kind: "added", path: "a.md"}]}),
        sync("older", at("2026-10-12T20:18:44"), {uploads: [{kind: "added", path: "b.md"}]}),
      ], [run("r", at("2026-10-25T08:00:00"))]));
      for (const title of ["10月17日 周六", "10月12日 周一"]) {
        expect(dayOf(modal, title).children.at(-1)!.text).toBe("超过 7 天，没有改动的检查已经不保留。");
      }
    });

    it("keeps an opened quiet-check line open after the status refresh redraws the window", () => {
      const listeners = new Set<(status: {text: string}) => void>();
      const controller = {...controllerWith([sync("one", at("2026-10-25T16:55:36"), {uploads: [{kind: "added", path: "a.md"}]})],
        [run("q", at("2026-10-25T08:00:00"))]),
      onStatusChange: (listener: (status: {text: string}) => void) => {listeners.add(listener); return () => listeners.delete(listener);}};
      const modal = open(controller);
      click(quietOf(dayOf(modal, "今天 · 10月25日 周日"))!.children[0]!);
      for (const listener of listeners) listener({text: "空闲：同步完成"});
      const quiet = quietOf(dayOf(modal, "今天 · 10月25日 周日"))!;
      expect(quiet.classes.has("is-open")).toBe(true);
      expect(textsIn(quiet)).toContain("定时检查 1 次。每次都成功完成。");
    });

    it("says so when there is no record yet, and shows the warning when the record file could not be read", () => {
      const empty = open(controllerWith([]));
      expect(textsIn(sectionOf(empty)!)).toEqual(expect.arrayContaining(["本设备 · 0 次有改动或需要注意", "最近 30 天还没有改动过文件的同步。"]));
      const broken = open(controllerWith([], [], "无法读取本地同步记录。同步数据没有受影响。"));
      const warning = all(sectionOf(broken)!).find(node => node.text === "无法读取本地同步记录。同步数据没有受影响。")!;
      expect(warning.classes.has("s3-vault-sync-error")).toBe(true);
    });

    it("does not draw the sync records on a phone or tablet, where there is no sync activity", () => {
      const without = open({...issueController([]), getDeletedRecoveries: () => []});
      expect(sectionOf(without)).toBeUndefined();
      const mobile = open({...issueController([]), getSyncActivity: () => undefined});
      expect(sectionOf(mobile)).toBeUndefined();
      expect(nodesOf(mobile).some(node => node.text.includes("同步记录"))).toBe(false);
    });
  });
});

describe("cleanup from the status window", () => {
  const originalTimeZone = process.env.TZ;
  beforeAll(() => {process.env.TZ = "Asia/Shanghai";});
  afterAll(() => {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
  });
  type FakeElement = InstanceType<typeof Element>;
  const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
  const nodesOf = (modal: {contentEl: unknown}) => all(modal.contentEl as FakeElement);
  const textsOf = (modal: {contentEl: unknown}) => nodesOf(modal).map(node => node.text);
  const button = (modal: {contentEl: unknown}, text: string) => {
    const found = nodesOf(modal).find(node => node.tag === "button" && node.text === text);
    if (!found) throw new Error(`Missing button ${text}`);
    return found;
  };
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;
  const SERVER = "2026-10-19T00:00:00.000Z";

  const recovery = (index: number, extra: Partial<CleanupCandidate> = {}): CleanupCandidate => ({
    blobId: `blob-r${index}`, deletedAt: "2026-09-05T02:20:00.000Z", entryId: `r${index}`, expiresAt: "2026-10-05T02:20:00.000Z",
    key: `recovery:r${index}:rev`, kind: "recovery", path: `notes/deleted-${index}.md`, revisionId: "rev", size: 2048, ...extra,
  } as CleanupCandidate);
  const history: CleanupCandidate = {
    blobId: "blob-h", entryId: "h", expiresAt: "2026-10-03T10:02:00.000Z", key: "history:h:rev", kind: "history",
    path: "notes/log.md", revisionId: "rev", size: 22528,
  };
  const orphan: CleanupCandidate = {blobId: "a91c0e2f-1111-4222-8333-444455556666", key: "orphan:a91c0e2f-1111-4222-8333-444455556666",
    kind: "orphan", size: 65536, uploadedAt: "2026-09-05T06:02:00.000Z"};

  const cleanupWith = (view: CleanupView, overrides: Partial<CleanupController> = {}) => {
    let current = view;
    const load = vi.fn(async () => current);
    const undo = vi.fn(async (_key: string) => {});
    const move = async (keys: string[], _allDevicesUpdated: boolean): Promise<void> => {
        const moved = current.candidates.filter(candidate => keys.includes(candidate.key));
        current = {...current, candidates: current.candidates.filter(candidate => !keys.includes(candidate.key)),
          pending: [...current.pending, ...moved.map(candidate => ({blobId: candidate.blobId, confirmedAt: new Date().toISOString(),
            key: candidate.key, kind: candidate.kind, size: candidate.size, ...(candidate.kind === "orphan" ? {} : {path: candidate.path})}))]};
    };
    const controller: CleanupController = {
      getCleanupCount: () => current.candidates.length,
      loadCleanup: load,
      getCleanupView: () => current,
      needsCleanupDeviceConfirmation: () => true,
      confirmCleanup: move,
      undoCleanup: undo,
      ...overrides,
    };
    return Object.assign(controller, {load, move, undo});
  };
  const statusController = (cleanup: CleanupController | undefined): StatusModalController => ({
    ...reviewActions,
    getStatusText: () => "空闲：", isPaused: () => false,
    getConflicts: () => [], getDeferredDownloads: () => [], getDeletedRecoveries: () => [],
    getLocalIssues: () => [], getPendingBulkDeletion: () => undefined,
    confirmBulkDeletion: async () => {}, downloadDeferred: async () => {}, importCandidate: async () => {},
    resolvePossibleRename: async () => {}, keepConflictDeleted: async () => {},
    resolveConflict: async () => {}, restoreDeleted: async () => {},
    readDeletedRecovery: async () => new Uint8Array(), syncNow: async () => {}, togglePause: async () => {},
    onStatusChange: () => () => {}, exportDiagnostics: () => "{}",
    cleanupController: () => cleanup,
  });
  const openCleanup = async (cleanup: CleanupController) => {
    const status = new StatusModal({} as App, statusController(cleanup));
    status.onOpen();
    button(status, cleanup.getCleanupCount() ? `待清理（${cleanup.getCleanupCount()}）` : "待清理").events.get("click")!();
    const page = opened.at(-1)!;
    await vi.waitFor(() => expect(textsOf(page)).toContain("待清理的内容"));
    await vi.waitFor(() => expect(nodesOf(page).some(node => node.text.startsWith("已选"))).toBe(true));
    return page;
  };
  const checkbox = (page: {contentEl: unknown}, label: string) => {
    // 勾选框和它的文字在同一个 label 里
    const owner = nodesOf(page).find(node => node.tag === "label" && all(node).some(child => child.text === label));
    const box = owner && all(owner).find(child => child.tag === "input" && child.type === "checkbox");
    if (!box) throw new Error(`Missing checkbox for ${label}`);
    return box;
  };
  const toggle = (box: FakeElement, checked: boolean) => { box.checked = checked; box.events.get("change")!(); };

  it("puts 待清理 last after 复制诊断数据 on the desktop, highlighted with the count, and does not read S3 to show it", () => {
    const cleanup = cleanupWith({candidates: [recovery(1), history, orphan], pending: [], serverDate: SERVER});
    const status = new StatusModal({} as App, statusController(cleanup));
    status.onOpen();
    const toolbar = nodesOf(status).find(node => node.children.some(child => child.text === "复制诊断数据"))!;
    const labels = toolbar.children.filter(node => node.tag === "button").map(node => node.text);
    expect(labels.at(-1)).toBe("待清理（3）");
    expect(labels.indexOf("待清理（3）")).toBe(labels.indexOf("复制诊断数据") + 1);
    expect(button(status, "待清理（3）").classes.has("s3-vault-sync-cleanup-pending")).toBe(true);
    expect(cleanup.load).not.toHaveBeenCalled();
  });

  it("leaves a closed list alone when its reading finishes after it was closed", async () => {
    let finish!: (view: CleanupView) => void;
    let fail!: (error: Error) => void;
    const cleanup = cleanupWith({candidates: [recovery(1)], pending: [], serverDate: SERVER}, {
      loadCleanup: () => new Promise<CleanupView>((resolve, reject) => { finish = resolve; fail = reject; }),
    });
    const status = new StatusModal({} as App, statusController(cleanup));
    status.onOpen();
    button(status, "待清理（1）").events.get("click")!();
    const page = opened.at(-1)! as unknown as {contentEl: unknown; onClose(): void; onOpen(): void};
    expect(textsOf(page)).toContain("正在读取远端记录…");
    page.onClose();
    // 让读取的 then/catch 回调都跑完
    const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
    finish({candidates: [recovery(1)], pending: [], serverDate: SERVER});
    await flush();
    expect(textsOf(page).filter(Boolean)).toEqual([]);

    // 读取失败的结果也一样不写进已关闭的窗口
    page.onOpen();
    page.onClose();
    fail(new Error("网络出错"));
    await flush();
    expect(textsOf(page).filter(Boolean)).toEqual([]);
  });

  it("shows a plain 待清理 when nothing can be cleaned, and no button at all on a phone", () => {
    const empty = new StatusModal({} as App, statusController(cleanupWith({candidates: [], pending: [], serverDate: SERVER})));
    empty.onOpen();
    expect(button(empty, "待清理").classes.has("s3-vault-sync-cleanup-pending")).toBe(false);
    const phone = new StatusModal({} as App, statusController(undefined));
    phone.onOpen();
    expect(textsOf(phone).some(text => text.startsWith("待清理"))).toBe(false);
  });

  it("lists the three groups with their details, the shared-content note and the explanation", async () => {
    const page = await openCleanup(cleanupWith({serverDate: SERVER, pending: [], candidates: [
      recovery(1, {sharedWith: {path: "报价-最终.xlsx"}}),
      recovery(2, {sharedWith: {}}), history, orphan,
    ]}));
    const texts = textsOf(page);
    expect(texts.some(text => text.includes("这些已经过了 30 天恢复期，不能再恢复") && text.includes("你在用的文件不会出现在这里"))).toBe(true);
    expect(texts.some(text => text.startsWith("一个文件的经过："))).toBe(true);
    expect(texts).toContain("删掉的文件留下的备份（已过 30 天，不能恢复了）");
    expect(texts).toContain("文件改动前的旧版本（已过 30 天）");
    expect(texts).toContain("找不到对应文件的数据（同步中断时留下的）");
    expect(texts).toContain("多数是同步中断时留下的，也包括记录已经清理过、S3 上还没删的内容。");
    expect(texts).toContain("2 项 · 4 KB");
    // 删除时间按本地时间（UTC+8），恢复期已过的天数按这次读到的 AWS 时间
    expect(texts).toContain("notes/deleted-1.md");
    expect(texts).toContain("删除于 2026-09-05 10:20 · 恢复期已过 13 天");
    expect(texts).toContain("notes/log.md 的旧版本");
    expect(texts).toContain("2026-09-03 18:02 被新版本替换 · 恢复期已过 15 天");
    expect(texts).toContain("找不到对应文件的数据（编号 a91c0e2f）");
    expect(texts).toContain("上传于 2026-09-05 14:02");
    expect(texts).toContain("64 KB");
    expect(texts).toContain("内容和现有文件「报价-最终.xlsx」相同：S3 上的数据会保留");
    expect(texts).toContain("内容还被别的记录用着：S3 上的数据会保留");
  });

  it("tracks single, group, all and partial selections and only enables 删除所选 with something selected", async () => {
    const page = await openCleanup(cleanupWith({serverDate: SERVER, pending: [], candidates: [recovery(1), recovery(2), history, orphan]}));
    expect(button(page, "删除所选（0）").disabled).toBe(true);
    toggle(checkbox(page, "notes/deleted-1.md"), true);
    expect(textsOf(page)).toContain("已选 1 项 · 2 KB");
    expect(button(page, "删除所选（1）").disabled).toBe(false);
    const group = checkbox(page, "删掉的文件留下的备份（已过 30 天，不能恢复了）");
    expect(group.indeterminate).toBe(true);
    expect(group.checked).toBe(false);
    toggle(group, true);
    expect(checkbox(page, "删掉的文件留下的备份（已过 30 天，不能恢复了）")).toMatchObject({checked: true, indeterminate: false});
    expect(checkbox(page, "全选")).toMatchObject({checked: false, indeterminate: true});
    toggle(checkbox(page, "全选"), true);
    expect(textsOf(page)).toContain("已选 4 项 · 90 KB");
    expect(checkbox(page, "全选")).toMatchObject({checked: true, indeterminate: false});
    toggle(checkbox(page, "全选"), false);
    expect(button(page, "删除所选（0）").disabled).toBe(true);
  });

  it("collapses a group of more than 50 items until it is opened", async () => {
    const many = Array.from({length: 51}, (_, index) => recovery(index));
    const page = await openCleanup(cleanupWith({serverDate: SERVER, pending: [], candidates: [...many, history]}));
    expect(textsOf(page)).toContain("51 项 · 102 KB");
    expect(textsOf(page)).not.toContain("notes/deleted-0.md");
    expect(textsOf(page)).toContain("notes/log.md 的旧版本");
    button(page, "展开").events.get("click")!();
    expect(textsOf(page)).toContain("notes/deleted-0.md");
  });

  it("asks once for the 0.1.10 confirmation, then moves the selection to the waiting list with an undo", async () => {
    let confirmed = false;
    const cleanup = cleanupWith({serverDate: SERVER, pending: [], candidates: [recovery(1), orphan]},
      {needsCleanupDeviceConfirmation: () => !confirmed});
    const {move} = cleanup;
    const confirm = vi.fn(async (keys: string[], allDevicesUpdated: boolean) => {
      confirmed ||= allDevicesUpdated;
      await move(keys, allDevicesUpdated);
    });
    cleanup.confirmCleanup = confirm;
    const page = await openCleanup(cleanup);
    toggle(checkbox(page, "notes/deleted-1.md"), true);
    button(page, "删除所选（1）").events.get("click")!();
    const dialog = await vi.waitFor(() => {
      const last = opened.at(-1)!;
      expect(last).not.toBe(page);
      return last;
    });
    expect(textsOf(dialog).some(text => text.includes("没升级的设备在记录被清理后可能卡在修复模式"))).toBe(true);
    const go = button(dialog, "继续删除");
    expect(go.disabled).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    toggle(checkbox(dialog, "所有设备都已更新到 0.1.10 或更高"), true);
    expect(button(dialog, "继续删除").disabled).toBe(false);
    button(dialog, "继续删除").events.get("click")!();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith([recovery(1).key], true));
    // 选中的项目马上离开分组，出现在「已删除，等着从 S3 清掉」里，可以撤销
    await vi.waitFor(() => expect(textsOf(page)).toContain("已删除，等着从 S3 清掉"));
    expect(textsOf(page)).toContain("还剩 24 小时可撤销");
    expect(textsOf(page)).not.toContain("删掉的文件留下的备份（已过 30 天，不能恢复了）");
    // 同一目标之后不再弹
    toggle(checkbox(page, "找不到对应文件的数据（编号 a91c0e2f）"), true);
    const dialogs = opened.length;
    button(page, "删除所选（1）").events.get("click")!();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith([orphan.key], false));
    expect(opened.length).toBe(dialogs);
  });

  it("shows waiting items with the hours left to undo, and no undo once the 24 hours have passed", async () => {
    vi.useFakeTimers({toFake: ["Date"]});
    try {
      vi.setSystemTime(Date.parse(SERVER) + 3 * HOUR);
      const cleanup = cleanupWith({serverDate: SERVER, candidates: [], pending: [
        {blobId: "blob-r1", confirmedAt: SERVER, key: "recovery:r1:rev", kind: "recovery", path: "notes/deleted-1.md", size: 2048},
        {blobId: "blob-h", confirmedAt: new Date(Date.parse(SERVER) - DAY).toISOString(), key: "history:h:rev", kind: "history",
          path: "notes/log.md", recordRemovedAt: SERVER, size: 10},
      ]});
      const page = await openCleanup(cleanup);
      const texts = textsOf(page);
      expect(texts).toContain("已删除，等着从 S3 清掉");
      expect(texts).toContain("还剩 21 小时可撤销");
      expect(texts).toContain("撤销期已过，正在从 S3 清掉");
      expect(texts).toContain("现在没有符合删除标准的内容。文件删除满 30 天后会自动出现在这里，等你确认。");
      expect(nodesOf(page).filter(node => node.tag === "button" && node.text === "撤销")).toHaveLength(1);
      button(page, "撤销").events.get("click")!();
      await vi.waitFor(() => expect(cleanup.undo).toHaveBeenCalledWith("recovery:r1:rev"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes the count in the status window when the list closes, but not after the status window itself was closed", async () => {
    const cleanup = cleanupWith({serverDate: SERVER, pending: [], candidates: [recovery(1), orphan]});
    const subscribe = vi.fn(() => () => {});
    const status = new StatusModal({} as App, {...statusController(cleanup), onStatusChange: subscribe});
    status.onOpen();
    button(status, "待清理（2）").events.get("click")!();
    const page = opened.at(-1)! as unknown as {onClose(): void; contentEl: unknown};
    await vi.waitFor(() => expect(textsOf(page)).toContain("待清理的内容"));
    await cleanup.move([recovery(1).key], true);
    expect(cleanup.getCleanupCount()).toBe(1);
    page.onClose();
    expect(textsOf(status)).toContain("待清理（1）");
    const subscriptions = subscribe.mock.calls.length;
    status.onClose();
    page.onClose();
    expect(subscribe.mock.calls.length).toBe(subscriptions);
  });

  it("says above the list why cleaning waits", async () => {
    const page = await openCleanup(cleanupWith({blockedReason: "有冲突还没处理，清理会等你处理完再继续。", serverDate: SERVER,
      pending: [], candidates: [recovery(1)]}));
    expect(textsOf(page)).toContain("有冲突还没处理，清理会等你处理完再继续。");
    // 仍然可以勾选和确认
    toggle(checkbox(page, "notes/deleted-1.md"), true);
    expect(button(page, "删除所选（1）").disabled).toBe(false);
  });
});
