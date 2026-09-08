import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";

const { Element } = vi.hoisted(() => {
  class Element {
    children: Element[] = [];
    text = "";
    constructor(readonly tag: string) {}
    empty() { this.children = []; }
    addClass() {}
    addEventListener() {}
    setText(text: string) { this.text = text; }
    createEl(tag: string, options: { text?: string } = {}) {
      const element = new Element(tag);
      element.text = options.text ?? "";
      this.children.push(element);
      return element;
    }
    createDiv() { return this.createEl("div"); }
  }
  return { Element };
});

vi.mock("obsidian", () => ({
  App: class {}, Notice: class {},
  Modal: class { contentEl = new Element("root"); },
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
});
