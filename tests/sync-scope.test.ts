import { describe, expect, it, vi } from "vitest";
import type { Vault } from "obsidian";

vi.mock("obsidian", () => ({
  FileSystemAdapter: class {},
  TFile: class {},
  Platform: { isDesktopApp: false, isAndroidApp: false },
  normalizePath: (path: string) => path,
}));

import { TFile } from "obsidian";
import { ObsidianVaultPort, isInSyncScope } from "../src/plugin/obsidian-vault-port";
import { RemoteStore } from "../src/storage/remote-store";
import type { ObjectStore, StoredObject } from "../src/storage/object-store";
import {
  SyncService,
  type CachedSyncState,
  type LocalVaultPort,
  type SyncCachePort,
} from "../src/sync/sync-service";

const ICON = "Icon\r";
const bytes = (value: string) => new TextEncoder().encode(value);

describe("macOS 文件夹图标文件 Icon\\r", () => {
  it.each(["Icon\r", "a/b/Icon\r"])("不在同步范围内：%j", (path) => {
    expect(isInSyncScope(path)).toBe(false);
  });

  it.each(["Icon", "Icon.md", "Icon\r.md", "MyIcon\r", "a/Icon/note.md"])(
    "名字只是相近的照旧同步：%j",
    (path) => {
      expect(isInSyncScope(path)).toBe(true);
    },
  );
});

// 内存里的 Obsidian 仓库：只提供同步读路径用得到的接口
const memoryVault = (files: Map<string, Uint8Array>) => {
  const toFile = (path: string) =>
    Object.assign(new TFile(), {
      path,
      stat: { mtime: 1, size: files.get(path)!.byteLength },
    });
  return {
    adapter: { exists: async () => false },
    getFiles: () => [...files.keys()].map(toFile),
    getAbstractFileByPath: (path: string) => (files.has(path) ? toFile(path) : null),
    readBinary: async (file: { path: string }) => files.get(file.path)!.slice().buffer,
  } as unknown as Vault;
};

const memoryObjects = (): ObjectStore => {
  const data = new Map<string, StoredObject>();
  let sequence = 0;
  return {
    get: async (key) => data.get(key),
    list: async (prefix) => [...data.keys()].filter((key) => key.startsWith(prefix)),
    listObjects: async (prefix) =>
      [...data]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, lastModified: value.lastModified, size: value.body.byteLength })),
    delete: async (key) => {
      data.delete(key);
    },
    put: async (key, body) => {
      const value = { body: body.slice(), etag: `etag-${++sequence}`, lastModified: "2026-11-13T00:00:00.000Z" };
      data.set(key, value);
      return value;
    },
  };
};

const memoryCache = (): SyncCachePort => {
  let state: CachedSyncState | undefined;
  return {
    load: async () => state,
    save: async (value) => {
      state = structuredClone(value);
    },
  };
};

const livePaths = async (remote: RemoteStore): Promise<string[]> => {
  const head = await remote.readHead();
  if (!head) throw new Error("远端还没有 Head");
  const snapshot = await remote.readSnapshot(head.value);
  return Object.values(snapshot.entries)
    .flatMap((entry) => (entry.kind === "live" ? [entry.path] : []))
    .sort();
};

describe("同步层对 Icon\\r 的处理", () => {
  it("本机有 Icon\\r 时只上传普通笔记，同步完成且没有未同步项", async () => {
    const files = new Map<string, Uint8Array>();
    const remote = await RemoteStore.open({ objects: memoryObjects(), prefix: "obs-sync", vaultKey: new Uint8Array(32) });
    const service = new SyncService({
      cache: memoryCache(),
      local: new ObsidianVaultPort(memoryVault(files)),
      remote,
      replicaId: "desktop",
    });
    await service.initializeNew("vault-1");
    files.set(ICON, new Uint8Array(0));
    files.set("note.md", bytes("note"));

    const result = await service.synchronize();

    expect(result).toMatchObject({
      status: "complete",
      uploaded: 1,
      uploads: [{ kind: "added", path: "note.md" }],
      unsyncedLocalEntries: 0,
      localIssues: [],
      deferredDownloadEntries: [],
    });
    expect(await livePaths(remote)).toEqual(["note.md"]);
  });

  it("远端和上次同步结果里已有活的 Icon\\r 时，不发布删除、不删本机文件、不下载", async () => {
    const files = new Map<string, Uint8Array>([
      [ICON, new Uint8Array(0)],
      ["note.md", bytes("note")],
    ]);
    const vault = memoryVault(files);
    const remote = await RemoteStore.open({ objects: memoryObjects(), prefix: "obs-sync", vaultKey: new Uint8Array(32) });
    const cache = memoryCache();
    // 旧版规则：Icon\r 也在同步范围内，先把它传上去并记进上次同步结果
    const legacy: LocalVaultPort = Object.assign(Object.create(new ObsidianVaultPort(vault)) as ObsidianVaultPort, {
      list: async () => [...files].map(([path, body]) => ({ path, modifiedAt: 1, size: body.byteLength })),
      supportsPath: () => true,
    });
    await new SyncService({ cache, local: legacy, remote, replicaId: "desktop" }).initializeNew("vault-1");
    expect(await livePaths(remote)).toEqual([ICON, "note.md"]);

    const local = new ObsidianVaultPort(vault);
    const write = vi.spyOn(local, "write");
    const remove = vi.spyOn(local, "delete");
    const move = vi.spyOn(local, "move");
    const result = await new SyncService({ cache, local, remote, replicaId: "desktop" }).synchronize();

    expect(result).toMatchObject({ deleted: 0, downloaded: 0, downloads: [], uploads: [] });
    expect(result.deferredDownloadEntries).toMatchObject([{ path: ICON, reason: "unsupported-path" }]);
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    expect(files.has(ICON)).toBe(true);
    expect(await livePaths(remote)).toEqual([ICON, "note.md"]);
  });
});
