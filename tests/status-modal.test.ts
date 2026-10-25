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
    setAttr() {}
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
