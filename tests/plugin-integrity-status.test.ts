import { afterEach, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
interface FixtureRequest {url: string; method: string; headers: Record<string, string>; body?: ArrayBuffer}
const host = vi.hoisted(() => {
  const stored: Record<string, unknown> = {};
  return {stored, request: vi.fn<(request: FixtureRequest) => Promise<unknown>>(), limit: undefined as number | undefined};
});
vi.mock("obsidian", () => ({
  App: class {}, PluginSettingTab: class {}, Modal: class {}, Setting: class {}, FileSystemAdapter: class {},
  TFile: class { constructor(public path: string, public stat: {mtime: number; size: number}) {} },
  Platform: {isDesktop: false, isDesktopApp: false, get isMobile() {return host.limit !== undefined;}, isAndroidApp: false},
  normalizePath: (path: string) => path, requestUrl: host.request,
  Notice: class {messageEl = {createEl: () => ({addEventListener: () => {}})}; hide() {}},
  Plugin: class {
    constructor(public app: unknown, public manifest: unknown) {}
    async loadData() {return structuredClone(host.stored);}
    async saveData(value: Record<string, unknown>) {host.stored = structuredClone(value);}
    addSettingTab() {} addRibbonIcon() {} addCommand() {} registerDomEvent() {} registerInterval() {}
  },
}));
vi.mock("../src/plugin/mobile-file-limit", () => ({automaticMobileFileLimit: () => host.limit}));
import { TFile } from "obsidian";
import S3VaultSyncPlugin from "../src/main";
import { sha256Content } from "../src/sync/content-hash";
import { DEFAULT_SETTINGS } from "../src/plugin/settings";
import { RemoteStore } from "../src/storage/remote-store";
import { ObsidianVaultPort } from "../src/plugin/obsidian-vault-port";
import type { ObjectStore, StoredObject } from "../src/storage/object-store";

const activePlugins: S3VaultSyncPlugin[] = [];
afterEach(() => {
  for (const plugin of activePlugins.splice(0)) plugin.onunload();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  host.limit = undefined;
  host.request.mockReset();
});

const fixture = async () => {
  vi.stubGlobal("window", {setInterval: () => 1, clearTimeout: () => {}, setTimeout: () => 1});
  vi.stubGlobal("document", {visibilityState: "hidden"});
  vi.stubGlobal("navigator", {});
  const data = new Map<string, StoredObject>(); let sequence = 0;
  const objects: ObjectStore = {
    get: async key => data.get(key), list: async prefix => [...data.keys()].filter(key => key.startsWith(prefix)), delete: async key => {data.delete(key);},
    put: async (key, body) => {const value = {body, etag: `"test-${++sequence}"`, lastModified: "Fri, 18 Sep 2026 00:00:00 GMT"}; data.set(key, value); return value;},
  };
  const vaultKey = new Uint8Array(32);
  const remote = await RemoteStore.open({objects, prefix: "obs-sync", vaultKey});
  const body = new TextEncoder().encode("current");
  const old = new TextEncoder().encode("history");
  await remote.writeBlob("current-blob", body); await remote.writeBlob("old-blob", old);
  const currentHash = await sha256Content(body);
  const entry = {kind: "live" as const, entryId: "existing", path: "existing.md", revision: {blobId: "current-blob", revisionId: "current", size: body.length, contentHash: currentHash, createdAt: "2026-09-18T00:00:00Z"}, history: [{blobId: "old-blob", revisionId: "old", size: old.length, contentHash: await sha256Content(old), createdAt: "2026-09-17T00:00:00Z", expiresAt: "2026-10-17T00:00:00Z"}]};
  const head = {commitId: "first", generation: 1, protocolVersion: 1 as const, vaultId: "vault"};
  await remote.initialize({head, commit: {...head, createdAt: "2026-09-18T00:00:00Z", replicaId: "fixture", parentIds: [], changes: [{kind: "set-entry", entry}]}});
  host.stored = {settings: {...DEFAULT_SETTINGS, replicaId: "test", bucket: "fixture", vaultId: "vault"}, cache: {bootstrapPending: true, files: {"existing.md": {path: "existing.md", entryId: "existing", contentHash: currentHash, modifiedAt: 1, size: body.length}}, snapshot: {vaultId: "vault", protocolVersion: 1, commitId: "first", entries: {existing: entry}}, unmaterializedEntryIds: []}};
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
    } else expect(request.method).toBe("GET");
    return {status: stored ? 200 : 404, arrayBuffer: request.method === "PUT" ? new ArrayBuffer(0) : stored?.body.slice().buffer ?? new ArrayBuffer(0), headers: {etag: stored?.etag ?? '"missing"', date: "Fri, 18 Sep 2026 00:00:00 GMT", "last-modified": "Fri, 18 Sep 2026 00:00:00 GMT"}};
  });
  const secrets = new Map([["s3-vault-sync-access-key-id", "fixture-access"], ["s3-vault-sync-secret-access-key", "fixture-secret"], ["s3-vault-sync-vault-key", btoa(String.fromCharCode(...vaultKey))]]);
  const files = new Map([["existing.md", "current"], ["import.md", "new content"]]);
  const vault = {
    adapter: {exists: async () => false},
    getFiles: () => [...files].map(([path, body]) => Object.assign(new TFile(), {path, stat: {mtime: 1, size: new TextEncoder().encode(body).byteLength}})),
    getAbstractFileByPath: (path: string) => files.has(path) ? Object.assign(new TFile(), {path, stat: {mtime: 1, size: files.get(path)!.length}}) : null,
    readBinary: async (file: {path: string}) => new TextEncoder().encode(files.get(file.path)).buffer,
  };
  const app = {vault, secretStorage: {getSecret: (key: string) => secrets.get(key) ?? null, setSecret: (key: string, value: string) => {secrets.set(key, value);}}, workspace: {onLayoutReady: () => {}}, plugins: {enabledPlugins: new Set()}} as unknown as App;
  const start = async () => {
    const plugin = new S3VaultSyncPlugin(app, {id: "s3-vault-sync", name: "S3 Safe Sync"} as PluginManifest);
    activePlugins.push(plugin);
    await plugin.onload();
    return plugin;
  };
  const corrupt = (suffix: string) => {
    const key = [...data.keys()].find(key => key.endsWith(suffix))!;
    const original = data.get(key)!;
    const damaged = original.body.slice(); damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1;
    data.set(key, {...original, body: damaged});
    return {key, damaged, restore: () => data.set(key, original)};
  };
  return {plugin: await start(), start, corrupt, data, files, remote, currentHash, entry};
};

it("keeps a known corrupt recovery actionable after an unrelated import and a no-op sync, then clears only after verification", async () => {
    const {plugin, corrupt, data} = await fixture();
    await plugin.syncNow();
    expect(plugin.getLocalIssues()).toEqual([{kind: "import-candidate", path: "import.md"}]);
    const damaged = corrupt("/current-blob");
    await expect(plugin.restoreRevision("existing", "old")).rejects.toThrow("No authenticated remote recovery");
    expect(plugin.getStatusText()).toMatch(/^Action required: Repair Mode:/);
    await plugin.importCandidate("import.md");
    expect(data.get(damaged.key)!.body).toEqual(damaged.damaged);
    expect(plugin.getStatusText()).toMatch(/^Action required:/);
    const before = host.request.mock.calls.length;
    await plugin.syncNow();
    expect(plugin.getStatusText()).toMatch(/^Action required:/);
    expect(host.request.mock.calls.slice(before).some(([request]) => request.method === "PUT")).toBe(false);
    damaged.restore();
    host.request.mockClear();
    await plugin.syncNow();
    expect(plugin.getStatusText()).toMatch(/^Idle:/);
    expect(host.stored.pendingIntegrityChecks).toEqual([]);
    const blobReads = host.request.mock.calls.map(([request]) => new URL(request.url).pathname).filter(path => path.includes("/blobs/"));
    expect(blobReads).toEqual(["/obs-sync/v1/blobs/current-blob"]);
});

it("preserves integrity attention across pause, settings, reload, and a network failure during recheck", async () => {
  const {plugin, start, corrupt} = await fixture();
  const damaged = corrupt("/old-blob");
  await expect(plugin.readHistoricalRevision("existing", "old")).rejects.toThrow("cannot be authenticated");
  await plugin.togglePause();
  await plugin.saveSettings();
  expect(plugin.getStatusText()).toMatch(/^Action required:/);
  expect(plugin.getStatusText()).toContain("paused");
  plugin.onunload();
  const restarted = await start();
  expect(restarted.getStatusText()).toMatch(/^Action required:/);
  expect(restarted.getStatusText()).toContain("cannot be authenticated");
  damaged.restore();
  host.request.mockRejectedValueOnce(new Error("Network offline"));
  await restarted.togglePause();
  expect(restarted.getStatusText()).toMatch(/^Action required:/);
  expect(restarted.getStatusText()).toContain("Temporary network failure");
  expect(host.stored.pendingIntegrityChecks).toHaveLength(1);
  await restarted.syncNow();
  expect(restarted.getStatusText()).toMatch(/^Action required:/); // Import still needs its own decision.
  expect(host.stored.pendingIntegrityChecks).toEqual([]);
  expect(restarted.getLocalIssues()).toEqual([{kind: "import-candidate", path: "import.md"}]);
});

it("clears metadata failures only after the original Head can be authenticated again", async () => {
  const {plugin, corrupt} = await fixture();
  const head = corrupt("/head");
  await plugin.syncNow();
  expect(plugin.getStatusText()).toMatch(/^Action required:/);
  expect(host.stored.pendingIntegrityChecks).toHaveLength(1);
  await plugin.syncNow();
  expect(host.stored.pendingIntegrityChecks).toHaveLength(1);
  head.restore();
  await plugin.syncNow();
  expect(host.stored.pendingIntegrityChecks).toEqual([]);
  expect(plugin.getLocalIssues()).toHaveLength(1);
});

it("does not mix integrity issues between configured S3 targets", async () => {
  const {plugin, corrupt} = await fixture();
  const damaged = corrupt("/old-blob");
  await expect(plugin.readHistoricalRevision("existing", "old")).rejects.toThrow();
  plugin.getSettings().prefix = "another-prefix";
  await plugin.saveSettings();
  await plugin.syncNow();
  expect(host.stored.pendingIntegrityChecks).toHaveLength(2);
  plugin.getSettings().prefix = "obs-sync/";
  damaged.restore();
  await plugin.syncNow();
  expect(host.stored.pendingIntegrityChecks).toHaveLength(1);
  expect(JSON.stringify(host.stored.pendingIntegrityChecks)).toContain("another-prefix");
  expect(plugin.getStatusText()).not.toContain("Repair Mode");
});

it("clears only verified failures when two different integrity issues are pending", async () => {
  const {plugin, corrupt} = await fixture();
  const current = corrupt("/current-blob");
  const historical = corrupt("/old-blob");
  await expect(plugin.restoreRevision("existing", "old")).rejects.toThrow();
  await expect(plugin.readHistoricalRevision("existing", "old")).rejects.toThrow();
  expect(host.stored.pendingIntegrityChecks).toHaveLength(2);
  current.restore();
  await plugin.syncNow();
  expect(host.stored.pendingIntegrityChecks).toHaveLength(1);
  expect(plugin.getStatusText()).toContain("Revision old cannot be authenticated");
  historical.restore();
  await plugin.syncNow();
  expect(host.stored.pendingIntegrityChecks).toEqual([]);
});

it("keeps automatic rechecks bounded but clears an oversized issue after an explicitly requested download verifies it", async () => {
  const {plugin, corrupt, files} = await fixture();
  const damaged = corrupt("/current-blob");
  host.limit = 1;
  await expect(plugin.downloadDeferred("existing")).rejects.toThrow("No authenticated remote recovery");
  damaged.restore();
  await plugin.syncNow();
  expect(plugin.getStatusText()).toContain("transfer limit");
  expect(host.stored.pendingIntegrityChecks).toHaveLength(1);
  // Substitute only the filesystem boundary; real service still verifies ciphertext and hashes.
  vi.spyOn(ObsidianVaultPort.prototype, "write").mockImplementation(async (path, body) => {
    files.set(path, new TextDecoder().decode(body));
  });
  await plugin.downloadDeferred("existing");
  expect(host.stored.pendingIntegrityChecks).toEqual([]);
  expect(plugin.getStatusText()).toMatch(/^Idle:/);
  expect(files.get("existing.md")).toBe("current");
});

it.each(["preview", "restore"])("clears the exact historical integrity issue after a successful %s retry", async action => {
  const {plugin, corrupt, files} = await fixture();
  await plugin.syncNow();
  const damaged = corrupt("/old-blob");
  await expect(plugin.readHistoricalRevision("existing", "old")).rejects.toThrow("cannot be authenticated");
  damaged.restore();
  vi.spyOn(ObsidianVaultPort.prototype, "write").mockImplementation(async (path, body) => {
    files.set(path, new TextDecoder().decode(body));
  });
  if (action === "preview") {
    expect(new TextDecoder().decode(await plugin.readHistoricalRevision("existing", "old"))).toBe("history");
  } else {
    await plugin.restoreRevision("existing", "old");
    expect(files.get("existing.md")).toBe("history");
  }
  expect(host.stored.pendingIntegrityChecks).toEqual([]);
  expect(plugin.getStatusText()).not.toContain("Repair Mode");
  expect(plugin.getStatusText()).toMatch(/^Action required:/); // Unrelated import still awaits confirmation.
});

it("clears a matching Entry/hash recovery issue when content review authenticates that exact version", async () => {
  const {plugin, corrupt} = await fixture();
  await plugin.syncNow();
  const damaged = corrupt("/current-blob");
  await expect(plugin.restoreRevision("existing", "old")).rejects.toThrow("No authenticated remote recovery");
  damaged.restore();
  const review = await plugin.reviewLocalContent("existing.md");
  expect(review.remoteVersions[0]!.preview).toBe("current");
  expect(host.stored.pendingIntegrityChecks).toEqual([]);
  expect(plugin.getStatusText()).not.toContain("Repair Mode");
});
