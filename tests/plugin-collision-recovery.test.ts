import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, PluginManifest, Vault } from "obsidian";

const host = vi.hoisted(() => {
  const stored: Record<string, unknown> = {};
  return {stored, failSave: false, isMobile: false, request: vi.fn()};
});
vi.mock("obsidian", () => ({
  App: class {}, PluginSettingTab: class {}, Modal: class {}, Setting: class {}, FileSystemAdapter: class {},
  TFile: class { constructor(public path: string, public stat: {mtime: number; size: number}) {} },
  Platform: {isDesktop: false, isDesktopApp: false, get isMobile() {return host.isMobile;}, isAndroidApp: false},
  normalizePath: (path: string) => path,
  requestUrl: host.request,
  Notice: class {messageEl = {createEl: () => ({addEventListener: () => {}})}; hide() {}},
  Plugin: class {
    constructor(public app: unknown, public manifest: unknown) {}
    async loadData() {return structuredClone(host.stored);}
    async saveData(value: Record<string, unknown>) {if (host.failSave) throw new Error("Disk write failed"); host.stored = structuredClone(value);}
    addSettingTab() {} addRibbonIcon() {} addCommand() {} registerDomEvent() {} registerInterval() {}
  },
}));

import { TFile } from "obsidian";
import S3VaultSyncPlugin from "../src/main";
import { sha256Content } from "../src/sync/content-hash";
import { DEFAULT_SETTINGS } from "../src/plugin/settings";
import { VaultCrypto } from "../src/crypto/vault-crypto";
import { BootstrapStore } from "../src/storage/bootstrap-store";
import { RemoteStore, type CommitChange } from "../src/storage/remote-store";
import type { ObjectStore, StoredObject } from "../src/storage/object-store";
import { ObsidianVaultPort } from "../src/plugin/obsidian-vault-port";

afterEach(() => {vi.unstubAllGlobals(); host.failSave = false; host.isMobile = false; host.request.mockReset();});

const start = async (files: Map<string, string>, secrets = new Map<string, string>()) => {
  vi.stubGlobal("window", {setInterval: () => 1, clearTimeout: () => {}, setTimeout: () => 1});
  vi.stubGlobal("document", {visibilityState: "hidden"});
  const vault = {
    adapter: {exists: async () => false},
    getFiles: () => [...files].map(([path, body]) => Object.assign(new TFile(), {path, stat: {mtime: 1, size: new TextEncoder().encode(body).byteLength}})),
    getAbstractFileByPath: (path: string) => files.has(path) ? Object.assign(new TFile(), {path, stat: {mtime: 1, size: files.get(path)!.length}}) : null,
    readBinary: async (file: {path: string}) => new TextEncoder().encode(files.get(file.path)).buffer,
  };
  const app = {vault, secretStorage: {getSecret: (key: string) => secrets.get(key) ?? null, setSecret: (key: string, value: string) => {secrets.set(key, value);}},
    workspace: {onLayoutReady: () => {}}, plugins: {enabledPlugins: new Set()}};
  const plugin = new S3VaultSyncPlugin(app as unknown as App, {id: "s3-vault-sync", name: "S3 Safe Sync"} as PluginManifest);
  await plugin.onload();
  return plugin;
};

const initial = async () => {
  const hash = await sha256Content(new TextEncoder().encode("original"));
  host.stored = {
    settings: {...DEFAULT_SETTINGS, replicaId: "test", paused: true},
    cache: {files: {"source.md": {path: "source.md", entryId: "stable", contentHash: hash, size: 8, modifiedAt: 1}},
      snapshot: {vaultId: "vault", protocolVersion: 1, commitId: "base", entries: {}}},
    pendingPathRenames: {"other.md": {entryId: "other", toPath: "other-new.md"}},
    pendingCollisionRename: {from: "source.md", to: "target.md", expectedHash: hash, entryId: "stable", identitySourcePath: "source.md"},
  };
};

describe("plugin collision recovery persistence", () => {
  it.each([{paused: false, deferred: false}, {paused: true, deferred: false}, {paused: false, deferred: true}])(
    "keeps remaining imports actionable without treating device-limit deferrals as errors (paused=$paused, deferred=$deferred)", async ({paused, deferred}) => {
    host.stored = {settings: {...DEFAULT_SETTINGS, replicaId: "test", bucket: "fixture", vaultId: "vault"}};
    const data = new Map<string, StoredObject>();
    let sequence = 0;
    const objects: ObjectStore = {
      get: async key => data.get(key), list: async prefix => [...data.keys()].filter(key => key.startsWith(prefix)),
      delete: async key => {data.delete(key);},
      put: async (key, body) => {
        const value = {body, etag: `"test-${++sequence}"`, lastModified: "Fri, 18 Sep 2026 00:00:00 GMT"};
        data.set(key, value); return value;
      },
    };
    const vaultKey = new Uint8Array(32);
    const remote = await RemoteStore.open({objects, prefix: "obs-sync", vaultKey});
    const changes: CommitChange[] = [];
    if (deferred) {
      host.isMobile = true;
      vi.stubGlobal("navigator", {connection: {type: "cellular"}});
      const body = new Uint8Array(11 * 1024 * 1024);
      await remote.writeBlob("large-blob", body);
      changes.push({kind: "set-entry", entry: {kind: "live", entryId: "large", path: "large.bin", revision: {
        blobId: "large-blob", revisionId: "large-revision", size: body.byteLength,
        contentHash: await sha256Content(body), createdAt: "2026-09-18T00:00:00Z",
      }}});
    }
    await remote.initialize({head: {commitId: "first", generation: 1, protocolVersion: 1, vaultId: "vault"},
      commit: {commitId: "first", vaultId: "vault", protocolVersion: 1, createdAt: "2026-09-18T00:00:00Z", replicaId: "fixture", parentIds: [], changes}});
    host.request.mockImplementation(async (request: {url: string; method: string; headers: Record<string, string>; body?: ArrayBuffer}) => {
      const url = new URL(request.url);
      if (url.searchParams.get("list-type") === "2") {
        expect(request.method).toBe("GET");
        const prefix = url.searchParams.get("prefix") ?? "";
        const contents = [...data.keys()].filter(key => key.startsWith(prefix)).map(key => `<Contents><Key>${key}</Key></Contents>`).join("");
        return {status: 200, arrayBuffer: new TextEncoder().encode(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`).buffer, headers: {}};
      }
      const key = decodeURIComponent(url.pathname.slice(1));
      let stored = data.get(key);
      if (request.method === "PUT") {
        const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]));
        if ((headers["if-none-match"] && stored) || (headers["if-match"] && headers["if-match"] !== stored?.etag)) {
          return {status: 412, arrayBuffer: new ArrayBuffer(0), headers: {}};
        }
        stored = await objects.put(key, new Uint8Array(request.body!));
      } else expect(request.method).toBe("GET");
      return {status: stored ? 200 : 404, arrayBuffer: request.method === "PUT" ? new ArrayBuffer(0) : stored?.body.slice().buffer ?? new ArrayBuffer(0),
        headers: {etag: stored?.etag ?? '"missing"', date: "Fri, 18 Sep 2026 00:00:00 GMT", "last-modified": "Fri, 18 Sep 2026 00:00:00 GMT"}};
    });
    const secrets = new Map([["s3-vault-sync-access-key-id", "fixture-access"], ["s3-vault-sync-secret-access-key", "fixture-secret"],
      ["s3-vault-sync-vault-key", btoa(String.fromCharCode(...vaultKey))]]);
    const plugin = await start(new Map([["first.md", "first"], ["second.md", "second"]]), secrets);
    const statuses: string[] = [];
    plugin.onStatusChange(status => statuses.push(status.text));
    await plugin.syncNow();
    expect(plugin.getStatusText()).toMatch(/^Action required:/);
    expect(plugin.getLocalIssues()).toHaveLength(2);
    if (paused) await plugin.togglePause();
    await plugin.importCandidate("first.md");
    expect(plugin.getLocalIssues()).toEqual([{kind: "import-candidate", path: "second.md"}]);
    expect(plugin.getStatusText()).toMatch(/^Action required:/);
    expect(statuses.at(-1)).toMatch(/^Action required:/);
    await plugin.importCandidate("second.md");
    expect(plugin.getLocalIssues()).toEqual([]);
    expect(plugin.getStatusText()).toMatch(paused ? /^Paused:/ : /^Idle:/);
    if (deferred) {
      expect(plugin.getDeferredDownloads()).toEqual([{entryId: "large", path: "large.bin", reason: "device-limit", size: 11 * 1024 * 1024}]);
      expect(plugin.getStatusText()).toContain("Deferred downloads: 1");
    }
    expect(Object.values((await remote.readSnapshot((await remote.readHead())!.value)).entries).map(entry => entry.path).sort())
      .toEqual(deferred ? ["first.md", "large.bin", "second.md"] : ["first.md", "second.md"]);
    plugin.onunload();
  });

  it("detects canonical folder names and file ancestors even when no synchronizable files are listed", async () => {
    const vault = {adapter: {exists: async () => false}, getAllLoadedFiles: () => [
      {path: "EMPTY.md"}, Object.assign(new TFile(), {path: "parent.md"}),
    ]};
    const local = new ObsidianVaultPort(vault as unknown as Vault);
    expect(await local.pathExists("empty.md")).toBe(true);
    expect(await local.pathExists("PARENT.md/note.md")).toBe(true);
    expect(await local.pathExists("unused.md")).toBe(false);
  });

  it("allows read-only existing-store unlock while ambiguous rename recovery still blocks writes", async () => {
    await initial();
    host.stored.settings = {...DEFAULT_SETTINGS, replicaId: "test", paused: true, bucket: "fixture", vaultId: "vault"};
    const pendingProbes = [{bucket: "fixture", region: DEFAULT_SETTINGS.region, prefix: "obs-sync",
      key: "obs-sync/.s3-vault-sync-probe-00000000-0000-0000-0000-000000000001"}];
    host.stored.pendingProbes = pendingProbes;
    const data = new Map<string, StoredObject>();
    const objects: ObjectStore = {
      get: async key => data.get(key), list: async prefix => [...data.keys()].filter(key => key.startsWith(prefix)),
      delete: async key => {data.delete(key);},
      put: async (key, body) => {
        const value = {body, etag: `"test-${data.size}"`, lastModified: "Fri, 18 Sep 2026 00:00:00 GMT"};
        data.set(key, value); return value;
      },
    };
    const vaultKey = new Uint8Array(32);
    const password = "fixture-only-passphrase";
    await new BootstrapStore(objects, "obs-sync").initialize({protocolVersion: 1, vaultId: "vault",
      envelope: await VaultCrypto.wrapKey({password, vaultKey})});
    const remote = await RemoteStore.open({objects, prefix: "obs-sync", vaultKey});
    await remote.initialize({head: {commitId: "first", generation: 1, protocolVersion: 1, vaultId: "vault"},
      commit: {commitId: "first", vaultId: "vault", protocolVersion: 1, createdAt: "2026-09-18T00:00:00Z", replicaId: "fixture", parentIds: [], changes: []}});
    host.request.mockImplementation(async (request: {url: string; method: string}) => {
      expect(request.method).toBe("GET");
      const stored = data.get(decodeURIComponent(new URL(request.url).pathname.slice(1)));
      return {status: stored ? 200 : 404, arrayBuffer: stored?.body.slice().buffer ?? new ArrayBuffer(0),
        headers: {etag: stored?.etag ?? '"missing"', date: "Fri, 18 Sep 2026 00:00:00 GMT", "last-modified": "Fri, 18 Sep 2026 00:00:00 GMT"}};
    });
    const secrets = new Map([["s3-vault-sync-access-key-id", "fixture-access"], ["s3-vault-sync-secret-access-key", "fixture-secret"]]);
    const files = new Map([["target.md", "changed"]]);
    const plugin = await start(files, secrets);
    await plugin.initializeOrUnlock(password);
    expect(secrets.has("s3-vault-sync-vault-key")).toBe(true);
    expect(host.stored.pendingCollisionRename).toBeDefined();
    expect(host.stored.pendingProbes).toEqual(pendingProbes);
    expect(plugin.getStatusText()).toContain("Unlocked. Open sync status");
    await expect(plugin.resolveLocalContent("target.md", "stale", "remote")).rejects.toThrow("interrupted rename needs confirmation");
    expect([...files]).toEqual([["target.md", "changed"]]);
    expect(host.request.mock.calls.length).toBeGreaterThan(0);
    plugin.onunload();
  });

  it("replays a finished rename after a persistence failure and restart before any manual action", async () => {
    await initial();
    const files = new Map([["target.md", "original"]]);
    const first = await start(files);
    host.failSave = true;
    await expect(first.initializeOrUnlock("")).rejects.toThrow("Disk write failed");
    expect(host.stored.pendingCollisionRename).toBeDefined();
    expect(host.stored.pendingPathRenames).toEqual({"other.md": {entryId: "other", toPath: "other-new.md"}});
    first.onunload();
    host.failSave = false;
    const restarted = await start(files);
    await expect(restarted.initializeOrUnlock("")).rejects.toThrow("Enter the Vault password first");
    expect(host.stored.pendingCollisionRename).toBeUndefined();
    expect(host.stored.pendingPathRenames).toEqual({"source.md": {entryId: "stable", toPath: "target.md"},
      "other.md": {entryId: "other", toPath: "other-new.md"}});
    expect([...files]).toEqual([["target.md", "original"]]);
    expect(host.request).not.toHaveBeenCalled();
    restarted.onunload();
  });

  it("cancels a not-started move without inventing a rename in the plugin's saved state", async () => {
    await initial();
    const plugin = await start(new Map([["source.md", "original"]]));
    await expect(plugin.initializeOrUnlock("")).rejects.toThrow("Enter the Vault password first");
    expect(host.stored.pendingCollisionRename).toBeUndefined();
    expect(host.stored.pendingPathRenames).toEqual({"other.md": {entryId: "other", toPath: "other-new.md"}});
    expect(host.request).not.toHaveBeenCalled();
    plugin.onunload();
  });

  it("blocks manual content replacement and provides collision review when recovery contents changed", async () => {
    await initial();
    const files = new Map([["target.md", "changed"]]);
    const plugin = await start(files);
    await expect(plugin.resolveLocalContent("target.md", "stale", "remote")).rejects.toThrow("interrupted rename needs confirmation");
    expect(host.stored.pendingCollisionRename).toBeDefined();
    expect(plugin.getLocalIssues()).toContainEqual({kind: "path-collision", paths: ["source.md", "target.md"]});
    expect([...files]).toEqual([["target.md", "changed"]]);
    expect(host.request).not.toHaveBeenCalled();
    plugin.onunload();
  });
});
