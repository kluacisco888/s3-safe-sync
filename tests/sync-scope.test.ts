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

const MAC_FOLDER_ICON = "Icon\r";
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
  it("本机有 Icon\\r 时只上传普通笔记，同步完成且没有 Unsynced Local Entry", async () => {
    const files = new Map<string, Uint8Array>();
    const remote = await RemoteStore.open({ objects: memoryObjects(), prefix: "obs-sync", vaultKey: new Uint8Array(32) });
    const service = new SyncService({
      cache: memoryCache(),
      local: new ObsidianVaultPort(memoryVault(files)),
      remote,
      replicaId: "desktop",
    });
    await service.initializeNew("vault-1");
    files.set(MAC_FOLDER_ICON, new Uint8Array(0));
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

  it("远端和 Sync Cache 里已有活的 Icon\\r 时，连续两轮同步都不发布 Deletion Record、不删本机文件、不下载", async () => {
    const files = new Map<string, Uint8Array>([
      [MAC_FOLDER_ICON, new Uint8Array(0)],
      ["note.md", bytes("note")],
    ]);
    const vault = memoryVault(files);
    const remote = await RemoteStore.open({ objects: memoryObjects(), prefix: "obs-sync", vaultKey: new Uint8Array(32) });
    const cache = memoryCache();
    // 旧版规则：Icon\r 也在同步范围内，先把它传上去并记进 Sync Cache；
    // 只有 list 和 supportsPath 换成旧规则，其余操作交给真实的 ObsidianVaultPort
    const real = new ObsidianVaultPort(vault);
    const legacy: LocalVaultPort = {
      cleanupEmptyDirectories: (retiredPaths) => real.cleanupEmptyDirectories(retiredPaths),
      delete: (path, expectedContentHash) => real.delete(path, expectedContentHash),
      hashContent: (path, options) => real.hashContent(path, options),
      list: async () => [...files].map(([path, body]) => ({ path, modifiedAt: 1, size: body.byteLength })),
      move: (fromPath, toPath, expectedSourceHash, expectedTargetHash) =>
        real.move(fromPath, toPath, expectedSourceHash, expectedTargetHash),
      pathExists: (path) => real.pathExists(path),
      read: (path) => real.read(path),
      stat: (path) => real.stat(path),
      supportsPath: () => true,
      write: (path, body, expectedCurrentHash) => real.write(path, body, expectedCurrentHash),
    };
    await new SyncService({ cache, local: legacy, remote, replicaId: "desktop" }).initializeNew("vault-1");
    expect(await livePaths(remote)).toEqual([MAC_FOLDER_ICON, "note.md"]);

    const local = new ObsidianVaultPort(vault);
    const write = vi.spyOn(local, "write");
    const remove = vi.spyOn(local, "delete");
    const move = vi.spyOn(local, "move");

    // 第一轮用新规则同步；第二轮再同步一次，Icon\r 仍应是已知但未落地的 Deferred Download
    for (const round of [1, 2]) {
      const result = await new SyncService({ cache, local, remote, replicaId: "desktop" }).synchronize();

      expect(result, `第 ${round} 轮`).toMatchObject({ deleted: 0, downloaded: 0, downloads: [], uploads: [] });
      expect(result.deferredDownloadEntries, `第 ${round} 轮`).toMatchObject([
        { path: MAC_FOLDER_ICON, reason: "unsupported-path" },
      ]);
      expect(write).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(move).not.toHaveBeenCalled();
      expect(files.has(MAC_FOLDER_ICON)).toBe(true);
      expect(await livePaths(remote)).toEqual([MAC_FOLDER_ICON, "note.md"]);
    }
  });
});
