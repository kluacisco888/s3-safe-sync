import { afterAll, describe, expect, it } from "vitest";

import {
  AwsS3ObjectStore,
  type HttpExecutor,
} from "../src/storage/aws-s3-object-store";
import { RemoteStore } from "../src/storage/remote-store";
import { sha256Content } from "../src/sync/content-hash";
import {
  SyncService,
  type CachedSyncState,
  type LocalFileInfo,
  type LocalVaultPort,
  type PossibleRenameIssue,
  type SyncCachePort,
} from "../src/sync/sync-service";

// 端到端：两台模拟设备（desktop、phone）连真实 S3，模拟 AI 直接在磁盘上挪文件、Obsidian 不发改名通知
const accessKeyId = process.env.S3_VAULT_SYNC_TEST_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_VAULT_SYNC_TEST_SECRET_ACCESS_KEY;
const sessionToken = process.env.S3_VAULT_SYNC_TEST_SESSION_TOKEN;
const region = process.env.S3_VAULT_SYNC_TEST_REGION;
const bucket = process.env.S3_VAULT_SYNC_TEST_BUCKET;
const configured = Boolean(accessKeyId && secretAccessKey && region && bucket);
const liveDescribe = configured ? describe : describe.skip;

const executeWithFetch: HttpExecutor = async (request) => {
  const response = await fetch(request.url, {
    body: request.body?.slice().buffer,
    headers: request.headers,
    method: request.method,
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return {
    body: new Uint8Array(await response.arrayBuffer()),
    headers,
    status: response.status,
  };
};

const encode = (text: string) => new TextEncoder().encode(text);

// 内存本地 Vault：挪动直接改这里的文件表，不经过 pathRenames，等同 AI 在磁盘上挪文件
class MemoryVault implements LocalVaultPort {
  private clock = 0;
  private readonly files = new Map<string, { bytes: Uint8Array; modifiedAt: number }>();

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }

  async list(): Promise<LocalFileInfo[]> {
    return [...this.files].map(([path, file]) => ({path, size: file.bytes.byteLength, modifiedAt: file.modifiedAt}));
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const file = this.files.get(fromPath);
    if (!file || this.files.has(toPath)) throw new Error(`Invalid test move ${fromPath} -> ${toPath}`);
    this.files.delete(fromPath);
    this.files.set(toPath, {bytes: file.bytes, modifiedAt: ++this.clock});
  }

  async read(path: string): Promise<Uint8Array> {
    const file = this.files.get(path);
    if (!file) throw new Error(`Missing local file ${path}`);
    return file.bytes.slice();
  }

  readText(path: string): string | undefined {
    const file = this.files.get(path);
    return file ? new TextDecoder().decode(file.bytes) : undefined;
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  async stat(path: string): Promise<LocalFileInfo | undefined> {
    const file = this.files.get(path);
    return file ? {path, size: file.bytes.byteLength, modifiedAt: file.modifiedAt} : undefined;
  }

  async write(path: string, body: Uint8Array, expectedCurrentHash?: string | null): Promise<void> {
    if (expectedCurrentHash === null && this.files.has(path)) throw new Error(`Test path occupied ${path}`);
    this.files.set(path, {bytes: body.slice(), modifiedAt: ++this.clock});
  }
}

class MemorySyncCache implements SyncCachePort {
  state: CachedSyncState | undefined;

  async load(): Promise<CachedSyncState | undefined> {
    return this.state;
  }

  async save(state: CachedSyncState): Promise<void> {
    this.state = structuredClone(state);
  }
}

liveDescribe("unobserved moves end to end on live S3", () => {
  if (!accessKeyId || !secretAccessKey || !region || !bucket) {
    return;
  }
  const testPrefix = `integration/e2e-${crypto.randomUUID()}`;
  const objects = new AwsS3ObjectStore({
    accessKeyId,
    bucket,
    execute: executeWithFetch,
    region,
    secretAccessKey,
    sessionToken,
  });

  afterAll(async () => {
    for (const key of await objects.list(`${testPrefix}/`)) {
      await objects.delete(key);
    }
  });

  // 每个场景独立子前缀：desktop 建库，phone 首次同步加入，两台各有自己的 Vault 和 Sync Cache
  const setupDevices = async (scenario: string, files: Record<string, Uint8Array>) => {
    const remote = await RemoteStore.open({objects, prefix: `${testPrefix}/${scenario}`,
      vaultKey: crypto.getRandomValues(new Uint8Array(32))});
    const desktopFiles = new MemoryVault();
    for (const [path, bytes] of Object.entries(files)) await desktopFiles.write(path, bytes);
    const desktopCache = new MemorySyncCache();
    const desktop = new SyncService({cache: desktopCache, local: desktopFiles, remote, replicaId: "desktop"});
    await desktop.initializeNew(`e2e-${scenario}`);
    const phoneFiles = new MemoryVault();
    const phone = new SyncService({cache: new MemorySyncCache(), local: phoneFiles, remote, replicaId: "phone"});
    expect((await phone.synchronize()).status).toBe("complete");
    expect(phoneFiles.paths()).toEqual(Object.keys(files).sort());
    const entries = async () => (await remote.readSnapshot((await remote.readHead())!.value)).entries;
    const liveByPath = async () => new Map(Object.values(await entries())
      .flatMap(entry => entry.kind === "live" ? [[entry.path, entry] as const] : []));
    const entryIdAt = (path: string) => desktopCache.state!.files[path]!.entryId;
    return {remote, desktop, desktopFiles, desktopCache, phone, phoneFiles, entries, liveByPath, entryIdAt};
  };
  // 无关的存活笔记：让被扣住的消失 Entry 不触发 Bulk Deletion
  const notes = (count: number) =>
    Object.fromEntries(Array.from({length: count}, (_, index) => [`笔记/note-${index}.md`, encode(`note ${index}`)]));

  it("carries a plain unobserved move to the other device under the same Entry", async () => {
    const {desktop, desktopFiles, phone, phoneFiles, entries, entryIdAt} =
      await setupDevices("plain-move", {"资料/a.md": encode("资料 a 正文"), ...notes(5)});
    const entryId = entryIdAt("资料/a.md");
    const before = (await entries())[entryId];
    if (before?.kind !== "live") throw new Error("Expected live fixture");

    await desktopFiles.move("资料/a.md", "归档/a.md");
    const pushed = await desktop.synchronize();
    expect(pushed.status).toBe("complete");
    expect(pushed.localIssues).toEqual([]);

    expect((await phone.synchronize()).status).toBe("complete");
    expect(phoneFiles.readText("资料/a.md")).toBeUndefined();
    expect(phoneFiles.readText("归档/a.md")).toBe("资料 a 正文");
    const after = await entries();
    expect(after[entryId]).toMatchObject({kind: "live", path: "归档/a.md", revision: {blobId: before.revision.blobId}});
    expect(Object.values(after).filter(entry => entry.kind === "deleted")).toEqual([]);
    expect((await desktop.synchronize()).uploaded).toBe(0);
  }, 120_000);

  it("archives a drawing next to an identical new drawing in one sync and shows it all on the other device", async () => {
    const drawing = encode("%PDF identical drawing bytes");
    const {desktop, desktopFiles, phone, phoneFiles, entries, liveByPath, entryIdAt} =
      await setupDevices("drawing-archive", {"TM图纸/8799-D (Section) R1.pdf": drawing, "notes/project.md": encode("v1")});
    const movedId = entryIdAt("TM图纸/8799-D (Section) R1.pdf");

    // 2026-10-13 实际场景：旧图纸挪进过程文档，同时新增字节相同的 8797-D、5 张截图、改一篇笔记
    await desktopFiles.move("TM图纸/8799-D (Section) R1.pdf", "TM图纸/过程文档/8799-D (Section) R1.pdf");
    await desktopFiles.write("TM图纸/8797-D (Section) R1.pdf", drawing);
    for (let index = 1; index <= 5; index += 1) await desktopFiles.write(`截图/screenshot-${index}.png`, encode(`png ${index}`));
    await desktopFiles.write("notes/project.md", encode("v2"));
    const pushed = await desktop.synchronize();
    expect(pushed.status).toBe("complete");
    expect(pushed.localIssues).toEqual([]);

    expect((await phone.synchronize()).status).toBe("complete");
    const expectedPaths = [
      "TM图纸/8797-D (Section) R1.pdf",
      "TM图纸/过程文档/8799-D (Section) R1.pdf",
      "notes/project.md",
      ...[1, 2, 3, 4, 5].map(index => `截图/screenshot-${index}.png`),
    ].sort();
    expect(phoneFiles.paths()).toEqual(expectedPaths);
    expect(phoneFiles.readText("notes/project.md")).toBe("v2");
    expect(phoneFiles.readText("TM图纸/过程文档/8799-D (Section) R1.pdf")).toBe("%PDF identical drawing bytes");
    expect(phoneFiles.readText("TM图纸/8797-D (Section) R1.pdf")).toBe("%PDF identical drawing bytes");
    const live = await liveByPath();
    expect([...live.keys()].sort()).toEqual(expectedPaths);
    expect(live.get("TM图纸/过程文档/8799-D (Section) R1.pdf")?.entryId).toBe(movedId);
    expect(live.get("TM图纸/8797-D (Section) R1.pdf")?.entryId).not.toBe(movedId);
    expect(Object.values(await entries()).filter(entry => entry.kind === "deleted")).toEqual([]);
  }, 120_000);

  it("holds moved-and-edited drawings for review while the rest syncs, then applies a partial pairing on both devices", async () => {
    const {desktop, desktopFiles, desktopCache, phone, phoneFiles, entries, liveByPath, entryIdAt} =
      await setupDevices("partial-review", {"图纸/a.pdf": encode("a v1"), "图纸/b.pdf": encode("b v1"), ...notes(10)});
    const aEntryId = entryIdAt("图纸/a.pdf");
    const aOldHash = desktopCache.state!.files["图纸/a.pdf"]!.contentHash;
    const bEntryId = entryIdAt("图纸/b.pdf");

    // 两个 pdf 挪走并改内容，另新增一个 pdf、一张 png，改一篇笔记
    await desktopFiles.move("图纸/a.pdf", "归档/a v2.pdf");
    await desktopFiles.write("归档/a v2.pdf", encode("a v2"));
    await desktopFiles.move("图纸/b.pdf", "归档/b v2.pdf");
    await desktopFiles.write("归档/b v2.pdf", encode("b v2"));
    await desktopFiles.write("归档/c.pdf", encode("c v1"));
    await desktopFiles.write("截图/shot.png", encode("png"));
    await desktopFiles.write("笔记/note-0.md", encode("note 0 edited"));
    const held = await desktop.synchronize();
    expect(held.status).toBe("action-required");
    expect(held.bulkDeletion).toBeUndefined();
    expect(held.localIssues).toEqual([{
      kind: "possible-rename",
      newPaths: ["归档/a v2.pdf", "归档/b v2.pdf", "归档/c.pdf"],
      oldPaths: ["图纸/a.pdf", "图纸/b.pdf"],
      reviewToken: expect.any(String),
    }]);
    const issue = held.localIssues[0] as PossibleRenameIssue;

    // phone：笔记和 png 已到，旧 pdf 仍在，被扣住的新 pdf 还没出现
    expect((await phone.synchronize()).status).toBe("complete");
    expect(phoneFiles.readText("笔记/note-0.md")).toBe("note 0 edited");
    expect(phoneFiles.readText("截图/shot.png")).toBe("png");
    expect(phoneFiles.readText("图纸/a.pdf")).toBe("a v1");
    expect(phoneFiles.readText("图纸/b.pdf")).toBe("b v1");
    for (const path of ["归档/a v2.pdf", "归档/b v2.pdf", "归档/c.pdf"]) expect(phoneFiles.readText(path)).toBeUndefined();

    // desktop 部分配对：a 挪到 a v2，b 不选（按删除处理），b v2 与 c 作为新文件
    const resolved = await desktop.synchronize([], {renameResolution: {kind: "moves", reviewToken: issue.reviewToken,
      pairs: [{fromPath: "图纸/a.pdf", toPath: "归档/a v2.pdf"}]}});
    expect(resolved.status).toBe("complete");
    expect(resolved.localIssues).toEqual([]);

    expect((await phone.synchronize()).status).toBe("complete");
    expect(phoneFiles.readText("图纸/a.pdf")).toBeUndefined();
    expect(phoneFiles.readText("图纸/b.pdf")).toBeUndefined();
    expect(phoneFiles.readText("归档/a v2.pdf")).toBe("a v2");
    expect(phoneFiles.readText("归档/b v2.pdf")).toBe("b v2");
    expect(phoneFiles.readText("归档/c.pdf")).toBe("c v1");
    const after = await entries();
    const moved = after[aEntryId];
    expect(moved).toMatchObject({kind: "live", path: "归档/a v2.pdf"});
    const previous = moved!.history?.[0];
    expect(previous?.contentHash).toBe(aOldHash);
    // phone 上能读回挪动前的版本：Version History 接上了
    expect(new TextDecoder().decode(await phone.readHistoricalRevision(aEntryId, previous!.revisionId))).toBe("a v1");
    expect(after[bEntryId]).toMatchObject({
      kind: "deleted", path: "图纸/b.pdf", recovery: expect.objectContaining({contentHash: await sha256Content(encode("b v1"))}),
    });
    const live = await liveByPath();
    for (const path of ["归档/b v2.pdf", "归档/c.pdf"]) {
      expect(live.get(path)?.entryId).toBeDefined();
      expect([aEntryId, bEntryId]).not.toContain(live.get(path)!.entryId);
    }
  }, 180_000);

  it("keeps another device's edit of a held Entry and the moved file without publishing a deletion", async () => {
    const {desktop, desktopFiles, phone, phoneFiles, entries, liveByPath, entryIdAt} =
      await setupDevices("held-remote-edit", {"plan.pdf": encode("plan v1"), ...notes(5)});
    const pdfEntryId = entryIdAt("plan.pdf");
    await desktopFiles.move("plan.pdf", "archive/plan v2.pdf");
    await desktopFiles.write("archive/plan v2.pdf", encode("plan v2"));
    const first = await desktop.synchronize();
    expect(first.localIssues.some(issue => issue.kind === "possible-rename")).toBe(true);

    // 扣住期间 phone 修改了旧文件
    expect((await phone.synchronize()).status).toBe("complete");
    await phoneFiles.write("plan.pdf", encode("plan v1 edited on phone"));
    expect((await phone.synchronize()).status).toBe("complete");
    const phoneHash = await sha256Content(encode("plan v1 edited on phone"));

    // 与 sync-service 单测一致：被扣住的 Entry 转为 delete-edit 冲突，新位置文件作为新文件上传，不发布删除
    const second = await desktop.synchronize();
    expect(second.status).toBe("action-required");
    expect(second.localIssues).toEqual([]);
    for (let round = 0; round < 2; round += 1) await desktop.synchronize();
    await phone.synchronize();

    const after = await entries();
    expect(after[pdfEntryId]).toMatchObject({kind: "conflicted", path: "plan.pdf", reason: "delete-edit"});
    const conflicted = after[pdfEntryId];
    if (conflicted?.kind !== "conflicted") throw new Error("Expected conflicted Entry");
    expect(conflicted.candidates.map(candidate => candidate.contentHash)).toContain(phoneHash);
    expect(Object.values(after).filter(entry => entry.kind === "deleted")).toEqual([]);
    const moved = (await liveByPath()).get("archive/plan v2.pdf");
    expect(moved?.entryId).toBeDefined();
    expect(moved!.entryId).not.toBe(pdfEntryId);
    expect(desktopFiles.readText("archive/plan v2.pdf")).toBe("plan v2");
    expect(phoneFiles.readText("plan.pdf")).toBe("plan v1 edited on phone");
    expect(phoneFiles.readText("archive/plan v2.pdf")).toBe("plan v2");
  }, 180_000);
});
