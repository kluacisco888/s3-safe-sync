import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";

const { Element, opened } = vi.hoisted(() => {
  class Element {
    children: Element[] = [];
    text = "";
    open = false;
    disabled = false;
    value = "";
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

import { StatusModal, VersionHistoryModal, type StatusModalController } from "../src/plugin/modals";
import type { LocalSyncIssue } from "../src/sync/sync-service";

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
      all(modal.contentEl as unknown as FakeElement).find(node => node.text === "Copy diagnostics")!.events.get("click")!();
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
        phaseDurations: {downloading: 1000}, observedRemote: "remote-version", remoteCheckedAt: 1_700_000_001_000,
        requests: 3, sentBytes: 0, receivedBytes: 42, pendingDownloads: 4, pendingUploads: 1,
        errorCategory: "service" as const, httpStatus: 503}],
    })};
    const modal = new StatusModal({} as App, controller);
    modal.onOpen();
    type FakeElement = InstanceType<typeof Element>;
    const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
    const texts = all(modal.contentEl as unknown as FakeElement).map(node => node.text);
    expect(texts).toContain("Local accepted Commit: accepted-version");
    expect(texts.some(text => text.includes("Last checked S3 Head: remote-version"))).toBe(true);
    expect(texts.some(text => text.includes("Pending uploads: 1") && text.includes("Pending downloads: 4"))).toBe(true);
    expect(texts.some(text => text.includes("service") && text.includes("503"))).toBe(true);
    expect(texts).toContain("Copy diagnostics");
  });

  it("offers a real review action for a collision that lists only one path", () => {
    const modal = new StatusModal({} as App, issueController([{kind: "path-collision", paths: ["weekly.md"]}]));
    modal.onOpen();
    type FakeElement = InstanceType<typeof Element>;
    const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
    expect(all(modal.contentEl as unknown as FakeElement).some(node =>
      node.tag === "button" && node.text === "Review path collision")).toBe(true);
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
    all(modal.contentEl as unknown as FakeElement).find(node => node.text === "Review path collision")!.events.get("click")!();
    const review = opened.at(-1)!;
    await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text === "Rename S3 record and sync")).toBe(true));
    const nodes = all(review.contentEl);
    expect(nodes.some(node => node.text === "local")).toBe(true);
    expect(nodes.some(node => node.text === "remote")).toBe(true);
    expect(nodes.some(node => node.text === "Previously accepted path: old.md")).toBe(true);
    expect(rename).not.toHaveBeenCalled();
    nodes.filter(node => node.tag === "input")[side === "local" ? 0 : 1]!.value = "chosen.md";
    nodes.find(node => node.text === (side === "local" ? "Rename local file and sync" : "Rename S3 record and sync"))!.events.get("click")!();
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
    all(modal.contentEl as unknown as FakeElement).find(node => node.text === "Review path collision")!.events.get("click")!();
    const review = opened.at(-1)!;
    await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text === "Confirm target is the renamed original")).toBe(true));
    expect(all(review.contentEl).some(node => node.text === "Rename local file and sync")).toBe(false);
    expect(all(review.contentEl).some(node => node.text === "Reload collision review")).toBe(true);
    expect(recover).not.toHaveBeenCalled();
    all(review.contentEl).find(node => node.text === "Confirm target is the renamed original")!.events.get("click")!();
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
    expect(nodes.some(node => node.text.includes("recoverable until 2026-10-18T10:00:00Z"))).toBe(true);
    nodes.find(node => node.text === "Preview")!.events.get("click")!();
    const preview = opened.at(-1)!;
    await vi.waitFor(() => expect(all(preview.contentEl).some(node => node.text === "unsynced draft")).toBe(true));
    expect(read).toHaveBeenCalledWith("entry", "backup");
    expect(restore).not.toHaveBeenCalled();
    nodes.find(node => node.text === "Restore")!.events.get("click")!();
    expect(restore).toHaveBeenCalledWith("entry", "backup");
    await vi.waitFor(() => expect(restore).toHaveResolved());
  });

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
    expect(buttons.filter(button => button.text === "How to resolve")).toHaveLength(0);
    const help = all(modal.contentEl as unknown as FakeElement).filter(node =>
      node.tag === "details" && node.children.some(child => child.text === "Why this needs attention"));
    expect(help).toHaveLength(8);
    expect(help.every(node => !node.open)).toBe(true);
    expect(buttons.filter(button => button.text === "Copy path")).toHaveLength(8);
    expect(buttons.filter(button => button.text === "Compare and resolve")).toHaveLength(3);
  });

  it("shows both previews before dispatching an explicitly confirmed preservation", async () => {
    const controller = issueController([{kind: "bootstrap-mismatch", path: "article.md"}]);
    const preserve = vi.fn(async () => "article (local copy).md");
    controller.resolveLocalContent = preserve;
    const modal = new StatusModal({} as App, controller);
    modal.onOpen();
    type FakeElement = InstanceType<typeof Element>;
    const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
    all(modal.contentEl as unknown as FakeElement).find(node => node.text === "Compare and resolve")!.events.get("click")!();
    const review = opened.at(-1)!;
    await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text === "remote")).toBe(true));
    expect(all(review.contentEl).some(node => node.text === "local")).toBe(true);
    expect(preserve).not.toHaveBeenCalled();
    const nodes = all(review.contentEl);
    expect(nodes.findIndex(node => node.text === "Keep both (local copy)"))
      .toBeLessThan(nodes.findIndex(node => node.tag === "pre"));
    all(review.contentEl).find(node => node.text === "Keep both (local copy)")!.events.get("click")!();
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
    all(modal.contentEl as unknown as FakeElement).find(node => node.text === "Compare and resolve")!.events.get("click")!();
    const review = opened.at(-1)!;
    await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text === "− remote edit")).toBe(true));
    expect(all(review.contentEl).some(node => node.text === "+ local edit")).toBe(true);
    expect(all(review.contentEl).some(node => node.text === "1 remote-only line · 1 local-only line")).toBe(true);
    const fullVersions = all(review.contentEl).filter(node => node.tag === "details");
    expect(fullVersions).toHaveLength(2);
    expect(fullVersions.every(node => !node.open)).toBe(true);
    expect(preserve).not.toHaveBeenCalled();
  });

  it.each([["Use local version", "local"], ["Use S3 version", "remote"], ["Keep both (local copy)", "both"]] as const)(
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
      all(modal.contentEl as unknown as FakeElement).find(node => node.text === "Compare and resolve")!.events.get("click")!();
      const review = opened.at(-1)!;
      await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text === label)).toBe(true));
      const nodes = all(review.contentEl);
      expect(nodes.some(node => node.text.startsWith("Local last modified:"))).toBe(true);
      expect(nodes.some(node => node.text.startsWith("S3 version recorded:"))).toBe(true);
      expect(nodes.some(node => node.text.includes("30 days"))).toBe(true);
      expect(nodes.some(node => node.text === "Decide later")).toBe(true);
      expect(resolve).not.toHaveBeenCalled();
      nodes.find(node => node.text === label)!.events.get("click")!();
      expect(resolve).toHaveBeenCalledWith("article.md", "review", choice);
      expect(nodes.filter(node => ["Use local version", "Use S3 version", "Keep both (local copy)"].includes(node.text))
        .every(node => node.disabled)).toBe(true);
      await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text === "Resolution complete")).toBe(true));
      if (choice !== "both") {
        all(review.contentEl).find(node => node.text === "Open version history")!.events.get("click")!();
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
    all(modal.contentEl as unknown as FakeElement).find(node => node.text === "Compare and resolve")!.events.get("click")!();
    const review = opened.at(-1)! as typeof opened[number] & {closed: boolean};
    await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text === "Use local version")).toBe(true));
    all(review.contentEl).find(node => node.text === "Decide later")!.events.get("click")!();
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
    all(modal.contentEl as unknown as FakeElement).find(node => node.text === "Compare and resolve")!.events.get("click")!();
    const review = opened.at(-1)!;
    await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text.startsWith("Line comparison unavailable:"))).toBe(true));
    expect(all(review.contentEl).some(node => node.text === "Keep both (local copy)")).toBe(!blocked);
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
    all(modal.contentEl as unknown as FakeElement).find(node => node.text === "Compare and resolve")!.events.get("click")!();
    const review = opened.at(-1)!;
    await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text === "Retry review")).toBe(true));
    expect(preserve).not.toHaveBeenCalled();
    all(review.contentEl).find(node => node.text === "Retry review")!.events.get("click")!();
    await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text === "Keep both (local copy)")).toBe(true));
    const confirm = all(review.contentEl).find(node => node.text === "Keep both (local copy)")!;
    confirm.events.get("click")!();
    await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text === "Reload review")).toBe(true));
    expect(confirm.disabled).toBe(true);
    confirm.events.get("click")!();
    expect(preserve).toHaveBeenCalledTimes(1);
    all(review.contentEl).find(node => node.text === "Reload review")!.events.get("click")!();
    await vi.waitFor(() => expect(all(review.contentEl).some(node => node.text === "+ fresh local")).toBe(true));
    expect(preserve).toHaveBeenCalledTimes(1);
    all(review.contentEl).find(node => node.text === "Keep both (local copy)")!.events.get("click")!();
    expect(preserve).toHaveBeenLastCalledWith("article.md", "fresh", "both");
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
        node.tag === "button" && node.text === "Compare and resolve",
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
