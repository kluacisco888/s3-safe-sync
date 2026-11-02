import { afterEach, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
interface FixtureRequest {url: string; method: string; headers: Record<string, string>; body?: ArrayBuffer}
const host = vi.hoisted(() => {
  const stored: Record<string, unknown> = {};
  return {stored, request: vi.fn<(request: FixtureRequest) => Promise<unknown>>()};
});
vi.mock("obsidian", () => ({
  App: class {}, PluginSettingTab: class {}, Modal: class { contentEl = {empty() {}}; open() {} close() {} }, Setting: class {}, FileSystemAdapter: class {},
  TFile: class { constructor(public path: string, public stat: {mtime: number; size: number}) {} },
  Platform: {isDesktop: false, isDesktopApp: false, isMobile: false, isAndroidApp: false},
  normalizePath: (path: string) => path, requestUrl: host.request,
  Notice: class {messageEl = {createEl: () => ({addEventListener: () => {}})}; hide() {}},
  Plugin: class {
    constructor(public app: unknown, public manifest: unknown) {}
    async loadData() {return structuredClone(host.stored);}
    async saveData(value: Record<string, unknown>) {host.stored = structuredClone(value);}
    addSettingTab() {} addRibbonIcon() {} addCommand() {} registerDomEvent() {} registerInterval() {} registerEvent() {}
  },
}));
import { TFile } from "obsidian";
import S3VaultSyncPlugin from "../src/main";
import { sha256Content } from "../src/sync/content-hash";
import { DEFAULT_SETTINGS } from "../src/plugin/settings";
import { RemoteStore } from "../src/storage/remote-store";
import type { ObjectStore, StoredObject } from "../src/storage/object-store";

const activePlugins: S3VaultSyncPlugin[] = [];
afterEach(() => {
  for (const plugin of activePlugins.splice(0)) plugin.onunload();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  host.request.mockReset();
});

// 设备需要完整校验（上次没做完、标记还在）；本机有一个已同步的文件和一个待导入文件，所以每次同步都停在「需要处理」
const fixture = async () => {
  // 只放行算指纹时让出主线程的 0 毫秒定时器；改动后的自动同步、重试等定时器不触发，由测试自己发起同步
  const realSetTimeout = globalThis.setTimeout;
  vi.stubGlobal("window", {setInterval: () => 1, clearTimeout: () => {}, setTimeout: (callback: () => void, delay?: number) => {
    if (!delay) realSetTimeout(callback, 0);
    return 1;
  }});
  vi.stubGlobal("document", {visibilityState: "visible"});
  vi.stubGlobal("navigator", {});
  const data = new Map<string, StoredObject>(); let sequence = 0;
  const objects: ObjectStore = {
    get: async key => data.get(key), list: async prefix => [...data.keys()].filter(key => key.startsWith(prefix)),
    listObjects: async prefix => [...data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({key, lastModified: value.lastModified, size: value.body.byteLength})), delete: async key => {data.delete(key);},
    put: async (key, body) => {const value = {body, etag: `"test-${++sequence}"`, lastModified: "Fri, 18 Sep 2026 00:00:00 GMT"}; data.set(key, value); return value;},
  };
  const vaultKey = new Uint8Array(32);
  const remote = await RemoteStore.open({objects, prefix: "obs-sync", vaultKey});
  const body = new TextEncoder().encode("current");
  await remote.writeBlob("current-blob", body);
  const currentHash = await sha256Content(body);
  const entry = {kind: "live" as const, entryId: "existing", path: "existing.md", revision: {blobId: "current-blob", revisionId: "current", size: body.length, contentHash: currentHash, createdAt: "2026-09-18T00:00:00Z"}};
  const head = {commitId: "first", generation: 1, protocolVersion: 1 as const, vaultId: "vault"};
  await remote.initialize({head, commit: {...head, createdAt: "2026-09-18T00:00:00Z", replicaId: "fixture", parentIds: [], changes: [{kind: "set-entry", entry}]}});
  host.stored = {
    settings: {...DEFAULT_SETTINGS, replicaId: "test", bucket: "fixture", vaultId: "vault", paused: true},
    fullHashVerificationRequired: true,
    lastFullHashVerificationAt: Date.now(),
    cache: {bootstrapPending: true, files: {"existing.md": {path: "existing.md", entryId: "existing", contentHash: currentHash, modifiedAt: 1, size: body.length}}, snapshot: {vaultId: "vault", protocolVersion: 1, commitId: "first", entries: {existing: entry}}, unmaterializedEntryIds: []},
  };
  host.request.mockImplementation(async (request) => {
    const url = new URL(request.url);
    if (url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const contents = [...data.keys()].filter(key => key.startsWith(prefix)).map(key => `<Contents><Key>${key}</Key></Contents>`).join("");
      return {status: 200, arrayBuffer: new TextEncoder().encode(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`).buffer, headers: {}};
    }
    const key = decodeURIComponent(url.pathname.slice(1)); let stored = data.get(key);
    if (request.method === "PUT") {
      const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]));
      if ((headers["if-none-match"] && stored) || (headers["if-match"] && headers["if-match"] !== stored?.etag)) return {status: 412, arrayBuffer: new ArrayBuffer(0), headers: {}};
      stored = await objects.put(key, new Uint8Array(request.body!));
    }
    return {status: stored ? 200 : 404, arrayBuffer: request.method === "PUT" ? new ArrayBuffer(0) : stored?.body.slice().buffer ?? new ArrayBuffer(0), headers: {etag: stored?.etag ?? '"missing"', date: "Fri, 18 Sep 2026 00:00:00 GMT", "last-modified": "Fri, 18 Sep 2026 00:00:00 GMT"}};
  });
  const secrets = new Map([["s3-vault-sync-access-key-id", "fixture-access"], ["s3-vault-sync-secret-access-key", "fixture-secret"], ["s3-vault-sync-vault-key", btoa(String.fromCharCode(...vaultKey))]]);
  // 本机文件：路径 -> 内容和修改时间
  const files = new Map([["existing.md", {text: "current", mtime: 1}], ["import.md", {text: "new content", mtime: 1}]]);
  const fileFor = (path: string) => {
    const file = files.get(path)!;
    return Object.assign(new TFile(), {path, stat: {mtime: file.mtime, size: new TextEncoder().encode(file.text).byteLength}});
  };
  // 每次真读文件内容都记下路径
  const reads: string[] = [];
  let duringRead: ((path: string) => void) | undefined;
  const listeners = new Map<string, Array<(file: TFile) => void>>();
  const vault = {
    adapter: {exists: async () => false},
    getFiles: () => [...files.keys()].map(fileFor),
    getAbstractFileByPath: (path: string) => files.has(path) ? fileFor(path) : null,
    readBinary: async (file: {path: string}) => {
      reads.push(file.path);
      const hook = duringRead; duringRead = undefined;
      hook?.(file.path);
      return new TextEncoder().encode(files.get(file.path)!.text).buffer;
    },
    on: (name: string, listener: (file: TFile) => void) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      return listener;
    },
  };
  const layoutReady: Array<() => void> = [];
  const app = {vault, secretStorage: {getSecret: (key: string) => secrets.get(key) ?? null, setSecret: (key: string, value: string) => {secrets.set(key, value);}}, workspace: {onLayoutReady: (callback: () => void) => {layoutReady.push(callback);}}, plugins: {enabledPlugins: new Set()}} as unknown as App;
  // 启动插件：暂停状态下走完布局就绪（登记文件事件、不触发启动同步），再恢复同步
  const start = async () => {
    const plugin = new S3VaultSyncPlugin(app, {id: "s3-vault-sync", name: "S3 Safe Sync"} as PluginManifest);
    activePlugins.push(plugin);
    layoutReady.length = 0;
    listeners.clear();
    await plugin.onload();
    plugin.getSettings().paused = true;
    for (const callback of layoutReady) callback();
    plugin.getSettings().paused = false;
    return plugin;
  };
  // 用户在 Obsidian 里改了文件：发改动事件
  const emitModify = (path: string) => {
    for (const listener of listeners.get("modify") ?? []) listener(fileFor(path));
  };
  const takeReads = () => reads.splice(0).sort();
  return {plugin: await start(), start, files, emitModify, takeReads, setDuringRead: (hook: (path: string) => void) => {duringRead = hook;}};
};

it("does not reread unchanged files on the next sync while an import decision keeps the full check pending", async () => {
  const {plugin, takeReads} = await fixture();
  await plugin.syncNow();
  expect(plugin.getLocalIssues()).toEqual([{kind: "import-candidate", path: "import.md"}]);
  expect(takeReads()).toEqual(["existing.md", "import.md"]);

  await plugin.syncNow();

  expect(plugin.getStatusText()).toMatch(/^需要处理：/);
  expect(plugin.getLocalIssues()).toEqual([{kind: "import-candidate", path: "import.md"}]);
  expect(takeReads()).toEqual([]);
  expect(host.stored.fullHashVerificationRequired).toBe(true);
});

it("after a sync stopped by a local change, rereads only files with a change event or changed size or modification time", async () => {
  const {plugin, files, emitModify, setDuringRead, takeReads} = await fixture();
  files.set("notes.md", {text: "unchanged note", mtime: 1});
  // 第一次同步读文件时 existing.md 收到改动事件（内容和修改时间都没变），同步因 local-change 停下
  setDuringRead(() => emitModify("existing.md"));
  await plugin.syncNow();
  expect(plugin.getStatusText()).toContain("本地文件被改动");
  expect(takeReads()).toEqual(["existing.md", "import.md", "notes.md"]);
  // import.md 的修改时间变了，但没有改动事件
  files.get("import.md")!.mtime = 2;

  await plugin.syncNow();

  expect(plugin.getStatusText()).toMatch(/^需要处理：/);
  expect(takeReads()).toEqual(["existing.md", "import.md"]);
  expect(host.stored.fullHashVerificationRequired).toBe(true);
});

it("rereads a file that received a change event between syncs even when its size and modification time did not change", async () => {
  const {plugin, files, emitModify, takeReads} = await fixture();
  await plugin.syncNow();
  expect(takeReads()).toEqual(["existing.md", "import.md"]);
  // 内容变了，大小和修改时间凑巧都没变
  files.get("existing.md")!.text = "CURRENT";
  emitModify("existing.md");

  await plugin.syncNow();

  expect(takeReads()).toEqual(["existing.md"]);
  // 用户处理完导入后，这次读到的新内容作为本机改动上传
  await plugin.importCandidate("import.md");
  await plugin.syncNow();
  expect(plugin.getStatusText()).toContain("上传 1");
});
