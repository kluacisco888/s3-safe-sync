import type { RevisionRef, VaultEntry, VaultSnapshot } from "./sync-engine";

export interface ExpiredRecoveryRemoval {
  deletedAt: string;
  path: string;
}

export interface MissingExpiryItem {
  kind: "history" | "recovery";
  path: string;
}

export interface ExpiredContentPlan {
  // 需要用 set-entry 改写的 Entry（已去掉过期内容）
  changedEntries: VaultEntry[];
  // 将去掉恢复副本的已删除文件，按删除时间排序
  removedRecoveries: ExpiredRecoveryRemoval[];
  // 将去掉的过期旧版本数
  removedHistory: number;
  // 缺到期时间（或无法解析）的项：不算过期、不去掉，只在预览里列出
  missingExpiry: MissingExpiryItem[];
}

type ExpiryState = "expired" | "kept" | "missing";

// 到期判断只用 AWS 时间（Head 的 serverDate），不用设备时间
const expiryState = (revision: RevisionRef, serverTime: number): ExpiryState => {
  const expiresAt = revision.expiresAt === undefined ? Number.NaN : Date.parse(revision.expiresAt);
  if (!Number.isFinite(expiresAt)) return "missing";
  return expiresAt <= serverTime ? "expired" : "kept";
};

/**
 * 按规格「哪些算过期内容」算出清理提交要改写的 Entry：
 * - Deleted：Recovery Copy 已过期就去掉它；删除记录的其他字段原样保留
 * - Live 和 Deleted：Version History 里已过期的项去掉，未过期的保留
 * - Conflicted：一律不动（冲突保留到用户决定）
 * 只读入参，不读本机缓存。
 */
export const planExpiredContentCleanup = (
  snapshot: VaultSnapshot,
  serverDate: string,
): ExpiredContentPlan => {
  const serverTime = Date.parse(serverDate);
  if (!Number.isFinite(serverTime)) {
    throw new Error("无法读取远端的 AWS 时间，这次不清理过期内容。");
  }
  const changedEntries: VaultEntry[] = [];
  const removedRecoveries: ExpiredRecoveryRemoval[] = [];
  const missingExpiry: MissingExpiryItem[] = [];
  let removedHistory = 0;
  const entries = Object.values(snapshot.entries).sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  for (const entry of entries) {
    if (entry.kind === "conflicted") continue;
    let changed = false;
    const next: VaultEntry = { ...entry };
    if (next.kind === "deleted" && next.recovery) {
      const state = expiryState(next.recovery, serverTime);
      if (state === "expired") {
        delete next.recovery;
        removedRecoveries.push({ deletedAt: next.deletedAt, path: next.path });
        changed = true;
      } else if (state === "missing") {
        missingExpiry.push({ kind: "recovery", path: entry.path });
      }
    }
    if (entry.history?.length) {
      const kept: RevisionRef[] = [];
      for (const revision of entry.history) {
        const state = expiryState(revision, serverTime);
        if (state === "expired") {
          removedHistory += 1;
          changed = true;
          continue;
        }
        if (state === "missing") missingExpiry.push({ kind: "history", path: entry.path });
        kept.push(revision);
      }
      if (kept.length > 0) next.history = kept;
      else delete next.history;
    }
    if (changed) changedEntries.push(next);
  }
  removedRecoveries.sort((left, right) =>
    Date.parse(left.deletedAt) - Date.parse(right.deletedAt) || (left.path < right.path ? -1 : 1));
  return { changedEntries, missingExpiry, removedHistory, removedRecoveries };
};
