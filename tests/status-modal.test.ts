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
  }
  return { Element, opened: [] as Array<{contentEl: Element}> };
});

vi.mock("obsidian", () => ({
  App: class {}, Notice: class {},
  Modal: class {
    contentEl = new Element("root");
    constructor(public app: unknown) {}
    onOpen() {}
    open() { opened.push(this); this.onOpen(); }
    close() {}
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

describe("StatusModal", () => {
  it("updates visible status and pause controls without reopening, then unsubscribes", () => {
    let text = "Error: old failure";
    let paused = false;
    const listeners = new Set<(status: { text: string }) => void>();
    const controller: StatusModalController = {
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
    expect(root.children.flatMap(e => e.children).some(e => e.text === "Resume")).toBe(true);
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
