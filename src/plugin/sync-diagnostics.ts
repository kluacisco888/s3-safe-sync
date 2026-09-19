import { SerializedDataWriter } from "./serialized-data-writer";

export const SYNC_TRIGGERS = ["startup", "manual", "edit", "periodic", "foreground", "shutdown", "resume", "online", "network-retry", "head-retry", "integrity-check"] as const;
export type SyncTrigger = typeof SYNC_TRIGGERS[number];
const PHASES = ["recovery", "remote", "scanning", "hashing", "uploading", "downloading", "publishing", "saving"] as const;
export type SyncPhase = typeof PHASES[number];
const ERROR_CATEGORIES = ["network", "timeout", "service", "authentication", "remote-integrity", "local-change", "head-race", "cancelled", "unknown"] as const;
export type SyncErrorCategory = typeof ERROR_CATEGORIES[number];
export interface SyncRunCounts {uploaded: number; downloaded: number; deleted: number; deferred: number; unsynced: number;}

export interface SyncRunRecord {
  id: string;
  startedAt: number;
  finishedAt?: number;
  outcome: "running" | "complete" | "action-required" | "error" | "retrying" | "interrupted";
  acceptedBefore?: string;
  observedRemote?: string;
  acceptedAfter?: string;
  publishedCommit?: string;
  vaultId?: string;
  triggers: SyncTrigger[];
  phase: SyncPhase;
  phaseDurations: Partial<Record<SyncPhase, number>>;
  requests: number;
  sentBytes: number;
  receivedBytes: number;
  remoteCheckedAt?: number;
  counts?: SyncRunCounts;
  pendingUploads?: number;
  pendingDownloads?: number;
  errorCategory?: SyncErrorCategory;
  httpStatus?: number;
  writeResultUncertain?: boolean;
  nextRetryAt?: number;
}

export interface SyncDiagnosticsSnapshot {
  records: SyncRunRecord[];
  persistenceWarning?: string;
  lastSuccessAt?: number;
}

export interface SyncDiagnosticsView extends SyncDiagnosticsSnapshot {
  acceptedCommit?: string;
  nextRetryAt?: number;
  queued: boolean;
  pendingLocalChanges: number;
}

const MAX_RECORDS = 1_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const identifier = (value: unknown): string | undefined =>
  typeof value === "string" && /^[\w.:-]{1,128}$/u.test(value) ? value : undefined;
const nonnegative = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

// Reconstruct only known fields; persisted diagnostics never import arbitrary objects.
const parseRecord = (value: unknown): SyncRunRecord | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const id = identifier(record.id);
  const triggers = Array.isArray(record.triggers) ? record.triggers : [];
  if (!id || typeof record.startedAt !== "number" || !Number.isFinite(record.startedAt) ||
    !["running", "complete", "action-required", "error", "retrying", "interrupted"].includes(String(record.outcome))) return undefined;
  return {
    id, startedAt: record.startedAt, outcome: record.outcome as SyncRunRecord["outcome"],
    ...(typeof record.finishedAt === "number" && Number.isFinite(record.finishedAt) ? {finishedAt: record.finishedAt} : {}),
    acceptedBefore: identifier(record.acceptedBefore), observedRemote: identifier(record.observedRemote),
    acceptedAfter: identifier(record.acceptedAfter), publishedCommit: identifier(record.publishedCommit),
    vaultId: identifier(record.vaultId),
    triggers: SYNC_TRIGGERS.filter(trigger => triggers.includes(trigger)),
    phase: PHASES.find(phase => phase === record.phase) ?? "recovery",
    phaseDurations: Object.fromEntries(PHASES.flatMap(phase => {
      const durations = record.phaseDurations;
      const value = durations && typeof durations === "object" ? nonnegative((durations as Record<string, unknown>)[phase]) : undefined;
      return value === undefined ? [] : [[phase, value]];
    })),
    requests: nonnegative(record.requests) ?? 0, sentBytes: nonnegative(record.sentBytes) ?? 0, receivedBytes: nonnegative(record.receivedBytes) ?? 0,
    remoteCheckedAt: nonnegative(record.remoteCheckedAt), pendingUploads: nonnegative(record.pendingUploads), pendingDownloads: nonnegative(record.pendingDownloads),
    errorCategory: ERROR_CATEGORIES.find(category => category === record.errorCategory), httpStatus: nonnegative(record.httpStatus),
    writeResultUncertain: record.writeResultUncertain === true ? true : undefined, nextRetryAt: nonnegative(record.nextRetryAt),
    ...(record.counts && typeof record.counts === "object" ? {counts: {
      uploaded: nonnegative((record.counts as Record<string, unknown>).uploaded) ?? 0,
      downloaded: nonnegative((record.counts as Record<string, unknown>).downloaded) ?? 0,
      deleted: nonnegative((record.counts as Record<string, unknown>).deleted) ?? 0,
      deferred: nonnegative((record.counts as Record<string, unknown>).deferred) ?? 0,
      unsynced: nonnegative((record.counts as Record<string, unknown>).unsynced) ?? 0,
    }} : {}),
  };
};

export class SyncDiagnostics {
  private records: SyncRunRecord[] = [];
  private persistenceWarning: string | undefined;
  private readonly phaseStarted = new WeakMap<SyncRunRecord, number>();
  private readonly writer: SerializedDataWriter<{version: 1; records: SyncRunRecord[]}>;

  constructor(private readonly storage: {read(): Promise<unknown>; write(value: unknown): Promise<void>}) {
    this.writer = new SerializedDataWriter(() => ({version: 1, records: this.snapshot().records}), value => storage.write(value));
  }

  async load(): Promise<void> {
    try {
      const stored = await this.storage.read();
      if (stored === undefined) return;
      if (!stored || typeof stored !== "object" || !("version" in stored) || stored.version !== 1 ||
        !("records" in stored) || !Array.isArray(stored.records)) throw new Error("Invalid diagnostics");
      this.records = stored.records.slice(-MAX_RECORDS).flatMap(value => {
        const record = parseRecord(value);
        return record ? [{...record, outcome: record.outcome === "running" ? "interrupted" as const : record.outcome}] : [];
      });
      this.prune();
    } catch {
      this.persistenceWarning = "Local diagnostics could not be loaded. Sync data was not changed.";
    }
  }

  async start(acceptedBefore: string | undefined, vaultId: string | undefined, triggers: SyncTrigger[]): Promise<SyncRunRecord> {
    const record: SyncRunRecord = {id: crypto.randomUUID(), startedAt: Date.now(), outcome: "running", acceptedBefore,
      vaultId, triggers, phase: "recovery", phaseDurations: {}, requests: 0, sentBytes: 0, receivedBytes: 0};
    this.phaseStarted.set(record, Date.now());
    this.records.push(record);
    this.prune();
    await this.save();
    return record;
  }

  async finish(record: SyncRunRecord): Promise<void> {
    this.phase(record, record.phase);
    this.phaseStarted.delete(record);
    record.finishedAt = Date.now();
    if (record.outcome === "running") record.outcome = "error";
    await this.save();
  }

  phase(record: SyncRunRecord, phase: SyncPhase): void {
    const now = Date.now();
    record.phaseDurations[record.phase] = (record.phaseDurations[record.phase] ?? 0) + Math.max(0, now - (this.phaseStarted.get(record) ?? now));
    record.phase = phase;
    this.phaseStarted.set(record, now);
  }

  snapshot(vaultId?: string, limit = MAX_RECORDS): SyncDiagnosticsSnapshot {
    this.prune();
    const records = this.records.filter(record => vaultId === undefined || record.vaultId === vaultId);
    const lastSuccess = [...records].reverse().find(record => record.outcome === "complete");
    return {records: records.slice(-Math.max(1, Math.min(MAX_RECORDS, limit))).flatMap(value => {const record = parseRecord(value); return record ? [record] : [];}),
      lastSuccessAt: lastSuccess?.finishedAt,
      ...(this.persistenceWarning ? {persistenceWarning: this.persistenceWarning} : {})};
  }

  private prune(): void {
    this.records = this.records.filter(record => record.startedAt >= Date.now() - RETENTION_MS).slice(-MAX_RECORDS);
  }

  private async save(): Promise<void> {
    try { await this.writer.save(); this.persistenceWarning = undefined; }
    catch { this.persistenceWarning = "Local diagnostics could not be saved. Sync data was not changed."; }
  }
}
