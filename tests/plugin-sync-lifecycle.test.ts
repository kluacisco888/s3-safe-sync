import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";

const host = vi.hoisted((): {
  data: unknown;
  notices: string[];
  requestUrl: ReturnType<typeof vi.fn>;
  beforeSave?: () => Promise<void>;
  beforeLoad?: () => Promise<void>;
  registrationCount: number;
} => ({
  data: undefined,
  notices: [],
  requestUrl: vi.fn(),
  registrationCount: 0,
}));

vi.mock("obsidian", () => ({
  App: class {},
  FileSystemAdapter: class {},
  Modal: class {},
  Notice: class { constructor(message: string) { host.notices.push(message); } },
  Platform: { isDesktop: false, isDesktopApp: false, isMobile: false },
  Plugin: class {
    constructor(public app: unknown, public manifest: unknown) {}
    async loadData() { await host.beforeLoad?.(); return structuredClone(host.data); }
    async saveData(data: unknown) { await host.beforeSave?.(); host.data = structuredClone(data); }
    addCommand() { host.registrationCount += 1; }
    addRibbonIcon() {}
    addSettingTab() {}
    registerDomEvent() {}
    registerEvent() {}
    registerInterval() {}
  },
  PluginSettingTab: class {},
  Setting: class {},
  TFile: class {
    constructor(public path: string, public stat: { mtime: number; size: number }) {}
  },
  normalizePath: (path: string) => path,
  requestUrl: host.requestUrl,
}));

import S3VaultSyncPlugin from "../src/main";
import { TFile } from "obsidian";
import { CredentialStore } from "../src/plugin/credential-store";
import { DEFAULT_SETTINGS } from "../src/plugin/settings";
import { AwsS3ObjectStore } from "../src/storage/aws-s3-object-store";
import { executeObsidianHttpRequest } from "../src/storage/obsidian-http";
import { RemoteStore } from "../src/storage/remote-store";

const setup = async (initialized = true) => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", { visibilityState: "visible" });
  host.notices = [];
  host.beforeSave = undefined;
  host.beforeLoad = undefined;
  host.registrationCount = 0;
  const objects = new Map<string, { body: Uint8Array; etag: string }>();
  let sequence = 0;
  const hooks: {
    beforeBlobRead?: () => void;
    headFailure?: "network" | "corrupt";
    failNextBlobPut?: boolean;
  } = {};
  host.requestUrl.mockImplementation(async (request: {
    url: string; method: string; body?: ArrayBuffer; headers: Record<string, string>;
  }) => {
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.slice(1));
    let status = 200;
    let body: Uint8Array = new Uint8Array();
    let etag: string | undefined;
    if (request.method === "GET" && url.searchParams.has("list-type")) {
      const prefix = url.searchParams.get("prefix") ?? "";
      body = new TextEncoder().encode(`<ListBucketResult><IsTruncated>false</IsTruncated>${
        [...objects.keys()].filter(k => k.startsWith(prefix)).map(k => `<Contents><Key>${k}</Key></Contents>`).join("")
      }</ListBucketResult>`);
    } else if (request.method === "GET") {
      if (key.includes("/blobs/")) hooks.beforeBlobRead?.();
      const stored = objects.get(key);
      status = stored ? 200 : 404;
      body = stored?.body ?? body;
      etag = stored?.etag;
      if (key.endsWith("/head") && hooks.headFailure) {
        status = hooks.headFailure === "network" ? 503 : 200;
        body = new TextEncoder().encode("invalid remote response");
      }
    } else if (request.method === "PUT") {
      const current = objects.get(key);
      if (key.includes("/blobs/") && hooks.failNextBlobPut) {
        hooks.failNextBlobPut = false;
        status = 503;
      } else if ((request.headers["if-none-match"] && current) ||
          (request.headers["if-match"] && request.headers["if-match"] !== current?.etag)) {
        status = 412;
      } else {
        etag = `"etag-${++sequence}"`;
        objects.set(key, { body: new Uint8Array(request.body ?? new ArrayBuffer(0)), etag });
      }
    } else if (request.method === "DELETE") {
      objects.delete(key);
      status = 204;
    } else {
      throw new Error(`Unexpected request method: ${request.method}`);
    }
    return {
      arrayBuffer: body.slice().buffer,
      headers: { date: new Date().toUTCString(), "last-modified": new Date().toUTCString(), ...(etag ? { etag } : {}) },
      status,
    };
  });
  const secrets = new Map<string, string>();
  const secretStorage = {
    getSecret: (id: string) => secrets.get(id) ?? null,
    setSecret: (id: string, value: string) => { secrets.set(id, value); },
  };
  const credentials = new CredentialStore(secretStorage);
  credentials.saveAwsCredentials({ accessKeyId: "test-key", secretAccessKey: "test-secret" });
  const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);
  credentials.saveVaultKey(vaultKey);
  const remote = await RemoteStore.open({
    objects: new AwsS3ObjectStore({
      accessKeyId: "test-key", secretAccessKey: "test-secret", bucket: "test-bucket",
      region: "us-east-1", execute: executeObsidianHttpRequest,
    }),
    prefix: "test-prefix", vaultKey,
  });
  await remote.writeBlob("original-blob", new TextEncoder().encode("Original article."));
  const entry = {
    entryId: "entry-1", kind: "live" as const, path: "notes/example.md",
    revision: {
      blobId: "original-blob", contentHash: "", createdAt: new Date().toUTCString(),
      revisionId: "revision-1", size: 17,
    },
  };
  const { sha256Content } = await import("../src/sync/content-hash");
  entry.revision.contentHash = await sha256Content(new TextEncoder().encode("Original article."));
  await remote.initialize({
    commit: {
      changes: [{ kind: "set-entry", entry }], commitId: "initial", createdAt: new Date().toUTCString(),
      parentIds: [], protocolVersion: 1, replicaId: "desktop", vaultId: "vault-1",
    },
    head: { commitId: "initial", generation: 1, protocolVersion: 1, vaultId: "vault-1" },
  });
  let text = "Original article.";
  const file = Object.assign(new TFile(), { path: entry.path, stat: { mtime: 1, size: 17 } });
  const events = new Map<string, Array<(file: TFile) => void>>();
  const edit = (value: string) => {
    text = value;
    file.stat = { ...file.stat, mtime: file.stat.mtime + 1, size: new TextEncoder().encode(text).length };
    for (const listener of events.get("modify") ?? []) listener(file);
  };
  const app = {
    secretStorage,
    vault: {
      adapter: { exists: () => Promise.resolve(false) },
      getFiles: () => [file],
      getAbstractFileByPath: (path: string) => path === file.path ? file : null,
      readBinary: () => Promise.resolve(new TextEncoder().encode(text).buffer),
      on: (name: string, listener: (file: TFile) => void) => {
        const listeners = events.get(name) ?? [];
        listeners.push(listener);
        events.set(name, listeners);
        return listener;
      },
    },
    workspace: { onLayoutReady: (callback: () => void) => callback() },
  } as unknown as App;
  host.data = {
    settings: { ...DEFAULT_SETTINGS, bucket: "test-bucket", prefix: "test-prefix", paused: true, replicaId: "desktop", vaultId: "vault-1" },
    lastFullHashVerificationAt: Date.now(),
    cache: {
      files: { [entry.path]: { path: entry.path, modifiedAt: 1, size: 17, entryId: entry.entryId, contentHash: entry.revision.contentHash } },
      snapshot: { commitId: "initial", entries: { [entry.entryId]: entry }, protocolVersion: 1, vaultId: "vault-1" },
      unmaterializedEntryIds: [],
    },
  };
  if (!initialized) {
    objects.clear();
    host.data = { settings: {
      ...DEFAULT_SETTINGS, bucket: "test-bucket", prefix: "test-prefix", paused: true,
      replicaId: "desktop",
    } };
  }
  const plugin = new S3VaultSyncPlugin(app, { id: "s3-vault-sync" } as PluginManifest);
  await plugin.onload();
  return { plugin, remote, hooks, edit, localText: () => text, app, objects };
};

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("plugin synchronization lifecycle", () => {
  it("does not register an instance unloaded while its settings were loading", async () => {
    const { plugin, app } = await setup();
    plugin.onunload();
    let finish!: () => void;
    host.beforeLoad = () => {
      host.beforeLoad = undefined;
      return new Promise<void>(resolve => { finish = resolve; });
    };
    const loadingPlugin = new S3VaultSyncPlugin(app, { id: "s3-vault-sync" } as PluginManifest);
    const loading = loadingPlugin.onload().then(() => "loaded", () => "stopped");
    await vi.waitFor(() => expect(finish).toBeDefined());
    const before = host.registrationCount;
    loadingPlugin.onunload();
    finish();
    expect(await loading).toBe("stopped");
    expect(host.registrationCount).toBe(before);
  });

  it("keeps the active sync status when an unrelated setting is saved", async () => {
    const { plugin } = await setup();
    const stop = plugin.onStatusChange(status => {
      if (status.text.includes("Checking metadata")) {
        stop();
        plugin.getSettings().deviceName = "Renamed device";
        void plugin.saveSettings();
        expect(plugin.getStatusText()).toBe(status.text);
      }
    });
    await plugin.togglePause();
    expect(host.notices).toEqual([]);
  });

  it("retries an interrupted initial upload with the same envelope after reload", async () => {
    const { plugin, hooks, app, objects } = await setup(false);
    hooks.failNextBlobPut = true;
    await expect(plugin.initializeOrUnlock("test-password")).rejects.toThrow("503");
    const envelope = objects.get("test-prefix/v1/key-envelope");
    expect(envelope).toBeDefined();
    expect(objects.has("test-prefix/v1/head")).toBe(false);
    const interruptedCheckpoint = structuredClone(host.data);
    plugin.onunload();
    const replacement = new S3VaultSyncPlugin(app, { id: "s3-vault-sync" } as PluginManifest);
    await replacement.onload();
    await expect(replacement.initializeOrUnlock("test-password")).resolves.toBeUndefined();
    expect(objects.get("test-prefix/v1/key-envelope")).toEqual(envelope);
    expect(objects.has("test-prefix/v1/head")).toBe(true);
    expect(replacement.getSettings().vaultId).toBeTruthy();
    objects.delete("test-prefix/v1/head");
    await expect(replacement.initializeOrUnlock("test-password")).rejects.toThrow("Head is missing");
    expect(objects.has("test-prefix/v1/head")).toBe(false);
    replacement.onunload();
    host.data = interruptedCheckpoint;
    const rolledBackCache = new S3VaultSyncPlugin(app, { id: "s3-vault-sync" } as PluginManifest);
    await rolledBackCache.onload();
    await expect(rolledBackCache.initializeOrUnlock("test-password")).rejects.toThrow("Head is missing");
  });

  it("waits for an old in-flight data write before loading a replacement instance", async () => {
    const { plugin, app } = await setup();
    let releaseWrite!: () => void;
    let writeStarted = false;
    host.beforeSave = () => {
      host.beforeSave = undefined;
      writeStarted = true;
      return new Promise<void>(resolve => { releaseWrite = resolve; });
    };
    plugin.getSettings().deviceName = "old setting";
    const saving = plugin.saveSettings();
    await vi.waitFor(() => expect(writeStarted).toBe(true));
    plugin.onunload();
    const replacement = new S3VaultSyncPlugin(app, { id: "s3-vault-sync" } as PluginManifest);
    let loaded = false;
    const loading = replacement.onload().then(() => { loaded = true; });
    await vi.advanceTimersByTimeAsync(10);
    expect(loaded).toBe(false);
    releaseWrite();
    await Promise.all([saving, loading]);
    expect(replacement.getSettings().deviceName).toBe("old setting");
    replacement.getSettings().deviceName = "new setting";
    await replacement.saveSettings();
    await expect(plugin.saveSettings()).rejects.toThrow("stopped");
    expect(host.data).toMatchObject({ settings: { deviceName: "new setting" } });
  });

  it("does not publish or schedule another run after unloading during a read", async () => {
    const { plugin, remote, hooks, edit } = await setup();
    edit("A draft not yet uploaded.");
    hooks.beforeBlobRead = () => {
      hooks.beforeBlobRead = undefined;
      plugin.onunload();
    };
    await plugin.togglePause();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await remote.readHead())?.value.commitId).toBe("initial");
    expect(host.notices).toEqual([]);
  });

  it("automatically retries an editor save after five seconds without a failure notice", async () => {
    const { plugin, remote, hooks, edit, localText } = await setup();
    edit("A paragraph in progress.");
    hooks.beforeBlobRead = () => {
      hooks.beforeBlobRead = undefined;
      edit("The complete paragraph and its final sentence.");
    };
    await plugin.togglePause();
    expect(plugin.getStatusText()).toContain("Retrying after edits settle");
    expect(host.notices).toEqual([]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect((await remote.readHead())?.value.commitId).toBe("initial");
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(plugin.getStatusText()).toMatch(/^Idle:/u));
    const head = await remote.readHead();
    if (!head) throw new Error("Expected accepted Head");
    const snapshot = await remote.readSnapshot(head.value);
    const entry = snapshot.entries["entry-1"];
    if (entry?.kind !== "live") throw new Error("Expected live article");
    expect(new TextDecoder().decode(await remote.readBlob(entry.revision.blobId))).toBe(localText());
    expect(localText()).toBe("The complete paragraph and its final sentence.");
    for (let poll = 0; poll < 2; poll += 1) {
      await vi.advanceTimersByTimeAsync(120_000);
      await vi.waitFor(() => expect(plugin.getStatusText()).toMatch(/^Idle:/u));
    }
    expect(await remote.readHead()).toMatchObject({ etag: head.etag, value: head.value });
    expect(plugin.getStatusText()).toMatch(/^Idle:/u);
    expect(host.notices).toEqual([]);
  });

  it("still displays Paused when an active synchronization finishes after pausing", async () => {
    const { plugin } = await setup();
    const stop = plugin.onStatusChange(status => {
      if (status.text.includes("Checking metadata")) {
        stop();
        void plugin.togglePause();
      }
    });
    await plugin.togglePause();
    expect(plugin.isPaused()).toBe(true);
    expect(plugin.getStatusText()).toMatch(/^Paused:/u);
  });

  it.each(["network", "corrupt"] as const)("does not hide a %s failure after pausing", async failure => {
    const { plugin, hooks } = await setup();
    const stop = plugin.onStatusChange(status => {
      if (status.text.startsWith("Checking: Reading")) {
        stop();
        hooks.headFailure = failure;
        void plugin.togglePause();
      }
    });
    await plugin.togglePause();
    expect(plugin.isPaused()).toBe(true);
    expect(plugin.getStatusText()).toMatch(failure === "network" ? /^Error:/u : /^Action required:/u);
    expect(host.notices).toHaveLength(1);
  });
});
