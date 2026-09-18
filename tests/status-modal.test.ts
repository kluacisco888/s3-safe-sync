import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";

const { Element, opened } = vi.hoisted(() => {
  class Element {
    children: Element[] = [];
    text = "";
    open = false;
    disabled = false;
    events = new Map<string, () => void>();
    constructor(readonly tag: string) {}
    empty() { this.children = []; }
    addClass() {}
    addEventListener(name: string, handler: () => void) { this.events.set(name, handler); }
    setText(text: string) { this.text = text; }
    createEl(tag: string, options: { text?: string } = {}) {
      const element = new Element(tag);
      element.text = options.text ?? "";
      this.children.push(element);
      return element;
    }
    createDiv(options: {text?: string} = {}) { return this.createEl("div", options); }
    createSpan(options: {text?: string} = {}) { return this.createEl("span", options); }
  }
  return { Element, opened: [] as Array<{contentEl: Element}> };
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
      callback({addOption() { return this; }, setValue() { return this; }, onChange() { return this; }});
      return this;
    }
  },
}));

import { StatusModal, type StatusModalController } from "../src/plugin/modals";
import type { LocalSyncIssue } from "../src/sync/sync-service";

const reviewActions = {
  openSettings: () => {},
  readConflictCandidate: async () => new Uint8Array(),
  openLocalFile: async () => {},
  reviewLocalContent: async (path: string) => ({path, reviewToken: "review", localExists: true,
    localSize: 5, localPreview: "local", remoteKind: "live" as const,
    remoteVersions: [{size: 6, createdAt: "2026-09-18", preview: "remote"}]}),
  preserveLocalCopyAndAcceptRemote: async () => "article (local copy).md",
};

describe("StatusModal", () => {
  it("adds bulk-deletion and repair actions when the already-open status changes", () => {
    const controller = issueController([]);
    let status = "Idle: ready";
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
    status = "Action required: review bulk deletion";
    listener({text: status});
    expect(all(modal.contentEl as unknown as FakeElement).some(node => node.text === "Confirm bulk deletion")).toBe(true);
    status = "Action required: Repair Mode: Head missing";
    listener({text: status});
    expect(all(modal.contentEl as unknown as FakeElement).some(node => node.text === "Recovery guidance")).toBe(true);
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
    all(modal.contentEl as unknown as FakeElement).find(node => node.text === "Try anyway")!.events.get("click")!();
    const confirmation = opened.at(-1)! as typeof opened[number] & {closed: boolean};
    const button = all(confirmation.contentEl).find(node => node.text === "Try anyway")!;
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
    expect(all(modal.contentEl as unknown as FakeElement).some(node => node.text === "Use this version")).toBe(true);
    all(modal.contentEl as unknown as FakeElement).find(node => node.text === "Preview version")!.events.get("click")!();
    const preview = opened.at(-1)!;
    await vi.waitFor(() => expect(all(preview.contentEl).some(node => node.text === "Retry preview")).toBe(true));
    all(preview.contentEl).find(node => node.text === "Retry preview")!.events.get("click")!();
    await vi.waitFor(() => expect(all(preview.contentEl).some(node => node.text === "text")).toBe(true));
  });

  it.each(["Not configured: unlock first", "Error: status 403", "Error: connection closed", "Paused: sync paused"])(
    "offers settings and troubleshooting for %s", status => {
      const controller = issueController([]);
      controller.getStatusText = () => status;
      controller.isPaused = () => status.startsWith("Paused");
      const openSettings = vi.fn();
      controller.openSettings = openSettings;
      const modal = new StatusModal({} as App, controller);
      modal.onOpen();
      type FakeElement = InstanceType<typeof Element>;
      const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
      const nodes = all(modal.contentEl as unknown as FakeElement);
      nodes.find(node => node.text === "Open settings")!.events.get("click")!();
      expect(openSettings).toHaveBeenCalledOnce();
      expect(nodes.some(node => node.text === "Troubleshooting")).toBe(true);
      expect(nodes.some(node => node.text === "Copy status")).toBe(true);
      if (status.startsWith("Paused")) {
        expect(nodes.find(node => node.text === "Sync now")?.disabled).toBe(true);
        expect(nodes.some(node => node.text === "Resume")).toBe(true);
      }
    },
  );
  const issueController = (issues: LocalSyncIssue[]): StatusModalController => ({
    ...reviewActions,
    getStatusText: () => "Action required", isPaused: () => false,
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
    expect(buttons.filter(button => button.text === "How to resolve")).toHaveLength(8);
    expect(buttons.filter(button => button.text === "Copy path")).toHaveLength(8);
    expect(buttons.filter(button => button.text === "Review versions")).toHaveLength(3);
  });

  it("shows both previews before dispatching an explicitly confirmed preservation", async () => {
    const controller = issueController([{kind: "bootstrap-mismatch", path: "article.md"}]);
    const preserve = vi.fn(async () => "article (local copy).md");
    controller.preserveLocalCopyAndAcceptRemote = preserve;
    const modal = new StatusModal({} as App, controller);
    modal.onOpen();
    type FakeElement = InstanceType<typeof Element>;
    const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
    all(modal.contentEl as unknown as FakeElement).find(node => node.text === "Review versions")!.events.get("click")!();
    const review = opened.at(-1)!;
    await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text === "remote")).toBe(true));
    expect(all(review.contentEl).some(node => node.text === "local")).toBe(true);
    expect(preserve).not.toHaveBeenCalled();
    all(review.contentEl).find(node => node.text === "Preserve local copy and accept remote")!.events.get("click")!();
    expect(preserve).toHaveBeenCalledWith("article.md", "review");
    await vi.waitFor(() => expect(preserve).toHaveResolved());
  });
  it.each(["bootstrap-mismatch", "resolution-mismatch", "deferred-local-edit"] as const)(
    "provides a review action for %s instead of a dead-end warning", kind => {
      const controller: StatusModalController = {
        ...reviewActions,
        getStatusText: () => "Action required", isPaused: () => false,
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
        node.tag === "button" && node.text === "Review versions",
      )).toBe(true);
    },
  );
  it("updates visible status and pause controls without reopening, then unsubscribes", () => {
    let text = "Error: old failure";
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
    text = "Idle: all changes synchronized";
    for (const listener of listeners) listener({ text });
    expect(statusNode?.text).toBe(text);
    paused = true;
    text = "Paused: automatic sync is paused";
    for (const listener of listeners) listener({ text });
    expect(statusNode?.text).toBe(text);
    const all = (node: InstanceType<typeof Element>): InstanceType<typeof Element>[] => [node, ...node.children.flatMap(all)];
    expect(all(root).some(e => e.text === "Resume")).toBe(true);
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
      getStatusText: () => "Action required: review files", isPaused: () => false,
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
    all(root).find(node => node.text === "Review and resolve")!.events.get("click")!();
    const review = opened.at(-1)!;
    const confirm = all(review.contentEl).find(node => node.text === "Confirm moves")!;
    expect(confirm.disabled).toBe(false);
    confirm.events.get("click")!();
    expect(resolvePossibleRename).toHaveBeenCalledWith({kind: "moves", reviewToken: "review-1",
      pairs: [{fromPath: "before/a.md", toPath: "after/a.md"}, {fromPath: "before/b.md", toPath: "after/b.md"}]});
    await vi.waitFor(() => expect(resolvePossibleRename).toHaveResolved());
  });
});
