import { describe, expect, it } from "vitest";

import { CollisionRenameJournal, type PendingCollisionRename } from "../src/sync/collision-rename-journal";
import { sha256Content } from "../src/sync/content-hash";
import type { LocalVaultPort } from "../src/sync/sync-service";

const fixture = async () => {
  const files = new Map([["source.md", "original"]]);
  let pending: PendingCollisionRename | undefined;
  const outcomes: boolean[] = [];
  let failFinish = false;
  const local: LocalVaultPort = {
    list: async () => [...files].map(([path, body]) => ({path, modifiedAt: 1, size: body.length})),
    stat: async path => files.has(path) ? {path, modifiedAt: 1, size: files.get(path)!.length} : undefined,
    read: async path => new TextEncoder().encode(files.get(path)),
    write: async (path, body) => {files.set(path, new TextDecoder().decode(body));},
    delete: async path => {files.delete(path);},
    move: async (from, to) => {files.set(to, files.get(from)!); files.delete(from);},
  };
  const store = {
    read: () => pending,
    prepare: async (value: PendingCollisionRename) => {pending = structuredClone(value);},
    finish: async (_value: PendingCollisionRename, moved: boolean) => {
      if (failFinish) throw new Error("Disk write failed");
      outcomes.push(moved); pending = undefined;
    },
  };
  const journal = new CollisionRenameJournal(local, store);
  const expectedHash = await sha256Content(new TextEncoder().encode("original"));
  await journal.prepare("source.md", "target.md", expectedHash, "stable-entry");
  return {files, store, journal, outcomes, expectedHash, failSave: () => {failFinish = true;}, recoverSave: () => {failFinish = false;}};
};

describe("collision rename journal", () => {
  it("cancels an intent saved before a move that never happened", async () => {
    const {journal, files, outcomes, store} = await fixture();
    expect(await journal.recover()).toBe("ready");
    expect(outcomes).toEqual([false]);
    expect([...files]).toEqual([["source.md", "original"]]);
    expect(store.read()).toBeUndefined();
  });

  it("recovers a completed move after restart before accepting its stable identity", async () => {
    const {files, store, outcomes} = await fixture();
    files.delete("source.md"); files.set("target.md", "original");
    const local: LocalVaultPort = {
      list: async () => [], stat: async path => files.has(path) ? {path, size: 8, modifiedAt: 1} : undefined,
      read: async path => new TextEncoder().encode(files.get(path)), move: async () => {}, write: async () => {}, delete: async () => {},
    };
    expect(await new CollisionRenameJournal(local, store).recover()).toBe("ready");
    expect(outcomes).toEqual([true]);
    expect([...files]).toEqual([["target.md", "original"]]);
  });

  it("keeps a failed completion durably pending and makes retry idempotent", async () => {
    const {journal, files, store, outcomes, failSave, recoverSave} = await fixture();
    files.delete("source.md"); files.set("target.md", "original");
    failSave();
    await expect(journal.recover()).rejects.toThrow("Disk write failed");
    expect(store.read()).toBeDefined();
    recoverSave();
    expect(await journal.recover()).toBe("ready");
    expect(await journal.recover()).toBe("ready");
    expect(outcomes).toEqual([true]);
  });

  it.each(["source", "target"] as const)("requires an explicit %s choice when both files remain", async side => {
    const {journal, files, outcomes, expectedHash} = await fixture();
    files.set("target.md", "original");
    expect(await journal.recover()).toBe("needs-review");
    expect(outcomes).toEqual([]);
    expect(await journal.recover({side, hash: expectedHash})).toBe("ready");
    expect(outcomes).toEqual([side === "target"]);
    expect(files.size).toBe(2);
  });

  it("does not guess that a changed destination is the original file", async () => {
    const {journal, files, outcomes, expectedHash} = await fixture();
    files.delete("source.md"); files.set("target.md", "new edits");
    expect(await journal.recover()).toBe("needs-review");
    await expect(journal.recover({side: "target", hash: expectedHash})).rejects.toThrow("changed again");
    expect(outcomes).toEqual([]);
    const reviewedHash = await sha256Content(new TextEncoder().encode("new edits"));
    expect(await journal.recover({side: "target", hash: reviewedHash})).toBe("ready");
    expect(files.get("target.md")).toBe("new edits");
  });

  it("keeps intent and blocks recovery when neither file is available", async () => {
    const {journal, files, store, outcomes} = await fixture();
    files.clear();
    expect(await journal.recover()).toBe("needs-review");
    expect(store.read()).toBeDefined();
    expect(outcomes).toEqual([]);
  });
});
