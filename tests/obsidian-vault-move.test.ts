import {afterEach, describe, expect, it, vi} from "vitest";
import type {Vault} from "obsidian";
import * as fs from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

const platform = vi.hoisted(() => ({desktop: false}));
vi.mock("obsidian", () => ({TFile: class {}, FileSystemAdapter: class {},
  Platform: {get isDesktopApp() {return platform.desktop;}, isAndroidApp: false}, normalizePath: (path: string) => path}));

import {FileSystemAdapter, TFile} from "obsidian";
import {ObsidianVaultPort} from "../src/plugin/obsidian-vault-port";
import {sha256Content} from "../src/sync/content-hash";

const bytes = (value: string) => new TextEncoder().encode(value);
afterEach(() => {platform.desktop = false; vi.unstubAllGlobals();});
const setup = () => {
  const files = new Map<string, Uint8Array>([["old/note.md", bytes("original")], ["new/note.md", bytes("original")]]);
  const folders = new Set(["old", "new"]);
  const trash: Uint8Array[] = [];
  const hooks: {beforeRead?: (path: string) => void; failTrash?: boolean} = {};
  const adapter = {
    exists: async (path: string) => files.has(path) || folders.has(path),
    stat: async (path: string) => files.has(path) ? {type: "file"} : folders.has(path) ? {type: "folder"} : null,
    readBinary: async (path: string) => {hooks.beforeRead?.(path); const body = files.get(path); if (!body) throw new Error("Missing file"); return body.slice().buffer;},
    copy: async (from: string, to: string) => {if (files.has(to) || folders.has(to)) throw new Error("Destination exists"); files.set(to, files.get(from)!.slice());},
    trashLocal: async (path: string) => {
      if (hooks.failTrash) {hooks.failTrash = false; throw new Error("Trash unavailable");}
      trash.push(files.get(path)!.slice()); files.delete(path);
    },
  };
  const vault = {
    adapter,
    getAbstractFileByPath: (path: string) => files.has(path) ? Object.assign(new TFile(), {path}) : folders.has(path) ? {path} : null,
    createFolder: async (path: string) => {folders.add(path);},
    trash: async (file: {path: string}) => adapter.trashLocal(file.path),
  };
  return {port: new ObsidianVaultPort(vault as unknown as Vault), files, folders, trash, hooks};
};

describe("Obsidian move recovery", () => {
  it("uses the desktop directory-only primitive and refreshes the host index after removal", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "s3-sync-desktop-cleanup-"));
    const indexed = new Set(["old"]);
    try {
      await fs.mkdir(join(root, "old"));
      platform.desktop = true;
      vi.stubGlobal("window", {require: (id: string) => {
        if (id !== "node:fs/promises") throw new Error("Unexpected module");
        return fs;
      }});
      const adapter = Object.assign(new FileSystemAdapter(), {
        getFullPath: (path: string) => join(root, path),
        queue: async (action: () => Promise<void>) => action(),
        reconcileInternalFile: async (path: string) => {await expect(fs.stat(join(root, path))).rejects.toThrow(); indexed.delete(path);},
        rmdir: () => {throw new Error("Unsafe host rmdir must not run");},
      });
      const port = new ObsidianVaultPort({adapter, configDir: ".obsidian"} as unknown as Vault);
      await port.cleanupEmptyDirectories(["old/retired.md"]);
      expect(indexed.size).toBe(0);
      expect((await fs.stat(root)).isDirectory()).toBe(true);
    } finally {
      await fs.rmdir(join(root, "old")).catch(() => undefined);
      await fs.rmdir(root);
    }
  });

  it("leaves directories alone on mobile instead of calling an unverified recursive adapter", async () => {
    const {port, files, folders, trash} = setup();
    await port.cleanupEmptyDirectories(["old/removed.md"]);
    expect([...folders]).toEqual(["old", "new"]);
    expect(files.size).toBe(2);
    expect(trash).toEqual([]);
  });

  it("keeps a verified existing copy and retires only the matching source through Trash", async () => {
    const {port, files, trash} = setup();
    const hash = await sha256Content(bytes("original"));
    await port.move("old/note.md", "new/note.md", hash, hash);
    expect(files.has("old/note.md")).toBe(false);
    expect(new TextDecoder().decode(files.get("new/note.md"))).toBe("original");
    expect(trash.map(body => new TextDecoder().decode(body))).toEqual(["original"]);
  });

  it.each(["old/note.md", "new/note.md"])("preserves both paths if %s changes while the move is being verified", async changedPath => {
    const {port, files, trash, hooks} = setup();
    const hash = await sha256Content(bytes("original"));
    let reads = 0;
    hooks.beforeRead = path => {if (path === changedPath && ++reads === 2) files.set(path, bytes("new draft"));};
    await expect(port.move("old/note.md", "new/note.md", hash, hash)).rejects.toThrow();
    expect(new TextDecoder().decode(files.get(changedPath))).toBe("new draft");
    expect(files.has("old/note.md")).toBe(true);
    expect(files.has("new/note.md")).toBe(true);
    expect(trash).toEqual([]);
  });

  it("can retry a move interrupted between verified copy and source retirement", async () => {
    const {port, files, trash, hooks} = setup();
    files.delete("new/note.md");
    hooks.failTrash = true;
    const hash = await sha256Content(bytes("original"));
    await expect(port.move("old/note.md", "new/note.md", hash, null)).rejects.toThrow("Trash unavailable");
    expect([...files.keys()].sort()).toEqual(["new/note.md", "old/note.md"]);
    await port.move("old/note.md", "new/note.md", hash, hash);
    expect([...files.keys()]).toEqual(["new/note.md"]);
    expect(trash.map(body => new TextDecoder().decode(body))).toEqual(["original"]);
  });

  it("does not resume an occupied target without explicit matching content preconditions", async () => {
    const {port, files, trash} = setup();
    const hash = await sha256Content(bytes("original"));
    await expect(port.move("old/note.md", "new/note.md", hash, null)).rejects.toThrow();
    await expect(port.move("old/note.md", "new/note.md")).rejects.toThrow();
    await expect(port.move("old/note.md", "old/NOTE.md", hash, hash)).rejects.toThrow();
    expect(files.size).toBe(2);
    expect(trash).toEqual([]);
  });
});
