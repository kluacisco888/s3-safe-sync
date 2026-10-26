import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
import { createServer, request as httpRequest } from "node:http";
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as realDelay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const host = vi.hoisted((): {
  data: unknown;
  notices: string[];
  noticeActions: Array<{text: string; click: (event: {stopPropagation(): void}) => void}>;
  requestUrl: ReturnType<typeof vi.fn>;
  beforeSave?: () => Promise<void>;
  beforeLoad?: () => Promise<void>;
  registrationCount: number;
  domEvents: Map<string, Array<() => void>>;
  mobile: boolean;
  android: boolean;
  desktop: boolean;
  openedModals: Array<{close(): void}>;
} => ({
  data: undefined,
  notices: [],
  noticeActions: [],
  requestUrl: vi.fn(),
  registrationCount: 0,
  domEvents: new Map(),
  mobile: false,
  android: false,
  desktop: false,
  openedModals: [],
}));

vi.mock("obsidian", () => ({
  App: class {},
  FileSystemAdapter: class {},
  Modal: class {
    contentEl = {empty() {}};
    open() { host.openedModals.push(this); }
    close() { (this as {onClose?: () => void}).onClose?.(); }
  },
  Notice: class {
    constructor(message: string) { host.notices.push(message); }
    hide() {}
    messageEl = {createEl: (_tag: string, options: {text: string}) => ({
      addEventListener: (_name: string, click: (event: {stopPropagation(): void}) => void) => {
        host.noticeActions.push({text: options.text, click});
      },
    })};
  },
  Platform: { isDesktop: false, get isDesktopApp() {return host.desktop;}, get isMobile() {return host.mobile;}, get isAndroidApp() {return host.android;} },
  Plugin: class {
    constructor(public app: unknown, public manifest: unknown) {}
    async loadData() { await host.beforeLoad?.(); return structuredClone(host.data); }
    async saveData(data: unknown) { await host.beforeSave?.(); host.data = structuredClone(data); }
    addCommand() { host.registrationCount += 1; }
    addRibbonIcon() {}
    addSettingTab() {}
    registerDomEvent(_target: unknown, name: string, listener: () => void) {
      host.domEvents.set(name, [...(host.domEvents.get(name) ?? []), listener]);
    }
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
import type { ObsidianRequestExecutor } from "../src/storage/obsidian-request-adapter";
import { RemoteStore } from "../src/storage/remote-store";
import { ObsidianVaultPort } from "../src/plugin/obsidian-vault-port";
import { withVaultMutationLock } from "../src/plugin/safe-vault-write";
import { SyncService, type LocalSyncIssue, type SyncResult } from "../src/sync/sync-service";
import { S3TransportError } from "../src/storage/obsidian-request-adapter";

const cleanups: Array<() => Promise<void>> = [];
// 数据块名和真实仓库一样是 UUID
const ORIGINAL_BLOB_ID = "5f0c2b1a-8e3d-4c7f-9a6b-1d2e3f4a5b6c";

const setup = async (initialized = true, configDir = ".obsidian", initialFile = {path: "notes/example.md", text: "Original article."}, loopback = false) => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", { visibilityState: "visible" });
  host.notices = [];
  host.noticeActions = [];
  host.openedModals = [];
  host.beforeSave = undefined;
  host.beforeLoad = undefined;
  host.registrationCount = 0;
  host.domEvents.clear();
  // lastModified：写入时的（假）时间，列表和读取都按它报 LastModified
  const objects = new Map<string, { body: Uint8Array; etag: string; lastModified?: number }>();
  const diagnosticFiles = new Map<string, string>();
  let sequence = 0;
  const hooks: {
    beforeBlobRead?: () => void;
    headFailure?: "network" | "corrupt" | "forbidden";
    failNextBlobPut?: boolean;
    // 下一次 Head PUT 不写入，直接按这个状态码失败（412 = Head 冲突，503 = 服务暂时不可用）
    failNextHeadPut?: 412 | 503;
    afterProbePut?: () => void;
    // 每次数据块 PUT 处理完（成功或按 failNextBlobPut 失败）都调用
    afterBlobPut?: () => void;
    afterHeadPut?: () => void;
    wireFault?: "reset-read" | "hang-read" | "drop-head-put";
    // 假 S3 的 AWS 时间 = 设备时间 + 这个偏移：用来造「设备时间和 AWS 时间不一致」
    awsOffsetMs?: number;
  } = {};
  const wire = {requests: 0, headPublications: 0, faults: 0, signedRequests: 0};
  host.requestUrl.mockImplementation(async (request: {
    url: string; method: string; body?: ArrayBuffer; headers: Record<string, string>;
  }) => {
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.slice(1));
    let status = 200;
    let body: Uint8Array = new Uint8Array();
    let etag: string | undefined;
    let lastModified: number | undefined;
    if (request.method === "GET" && url.searchParams.has("list-type")) {
      const prefix = url.searchParams.get("prefix") ?? "";
      body = new TextEncoder().encode(`<ListBucketResult><IsTruncated>false</IsTruncated>${
        [...objects].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => `<Contents><Key>${k}</Key><LastModified>${
          new Date(v.lastModified ?? Date.now()).toISOString()}</LastModified><Size>${v.body.byteLength}</Size></Contents>`).join("")
      }</ListBucketResult>`);
    } else if (request.method === "GET") {
      if (key.includes("/blobs/")) hooks.beforeBlobRead?.();
      const stored = objects.get(key);
      status = stored ? 200 : 404;
      body = stored?.body ?? body;
      etag = stored?.etag;
      lastModified = stored?.lastModified;
      if (key.endsWith("/head") && hooks.headFailure) {
        status = hooks.headFailure === "network" ? 503 : hooks.headFailure === "forbidden" ? 403 : 200;
        body = new TextEncoder().encode("invalid remote response");
      }
    } else if (request.method === "PUT") {
      const current = objects.get(key);
      if (key.includes("/blobs/") && hooks.failNextBlobPut) {
        hooks.failNextBlobPut = false;
        status = 503;
      } else if (key.endsWith("/head") && hooks.failNextHeadPut) {
        status = hooks.failNextHeadPut;
        hooks.failNextHeadPut = undefined;
      } else if ((request.headers["if-none-match"] && current) ||
          (request.headers["if-match"] && request.headers["if-match"] !== current?.etag)) {
        status = 412;
      } else {
        etag = `"etag-${++sequence}"`;
        objects.set(key, { body: new Uint8Array(request.body ?? new ArrayBuffer(0)), etag, lastModified: Date.now() + (hooks.awsOffsetMs ?? 0) });
      }
    } else if (request.method === "DELETE") {
      objects.delete(key);
      status = 204;
    } else {
      throw new Error(`Unexpected request method: ${request.method}`);
    }
    if (request.method === "PUT" && key.includes(".s3-vault-sync-probe-")) hooks.afterProbePut?.();
    if (request.method === "PUT" && key.includes("/blobs/")) hooks.afterBlobPut?.();
    if (request.method === "PUT" && key.endsWith("/head") && status === 200) hooks.afterHeadPut?.();
    const awsNow = Date.now() + (hooks.awsOffsetMs ?? 0);
    return {
      arrayBuffer: body.slice().buffer,
      headers: { date: new Date(awsNow).toUTCString(), "last-modified": new Date(lastModified ?? awsNow).toUTCString(), ...(etag ? { etag } : {}) },
      status,
    };
  });
  let localRoot: string | undefined;
  if (loopback) {
    localRoot = await mkdtemp(join(tmpdir(), "s3-sync-loopback-"));
    const ownedRoot = localRoot;
    cleanups.push(() => rm(ownedRoot, {recursive: true, force: true}));
    await mkdir(dirname(join(localRoot, initialFile.path)), {recursive: true});
    await writeFile(join(localRoot, initialFile.path), initialFile.text);
    const protocol = host.requestUrl.getMockImplementation() as ObsidianRequestExecutor;
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
        const body = Buffer.concat(chunks);
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        wire.requests++;
        if (request.headers.authorization?.startsWith("AWS4-HMAC-SHA256")) wire.signedRequests++;
        const fault = hooks.wireFault;
        if (request.method === "GET" && url.pathname.endsWith("/head") && (fault === "reset-read" || fault === "hang-read")) {
          hooks.wireFault = undefined;
          wire.faults++;
          if (fault === "reset-read") response.destroy();
          return;
        }
        const result = await protocol({url: url.toString(), method: request.method,
          headers: Object.fromEntries(Object.entries(request.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(",") : value]])),
          body: Uint8Array.from(body).buffer});
        if (request.method === "PUT" && url.pathname.endsWith("/head") && result.status === 200) {
          wire.headPublications++;
          if (fault === "drop-head-put") {hooks.wireFault = undefined; wire.faults++; response.destroy(); return;}
        }
        response.writeHead(result.status, result.headers);
        response.end(Buffer.from(result.arrayBuffer));
      })().catch(() => response.destroy());
    });
    cleanups.push(async () => {server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));});
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a loopback port");
    host.requestUrl.mockImplementation((request: Parameters<ObsidianRequestExecutor>[0]) => new Promise<Awaited<ReturnType<ObsidianRequestExecutor>>>((resolve, reject) => {
      const original = new URL(request.url);
      const connection = httpRequest({hostname: "127.0.0.1", port: address.port, path: original.pathname + original.search,
        method: request.method, headers: request.headers, agent: false}, response => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("aborted", () => reject(new Error("Response connection closed")));
        response.on("end", () => resolve({status: response.statusCode ?? 0, arrayBuffer: Uint8Array.from(Buffer.concat(chunks)).buffer,
          headers: Object.fromEntries(Object.entries(response.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(",") : value]]))}));
      });
      connection.on("error", reject);
      connection.end(typeof request.body === "string" ? request.body : request.body ? Buffer.from(request.body) : undefined);
    }));
  }
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
  const initialBytes = new TextEncoder().encode(initialFile.text);
  await remote.writeBlob(ORIGINAL_BLOB_ID, initialBytes);
  const entry = {
    entryId: "entry-1", kind: "live" as const, path: initialFile.path,
    revision: {
      blobId: ORIGINAL_BLOB_ID, contentHash: "", createdAt: new Date().toUTCString(),
      revisionId: "revision-1", size: initialBytes.byteLength,
    },
  };
  const { sha256Content } = await import("../src/sync/content-hash");
  entry.revision.contentHash = await sha256Content(initialBytes);
  await remote.initialize({
    commit: {
      changes: [{ kind: "set-entry", entry }], commitId: "initial", createdAt: new Date().toUTCString(),
      parentIds: [], protocolVersion: 1, replicaId: "desktop", vaultId: "vault-1",
    },
    head: { commitId: "initial", generation: 1, protocolVersion: 1, vaultId: "vault-1" },
  });
  let text = initialFile.text;
  let localPresent = true;
  const file = Object.assign(new TFile(), { path: entry.path, stat: { mtime: 1, size: initialBytes.byteLength } });
  const events = new Map<string, Array<(file: TFile, oldPath?: string) => void>>();
  const edit = (value: string) => {
    text = value;
    if (localRoot) writeFileSync(join(localRoot, initialFile.path), text);
    file.stat = { ...file.stat, mtime: file.stat.mtime + 1, size: new TextEncoder().encode(text).length };
    for (const listener of events.get("modify") ?? []) listener(file);
  };
  const rename = (oldPath: string, path: string) => {
    if (file.path === oldPath) file.path = path;
    for (const listener of events.get("rename") ?? []) {
      listener(Object.assign(new TFile(), {path, stat: file.stat}), oldPath);
    }
  };
  // 用户新建的文件（不在 Sync Cache 里），只在内存里，不写回环目录
  const createdFiles: Array<{file: TFile; text: string}> = [];
  const createdAt = (path: string) => createdFiles.find(created => created.file.path === path);
  const createFile = (path: string, value: string) => {
    const created = {file: Object.assign(new TFile(), {path, stat: {mtime: 1, size: new TextEncoder().encode(value).length}}), text: value};
    createdFiles.push(created);
    for (const listener of events.get("create") ?? []) listener(created.file);
  };
  const editCreated = (path: string, value: string) => {
    const created = createdAt(path);
    if (!created) throw new Error(`Missing created file ${path}`);
    created.text = value;
    created.file.stat = {...created.file.stat, mtime: created.file.stat.mtime + 1, size: new TextEncoder().encode(value).length};
    for (const listener of events.get("modify") ?? []) listener(created.file);
  };
  // 挪动新建的文件或包含它们的文件夹；event=false 表示在磁盘上直接挪、Obsidian 不发改名事件
  const renameCreated = (oldPath: string, path: string, event = true) => {
    for (const created of createdFiles) {
      if (created.file.path === oldPath || created.file.path.startsWith(`${oldPath}/`)) {
        created.file.path = `${path}${created.file.path.slice(oldPath.length)}`;
      }
    }
    if (!event) return;
    for (const listener of events.get("rename") ?? []) {
      listener(Object.assign(new TFile(), {path, stat: createdAt(path)?.file.stat ?? {mtime: 1, size: 0}}), oldPath);
    }
  };
  const app = {
    secretStorage,
    vault: {
      configDir,
      adapter: {
        exists: (path: string) => localRoot ? access(join(localRoot, path)).then(() => true, () => false) : Promise.resolve(diagnosticFiles.has(path)),
        read: async (path: string) => { if (localRoot) return readFile(join(localRoot, path), "utf8"); const body = diagnosticFiles.get(path); if (body === undefined) throw new Error("Missing file"); return body; },
        write: async (path: string, body: string) => { if (localRoot) {await mkdir(dirname(join(localRoot, path)), {recursive: true}); await writeFile(join(localRoot, path), body);} else diagnosticFiles.set(path, body); },
      },
      getFiles: () => [...(localPresent ? [file] : []), ...createdFiles.map(created => created.file)],
      getAbstractFileByPath: (path: string) => localPresent && path === file.path ? file : createdAt(path)?.file ?? null,
      readBinary: (target?: TFile) => {
        const created = createdFiles.find(candidate => candidate.file === target);
        if (created) return Promise.resolve(new TextEncoder().encode(created.text).buffer);
        return localRoot ? readFile(join(localRoot, initialFile.path)).then(body => Uint8Array.from(body).buffer) : Promise.resolve(new TextEncoder().encode(text).buffer);
      },
      on: (name: string, listener: (file: TFile, oldPath?: string) => void) => {
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
      files: { [entry.path]: { path: entry.path, modifiedAt: 1, size: initialBytes.byteLength, entryId: entry.entryId, contentHash: entry.revision.contentHash } },
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
  if (loopback) cleanups.push(() => {plugin.onunload(); return Promise.resolve();});
  const setLocalPresent = (present: boolean) => {localPresent = present;};
  return { plugin, remote, hooks, edit, rename, createFile, editCreated, renameCreated, setLocalPresent, localText: () => localRoot ? readFileSync(join(localRoot, initialFile.path), "utf8") : text, app, objects, diagnosticFiles, wire, localRoot };
};

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  host.mobile = false;
  host.android = false;
  host.desktop = false;
  host.requestUrl.mockClear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("plugin synchronization lifecycle", () => {
  it("cancels a held loopback request on unload and recognizes the unfinished disk record on reload", async () => {
    const {plugin, app, hooks, wire} = await setup(true, ".obsidian", undefined, true);
    hooks.wireFault = "hang-read";
    const syncing = plugin.togglePause();
    await vi.waitFor(() => expect(wire.faults).toBe(1));
    await plugin.togglePause();
    plugin.onunload();
    await syncing;
    const requests = wire.requests;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wire.requests).toBe(requests);
    const replacement = new S3VaultSyncPlugin(app, {id: "s3-vault-sync"} as PluginManifest);
    await replacement.onload();
    expect(replacement.getDiagnostics().records.at(-1)?.outcome).toBe("interrupted");
    expect(replacement.getDiagnostics().lastSuccessAt).toBeUndefined();
    expect(replacement.getDiagnostics().acceptedCommit).toBe("initial");
    replacement.onunload();
  }, 20_000);

  it("uploads the complete latest disk content after a real loopback 503 and more edits", async () => {
    const {plugin, remote, edit, hooks, wire, localText} = await setup(true, ".obsidian", undefined, true);
    hooks.headFailure = "network";
    edit("A draft started before the service failure.");
    await plugin.togglePause();
    expect(plugin.getDiagnostics().records.at(-1)).toMatchObject({errorCategory: "service", httpStatus: 503, outcome: "retrying"});
    edit("The completed article 中文段落.\n".repeat(300) + "FINAL PARAGRAPH");
    hooks.headFailure = undefined;
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => {
      expect(plugin.getStatusText()).toMatch(/^空闲：/);
      expect(plugin.getDiagnostics().queued).toBe(false);
    });
    const head = (await remote.readHead())!;
    const snapshot = await remote.readSnapshot(head.value);
    const entry = snapshot.entries["entry-1"];
    if (entry?.kind !== "live") throw new Error("Expected live article");
    expect(new TextDecoder().decode(await remote.readBlob(entry.revision.blobId))).toBe(localText());
    expect(wire.headPublications).toBe(2); // Initialization plus the complete article, no partial version.
    const exported = plugin.exportDiagnostics();
    for (const excluded of ["FINAL PARAGRAPH", "notes/example.md", "test-key", "test-secret", "127.0.0.1", "test-bucket"]) {
      expect(exported).not.toContain(excluded);
    }
  }, 20_000);

  it("times out an actual held loopback response then recovers through a fresh request", async () => {
    const {plugin, hooks, wire} = await setup(true, ".obsidian", undefined, true);
    hooks.wireFault = "hang-read";
    const first = plugin.togglePause();
    await vi.waitFor(() => expect(wire.faults).toBe(1));
    // Accelerate the plugin clock; the HTTP connection itself is real and remains open.
    await vi.advanceTimersByTimeAsync(120_000);
    await first;
    expect(plugin.getDiagnostics().records.at(-1)).toMatchObject({errorCategory: "timeout", outcome: "retrying"});
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(plugin.getStatusText()).toMatch(/^空闲：/));
    expect(plugin.getDiagnostics().acceptedCommit).toBe("initial");
    expect(plugin.getDiagnostics().nextRetryAt).toBeUndefined();
  }, 20_000);

  it("does not republish after a loopback server accepts Head then drops the TCP response", async () => {
    const {plugin, remote, hooks, edit, wire, localText} = await setup(true, ".obsidian", undefined, true);
    hooks.wireFault = "drop-head-put";
    edit("Article edited on disk, including the very last line.");
    await plugin.togglePause();
    const head = (await remote.readHead())!;
    const publications = wire.headPublications;
    expect(head.value.commitId).not.toBe("initial");
    expect(wire.faults).toBe(1);
    expect(plugin.getDiagnostics().records.at(-1)).toMatchObject({outcome: "retrying", writeResultUncertain: true});
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(plugin.getStatusText()).toMatch(/^空闲：/));
    expect((await remote.readHead())!.value.commitId).toBe(head.value.commitId);
    expect(wire.headPublications).toBe(publications);
    const snapshot = await remote.readSnapshot(head.value);
    const entry = snapshot.entries["entry-1"];
    if (entry?.kind !== "live") throw new Error("Expected live article");
    expect(new TextDecoder().decode(await remote.readBlob(entry.revision.blobId))).toBe(localText());
  }, 20_000);

  it("recovers an actual loopback connection reset and reloads its diagnostics from disk", async () => {
    const {plugin, remote, hooks, edit, app, wire, localRoot, localText} = await setup(true, ".obsidian", undefined, true);
    hooks.wireFault = "reset-read";
    edit("Local integration article 中文 📝.\n".repeat(200) + "FINAL SENTENCE");
    await plugin.togglePause();
    expect(wire.faults).toBe(1);
    expect(plugin.getDiagnostics().records.at(-1)?.errorCategory).toBe("network");
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(plugin.getStatusText()).toMatch(/^空闲：/));
    const head = (await remote.readHead())!;
    const snapshot = await remote.readSnapshot(head.value);
    const entry = snapshot.entries["entry-1"];
    if (entry?.kind !== "live") throw new Error("Expected live article");
    expect(new TextDecoder().decode(await remote.readBlob(entry.revision.blobId))).toBe(localText());
    expect(wire.requests).toBeGreaterThan(10);
    expect(wire.signedRequests).toBe(wire.requests);
    expect(localRoot).toBeDefined();
    await plugin.togglePause();
    plugin.onunload();
    const replacement = new S3VaultSyncPlugin(app, {id: "s3-vault-sync"} as PluginManifest);
    await replacement.onload();
    expect(replacement.getDiagnostics().records.map(record => record.outcome)).toEqual(["retrying", "complete"]);
    expect(replacement.exportDiagnostics()).not.toContain("FINAL SENTENCE");
    expect(replacement.exportDiagnostics()).not.toContain("test-secret");
    replacement.onunload();
  }, 20_000);

  it("invalidates a retry queued behind an exclusive operation when its target changes", async () => {
    const {plugin, hooks} = await setup();
    hooks.headFailure = "network";
    await plugin.togglePause();
    hooks.headFailure = undefined;
    const execute = host.requestUrl.getMockImplementation() as ObsidianRequestExecutor;
    let held = false, retargetedRequests = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    host.requestUrl.mockImplementation(async (request: Parameters<ObsidianRequestExecutor>[0]) => {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/queue-other-prefix/")) retargetedRequests++;
      if (!held && request.method === "GET" && path.endsWith("/head")) {held = true; await gate;}
      return execute(request);
    });
    const reading = plugin.readConflictCandidate("entry-1", "revision-1").catch(() => undefined);
    await vi.waitFor(() => expect(held).toBe(true));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(plugin.getDiagnostics().queued).toBe(true);
    plugin.getSettings().prefix = "queue-other-prefix";
    release();
    await reading;
    await vi.waitFor(() => {
      expect(plugin.getDiagnostics().queued).toBe(false);
      expect(plugin.getDiagnostics().records.at(-1)?.finishedAt).toBeDefined();
    });
    expect(retargetedRequests).toBe(0);
    plugin.onunload();
  });

  it("invalidates network recovery when the target changes during the failing request", async () => {
    const {plugin} = await setup();
    const execute = host.requestUrl.getMockImplementation() as ObsidianRequestExecutor;
    let fail = true;
    host.requestUrl.mockImplementation(async (request: Parameters<ObsidianRequestExecutor>[0]) => {
      if (fail && request.method === "GET" && new URL(request.url).pathname.endsWith("/head")) {
        fail = false;
        plugin.getSettings().prefix = "other-prefix";
        throw new Error("Connection reset after target was edited");
      }
      return execute(request);
    });
    await plugin.togglePause();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(plugin.getDiagnostics().records.at(-1)?.finishedAt).toBeDefined());
    expect(plugin.getDiagnostics().records).toHaveLength(1);
    expect(plugin.getDiagnostics().nextRetryAt).toBeUndefined();
    plugin.onunload();
  });

  it.each(["success", "authentication"])("cancels obsolete retry timers when a queued follow-up ends with %s", async outcome => {
    const {plugin} = await setup();
    const execute = host.requestUrl.getMockImplementation() as ObsidianRequestExecutor;
    let fail = true;
    host.requestUrl.mockImplementation(async (request: Parameters<ObsidianRequestExecutor>[0]) => {
      if (request.method === "GET" && new URL(request.url).pathname.endsWith("/head")) {
        if (fail) {
          fail = false;
          void plugin.syncNow();
          return {arrayBuffer: new ArrayBuffer(0), headers: {}, status: 503};
        }
        if (outcome === "authentication") return {arrayBuffer: new ArrayBuffer(0), headers: {}, status: 403};
      }
      return execute(request);
    });
    await plugin.togglePause();
    expect(plugin.getDiagnostics().records).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(plugin.getDiagnostics().records).toHaveLength(2);
    expect(plugin.getDiagnostics().nextRetryAt).toBeUndefined();
    plugin.onunload();
  });

  it("does not access a changed S3 target after waiting for the initial diagnostic write", async () => {
    const {plugin, app} = await setup();
    const write = app.vault.adapter.write.bind(app.vault.adapter);
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    let waiting = false;
    vi.spyOn(app.vault.adapter, "write").mockImplementation(async (path, body) => {
      if (!waiting) {waiting = true; await gate;}
      await write(path, body);
    });
    const requestCount = host.requestUrl.mock.calls.length;
    const syncing = plugin.togglePause();
    await vi.waitFor(() => expect(waiting).toBe(true));
    plugin.getSettings().prefix = "different-prefix";
    release();
    await syncing;
    expect(host.requestUrl.mock.calls.length).toBe(requestCount);
    expect(plugin.getStatusText()).toContain("S3 目标被改了");
    plugin.onunload();
  });

  it("does not start reading diagnostics after unloading during the existence check", async () => {
    const {plugin, app} = await setup();
    plugin.onunload();
    let finish!: (exists: boolean) => void;
    vi.spyOn(app.vault.adapter, "exists").mockImplementation(() => new Promise<boolean>(resolve => {finish = resolve;}));
    const read = vi.spyOn(app.vault.adapter, "read");
    const replacement = new S3VaultSyncPlugin(app, {id: "s3-vault-sync"} as PluginManifest);
    const loading = replacement.onload().then(() => "loaded", () => "stopped");
    await vi.waitFor(() => expect(finish).toBeDefined());
    replacement.onunload();
    finish(true);
    expect(await loading).toBe("stopped");
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps a retry's accepted Head when an older timed-out PUT arrives late", async () => {
    const {plugin, remote, edit} = await setup();
    const execute = host.requestUrl.getMockImplementation() as ObsidianRequestExecutor;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    let held = false, lateStatus: number | undefined;
    host.requestUrl.mockImplementation(async (request: Parameters<ObsidianRequestExecutor>[0]) => {
      if (!held && request.method === "PUT" && new URL(request.url).pathname.endsWith("/head")) {
        held = true;
        await gate;
        const response = await execute(request);
        lateStatus = response.status;
        return response;
      }
      return execute(request);
    });
    edit("The full draft must survive the late request.");
    const first = plugin.togglePause();
    await vi.waitFor(() => expect(held).toBe(true));
    await vi.advanceTimersByTimeAsync(120_000);
    await first;
    expect(plugin.getDiagnostics().records.at(-1)).toMatchObject({outcome: "retrying", errorCategory: "timeout", writeResultUncertain: true});
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(plugin.getStatusText()).toMatch(/^空闲：/));
    const winner = (await remote.readHead())!.value.commitId;
    release();
    await vi.waitFor(() => expect(lateStatus).toBe(412));
    expect((await remote.readHead())!.value.commitId).toBe(winner);
    expect(plugin.getDiagnostics().acceptedCommit).toBe(winner);
    plugin.onunload();
  });

  it("records a coalesced follow-up request separately from the active run", async () => {
    const {plugin, hooks, edit} = await setup();
    edit("An edited note.");
    hooks.beforeBlobRead = () => {
      hooks.beforeBlobRead = undefined;
      void plugin.syncNow();
      expect(plugin.getDiagnostics().queued).toBe(true);
    };
    await plugin.togglePause();
    expect(plugin.getDiagnostics().records.map(record => record.triggers)).toEqual([["resume"], ["manual"]]);
    expect(plugin.getDiagnostics().queued).toBe(false);
    plugin.onunload();
  });

  it("keeps sync usable when diagnostic persistence fails and reports the logging failure safely", async () => {
    const {plugin, app, edit, remote} = await setup();
    vi.spyOn(app.vault.adapter, "write").mockRejectedValue(new Error("secret local path and credentials"));
    edit("A saved paragraph.");
    await plugin.togglePause();
    expect(plugin.getStatusText()).toMatch(/^空闲：/);
    expect((await remote.readHead())!.value.commitId).not.toBe("initial");
    expect(plugin.getDiagnostics().persistenceWarning).toContain("无法保存");
    expect(plugin.exportDiagnostics()).not.toContain("secret local path");
    plugin.onunload();
  });

  it("bounds persisted history, marks interrupted runs, and strips injected fields on reload", async () => {
    const {plugin, app, diagnosticFiles} = await setup();
    await plugin.togglePause();
    const sample = plugin.getDiagnostics().records.at(-1)!;
    await plugin.togglePause();
    plugin.onunload();
    const records = Array.from({length: 1_005}, (_, index) => ({...sample, id: `run-${index}`,
      privateField: "INJECTED SECRET", triggers: ["manual", "INJECTED SECRET"],
      outcome: index === 1_004 ? "running" : "complete", counts: {...sample.counts, path: "PRIVATE PATH"}}));
    diagnosticFiles.set(".obsidian/plugins/s3-vault-sync/diagnostics.json", JSON.stringify({version: 1, records}));
    const replacement = new S3VaultSyncPlugin(app, {id: "s3-vault-sync"} as PluginManifest);
    await replacement.onload();
    const exported = replacement.exportDiagnostics();
    const parsed = JSON.parse(exported) as {records: Array<{id: string; outcome: string}>};
    expect(parsed.records).toHaveLength(1_000);
    expect(parsed.records[0]?.id).toBe("run-5");
    expect(parsed.records.at(-1)?.outcome).toBe("interrupted");
    expect(exported).not.toContain("INJECTED SECRET");
    expect(exported).not.toContain("PRIVATE PATH");
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1_000);
    expect(replacement.getDiagnostics().records).toEqual([]);
    replacement.onunload();
  });

  it("does not show another Vault's past diagnostic history", async () => {
    const {plugin} = await setup();
    await plugin.togglePause();
    await plugin.togglePause();
    plugin.getSettings().vaultId = "different-vault";
    expect(plugin.getDiagnostics().records).toEqual([]);
    expect(plugin.getDiagnostics().acceptedCommit).toBeUndefined();
    plugin.onunload();
  });

  it("reports run reasons, transfer counts, phases, request totals and the last accepted version", async () => {
    const {plugin, edit} = await setup();
    edit("A changed article.");
    await plugin.togglePause();
    const view = plugin.getDiagnostics(), record = view.records.at(-1)!;
    expect(record).toMatchObject({triggers: ["resume"], vaultId: "vault-1", outcome: "complete",
      counts: {uploaded: 1, downloaded: 0, deleted: 0, deferred: 0, unsynced: 0}, phase: "saving"});
    expect(record.requests).toBeGreaterThan(0);
    expect(record.sentBytes).toBeGreaterThan(0);
    expect(record.receivedBytes).toBeGreaterThan(0);
    expect(record.phaseDurations?.hashing).toBeDefined();
    expect(view.acceptedCommit).toBe(record.acceptedAfter);
    expect(view.lastSuccessAt).toBe(record.finishedAt);
    expect(view.queued).toBe(false);
    expect(view.pendingLocalChanges).toBe(0);
    expect(record.remoteCheckedAt).toBeDefined();
    plugin.onunload();
  });

  it("bounds fast network retries and lets an explicit manual sync recover later", async () => {
    const {plugin, hooks} = await setup();
    hooks.headFailure = "network";
    await plugin.togglePause();
    for (let count = 2; count <= 4; count++) {
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(plugin.getDiagnostics().records.at(count - 1)?.finishedAt).toBeDefined());
    }
    expect(plugin.getDiagnostics().records).toHaveLength(4);
    expect(plugin.getStatusText()).toMatch(/^出错：/);
    expect(host.notices).toHaveLength(1);
    hooks.headFailure = undefined;
    await plugin.syncNow();
    expect(plugin.getStatusText()).toMatch(/^空闲：/);
    plugin.onunload();
  });

  it.each(["pause", "unload"])("cancels a pending network retry on %s", async action => {
    const {plugin, hooks} = await setup();
    hooks.headFailure = "network";
    await plugin.togglePause();
    const requests = host.requestUrl.mock.calls.length;
    if (action === "pause") await plugin.togglePause(); else plugin.onunload();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.requestUrl.mock.calls.length).toBe(requests);
    expect(plugin.getDiagnostics().records).toHaveLength(1);
    plugin.onunload();
  });

  it("does not fast-retry permissions or authenticated-metadata failures", async () => {
    const {plugin, hooks} = await setup();
    for (const failure of ["forbidden", "corrupt"] as const) {
      hooks.headFailure = failure;
      if (plugin.isPaused()) await plugin.togglePause(); else await plugin.syncNow();
      const requests = host.requestUrl.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(host.requestUrl.mock.calls.length).toBe(requests);
    }
    plugin.onunload();
  });

  it("reconciles an accepted Head after losing its PUT response instead of publishing again", async () => {
    const {plugin, remote, hooks, edit, localText} = await setup();
    let publications = 0;
    hooks.afterHeadPut = () => { if (++publications === 1) throw new Error("Connection reset after PUT"); };
    edit("Saved article including its final sentence.");
    await plugin.togglePause();
    const acceptedHead = (await remote.readHead())!.value.commitId;
    expect(plugin.getStatusText()).toContain("秒后自动重试");
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(plugin.getStatusText()).toMatch(/^空闲：/));
    expect((await remote.readHead())!.value.commitId).toBe(acceptedHead);
    expect(publications).toBe(1);
    const snapshot = await remote.readSnapshot((await remote.readHead())!.value);
    const entry = snapshot.entries["entry-1"];
    if (entry?.kind !== "live") throw new Error("Expected live file");
    expect(new TextDecoder().decode(await remote.readBlob(entry.revision.blobId))).toBe(localText());
    plugin.onunload();
  });

  it("uses a connectivity event to recover without waiting for a scheduled retry", async () => {
    const {plugin, hooks} = await setup();
    hooks.headFailure = "network";
    await plugin.togglePause();
    hooks.headFailure = undefined;
    for (const listener of host.domEvents.get("online") ?? []) {listener(); listener();}
    await vi.waitFor(() => expect(plugin.getStatusText()).toMatch(/^空闲：/));
    expect(plugin.getDiagnostics().records).toHaveLength(2);
    plugin.onunload();
  });

  it("automatically recovers from a temporary 503 using a fresh sync without a failure notice", async () => {
    const {plugin, hooks, remote} = await setup();
    hooks.headFailure = "network";
    await plugin.togglePause();
    expect(plugin.getStatusText()).toContain("秒后自动重试");
    expect(host.notices).toEqual([]);
    hooks.headFailure = undefined;
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(plugin.getStatusText()).toMatch(/^空闲：/u));
    expect((await remote.readHead())?.value.commitId).toBe("initial");
    expect(plugin.getDiagnostics().records.map(record => record.outcome)).toEqual(["retrying", "complete"]);
    plugin.onunload();
  });

  it("records a published Head even when accepting the local cache subsequently fails", async () => {
    const {plugin, remote, hooks, edit} = await setup();
    edit("An unpublished draft.");
    hooks.afterHeadPut = () => {
      hooks.afterHeadPut = undefined;
      host.beforeSave = async () => {host.beforeSave = undefined; throw new Error("Private local filesystem failure");};
    };
    await plugin.togglePause();
    const head = (await remote.readHead())!;
    expect(head.value.commitId).not.toBe("initial");
    expect(plugin.getDiagnostics().records.at(-1)).toMatchObject({outcome: "error", publishedCommit: head.value.commitId});
    expect(plugin.getDiagnostics().records.at(-1)?.acceptedAfter).not.toBe(head.value.commitId);
    expect(plugin.exportDiagnostics()).not.toContain("Private local filesystem failure");
    plugin.onunload();
  });

  it("retains an accepted sync record across reload without exporting content or credentials", async () => {
    const {plugin, app, edit} = await setup();
    edit("Private article text should never enter diagnostics.");
    await plugin.togglePause();
    const before = plugin.getDiagnostics();
    expect(before.records.at(-1)).toMatchObject({outcome: "complete", acceptedBefore: "initial", observedRemote: "initial"});
    expect(before.records.at(-1)?.acceptedAfter).not.toBe("initial");
    expect(before.records.at(-1)?.publishedCommit).toBe(before.records.at(-1)?.acceptedAfter);
    await plugin.togglePause();
    plugin.onunload();
    const replacement = new S3VaultSyncPlugin(app, {id: "s3-vault-sync"} as PluginManifest);
    await replacement.onload();
    expect(replacement.getDiagnostics().records).toEqual(before.records);
    const exported = replacement.exportDiagnostics();
    for (const secret of ["test-key", "test-secret", "test-bucket", "test-prefix", "notes/example.md", "Private article text"]) {
      expect(exported).not.toContain(secret);
    }
    replacement.onunload();
  });
  it.each([
    {device: "Android Wi-Fi", mobile: true, android: true, network: "wifi", mib: 51},
    {device: "iOS Wi-Fi", mobile: true, android: false, network: "wifi", mib: 51},
    {device: "Android cellular", mobile: true, android: true, network: "cellular", mib: 11},
    {device: "iOS unknown network", mobile: true, android: false, network: undefined, mib: 11},
    {device: "desktop", mobile: false, android: false, network: undefined, mib: 51},
  ])("keeps accepted large attachments synchronized on $device", async ({mobile, android, network, mib}) => {
    host.mobile = mobile;
    host.android = android;
    vi.stubGlobal("navigator", {connection: {type: network}});
    const {plugin, remote, localText} = await setup(true, ".obsidian", {
      path: "attachments/large.bin", text: "x".repeat(mib * 1024 * 1024),
    });
    try {
      await plugin.togglePause();
      expect(plugin.getStatusText()).toMatch(/^空闲：/);
      expect(plugin.getLocalIssues()).toEqual([]);
      expect(plugin.getDeferredDownloads()).toEqual([]);
      await plugin.syncNow();
      expect(plugin.getLocalIssues()).toEqual([]);
      expect(plugin.getDeferredDownloads()).toEqual([]);
      expect(localText().length).toBe(mib * 1024 * 1024);
      expect((await remote.readHead())!.value.generation).toBe(1);
    } finally {plugin.onunload();}
  }, 120_000);

  it.each([".obsidian", ".custom-config"])("does not persist a staging backup as a user rename with configDir=%s", async configDir => {
    const {plugin, rename} = await setup(true, configDir);
    rename("notes/example.md", `${configDir}/plugins/s3-vault-sync/staging/write-1.backup`);
    await plugin.saveSettings();
    expect((host.data as {pendingPathRenames: unknown}).pendingPathRenames).toEqual({});
    plugin.onunload();
  });

  it.each([".obsidian", ".custom-config"])("removes persisted staging renames across restart with configDir=%s", async configDir => {
    const {plugin, app, edit, localText} = await setup(true, configDir);
    edit("A newer user edit must survive cleanup.");
    await plugin.saveSettings();
    plugin.onunload();
    const previous = host.data as Record<string, unknown>;
    const userRenames = {
      "notes/user.md": {entryId: "user", toPath: "notes/user-renamed.md"},
      "notes/hidden.md": {entryId: "hidden", toPath: "_private/hidden.md"},
      "_private/returned.md": {entryId: "returned", toPath: "notes/returned.md"},
    };
    host.data = {...previous, pendingPathRenames: {
      ...userRenames,
      "notes/example.md": {entryId: "entry-1", toPath: `${configDir}/plugins/s3-vault-sync/staging/old-write.backup`},
      "notes/legacy.md": {entryId: "legacy", toPath: ".obsidian/plugins/s3-vault-sync/staging/legacy.backup"},
      [`${configDir}/plugins/s3-vault-sync/staging/old-write.new`]: {entryId: "internal", toPath: "notes/restored.md"},
    }};

    const replacement = new S3VaultSyncPlugin(app, {id: "s3-vault-sync"} as PluginManifest);
    await replacement.onload();
    expect((host.data as {pendingPathRenames: unknown}).pendingPathRenames).toEqual(userRenames);
    expect((host.data as {cache: unknown}).cache).toEqual(previous.cache);
    expect(localText()).toBe("A newer user edit must survive cleanup.");
    replacement.onunload();
    const restarted = new S3VaultSyncPlugin(app, {id: "s3-vault-sync"} as PluginManifest);
    await restarted.onload();
    expect((host.data as {pendingPathRenames: unknown}).pendingPathRenames).toEqual(userRenames);
    restarted.onunload();
  });

  it("keeps user rename chains through excluded paths when staging events occur between them", async () => {
    const {plugin, rename} = await setup();
    rename("notes/example.md", "notes/renamed.md");
    rename("notes/renamed.md", ".obsidian/plugins/s3-vault-sync/staging/internal.backup");
    await plugin.saveSettings();
    expect((host.data as {pendingPathRenames: unknown}).pendingPathRenames).toEqual({
      "notes/example.md": {entryId: "entry-1", toPath: "notes/renamed.md"},
    });
    rename(".obsidian/plugins/s3-vault-sync/staging/internal.backup", "notes/renamed.md");
    rename("notes/renamed.md", "_private/renamed.md");
    await plugin.saveSettings();
    expect((host.data as {pendingPathRenames: unknown}).pendingPathRenames).toEqual({
      "notes/example.md": {entryId: "entry-1", toPath: "_private/renamed.md"},
    });
    rename("_private/renamed.md", ".obsidian/plugins/s3-vault-sync/staging-archive/renamed.md");
    await plugin.saveSettings();
    expect((host.data as {pendingPathRenames: unknown}).pendingPathRenames).toEqual({
      "notes/example.md": {entryId: "entry-1", toPath: ".obsidian/plugins/s3-vault-sync/staging-archive/renamed.md"},
    });
    rename(".obsidian/plugins/s3-vault-sync/staging-archive/renamed.md", "notes/final.md");
    await plugin.saveSettings();
    expect((host.data as {pendingPathRenames: unknown}).pendingPathRenames).toEqual({
      "notes/example.md": {entryId: "entry-1", toPath: "notes/final.md"},
    });
    plugin.onunload();
  });

  it("persists a user rename received while synchronization is running", async () => {
    const {plugin, hooks, edit, rename} = await setup();
    edit("A user edit ready to upload.");
    hooks.beforeBlobRead = () => {
      hooks.beforeBlobRead = undefined;
      rename("notes/example.md", "notes/renamed-during-sync.md");
    };
    await plugin.togglePause();
    await plugin.saveSettings();
    expect((host.data as {pendingPathRenames: unknown}).pendingPathRenames).toEqual({
      "notes/example.md": {entryId: "entry-1", toPath: "notes/renamed-during-sync.md"},
    });
    plugin.onunload();
  });

  it("does not delete after its session stops while waiting for a mutation lock", async () => {
    const { app } = await setup();
    const trash = vi.fn(async () => {});
    app.vault.trash = trash;
    let release!: () => void;
    let acquired!: () => void;
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const holding = withVaultMutationLock(app.vault.adapter, () => new Promise<void>(resolve => { release = resolve; acquired(); }));
    await locked;
    let stopped = false;
    const local = new ObsidianVaultPort(app.vault, () => { if (stopped) throw new Error("stopped"); });
    const deleting = local.delete("notes/example.md");
    await vi.advanceTimersByTimeAsync(1);
    stopped = true;
    release();
    await holding;
    await expect(deleting).rejects.toThrow("stopped");
    expect(trash).not.toHaveBeenCalled();
  });

  it("does not remove an unowned probe-like object to make a prefix appear empty", async () => {
    const { plugin, objects } = await setup(false);
    const key = "test-prefix/.s3-vault-sync-probe-00000000-0000-4000-8000-000000000000";
    const original = { body: new TextEncoder().encode("user-owned object"), etag: "user-etag" };
    objects.set(key, original);
    await expect(plugin.initializeOrUnlock("test-password")).rejects.toThrow("前缀不是空的");
    expect(objects.get(key)).toEqual(original);
  });

  it("recovers its probe when unload interrupts an accepted conditional PUT", async () => {
    const { plugin, hooks, app, objects } = await setup(false);
    hooks.afterProbePut = () => {
      hooks.afterProbePut = undefined;
      plugin.onunload();
    };
    await expect(plugin.initializeOrUnlock("test-password")).rejects.toThrow("插件已停止运行");
    expect([...objects.keys()].some(key => key.includes(".s3-vault-sync-probe-"))).toBe(true);
    const replacement = new S3VaultSyncPlugin(app, { id: "s3-vault-sync" } as PluginManifest);
    await replacement.onload();
    await expect(replacement.initializeOrUnlock("test-password")).resolves.toBeUndefined();
    expect(objects.has("test-prefix/v1/head")).toBe(true);
    expect([...objects.keys()].some(key => key.includes(".s3-vault-sync-probe-"))).toBe(false);
  });

  it.each(["bucket", "region", "prefix"] as const)("does not bind a changed %s after initialization starts", async field => {
    const { plugin, hooks, objects } = await setup(false);
    hooks.beforeBlobRead = () => {
      hooks.beforeBlobRead = undefined;
      plugin.getSettings()[field] += "-changed";
    };
    await expect(plugin.initializeOrUnlock("test-password")).rejects.toThrow("S3 目标被改了");
    expect(plugin.getSettings().vaultId).toBeUndefined();
    expect(objects.has("test-prefix/v1/head")).toBe(false);
    expect(host.data).toMatchObject({ pendingInitialization: {
      bucket: "test-bucket", region: "us-east-1", prefix: "test-prefix", phase: "uploading",
    } });
  });

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
      if (status.text.includes("正在检查元数据")) {
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
    await expect(replacement.initializeOrUnlock("test-password")).rejects.toThrow("Head 指针缺失");
    expect(objects.has("test-prefix/v1/head")).toBe(false);
    replacement.onunload();
    host.data = interruptedCheckpoint;
    const rolledBackCache = new S3VaultSyncPlugin(app, { id: "s3-vault-sync" } as PluginManifest);
    await rolledBackCache.onload();
    await expect(rolledBackCache.initializeOrUnlock("test-password")).rejects.toThrow("Head 指针缺失");
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
    await expect(plugin.saveSettings()).rejects.toThrow("插件已停止运行");
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
    expect(plugin.getStatusText()).toContain("等编辑停下后会自动重试");
    expect(host.notices).toEqual([]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect((await remote.readHead())?.value.commitId).toBe("initial");
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(plugin.getStatusText()).toMatch(/^空闲：/u));
    const head = await remote.readHead();
    if (!head) throw new Error("Expected accepted Head");
    const snapshot = await remote.readSnapshot(head.value);
    const entry = snapshot.entries["entry-1"];
    if (entry?.kind !== "live") throw new Error("Expected live article");
    expect(new TextDecoder().decode(await remote.readBlob(entry.revision.blobId))).toBe(localText());
    expect(localText()).toBe("The complete paragraph and its final sentence.");
    for (let poll = 0; poll < 2; poll += 1) {
      await vi.advanceTimersByTimeAsync(120_000);
      await vi.waitFor(() => expect(plugin.getStatusText()).toMatch(/^空闲：/u));
    }
    expect(await remote.readHead()).toMatchObject({ etag: head.etag, value: head.value });
    expect(plugin.getStatusText()).toMatch(/^空闲：/u);
    expect(host.notices).toEqual([]);
  });

  it("still displays Paused when an active synchronization finishes after pausing", async () => {
    const { plugin } = await setup();
    const stop = plugin.onStatusChange(status => {
      if (status.text.includes("正在检查元数据")) {
        stop();
        void plugin.togglePause();
      }
    });
    await plugin.togglePause();
    expect(plugin.isPaused()).toBe(true);
    expect(plugin.getStatusText()).toMatch(/^已暂停：/u);
  });

  it.each(["network", "corrupt"] as const)("does not hide a %s failure after pausing", async failure => {
    const { plugin, hooks } = await setup();
    const stop = plugin.onStatusChange(status => {
      if (status.text.startsWith("检查中：正在读取")) {
        stop();
        hooks.headFailure = failure;
        void plugin.togglePause();
      }
    });
    await plugin.togglePause();
    expect(plugin.isPaused()).toBe(true);
    expect(plugin.getStatusText()).toMatch(failure === "network" ? /^出错：/u : /^需要处理：/u);
    expect(host.notices).toHaveLength(1);
    const openStatus = vi.spyOn(plugin, "openStatus").mockImplementation(() => {});
    expect(host.noticeActions[0]?.text).toBe("打开同步状态");
    host.noticeActions[0]?.click({stopPropagation() {}});
    expect(openStatus).toHaveBeenCalledOnce();
  });

  it("propagates a manual download failure so its confirmation cannot close as a success", async () => {
    const {plugin, hooks} = await setup();
    hooks.headFailure = "network";
    await expect(plugin.downloadDeferred("entry-1")).rejects.toThrow("503");
    expect(plugin.getStatusText()).toMatch(/^出错：/);
  });
});

describe("opening sync status when synchronization stops", () => {
  it("opens sync status once when a sync needs a Bulk Deletion decision", async () => {
    const {plugin, setLocalPresent} = await setup();
    setLocalPresent(false);
    await plugin.togglePause();
    expect(plugin.getStatusText()).toMatch(/^需要处理：请审查并确认这次批量删除/u);
    expect(host.openedModals).toHaveLength(1);
    plugin.onunload();
  });

  it.each(["forbidden", "corrupt"] as const)("opens sync status once at once for a %s failure", async failure => {
    const {plugin, hooks} = await setup();
    hooks.headFailure = failure;
    await plugin.togglePause();
    expect(plugin.getStatusText()).toMatch(failure === "forbidden" ? /^出错：/u : /^需要处理：修复模式/u);
    expect(host.openedModals).toHaveLength(1);
    expect(host.notices).toHaveLength(1);
    expect(host.noticeActions.map(action => action.text)).toEqual(["打开同步状态"]);
    plugin.onunload();
  });

  it("opens sync status once per problem until it changes or a sync succeeds", async () => {
    const {plugin, hooks, setLocalPresent} = await setup();
    setLocalPresent(false);
    await plugin.togglePause();
    expect(host.openedModals).toHaveLength(1);
    host.openedModals[0]!.close();
    await plugin.syncNow();
    expect(plugin.getStatusText()).toMatch(/^需要处理：/u);
    expect(host.openedModals).toHaveLength(1);
    hooks.headFailure = "forbidden";
    await plugin.syncNow();
    expect(plugin.getStatusText()).toMatch(/^出错：/u);
    expect(host.openedModals).toHaveLength(2);
    host.openedModals[1]!.close();
    hooks.headFailure = undefined;
    setLocalPresent(true);
    await plugin.syncNow();
    expect(plugin.getStatusText()).toMatch(/^空闲：/u);
    setLocalPresent(false);
    await plugin.syncNow();
    expect(plugin.getStatusText()).toMatch(/^需要处理：/u);
    expect(host.openedModals).toHaveLength(3);
    plugin.onunload();
  });

  it("does not open another sync status window while one is open", async () => {
    const {plugin, hooks, setLocalPresent} = await setup();
    setLocalPresent(false);
    await plugin.togglePause();
    expect(host.openedModals).toHaveLength(1);
    hooks.headFailure = "forbidden";
    await plugin.syncNow();
    expect(plugin.getStatusText()).toMatch(/^出错：/u);
    expect(host.openedModals).toHaveLength(1);
    host.openedModals[0]!.close();
    await plugin.syncNow();
    expect(host.openedModals).toHaveLength(1);
    plugin.onunload();
  });

  it("does not open sync status for settings validation or unlock errors", async () => {
    const {plugin} = await setup();
    await expect(plugin.saveAwsCredentials({accessKeyId: "test-key", secretAccessKey: ""})).rejects.toThrow();
    await expect(plugin.initializeOrUnlock("")).rejects.toThrow();
    expect(plugin.getStatusText()).toMatch(/^出错：/u);
    expect(host.notices).toHaveLength(2);
    expect(host.openedModals).toHaveLength(0);
    plugin.onunload();
  });

  const stubSyncResult = (localIssues: LocalSyncIssue[]) =>
    vi.spyOn(SyncService.prototype, "synchronize").mockResolvedValue({
      cacheUpdated: false, deferredDownloadEntries: [], deferredDownloads: 0, deleted: 0, downloaded: 0, downloads: [],
      localIssues, status: "action-required", unsyncedLocalEntries: 0, uploaded: 0, uploads: [],
    });

  it("does not open sync status when a sync only reports unsynced local files", async () => {
    const {plugin} = await setup();
    const synchronize = stubSyncResult([{kind: "unsynced-local", path: "notes/example.md"}]);
    await plugin.togglePause();
    expect(plugin.getStatusText()).toMatch(/^需要处理：/u);
    expect(host.openedModals).toHaveLength(0);
    synchronize.mockRestore();
    plugin.onunload();
  });

  it("opens sync status once for a possible rename review", async () => {
    const {plugin} = await setup();
    const synchronize = stubSyncResult([
      {kind: "possible-rename", oldPaths: ["notes/example.md"], newPaths: ["notes/moved.md"], reviewToken: "token-1"},
      {kind: "unsynced-local", path: "notes/other.md"},
    ]);
    await plugin.togglePause();
    expect(host.openedModals).toHaveLength(1);
    host.openedModals[0]!.close();
    synchronize.mockResolvedValue({
      cacheUpdated: false, deferredDownloadEntries: [], deferredDownloads: 0, deleted: 0, downloaded: 0, downloads: [],
      localIssues: [
        {kind: "possible-rename", oldPaths: ["notes/example.md"], newPaths: ["notes/moved.md"], reviewToken: "token-1"},
        {kind: "unsynced-local", path: "notes/third.md"},
      ],
      status: "action-required", unsyncedLocalEntries: 0, uploaded: 0, uploads: [],
    });
    await plugin.syncNow();
    expect(plugin.getStatusText()).toMatch(/^需要处理：/u);
    expect(host.openedModals).toHaveLength(1);
    synchronize.mockRestore();
    plugin.onunload();
  });

  // 同步里的加密运算走真实线程，假时钟管不到。一下子把时间拨很久，机器忙时同步还没跑到失败，时钟就已经拨过去了，
  // 「连续断网 30 分钟」就会从晚了的时间点开始算。所以每次只拨 1 秒，每拨一步都等正在跑的同步结束再拨下一步。
  // 等待期间每次拨 1 毫秒，让同步里的让步计时器能触发；这部分时间也算进总时长，总共拨过的仍是 ms。
  const settle = async (plugin: S3VaultSyncPlugin, ms: number) => {
    const queue = (plugin as unknown as {syncRequests: {isRunning: boolean}}).syncRequests;
    const waitUntilIdle = async () => {
      for (let attempt = 0; queue.isRunning; attempt += 1) {
        if (attempt > 2_000) throw new Error("同步一直没有结束");
        await vi.advanceTimersByTimeAsync(1);
        if (queue.isRunning) await realDelay(1);
      }
    };
    const end = Date.now() + ms;
    await waitUntilIdle();
    while (Date.now() < end) {
      await vi.advanceTimersByTimeAsync(Math.min(1_000, end - Date.now()));
      await waitUntilIdle();
    }
  };

  it("opens sync status only after network failures continue for 30 minutes", async () => {
    const {plugin, hooks} = await setup();
    hooks.headFailure = "network";
    await plugin.togglePause();
    await settle(plugin, 29 * 60_000);
    expect(plugin.getStatusText()).toMatch(/^出错：/u);
    expect(host.notices.length).toBeGreaterThan(0);
    expect(host.openedModals).toHaveLength(0);
    await settle(plugin, 2 * 60_000);
    expect(host.openedModals).toHaveLength(1);
    await settle(plugin, 10 * 60_000);
    expect(host.openedModals).toHaveLength(1);
    plugin.onunload();
  });

  it("opens sync status once for one network outage that fails different operations", async () => {
    const {plugin, hooks, edit} = await setup();
    hooks.headFailure = "network";
    await plugin.togglePause();
    await settle(plugin, 31 * 60_000);
    expect(host.openedModals).toHaveLength(1);
    host.openedModals[0]!.close();
    const headFailure = plugin.getStatusText();
    const protocol = host.requestUrl.getMockImplementation() as ObsidianRequestExecutor;
    host.requestUrl.mockImplementation((request: Parameters<ObsidianRequestExecutor>[0]) =>
      request.method === "PUT" && request.url.includes("/blobs/")
        ? Promise.resolve({status: 503, arrayBuffer: new ArrayBuffer(0), headers: {}})
        : protocol(request));
    hooks.headFailure = undefined;
    edit("An edit made while the network is still failing.");
    await settle(plugin, 10 * 60_000);
    expect(plugin.getStatusText()).toMatch(/^出错：/u);
    expect(plugin.getStatusText()).not.toBe(headFailure);
    expect(host.openedModals).toHaveLength(1);
    plugin.onunload();
  });

  it("restarts the 30 minute network wait after one successful sync", async () => {
    const {plugin, hooks} = await setup();
    hooks.headFailure = "network";
    await plugin.togglePause();
    await settle(plugin, 20 * 60_000);
    hooks.headFailure = undefined;
    await settle(plugin, 2 * 60_000);
    expect(plugin.getStatusText()).toMatch(/^空闲：/u);
    hooks.headFailure = "network";
    await settle(plugin, 2 * 60_000);
    await settle(plugin, 16 * 60_000);
    expect(plugin.getStatusText()).toMatch(/^出错：/u);
    expect(host.openedModals).toHaveLength(0);
    await settle(plugin, 16 * 60_000);
    expect(host.openedModals).toHaveLength(1);
    plugin.onunload();
  });

  it.each([
    {device: "Android", android: true},
    {device: "iOS", android: false},
  ])("applies the same popup rules on $device", async ({android}) => {
    host.mobile = true;
    host.android = android;
    const {plugin, hooks, setLocalPresent} = await setup();
    hooks.headFailure = "network";
    await plugin.togglePause();
    await settle(plugin, 29 * 60_000);
    expect(host.openedModals).toHaveLength(0);
    await settle(plugin, 2 * 60_000);
    expect(host.openedModals).toHaveLength(1);
    host.openedModals[0]!.close();
    hooks.headFailure = undefined;
    await plugin.syncNow();
    expect(plugin.getStatusText()).toMatch(/^空闲：/u);
    setLocalPresent(false);
    await plugin.syncNow();
    expect(plugin.getStatusText()).toMatch(/^需要处理：/u);
    expect(host.openedModals).toHaveLength(2);
    await plugin.syncNow();
    expect(host.openedModals).toHaveLength(2);
    plugin.onunload();
  });
});

describe("manual cleanup from the status window", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const HOUR_MS = 60 * 60 * 1000;
  const ORPHANS = ["3c9a7e10-2b4d-4f6a-8c1e-5d7f9a0b2c4e", "7e1d2c3b-4a5f-4b6c-8d7e-9f0a1b2c3d4e", "a0b1c2d3-e4f5-4a6b-9c7d-8e9f0a1b2c3d"];
  const blobKeyOf = (blobId: string) => `test-prefix/v1/blobs/${blobId}`;
  type Objects = Map<string, { body: Uint8Array; etag: string; lastModified?: number }>;
  type Request = { method: string; url: string };
  const requests = () => host.requestUrl.mock.calls.map(([request]) => request as Request);
  const deletes = () => requests().filter((request) => request.method === "DELETE");
  const writes = () => requests().filter((request) => request.method === "PUT" || request.method === "DELETE");
  // AWS 时间（假 S3 的 date 头）和设备时间一起往前拨
  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

  // 远端多一条已删除记录，它的恢复副本早已过期；blobId 可以指定（比如和现有文件同一份内容）
  const addExpiredRecovery = async (remote: RemoteStore, entryId: string, path: string, blobId?: string) => {
    const body = new TextEncoder().encode(blobId ? "Original article." : `long gone ${entryId}`);
    const id = blobId ?? crypto.randomUUID();
    if (!blobId) await remote.writeBlob(id, body);
    const { sha256Content } = await import("../src/sync/content-hash");
    const head = (await remote.readHead())!;
    const commitId = crypto.randomUUID();
    await remote.advance({
      commit: { changes: [{ kind: "set-entry", entry: {
        deletedAt: "2020-01-01T00:00:00.000Z", entryId, kind: "deleted", lastContentHash: await sha256Content(body),
        lastRevisionId: `${entryId}-revision`, path,
        recovery: { blobId: id, contentHash: await sha256Content(body), createdAt: "2020-01-01T00:00:00.000Z",
          expiresAt: "2020-01-31T00:00:00.000Z", revisionId: `${entryId}-revision`, size: body.byteLength },
      } }], commitId, createdAt: head.serverDate, parentIds: [head.value.commitId], protocolVersion: 1,
      replicaId: "phone", vaultId: "vault-1" },
      expectedHeadEtag: head.etag,
      head: { ...head.value, commitId, generation: head.value.generation + 1 },
    });
    return id;
  };
  // 40 天前上传、没有任何记录引用的数据块（早于 Head 对象的 LastModified）
  const plant = (objects: Objects, blobIds = [ORPHANS[0]!]) => {
    for (const blobId of blobIds) {
      objects.set(blobKeyOf(blobId), { body: new Uint8Array(1234), etag: `"orphan-${blobId}"`, lastModified: Date.now() - 40 * DAY_MS });
    }
  };
  const recordOf = async (remote: RemoteStore, entryId: string) => {
    const head = (await remote.readHead())!;
    return (await remote.readSnapshot(head.value)).entries[entryId];
  };
  const recoveryOf = async (remote: RemoteStore, entryId: string) => {
    const entry = await recordOf(remote, entryId);
    return entry?.kind === "deleted" ? entry.recovery : undefined;
  };

  // 电脑上：远端有两份过期的备份（gone、other）和一个 40 天前的无对应文件的数据块
  const desktop = async (orphans = [ORPHANS[0]!]) => {
    host.desktop = true;
    const fixture = await setup();
    const goneBlob = await addExpiredRecovery(fixture.remote, "gone", "old/gone.md");
    const otherBlob = await addExpiredRecovery(fixture.remote, "other", "old/other.md");
    // 过期备份的数据块上传于删除之前，早已满 30 天
    for (const blobId of [goneBlob, otherBlob]) fixture.objects.get(blobKeyOf(blobId))!.lastModified = Date.now() - 40 * DAY_MS;
    plant(fixture.objects, orphans);
    // 第一次同步只为让本机接受现在的记录
    await fixture.plugin.togglePause();
    expect(fixture.plugin.getStatusText()).toMatch(/^空闲：/u);
    return { ...fixture, goneBlob };
  };
  const keyOf = (plugin: S3VaultSyncPlugin, match: (candidate: { kind: string; path?: string; blobId: string }) => boolean) => {
    const found = plugin.getCleanupView()!.candidates.find(match);
    if (!found) throw new Error("Expected the candidate in the cleanup list");
    return found.key;
  };
  const confirmed = async (plugin: S3VaultSyncPlugin, paths: string[], orphans: string[] = []) => {
    await plugin.loadCleanup();
    const keys = [
      ...paths.map((path) => keyOf(plugin, (candidate) => candidate.path === path)),
      ...orphans.map((blobId) => keyOf(plugin, (candidate) => candidate.kind === "orphan" && candidate.blobId === blobId)),
    ];
    await plugin.confirmCleanup(keys, true);
    return keys;
  };

  it("counts what can be cleaned without reading S3, only on the desktop, and only for the current target", async () => {
    const { plugin } = await desktop();
    // 一次完全成功的同步之后算过一次：两份备份 + 一个数据块
    expect(plugin.getCleanupCount()).toBe(3);
    const before = requests().length;
    expect(plugin.getCleanupCount()).toBe(3);
    expect(requests().length).toBe(before);
    // 确认删除的项目从数字里减掉，不读 S3
    await confirmed(plugin, ["old/gone.md"]);
    const afterConfirm = requests().length;
    expect(plugin.getCleanupCount()).toBe(2);
    expect(requests().length).toBe(afterConfirm);
    // 目标变了：结果作废
    plugin.getSettings().bucket = "another-bucket";
    expect(plugin.getCleanupCount()).toBe(0);
    plugin.getSettings().bucket = "test-bucket";
    // 手机上没有这个入口，也不能打开列表
    expect(plugin.cleanupController()).toBe(plugin);
    host.desktop = false;
    expect(plugin.cleanupController()).toBeUndefined();
    expect(plugin.getCleanupCount()).toBeUndefined();
    await expect(plugin.loadCleanup()).rejects.toThrow("电脑");
    plugin.onunload();
  });

  it("refreshes the count at most once per 24 hours of AWS time after a complete sync", async () => {
    const { plugin, remote } = await desktop();
    expect(plugin.getCleanupCount()).toBe(3);
    await addExpiredRecovery(remote, "later", "old/later.md");
    await plugin.syncNow();
    expect(plugin.getCleanupCount()).toBe(3);
    advance(25 * HOUR_MS);
    await plugin.syncNow();
    expect(plugin.getCleanupCount()).toBe(4);
    plugin.onunload();
  });

  it("lists the three groups, records a confirmation without writing to S3, and lets an undo put it back", async () => {
    const { plugin, remote } = await desktop();
    const view = await plugin.loadCleanup();
    expect(view.candidates.map((candidate) => [candidate.kind, candidate.kind === "orphan" ? candidate.blobId : candidate.path]))
      .toEqual([["recovery", "old/gone.md"], ["recovery", "old/other.md"], ["orphan", ORPHANS[0]]]);
    // 当前在用的文件不在列表里
    expect(view.candidates.some((candidate) => candidate.kind !== "orphan" && candidate.path === "notes/example.md")).toBe(false);
    const key = keyOf(plugin, (candidate) => candidate.path === "old/gone.md");
    const writesBefore = writes().length;

    // 第一次删除要先确认所有设备都已更新
    expect(plugin.needsCleanupDeviceConfirmation()).toBe(true);
    await expect(plugin.confirmCleanup([key], false)).rejects.toThrow("0.1.10");
    const requestsBefore = requests().length;
    await plugin.confirmCleanup([key], true);
    expect(plugin.needsCleanupDeviceConfirmation()).toBe(false);

    expect(requests().length).toBe(requestsBefore);
    const pending = plugin.getCleanupView()!;
    expect(pending.candidates.map((candidate) => candidate.key)).not.toContain(key);
    expect(pending.pending).toEqual([expect.objectContaining({ key, kind: "recovery", path: "old/gone.md", confirmedAt: view.serverDate })]);

    await plugin.undoCleanup(key);

    expect(requests().length).toBe(requestsBefore);
    expect(plugin.getCleanupView()!.pending).toEqual([]);
    expect(plugin.getCleanupView()!.candidates.map((candidate) => candidate.key)).toContain(key);
    expect(writes().length).toBe(writesBefore);
    expect(await recoveryOf(remote, "gone")).toBeDefined();
    // 撤销后过多久同步都不处理它
    advance(3 * DAY_MS);
    await plugin.syncNow();
    expect(await recoveryOf(remote, "gone")).toBeDefined();
    expect(deletes()).toEqual([]);
    plugin.onunload();
  });

  it("writes one sync activity line per confirmation and undo with counts and bytes but no blob names", async () => {
    const { plugin, app, diagnosticFiles } = await desktop();
    const manualRecords = () => plugin.getSyncActivity()!.records.filter((record) => record.kind === "manual");
    await plugin.loadCleanup();
    const goneKey = keyOf(plugin, (candidate) => candidate.path === "old/gone.md");
    const orphanKey = keyOf(plugin, (candidate) => candidate.kind === "orphan");
    // 第一次没确认所有设备已更新：操作抛错，不记
    await expect(plugin.confirmCleanup([goneKey, orphanKey], false)).rejects.toThrow("0.1.10");
    expect(manualRecords()).toEqual([]);

    await plugin.confirmCleanup([goneKey, orphanKey], true);
    await plugin.undoCleanup(orphanKey);

    expect(manualRecords().map((record) => [record.summary, record.files])).toEqual([
      ["待清理：确认删除 2 份数据（1 KB）", []],
      ["待清理：撤销 1 份数据（1 KB）", []],
    ]);
    const saved = diagnosticFiles.get(`${app.vault.configDir}/plugins/s3-vault-sync/sync-activity.json`)!;
    expect(saved).not.toContain(ORPHANS[0]!);
    expect(saved).not.toContain(orphanKey);
    plugin.onunload();
  });

  it("changes nothing before 24 hours of AWS time even when the device clock is 60 days ahead", async () => {
    const { plugin, remote, objects, hooks } = await desktop();
    await confirmed(plugin, ["old/gone.md"], [ORPHANS[0]!]);
    advance(60 * DAY_MS);
    hooks.awsOffsetMs = -60 * DAY_MS + 23 * HOUR_MS;

    await plugin.syncNow();

    expect(plugin.getStatusText()).toMatch(/^空闲：/u);
    expect(await recoveryOf(remote, "gone")).toBeDefined();
    expect(objects.has(blobKeyOf(ORPHANS[0]!))).toBe(true);
    expect(deletes()).toEqual([]);
    plugin.onunload();
  });

  it("removes only the confirmed backup from the record after 24 hours, and deletes its data 24 hours after that", async () => {
    const { plugin, remote, objects, goneBlob } = await desktop();
    await confirmed(plugin, ["old/gone.md"], [ORPHANS[0]!]);
    advance(25 * HOUR_MS);

    await plugin.syncNow();

    expect(plugin.getStatusText()).toMatch(/^空闲：/u);
    // 只去掉确认过的那份；删除记录本身保留；没确认的过期备份仍在记录里
    expect(await recordOf(remote, "gone")).toMatchObject({ kind: "deleted", path: "old/gone.md", deletedAt: "2020-01-01T00:00:00.000Z" });
    expect(await recoveryOf(remote, "gone")).toBeUndefined();
    expect(await recoveryOf(remote, "other")).toBeDefined();
    // 这一次不删备份的数据；确认满 24 小时的无对应文件的数据删掉了，DELETE 不带 versionId
    expect(objects.has(blobKeyOf(goneBlob))).toBe(true);
    expect(objects.has(blobKeyOf(ORPHANS[0]!))).toBe(false);
    expect(deletes().map((request) => { const url = new URL(request.url); return [url.pathname, url.search]; }))
      .toEqual([[`/${blobKeyOf(ORPHANS[0]!)}`, ""]]);
    expect(plugin.getDiagnostics().records.at(-1)).toMatchObject({
      expiredContentCleanup: { removedHistory: 0, removedRecoveries: 1 }, blobCleanup: { deletedBlobs: 1, deletedBytes: 1234 },
    });
    expect(plugin.getCleanupView()!.pending.map((item) => item.path)).toEqual(["old/gone.md"]);
    expect(plugin.exportDiagnostics()).not.toContain("old/gone.md");

    advance(25 * HOUR_MS);
    await plugin.syncNow();

    expect(objects.has(blobKeyOf(goneBlob))).toBe(false);
    expect(plugin.getCleanupView()!.pending).toEqual([]);
    expect(plugin.getStatusText()).toMatch(/^空闲：/u);
    plugin.onunload();
  });

  it("keeps the data of a backup whose content an existing file still uses, and drops it from the queue", async () => {
    host.desktop = true;
    const { plugin, remote, objects } = await setup();
    await addExpiredRecovery(remote, "same", "old/same.md", ORIGINAL_BLOB_ID);
    await plugin.togglePause();
    const view = await plugin.loadCleanup();
    expect(view.candidates).toEqual([expect.objectContaining({ path: "old/same.md", sharedWith: { path: "notes/example.md" } })]);
    await plugin.confirmCleanup([view.candidates[0]!.key], true);
    advance(25 * HOUR_MS);
    await plugin.syncNow();
    advance(25 * HOUR_MS);
    await plugin.syncNow();

    expect(objects.has(blobKeyOf(ORIGINAL_BLOB_ID))).toBe(true);
    expect(deletes()).toEqual([]);
    expect(plugin.getCleanupView()!.pending).toEqual([]);
    expect(plugin.getStatusText()).toMatch(/^空闲：/u);
    plugin.onunload();
  });

  it("does not delete a confirmed blob that the record references again", async () => {
    const { plugin, remote, objects } = await desktop();
    await confirmed(plugin, [], [ORPHANS[0]!]);
    // 确认之后，别的设备发布了引用这个数据块的提交（一条带旧版本的删除记录，不需要下载）
    const { sha256Content } = await import("../src/sync/content-hash");
    const body = new TextEncoder().encode("picked up again");
    objects.delete(blobKeyOf(ORPHANS[0]!));
    await remote.writeBlob(ORPHANS[0]!, body);
    objects.get(blobKeyOf(ORPHANS[0]!))!.lastModified = Date.now() - 40 * DAY_MS;
    const head = (await remote.readHead())!;
    const commitId = crypto.randomUUID();
    const contentHash = await sha256Content(body);
    await remote.advance({
      commit: { changes: [{ kind: "set-entry", entry: { deletedAt: head.serverDate, entryId: "picked", kind: "deleted",
        lastContentHash: contentHash, lastRevisionId: "picked", path: "picked.md", history: [{
          blobId: ORPHANS[0]!, contentHash, createdAt: head.serverDate, expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
          revisionId: "picked", size: body.byteLength,
        }] } }], commitId, createdAt: head.serverDate, parentIds: [head.value.commitId], protocolVersion: 1, replicaId: "phone", vaultId: "vault-1" },
      expectedHeadEtag: head.etag, head: { ...head.value, commitId, generation: head.value.generation + 1 },
    });
    advance(25 * HOUR_MS);

    await plugin.syncNow();

    expect(objects.has(blobKeyOf(ORPHANS[0]!))).toBe(true);
    expect(deletes()).toEqual([]);
    expect(plugin.getCleanupView()!.pending).toEqual([]);
    plugin.onunload();
  });

  it("deletes nothing and reports it when the blob folder holds an unexpected name, then waits an hour before trying again", async () => {
    const { plugin, objects } = await desktop();
    await confirmed(plugin, [], [ORPHANS[0]!]);
    advance(25 * HOUR_MS);
    objects.set("test-prefix/v1/blobs/not-a-uuid", { body: new Uint8Array(1), etag: "\"stray\"", lastModified: Date.now() - 40 * DAY_MS });

    await plugin.syncNow();

    expect(deletes()).toEqual([]);
    expect(objects.has(blobKeyOf(ORPHANS[0]!))).toBe(true);
    expect(plugin.getStatusText()).toContain("这次不删除任何数据块");
    // 原因排除了，1 小时内也不再重试
    objects.delete("test-prefix/v1/blobs/not-a-uuid");
    advance(30 * 60 * 1000);
    await plugin.syncNow();
    expect(plugin.getStatusText()).toMatch(/^空闲：/u);
    expect(objects.has(blobKeyOf(ORPHANS[0]!))).toBe(true);
    advance(31 * 60 * 1000);
    await plugin.syncNow();
    expect(objects.has(blobKeyOf(ORPHANS[0]!))).toBe(false);
    plugin.onunload();
  });

  it.each(["bucket", "region", "prefix"] as const)("sends no further DELETE once the %s changes during the run", async (field) => {
    const { plugin, objects } = await desktop(ORPHANS);
    await confirmed(plugin, [], ORPHANS);
    advance(25 * HOUR_MS);
    const execute = host.requestUrl.getMockImplementation() as ObsidianRequestExecutor;
    host.requestUrl.mockImplementation(async (request: Parameters<ObsidianRequestExecutor>[0]) => {
      const response = await execute(request);
      if (request.method === "DELETE") plugin.getSettings()[field] = field === "region" ? "eu-west-1" : `other-${field}`;
      return response;
    });

    await plugin.syncNow();

    expect(deletes()).toHaveLength(1);
    expect(ORPHANS.filter((blobId) => objects.has(blobKeyOf(blobId)))).toHaveLength(2);
    expect(plugin.getStatusText()).toContain("S3 目标被改了");
    plugin.onunload();
  });

  it("waits while a Conflict is unresolved and says why on the list", async () => {
    const { plugin, remote } = await desktop();
    await confirmed(plugin, ["old/gone.md"]);
    advance(25 * HOUR_MS);
    const head = (await remote.readHead())!;
    const commitId = crypto.randomUUID();
    const body = new TextEncoder().encode("candidate");
    await remote.writeBlob("candidate-blob", body);
    const { sha256Content } = await import("../src/sync/content-hash");
    await remote.advance({
      commit: { changes: [{ kind: "set-entry", entry: { candidates: [{ blobId: "candidate-blob",
        contentHash: await sha256Content(body), createdAt: head.serverDate, revisionId: "candidate", size: body.byteLength }],
        entryId: "conflict", kind: "conflicted", path: "other/conflict.md", reason: "edit-edit" } }],
      commitId, createdAt: head.serverDate, parentIds: [head.value.commitId], protocolVersion: 1, replicaId: "phone", vaultId: "vault-1" },
      expectedHeadEtag: head.etag, head: { ...head.value, commitId, generation: head.value.generation + 1 },
    });

    await plugin.syncNow();

    expect(plugin.getStatusText()).toMatch(/^需要处理：/u);
    expect(await recoveryOf(remote, "gone")).toBeDefined();
    expect(plugin.getCleanupView()!.blockedReason).toBe("有冲突还没处理，清理会等你处理完再继续。");
    plugin.onunload();
  });

  it("processes on the next complete sync once a Bulk Deletion decision no longer blocks it", async () => {
    const { plugin, remote, setLocalPresent } = await desktop();
    await confirmed(plugin, ["old/gone.md"]);
    advance(25 * HOUR_MS);
    setLocalPresent(false);
    await plugin.syncNow();
    expect(plugin.getStatusText()).toMatch(/^需要处理：/u);
    expect(await recoveryOf(remote, "gone")).toBeDefined();
    expect(plugin.getCleanupView()!.blockedReason).toBe("有批量删除等你确认，清理会等你确认后再继续。");

    setLocalPresent(true);
    await plugin.syncNow();

    expect(plugin.getStatusText()).toMatch(/^空闲：/u);
    expect(await recoveryOf(remote, "gone")).toBeUndefined();
    expect(plugin.getCleanupView()!.blockedReason).toBeUndefined();
    plugin.onunload();
  });

  it("neither shows nor processes anything on a phone", async () => {
    const { plugin, remote, objects } = await desktop();
    await confirmed(plugin, ["old/gone.md"], [ORPHANS[0]!]);
    host.desktop = false;
    advance(3 * DAY_MS);

    await plugin.syncNow();

    expect(plugin.getStatusText()).toMatch(/^空闲：/u);
    expect(await recoveryOf(remote, "gone")).toBeDefined();
    expect(objects.has(blobKeyOf(ORPHANS[0]!))).toBe(true);
    expect(deletes()).toEqual([]);
    plugin.onunload();
  });

  it("drops the old automatic-cleanup data on load and never cleans automatically", async () => {
    host.desktop = true;
    const { plugin, remote, objects, app } = await setup();
    await addExpiredRecovery(remote, "gone", "old/gone.md");
    plant(objects);
    plugin.onunload();
    const target = JSON.stringify(["test-bucket", "us-east-1", "test-prefix", "vault-1"]);
    Object.assign(host.data as object, {
      expiredContentCleanup: { target, lastRunServerDate: new Date(Date.now() - 3 * DAY_MS).toISOString() },
      unreferencedBlobMarks: { target, firstSeen: { [ORPHANS[0]!]: new Date(Date.now() - 3 * DAY_MS).toISOString() } },
    });
    const replacement = new S3VaultSyncPlugin(app, { id: "s3-vault-sync" } as PluginManifest);
    await replacement.onload();
    expect(host.data).not.toHaveProperty("expiredContentCleanup");
    expect(host.data).not.toHaveProperty("unreferencedBlobMarks");

    await replacement.togglePause();
    advance(3 * DAY_MS);
    await replacement.syncNow();

    expect(replacement.getStatusText()).toMatch(/^空闲：/u);
    expect(await recoveryOf(remote, "gone")).toBeDefined();
    expect(objects.has(blobKeyOf(ORPHANS[0]!))).toBe(true);
    expect(deletes()).toEqual([]);
    // 那些数据块出现在「找不到对应文件的数据」里，等用户确认
    expect((await replacement.loadCleanup()).candidates.some((candidate) => candidate.kind === "orphan" && candidate.blobId === ORPHANS[0])).toBe(true);
    replacement.onunload();
  });
});

describe("manual cleanup that keeps losing the Head race", () => {
  it("gives up quietly after the retries and tries again after the next sync", async () => {
    host.desktop = true;
    const { plugin, remote } = await setup();
    const body = new TextEncoder().encode("long gone");
    const blobId = crypto.randomUUID();
    await remote.writeBlob(blobId, body);
    const { sha256Content } = await import("../src/sync/content-hash");
    const head = (await remote.readHead())!;
    const commitId = crypto.randomUUID();
    await remote.advance({
      commit: { changes: [{ kind: "set-entry", entry: {
        deletedAt: "2020-01-01T00:00:00.000Z", entryId: "gone", kind: "deleted", lastContentHash: await sha256Content(body),
        lastRevisionId: "gone-revision", path: "old/gone.md",
        recovery: { blobId, contentHash: await sha256Content(body), createdAt: "2020-01-01T00:00:00.000Z",
          expiresAt: "2020-01-31T00:00:00.000Z", revisionId: "gone-revision", size: body.byteLength },
      } }], commitId, createdAt: head.serverDate, parentIds: [head.value.commitId], protocolVersion: 1, replicaId: "phone", vaultId: "vault-1" },
      expectedHeadEtag: head.etag, head: { ...head.value, commitId, generation: head.value.generation + 1 },
    });
    const view = await plugin.loadCleanup();
    await plugin.confirmCleanup(view.candidates.map((candidate) => candidate.key), true);
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    const { HeadChangedError } = await import("../src/storage/remote-store");
    const cleanup = vi.spyOn(SyncService.prototype, "cleanupExpiredContent").mockRejectedValue(new HeadChangedError());

    // 重试之间的等待用的是假计时器，一点点往前拨直到这次同步结束。同步里的加密运算走真实线程，假时钟管不到：
    // 机器忙时一口气拨完，加密还没做完，重试的等待就落在拨完之后、再没人拨。所以每拨 50 毫秒都真等 1 毫秒让加密跑完；
    // 拨满 100 秒（远超最长约 7.5 秒的重试等待，又不到 120 秒的定时同步）还没结束就直接报错，不干等到超时
    const settle = async (run: Promise<void>) => {
      let done = false;
      void run.finally(() => { done = true; });
      for (let step = 0; !done; step++) {
        if (step >= 2_000) throw new Error("同步一直没有结束");
        await vi.advanceTimersByTimeAsync(50);
        if (!done) await realDelay(1);
      }
      await run;
    };
    // 无论成败都撤掉模拟失败
    try {
      await settle(plugin.togglePause());

      expect(cleanup).toHaveBeenCalledTimes(5);
      expect(plugin.getStatusText()).toMatch(/^空闲：/u);
      expect(plugin.getDiagnostics().records.at(-1)).toMatchObject({ outcome: "complete" });
      expect(plugin.getDiagnostics().records.at(-1)!.expiredContentCleanup).toBeUndefined();
      expect(plugin.getCleanupView()!.pending).toHaveLength(1);
      await settle(plugin.syncNow());
      expect(cleanup).toHaveBeenCalledTimes(10);
    } finally {
      cleanup.mockRestore();
    }
    plugin.onunload();
  });
});

describe("local sync activity on the desktop", () => {
  const activityPath = (app: App) => `${app.vault.configDir}/plugins/s3-vault-sync/sync-activity.json`;
  const stubbedResult = (overrides: Partial<SyncResult> = {}): SyncResult => ({
    cacheUpdated: true, deferredDownloadEntries: [], deferredDownloads: 0, deleted: 0, downloaded: 0, downloads: [],
    localIssues: [], status: "complete", unsyncedLocalEntries: 0, uploaded: 0, uploads: [], ...overrides,
  });
  // 重试之间的等待用假计时器：每拨 50 毫秒真等 1 毫秒，让走真实线程的加密运算跑完
  const settle = async (run: Promise<unknown>) => {
    let done = false;
    void run.finally(() => { done = true; });
    for (let step = 0; !done; step++) {
      if (step >= 2_000) throw new Error("同步一直没有结束");
      await vi.advanceTimersByTimeAsync(50);
      if (!done) await realDelay(1);
    }
    await run;
  };
  const restoreSpies: Array<() => void> = [];
  afterEach(() => {
    for (const restore of restoreSpies.splice(0)) restore();
  });

  it("records the uploaded file under the diagnostic record's id without putting it into the diagnostics export", async () => {
    host.desktop = true;
    const {plugin, app, edit, diagnosticFiles} = await setup();
    edit("A changed article.");

    await plugin.togglePause();

    const run = plugin.getDiagnostics().records.at(-1)!;
    const records = plugin.getSyncActivity()!.records;
    expect(records).toEqual([expect.objectContaining({
      id: run.id, vaultId: "vault-1", kind: "sync", startedAt: run.startedAt, finishedAt: run.finishedAt,
      triggers: ["resume"], outcome: "complete", phase: "saving", requests: run.requests, sentBytes: run.sentBytes,
      receivedBytes: run.receivedBytes, phaseDurations: run.phaseDurations,
      uploads: [{kind: "modified", path: "notes/example.md"}], downloads: [],
    })]);
    expect(JSON.parse(diagnosticFiles.get(activityPath(app))!)).toEqual({version: 1, records});
    expect(plugin.exportDiagnostics()).not.toContain("notes/example.md");
    plugin.onunload();
  });

  it("does not record a complete synchronization that changed no files", async () => {
    host.desktop = true;
    const {plugin, app, diagnosticFiles} = await setup();

    await plugin.togglePause();
    await plugin.syncNow();

    expect(plugin.getDiagnostics().records.map(record => record.outcome)).toEqual(["complete", "complete"]);
    expect(plugin.getSyncActivity()!.records).toEqual([]);
    expect(diagnosticFiles.has(activityPath(app))).toBe(false);
    plugin.onunload();
  });

  it("records a retry for a file still being edited without any files, then the upload that follows", async () => {
    host.desktop = true;
    const {plugin, hooks, edit} = await setup();
    edit("A paragraph in progress.");
    hooks.beforeBlobRead = () => {
      hooks.beforeBlobRead = undefined;
      edit("The complete paragraph.");
    };

    await plugin.togglePause();
    expect(plugin.getSyncActivity()!.records).toEqual([expect.objectContaining({outcome: "retrying", uploads: [], downloads: []})]);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(plugin.getStatusText()).toMatch(/^空闲：/u));

    expect(plugin.getSyncActivity()!.records.map(record => [record.outcome, record.uploads]))
      .toEqual([["retrying", []], ["complete", [{kind: "modified", path: "notes/example.md"}]]]);
    plugin.onunload();
  });

  it("records no upload when another device keeps publishing first", async () => {
    host.desktop = true;
    const {plugin, edit} = await setup();
    const execute = host.requestUrl.getMockImplementation() as ObsidianRequestExecutor;
    host.requestUrl.mockImplementation((request: Parameters<ObsidianRequestExecutor>[0]) =>
      request.method === "PUT" && request.url.endsWith("/head")
        ? Promise.resolve({status: 412, arrayBuffer: new ArrayBuffer(0), headers: {date: new Date().toUTCString()}})
        : execute(request));
    edit("A draft that loses the race.");

    await settle(plugin.togglePause());

    expect(plugin.getDiagnostics().records.at(-1)).toMatchObject({outcome: "retrying", errorCategory: "head-race"});
    expect(plugin.getSyncActivity()!.records).toEqual([expect.objectContaining({outcome: "retrying", uploads: [], downloads: []})]);
    plugin.onunload();
  });

  it.each([
    {failure: "another device publishing first", error: async () => new (await import("../src/storage/remote-store")).HeadChangedError(), outcome: "retrying"},
    {failure: "a network error", error: async () => new S3TransportError("network", false), outcome: "retrying"},
    {failure: "an unexpected error", error: async () => new Error("disk failure"), outcome: "error"},
  ])("keeps the files downloaded before publishing failed because of $failure", async ({error, outcome}) => {
    host.desktop = true;
    const {plugin} = await setup();
    const failure = await error();
    let calls = 0;
    const synchronize = vi.spyOn(SyncService.prototype, "synchronize").mockImplementation((_approved, options) => {
      // 第一次尝试下载落地一个文件后发布失败；重试时文件已经在本机，不会再下载
      if (calls++ === 0) options?.onDownloadApplied?.({kind: "added", path: "notes/from-phone.md"});
      return Promise.reject(failure);
    });
    restoreSpies.push(() => synchronize.mockRestore());

    await settle(plugin.togglePause());

    expect(plugin.getSyncActivity()!.records).toEqual([expect.objectContaining({
      outcome, uploads: [], downloads: [{kind: "added", path: "notes/from-phone.md"}],
    })]);
    plugin.onunload();
  });

  it("records both directions and downloads from an earlier attempt that lost the Head race", async () => {
    host.desktop = true;
    const {plugin} = await setup();
    const {HeadChangedError} = await import("../src/storage/remote-store");
    let calls = 0;
    const synchronize = vi.spyOn(SyncService.prototype, "synchronize").mockImplementation((_approved, options) => {
      if (calls++ === 0) {
        options?.onDownloadApplied?.({kind: "updated", path: "notes/from-phone.md"});
        return Promise.reject(new HeadChangedError());
      }
      return Promise.resolve(stubbedResult({uploads: [{kind: "modified", path: "notes/example.md"}], uploaded: 1}));
    });
    restoreSpies.push(() => synchronize.mockRestore());

    await settle(plugin.togglePause());

    expect(plugin.getSyncActivity()!.records).toEqual([expect.objectContaining({
      outcome: "complete", uploads: [{kind: "modified", path: "notes/example.md"}],
      downloads: [{kind: "updated", path: "notes/from-phone.md"}],
    })]);
    plugin.onunload();
  });

  it("starts an empty record with a notice when the file is damaged, and keeps synchronizing", async () => {
    host.desktop = true;
    const {plugin, app, edit, diagnosticFiles, remote} = await setup();
    plugin.onunload();
    for (const damaged of ["{not json", JSON.stringify({version: 1, records: "nope"})]) {
      diagnosticFiles.set(activityPath(app), damaged);
      const replacement = new S3VaultSyncPlugin(app, {id: "s3-vault-sync"} as PluginManifest);
      await replacement.onload();
      expect(replacement.getSyncActivity()).toEqual({records: [], persistenceWarning: "无法读取本地同步记录。同步数据没有受影响。"});
      edit(`An article saved after the damage: ${damaged}`);
      if (replacement.isPaused()) await replacement.togglePause(); else await replacement.syncNow();
      expect(replacement.getStatusText()).toMatch(/^空闲：/u);
      expect((await remote.readHead())!.value.commitId).toBe(replacement.getDiagnostics().acceptedCommit);
      expect(replacement.getSyncActivity()!.records).toEqual([expect.objectContaining({uploads: [{kind: "modified", path: "notes/example.md"}]})]);
      await replacement.togglePause();
      replacement.onunload();
    }
  });

  it("neither reads nor writes the record on a phone or tablet", async () => {
    host.desktop = false;
    host.mobile = true;
    const {plugin, app, edit, diagnosticFiles} = await setup();
    plugin.onunload();
    const existing = JSON.stringify({version: 1, records: []});
    diagnosticFiles.set(activityPath(app), existing);
    const touched: string[] = [];
    for (const method of ["exists", "read", "write"] as const) {
      const original = app.vault.adapter[method].bind(app.vault.adapter) as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(app.vault.adapter, method).mockImplementation(((path: string, ...rest: unknown[]) => {
        touched.push(path);
        return original(path, ...rest);
      }) as never);
    }
    const restore = vi.spyOn(SyncService.prototype, "restoreRevision").mockResolvedValue();
    restoreSpies.push(() => restore.mockRestore());
    const phone = new S3VaultSyncPlugin(app, {id: "s3-vault-sync"} as PluginManifest);
    await phone.onload();
    edit("Edited on the phone.");

    await phone.togglePause();
    await phone.restoreRevision("entry-1", "revision-1");

    expect(phone.getStatusText()).toMatch(/^空闲：/u);
    expect(phone.getSyncActivity()).toBeUndefined();
    expect(touched).not.toContain(activityPath(app));
    expect(diagnosticFiles.get(activityPath(app))).toBe(existing);
    phone.onunload();
  });

  describe("manual operations", () => {
    const manualRecords = (plugin: S3VaultSyncPlugin) => plugin.getSyncActivity()!.records.filter(record => record.kind === "manual");
    // 电脑上、已恢复同步；之后的同步都返回「没有改动」，只留下手动操作那一条
    const ready = async () => {
      host.desktop = true;
      const fixture = await setup();
      await fixture.plugin.togglePause();
      const synchronize = vi.spyOn(SyncService.prototype, "synchronize").mockResolvedValue(stubbedResult());
      restoreSpies.push(() => synchronize.mockRestore());
      return {...fixture, synchronize};
    };
    type StubbedMethod = "restoreDeleted" | "restoreRevision" | "resolveConflict" | "resolvePathCollision" | "resolveLocalContent";
    const stub = (name: StubbedMethod, result: "resolve" | "reject", value?: string) => {
      // 各个方法的返回类型不同，这里只按调用结果统一处理
      const spy = vi.spyOn(SyncService.prototype as unknown as Record<StubbedMethod, () => Promise<unknown>>, name)
        .mockImplementation(() => result === "resolve" ? Promise.resolve(value) : Promise.reject(new Error("操作失败")));
      restoreSpies.push(() => spy.mockRestore());
    };
    interface ManualCase {
      operation: string; service: StubbedMethod; value?: string; run: (plugin: S3VaultSyncPlugin) => Promise<unknown>;
      summary: string; files: Array<{kind: string; path: string; fromPath?: string}>;
    }
    const renameIssue: LocalSyncIssue = {kind: "possible-rename", oldPaths: ["notes/example.md", "notes/gone.md"],
      newPaths: ["notes/moved.md", "notes/fresh.md"], reviewToken: "token-1"};

    it.each<ManualCase>([
      {operation: "restoreDeleted", service: "restoreDeleted", run: (plugin: S3VaultSyncPlugin) => plugin.restoreDeleted("entry-1"),
        summary: "恢复已删除的文件：example.md", files: [{kind: "restored", path: "notes/example.md"}]},
      {operation: "restoreRevision", service: "restoreRevision", run: (plugin: S3VaultSyncPlugin) => plugin.restoreRevision("entry-1", "revision-1"),
        summary: "恢复历史版本：example.md", files: [{kind: "restored", path: "notes/example.md"}]},
      {operation: "resolveConflict", service: "resolveConflict", run: (plugin: S3VaultSyncPlugin) => plugin.resolveConflict("entry-1", "revision-1"),
        summary: "处理冲突：example.md", files: [{kind: "modified", path: "notes/example.md"}]},
      {operation: "keepConflictDeleted", service: "resolveConflict", run: (plugin: S3VaultSyncPlugin) => plugin.keepConflictDeleted("entry-1"),
        summary: "处理冲突（保留删除）：example.md", files: [{kind: "deleted", path: "notes/example.md"}]},
      {operation: "resolvePathCollision", service: "resolvePathCollision", value: "notes/example 2.md",
        run: (plugin: S3VaultSyncPlugin) => plugin.resolvePathCollision({paths: ["notes/example.md", "notes/Example.md"], reviewToken: "token-1",
          side: "local", path: "notes/example.md", newName: "example 2.md"}),
        summary: "路径撞名：改名为 example 2.md", files: [{kind: "moved", fromPath: "notes/example.md", path: "notes/example 2.md"}]},
      {operation: "resolveLocalContent (local)", service: "resolveLocalContent", run: (plugin: S3VaultSyncPlugin) => plugin.resolveLocalContent("notes/example.md", "token-1", "local"),
        summary: "处理本地内容（保留本机版本）：example.md", files: [{kind: "modified", path: "notes/example.md"}]},
      {operation: "resolveLocalContent (remote)", service: "resolveLocalContent", run: (plugin: S3VaultSyncPlugin) => plugin.resolveLocalContent("notes/example.md", "token-1", "remote"),
        summary: "处理本地内容（使用 S3 版本）：example.md", files: [{kind: "updated", path: "notes/example.md"}]},
      {operation: "resolveLocalContent (both)", service: "resolveLocalContent", value: "notes/example (local copy).md",
        run: (plugin: S3VaultSyncPlugin) => plugin.resolveLocalContent("notes/example.md", "token-1", "both"),
        summary: "处理本地内容（两份都保留）：example.md",
        files: [{kind: "added", path: "notes/example (local copy).md"}, {kind: "updated", path: "notes/example.md"}]},
    ])("records $operation after it succeeds and not after it fails", async ({service, value, run, summary, files}) => {
      const {plugin} = await ready();
      stub(service, "reject");
      await expect(run(plugin)).rejects.toThrow("操作失败");
      expect(manualRecords(plugin)).toEqual([]);

      stub(service, "resolve", value);
      await run(plugin);

      expect(manualRecords(plugin)).toEqual([expect.objectContaining({kind: "manual", vaultId: "vault-1", outcome: "complete", summary, files})]);
      plugin.onunload();
    });

    it("records a reviewed move with the paired, deleted and added files, and not a review that fails", async () => {
      const {plugin, synchronize} = await ready();
      synchronize.mockResolvedValueOnce(stubbedResult({cacheUpdated: false, status: "action-required", localIssues: [renameIssue]}));
      await plugin.syncNow();
      await plugin.togglePause();
      await expect(plugin.resolvePossibleRename({kind: "moves", reviewToken: "token-1",
        pairs: [{fromPath: "notes/example.md", toPath: "notes/moved.md"}]})).rejects.toThrow("恢复同步");
      await plugin.togglePause();
      synchronize.mockResolvedValueOnce(stubbedResult({cacheUpdated: false, status: "action-required", localIssues: [renameIssue]}));
      await plugin.syncNow();
      expect(manualRecords(plugin)).toEqual([]);

      await plugin.resolvePossibleRename({kind: "moves", reviewToken: "token-1", pairs: [{fromPath: "notes/example.md", toPath: "notes/moved.md"}]});

      expect(manualRecords(plugin)).toEqual([expect.objectContaining({summary: "审查挪动：按挪动处理 1 个文件", files: [
        {kind: "moved", fromPath: "notes/example.md", path: "notes/moved.md"},
        {kind: "deleted", path: "notes/gone.md"},
        {kind: "added", path: "notes/fresh.md"},
      ]})]);
      synchronize.mockResolvedValueOnce(stubbedResult({cacheUpdated: false, status: "action-required", localIssues: [renameIssue]}));
      await plugin.syncNow();
      await plugin.resolvePossibleRename({kind: "separate", reviewToken: "token-1"});
      expect(manualRecords(plugin).at(-1)).toMatchObject({summary: "审查挪动：按删除和新增处理", files: [
        {kind: "deleted", path: "notes/example.md"}, {kind: "deleted", path: "notes/gone.md"},
        {kind: "added", path: "notes/moved.md"}, {kind: "added", path: "notes/fresh.md"},
      ]});
      plugin.onunload();
    });

    it("records a confirmed Bulk Deletion once its synchronization succeeds, and not one whose synchronization fails", async () => {
      const {plugin, synchronize} = await ready();
      const bulkDeletion = {count: 1, entryIds: ["entry-1"], totalLiveEntries: 1};
      synchronize.mockResolvedValueOnce(stubbedResult({cacheUpdated: false, status: "action-required", bulkDeletion}));
      await plugin.syncNow();
      synchronize.mockRejectedValueOnce(new Error("disk failure"));
      await plugin.confirmBulkDeletion();
      expect(plugin.getPendingBulkDeletion()).toEqual(bulkDeletion);
      expect(manualRecords(plugin)).toEqual([]);

      await plugin.confirmBulkDeletion();

      expect(plugin.getPendingBulkDeletion()).toBeUndefined();
      expect(manualRecords(plugin)).toEqual([expect.objectContaining({summary: "确认批量删除：1 个文件",
        files: [{kind: "deleted", path: "notes/example.md"}]})]);
      plugin.onunload();
    });
  });
});

describe("renaming a new file while its first upload is running", () => {
  const remoteEntries = async (remote: RemoteStore) =>
    Object.values((await remote.readSnapshot((await remote.readHead())!.value)).entries);
  const pendingRenames = () => (host.data as {pendingPathRenames: unknown}).pendingPathRenames;
  const expectClean = (plugin: S3VaultSyncPlugin) => {
    expect(plugin.getLocalIssues()).toEqual([]);
    expect(host.openedModals).toHaveLength(0);
    expect(plugin.getStatusText()).toMatch(/^空闲：/u);
  };
  // Head 冲突重试之间的等待走假时钟：边拨时钟边等这次同步结束
  const settle = async (run: Promise<unknown>) => {
    let done = false;
    void run.finally(() => { done = true; });
    for (let step = 0; !done; step++) {
      if (step >= 2_000) throw new Error("同步一直没有结束");
      await vi.advanceTimersByTimeAsync(50);
      if (!done) await realDelay(1);
    }
    await run;
  };
  // 新名字上只有原 Entry 一个 live 记录，旧路径既没有 live 记录也没有删除记录
  const expectFollowedRename = async (remote: RemoteStore, entryId: string, fromPath: string, toPath: string, body: string) => {
    const entries = await remoteEntries(remote);
    const moved = entries.find(entry => entry.entryId === entryId);
    if (moved?.kind !== "live") throw new Error("Expected the original Entry to stay live");
    expect(moved.path).toBe(toPath);
    expect(new TextDecoder().decode(await remote.readBlob(moved.revision.blobId))).toBe(body);
    expect(entries.filter(entry => entry.path === fromPath)).toEqual([]);
    expect(entries.filter(entry => entry.kind === "live" && entry.path === toPath)).toHaveLength(1);
  };
  const publishedEntryId = async (remote: RemoteStore, path: string) => {
    const entry = (await remoteEntries(remote)).find(candidate => candidate.kind === "live" && candidate.path === path);
    if (!entry) throw new Error(`Expected ${path} to be published`);
    return entry.entryId;
  };

  it.each([
    ["after its data block PUT", "afterBlobPut", "改好的正文。"],
    ["after its Head PUT", "afterHeadPut", "改好的正文。"],
    ["after its data block PUT without changing the empty content", "afterBlobPut", ""],
    ["after its Head PUT without changing the empty content", "afterHeadPut", ""],
  ] as const)("follows a rename %s on the next synchronization", async (_name, hook, body) => {
    const {plugin, remote, hooks, createFile, editCreated, renameCreated} = await setup();
    createFile("notes/未命名.md", "");
    hooks[hook] = () => {
      hooks[hook] = undefined;
      renameCreated("notes/未命名.md", "notes/新名字.md");
      if (body) editCreated("notes/新名字.md", body);
    };
    await plugin.togglePause();
    const entryId = await publishedEntryId(remote, "notes/未命名.md");

    await plugin.syncNow();

    expectClean(plugin);
    await expectFollowedRename(remote, entryId, "notes/未命名.md", "notes/新名字.md", body);
    expect(pendingRenames()).toEqual({});
    plugin.onunload();
  });

  it("follows a folder rename during the first upload of a file inside it", async () => {
    const {plugin, remote, hooks, createFile, renameCreated} = await setup();
    createFile("草稿/未命名.md", "");
    hooks.afterBlobPut = () => {
      hooks.afterBlobPut = undefined;
      renameCreated("草稿", "定稿");
    };
    await plugin.togglePause();
    const entryId = await publishedEntryId(remote, "草稿/未命名.md");

    await plugin.syncNow();

    expectClean(plugin);
    await expectFollowedRename(remote, entryId, "草稿/未命名.md", "定稿/未命名.md", "");
    plugin.onunload();
  });

  it.each([
    ["data block PUT", (hooks: Awaited<ReturnType<typeof setup>>["hooks"]) => { hooks.failNextBlobPut = true; }],
    ["Head PUT", (hooks: Awaited<ReturnType<typeof setup>>["hooks"]) => { hooks.failNextHeadPut = 503; }],
  ] as const)("uploads the new name as a new file when the %s of the renamed upload fails", async (_name, fail) => {
    const {plugin, remote, hooks, createFile, editCreated, renameCreated} = await setup();
    createFile("notes/未命名.md", "");
    fail(hooks);
    hooks.afterBlobPut = () => {
      hooks.afterBlobPut = undefined;
      renameCreated("notes/未命名.md", "notes/新名字.md");
      editCreated("notes/新名字.md", "改好的正文。");
    };
    await plugin.togglePause();
    expect((await remoteEntries(remote)).map(entry => entry.path)).toEqual(["notes/example.md"]);
    expect(Object.keys(pendingRenames() as object)).toEqual(["notes/未命名.md"]);
    host.openedModals = [];

    await plugin.syncNow();

    expectClean(plugin);
    expect(host.notices).toEqual([]);
    const entries = await remoteEntries(remote);
    expect(entries.map(entry => [entry.kind, entry.path]).sort()).toEqual([["live", "notes/example.md"], ["live", "notes/新名字.md"]]);
    await plugin.syncNow();
    expectClean(plugin);
    expect(pendingRenames()).toEqual({});
    plugin.onunload();
  });

  it("keeps one live Entry at the new name when the renamed upload loses a Head race", async () => {
    const {plugin, remote, hooks, createFile, editCreated, renameCreated} = await setup();
    createFile("notes/未命名.md", "");
    hooks.failNextHeadPut = 412;
    hooks.afterBlobPut = () => {
      hooks.afterBlobPut = undefined;
      renameCreated("notes/未命名.md", "notes/新名字.md");
      editCreated("notes/新名字.md", "改好的正文。");
    };
    await settle(plugin.togglePause());
    await settle(plugin.syncNow());
    await settle(plugin.syncNow());

    expectClean(plugin);
    expect(host.notices).toEqual([]);
    const entries = await remoteEntries(remote);
    expect(entries.map(entry => [entry.kind, entry.path]).sort()).toEqual([["live", "notes/example.md"], ["live", "notes/新名字.md"]]);
    expect(pendingRenames()).toEqual({});
    plugin.onunload();
  });

  it("uses the Entry ID of the retried attempt for a rename during the upload after a Head race", async () => {
    const {plugin, remote, hooks, createFile, editCreated, renameCreated} = await setup();
    createFile("notes/未命名.md", "");
    hooks.failNextHeadPut = 412;
    let blobPuts = 0;
    hooks.afterBlobPut = () => {
      // 第一次尝试的 Head PUT 撞上 412；第二次尝试上传时改名
      if (++blobPuts !== 2) return;
      hooks.afterBlobPut = undefined;
      renameCreated("notes/未命名.md", "notes/新名字.md");
      editCreated("notes/新名字.md", "改好的正文。");
    };
    await settle(plugin.togglePause());
    expect(plugin.getStatusText()).toMatch(/^空闲：/u);
    expect(blobPuts).toBe(2);
    const entryId = await publishedEntryId(remote, "notes/未命名.md");

    await settle(plugin.syncNow());

    expectClean(plugin);
    await expectFollowedRename(remote, entryId, "notes/未命名.md", "notes/新名字.md", "改好的正文。");
    plugin.onunload();
  });

  it("forgets the uploading new files once a synchronization ends", async () => {
    const {plugin, remote, hooks, createFile, renameCreated} = await setup();
    createFile("notes/未命名.md", "");
    hooks.failNextBlobPut = true;
    await plugin.togglePause();
    expect((await remoteEntries(remote)).map(entry => entry.path)).toEqual(["notes/example.md"]);

    renameCreated("notes/未命名.md", "notes/新名字.md");
    await plugin.saveSettings();

    expect(pendingRenames()).toEqual({});
    plugin.onunload();
  });

  describe("unchanged behavior", () => {
    it("follows a rename made after the first upload finished", async () => {
      const {plugin, remote, createFile, editCreated, renameCreated} = await setup();
      createFile("notes/未命名.md", "");
      await plugin.togglePause();
      const entryId = await publishedEntryId(remote, "notes/未命名.md");
      renameCreated("notes/未命名.md", "notes/新名字.md");
      editCreated("notes/新名字.md", "改好的正文。");

      await plugin.syncNow();

      expectClean(plugin);
      await expectFollowedRename(remote, entryId, "notes/未命名.md", "notes/新名字.md", "改好的正文。");
      plugin.onunload();
    });

    it("uploads only the new name for a rename made before the first synchronization", async () => {
      const {plugin, remote, createFile, editCreated, renameCreated} = await setup();
      createFile("notes/未命名.md", "");
      renameCreated("notes/未命名.md", "notes/新名字.md");
      editCreated("notes/新名字.md", "改好的正文。");

      await plugin.togglePause();

      expectClean(plugin);
      expect(pendingRenames()).toEqual({});
      expect((await remoteEntries(remote)).map(entry => [entry.kind, entry.path]).sort())
        .toEqual([["live", "notes/example.md"], ["live", "notes/新名字.md"]]);
      plugin.onunload();
    });

    it("still asks for a move review when the file is moved on disk without a rename event", async () => {
      const {plugin, hooks, createFile, editCreated, renameCreated} = await setup();
      createFile("notes/未命名.md", "");
      hooks.afterBlobPut = () => {
        hooks.afterBlobPut = undefined;
        renameCreated("notes/未命名.md", "notes/新名字.md", false);
        editCreated("notes/新名字.md", "改好的正文。");
      };
      await plugin.togglePause();
      expect(pendingRenames()).toEqual({});

      await plugin.syncNow();

      expect(plugin.getLocalIssues()).toEqual([expect.objectContaining({
        kind: "possible-rename", oldPaths: ["notes/未命名.md"], newPaths: ["notes/新名字.md"],
      })]);
      expect(host.openedModals).toHaveLength(1);
      plugin.onunload();
    });

    it.each([
      ["an already synchronized file", false],
      ["a new file renamed during its first upload", true],
    ] as const)("reports a path collision when a new file appears at the old path of %s", async (_name, duringUpload) => {
      const {plugin, hooks, createFile, renameCreated} = await setup();
      createFile("notes/未命名.md", "");
      const renameAndRecreate = () => {
        renameCreated("notes/未命名.md", "notes/新名字.md");
        createFile("notes/未命名.md", "又一篇新笔记。");
      };
      if (duringUpload) {
        hooks.afterBlobPut = () => {
          hooks.afterBlobPut = undefined;
          renameAndRecreate();
        };
      }
      await plugin.togglePause();
      if (!duringUpload) renameAndRecreate();

      await plugin.syncNow();

      expect(plugin.getLocalIssues()).toContainEqual({kind: "path-collision", paths: ["notes/未命名.md"]});
      plugin.onunload();
    });
  });
});
