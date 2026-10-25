import { afterEach, describe, expect, it, vi } from "vitest";

import { SyncActivity } from "../src/plugin/sync-activity";
import type { SyncRunRecord } from "../src/plugin/sync-diagnostics";

const DAY_MS = 24 * 60 * 60 * 1_000;

// 内存里的存储：value 是写进 sync-activity.json 的内容
const memoryStorage = (initial?: unknown) => {
  const storage = {
    value: initial,
    writes: 0,
    read: () => Promise.resolve(storage.value),
    write: (value: unknown) => {storage.value = structuredClone(value); storage.writes += 1; return Promise.resolve();},
  };
  return storage;
};

const run = (overrides: Partial<SyncRunRecord> = {}): SyncRunRecord => ({
  id: crypto.randomUUID(), startedAt: Date.now() - 1_500, finishedAt: Date.now(), outcome: "complete", vaultId: "vault-1",
  triggers: ["edit"], phase: "saving", phaseDurations: {hashing: 20, uploading: 300}, requests: 12, sentBytes: 2_048, receivedBytes: 4_096,
  ...overrides,
});

const stored = (records: unknown[]) => ({version: 1, records});

afterEach(() => {
  vi.useRealTimers();
});

describe("local sync activity", () => {
  it("keeps 200 file names of a large synchronization and counts the rest", async () => {
    const storage = memoryStorage();
    const activity = new SyncActivity(storage);
    await activity.load();
    const uploads = Array.from({length: 201}, (_, index) => ({kind: "added" as const, path: `clips/clip ${index}.md`}));

    await activity.recordSync(run(), uploads, []);

    const [record] = activity.snapshot("vault-1").records;
    expect(record?.uploads).toHaveLength(200);
    expect(record?.uploads[199]).toEqual({kind: "added", path: "clips/clip 199.md"});
    expect(record?.moreFiles).toBe(1);
    expect((storage.value as {records: Array<{uploads: unknown[]}>}).records[0]?.uploads).toHaveLength(200);
  });

  it("counts uploads and downloads together against the 200 names", async () => {
    const activity = new SyncActivity(memoryStorage());
    await activity.load();
    const files = (count: number, folder: string) => Array.from({length: count}, (_, index) => ({kind: "added" as const, path: `${folder}/${index}.md`}));

    await activity.recordSync(run(), files(150, "up"), files(60, "down"));

    const [record] = activity.snapshot().records;
    expect(record?.uploads).toHaveLength(150);
    expect(record?.downloads).toHaveLength(50);
    expect(record?.moreFiles).toBe(10);
  });

  it("drops records older than 30 days when loading and when writing", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const storage = memoryStorage(stored([
      {...run({id: "old", startedAt: now - 31 * DAY_MS, finishedAt: now - 31 * DAY_MS}), kind: "sync", uploads: [{kind: "added", path: "old.md"}], downloads: []},
      {...run({id: "recent", startedAt: now - 29 * DAY_MS, finishedAt: now - 29 * DAY_MS}), kind: "sync", uploads: [{kind: "added", path: "recent.md"}], downloads: []},
    ]));
    const activity = new SyncActivity(storage);

    await activity.load();
    expect(activity.snapshot().records.map(record => record.id)).toEqual(["recent"]);

    vi.setSystemTime(now + 2 * DAY_MS);
    await activity.recordSync(run({id: "today"}), [{kind: "modified", path: "today.md"}], []);
    expect((storage.value as {records: Array<{id: string}>}).records.map(record => record.id)).toEqual(["today"]);
  });

  it("keeps at most 5,000 records", async () => {
    const now = Date.now();
    const records = Array.from({length: 5_000}, (_, index) => ({...run({id: `run-${index}`, startedAt: now - 5_000 + index}),
      kind: "sync", uploads: [{kind: "added", path: `${index}.md`}], downloads: []}));
    const activity = new SyncActivity(memoryStorage(stored(records)));
    await activity.load();

    await activity.recordSync(run({id: "newest"}), [{kind: "added", path: "newest.md"}], []);

    const ids = activity.snapshot().records.map(record => record.id);
    expect(ids).toHaveLength(5_000);
    expect(ids[0]).toBe("run-1");
    expect(ids.at(-1)).toBe("newest");
  });

  it("does not record a complete synchronization that changed no files, but does record one that has to retry", async () => {
    const storage = memoryStorage();
    const activity = new SyncActivity(storage);
    await activity.load();

    await activity.recordSync(run(), [], []);
    expect(activity.snapshot().records).toEqual([]);
    expect(storage.writes).toBe(0);

    const retrying = run({outcome: "retrying", phase: "hashing", errorCategory: "local-change"});
    await activity.recordSync(retrying, [], []);
    expect(activity.snapshot().records).toEqual([{
      id: retrying.id, vaultId: "vault-1", kind: "sync", startedAt: retrying.startedAt, finishedAt: retrying.finishedAt,
      triggers: ["edit"], outcome: "retrying", phase: "hashing", errorCategory: "local-change", phaseDurations: {hashing: 20, uploading: 300},
      requests: 12, sentBytes: 2_048, receivedBytes: 4_096, uploads: [], downloads: [],
    }]);
  });

  it("keeps the error category of a synchronization that failed or has to retry, and drops an unknown one when loading", async () => {
    const storage = memoryStorage();
    const activity = new SyncActivity(storage);
    await activity.load();

    await activity.recordSync(run({id: "network", outcome: "retrying", errorCategory: "network"}), [], []);
    await activity.recordSync(run({id: "service", outcome: "error", errorCategory: "service"}), [], []);

    expect(activity.snapshot().records.map(record => record.errorCategory)).toEqual(["network", "service"]);
    const reloaded = new SyncActivity(memoryStorage(stored([
      ...(storage.value as {records: unknown[]}).records,
      {...run({id: "odd"}), kind: "sync", outcome: "error", errorCategory: "INJECTED", uploads: [], downloads: []},
    ])));
    await reloaded.load();
    expect(reloaded.snapshot().records.map(record => record.errorCategory)).toEqual(["network", "service", undefined]);
    expect(JSON.stringify(reloaded.snapshot())).not.toContain("INJECTED");
  });

  it("records a manual operation with its summary and files", async () => {
    const activity = new SyncActivity(memoryStorage());
    await activity.load();
    const startedAt = Date.now() - 100;

    await activity.recordManual("vault-1", startedAt, "恢复已删除的文件：旧报价.xlsx", [{kind: "restored", path: "客户/旧报价.xlsx"}]);

    const [record] = activity.snapshot("vault-1").records;
    expect(record).toMatchObject({kind: "manual", vaultId: "vault-1", startedAt, outcome: "complete", triggers: [],
      summary: "恢复已删除的文件：旧报价.xlsx", files: [{kind: "restored", path: "客户/旧报价.xlsx"}]});
    expect(record?.finishedAt).toBeGreaterThanOrEqual(startedAt);
  });

  it("shows only the current Vault's records", async () => {
    const activity = new SyncActivity(memoryStorage());
    await activity.load();
    await activity.recordSync(run({vaultId: "vault-1"}), [{kind: "added", path: "one.md"}], []);
    await activity.recordSync(run({vaultId: "vault-2"}), [{kind: "added", path: "two.md"}], []);

    expect(activity.snapshot("vault-2").records.map(record => record.uploads[0]?.path)).toEqual(["two.md"]);
  });

  it("rebuilds only known fields when loading", async () => {
    const activity = new SyncActivity(memoryStorage(stored([
      {...run({id: "kept"}), kind: "sync", privateField: "INJECTED", triggers: ["edit", "INJECTED"],
        uploads: [{kind: "added", path: "a.md", extra: "INJECTED"}, {kind: "exploded", path: "b.md"}, {kind: "added"}],
        downloads: [{kind: "moved", fromPath: "old.md", path: "new.md"}]},
      {id: "no start time", kind: "sync", outcome: "complete", uploads: [], downloads: []},
    ])));

    await activity.load();

    const snapshot = activity.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain("INJECTED");
    expect(snapshot.records.map(record => record.id)).toEqual(["kept"]);
    expect(snapshot.records[0]?.uploads).toEqual([{kind: "added", path: "a.md"}]);
    expect(snapshot.records[0]?.downloads).toEqual([{kind: "moved", fromPath: "old.md", path: "new.md"}]);
    expect(snapshot.persistenceWarning).toBeUndefined();
  });

  it.each([
    {broken: "text that is not JSON", read: () => Promise.reject(new SyntaxError("Unexpected token"))},
    {broken: "a different shape", read: () => Promise.resolve({version: 9, records: "nope"})},
  ])("starts from an empty record with a notice when the file holds $broken", async ({read}) => {
    const storage = {read, write: () => Promise.resolve()};
    const activity = new SyncActivity(storage);

    await activity.load();

    expect(activity.snapshot().records).toEqual([]);
    expect(activity.snapshot().persistenceWarning).toContain("无法读取本地同步记录");
    await activity.recordSync(run(), [{kind: "added", path: "a.md"}], []);
    expect(activity.snapshot().records).toHaveLength(1);
  });

  it("reports a failed write without throwing", async () => {
    const activity = new SyncActivity({read: () => Promise.resolve(undefined), write: () => Promise.reject(new Error("disk full"))});
    await activity.load();

    await expect(activity.recordSync(run(), [{kind: "added", path: "a.md"}], [])).resolves.toBeUndefined();

    expect(activity.snapshot().persistenceWarning).toContain("无法保存本地同步记录");
  });
});
