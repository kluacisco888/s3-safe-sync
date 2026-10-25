import type { SyncFileChange } from "../sync/sync-service";
import { SerializedDataWriter } from "./serialized-data-writer";
import { ERROR_CATEGORIES, PHASES, SYNC_TRIGGERS, identifier, nonnegative, type SyncErrorCategory, type SyncPhase, type SyncRunRecord, type SyncTrigger } from "./sync-diagnostics";

// 本机同步记录（sync-activity.json）：只在电脑上，含文件路径，保留 30 天；和诊断日志分开存，不进导出
// 记录里的一个文件：同步时的上传和下载，加上手动操作的「恢复」
export interface SyncActivityFile {
  fromPath?: string;
  kind: SyncFileChange["kind"] | "restored";
  path: string;
}

export interface SyncActivityRecord {
  // 同步记录和诊断日志里的同一次同步用同一个 id
  id: string;
  vaultId?: string;
  kind: "sync" | "manual";
  // 用时 = finishedAt − startedAt
  startedAt: number;
  finishedAt: number;
  triggers: SyncTrigger[];
  outcome: SyncRunRecord["outcome"];
  uploads: SyncActivityFile[];
  downloads: SyncActivityFile[];
  // 手动操作涉及的文件
  files?: SyncActivityFile[];
  // 超出 200 个的文件只记数量
  moreFiles?: number;
  phase?: SyncPhase;
  // 出错或重试时的错误类型，窗口里据此写「网络出错」「文件还在被修改」等说明
  errorCategory?: SyncErrorCategory;
  phaseDurations?: Partial<Record<SyncPhase, number>>;
  requests?: number;
  sentBytes?: number;
  receivedBytes?: number;
  // 手动操作的一句中文摘要
  summary?: string;
}

export interface SyncActivitySnapshot {
  records: SyncActivityRecord[];
  persistenceWarning?: string;
}

const MAX_RECORDS = 5_000;
const MAX_FILES = 200;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const FILE_KINDS = ["added", "modified", "updated", "deleted", "moved", "restored"] as const;
const OUTCOMES = ["running", "complete", "action-required", "error", "retrying", "interrupted"] as const;
const text = (value: unknown, maxLength: number): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : undefined;

const parseFiles = (value: unknown): SyncActivityFile[] => Array.isArray(value) ? value.flatMap((item: unknown) => {
  if (!item || typeof item !== "object") return [];
  const file = item as Record<string, unknown>;
  const kind = FILE_KINDS.find(known => known === file.kind);
  const path = text(file.path, 4_096);
  const fromPath = text(file.fromPath, 4_096);
  if (!kind || !path || (kind === "moved" && !fromPath)) return [];
  return [kind === "moved" ? {kind, fromPath, path} : {kind, path}];
}) : [];

// 一条记录里的文件名合计最多 200 个：按上传、下载、手动操作的顺序保留，其余只记数量
const capFiles = (lists: readonly SyncActivityFile[][], earlierOverflow = 0): {kept: SyncActivityFile[][]; moreFiles?: number} => {
  let room = MAX_FILES;
  let overflow = earlierOverflow;
  const kept = lists.map(files => {
    const taken = files.slice(0, room);
    room -= taken.length;
    overflow += files.length - taken.length;
    return taken;
  });
  return {kept, ...(overflow > 0 ? {moreFiles: overflow} : {})};
};

// 只按已知字段重建；存着的记录不会把任意对象带进来
const parseRecord = (value: unknown): SyncActivityRecord | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const id = identifier(record.id);
  const startedAt = nonnegative(record.startedAt);
  const outcome = OUTCOMES.find(known => known === record.outcome);
  const kind = record.kind === "sync" || record.kind === "manual" ? record.kind : undefined;
  if (!id || startedAt === undefined || !outcome || !kind) return undefined;
  const triggers = Array.isArray(record.triggers) ? record.triggers : [];
  const durations = record.phaseDurations && typeof record.phaseDurations === "object" ? record.phaseDurations as Record<string, unknown> : undefined;
  const {kept: [uploads = [], downloads = [], files = []], moreFiles} = capFiles(
    [parseFiles(record.uploads), parseFiles(record.downloads), parseFiles(record.files)], nonnegative(record.moreFiles) ?? 0);
  const phase = PHASES.find(known => known === record.phase);
  const errorCategory = ERROR_CATEGORIES.find(known => known === record.errorCategory);
  const summary = text(record.summary, 500);
  return {
    id, ...(identifier(record.vaultId) ? {vaultId: identifier(record.vaultId)} : {}), kind, startedAt,
    finishedAt: nonnegative(record.finishedAt) ?? startedAt,
    triggers: SYNC_TRIGGERS.filter(trigger => triggers.includes(trigger)),
    outcome: outcome === "running" ? "interrupted" : outcome,
    ...(phase ? {phase} : {}),
    ...(errorCategory ? {errorCategory} : {}),
    ...(durations ? {phaseDurations: Object.fromEntries(PHASES.flatMap(name => {
      const duration = nonnegative(durations[name]);
      return duration === undefined ? [] : [[name, duration]];
    }))} : {}),
    ...(nonnegative(record.requests) !== undefined ? {requests: nonnegative(record.requests)} : {}),
    ...(nonnegative(record.sentBytes) !== undefined ? {sentBytes: nonnegative(record.sentBytes)} : {}),
    ...(nonnegative(record.receivedBytes) !== undefined ? {receivedBytes: nonnegative(record.receivedBytes)} : {}),
    uploads, downloads,
    ...(kind === "manual" ? {files} : {}),
    ...(moreFiles !== undefined ? {moreFiles} : {}),
    ...(summary ? {summary} : {}),
  };
};

export class SyncActivity {
  private records: SyncActivityRecord[] = [];
  private persistenceWarning: string | undefined;
  private readonly writer: SerializedDataWriter<{version: 1; records: SyncActivityRecord[]}>;

  constructor(private readonly storage: {read(): Promise<unknown>; write(value: unknown): Promise<void>}) {
    this.writer = new SerializedDataWriter(() => ({version: 1, records: this.snapshot().records}), value => storage.write(value));
  }

  async load(): Promise<void> {
    try {
      const stored = await this.storage.read();
      if (stored === undefined) return;
      if (!stored || typeof stored !== "object" || !("version" in stored) || stored.version !== 1 ||
        !("records" in stored) || !Array.isArray(stored.records)) throw new Error("Invalid sync activity");
      this.records = stored.records.slice(-MAX_RECORDS).flatMap(value => {
        const record = parseRecord(value);
        return record ? [record] : [];
      });
      this.prune();
    } catch {
      this.persistenceWarning = "无法读取本地同步记录。同步数据没有受影响。";
    }
  }

  // 一次同步结束时调用：改动了文件，或者结果不是 complete，才记一条
  async recordSync(run: SyncRunRecord, uploads: readonly SyncFileChange[], downloads: readonly SyncFileChange[]): Promise<void> {
    if (uploads.length + downloads.length === 0 && run.outcome === "complete") return;
    const {kept: [keptUploads = [], keptDownloads = []], moreFiles} = capFiles([[...uploads], [...downloads]]);
    this.records.push({
      id: run.id, ...(run.vaultId ? {vaultId: run.vaultId} : {}), kind: "sync", startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? Date.now(), triggers: [...run.triggers], outcome: run.outcome, phase: run.phase,
      ...(run.errorCategory ? {errorCategory: run.errorCategory} : {}), phaseDurations: {...run.phaseDurations}, requests: run.requests, sentBytes: run.sentBytes, receivedBytes: run.receivedBytes,
      uploads: keptUploads, downloads: keptDownloads, ...(moreFiles !== undefined ? {moreFiles} : {}),
    });
    await this.save();
  }

  // 手动操作成功完成后调用
  async recordManual(vaultId: string | undefined, startedAt: number, summary: string, files: readonly SyncActivityFile[]): Promise<void> {
    const {kept: [keptFiles = []], moreFiles} = capFiles([[...files]]);
    this.records.push({
      id: crypto.randomUUID(), ...(vaultId ? {vaultId} : {}), kind: "manual", startedAt, finishedAt: Date.now(),
      triggers: [], outcome: "complete", uploads: [], downloads: [], files: keptFiles, summary,
      ...(moreFiles !== undefined ? {moreFiles} : {}),
    });
    await this.save();
  }

  snapshot(vaultId?: string): SyncActivitySnapshot {
    this.prune();
    return {
      records: this.records.filter(record => vaultId === undefined || record.vaultId === vaultId)
        .flatMap(value => {const record = parseRecord(value); return record ? [record] : [];}),
      ...(this.persistenceWarning ? {persistenceWarning: this.persistenceWarning} : {}),
    };
  }

  private prune(): void {
    this.records = this.records.filter(record => record.startedAt >= Date.now() - RETENTION_MS).slice(-MAX_RECORDS);
  }

  private async save(): Promise<void> {
    this.prune();
    try { await this.writer.save(); this.persistenceWarning = undefined; }
    catch { this.persistenceWarning = "无法保存本地同步记录。同步数据没有受影响。"; }
  }
}
