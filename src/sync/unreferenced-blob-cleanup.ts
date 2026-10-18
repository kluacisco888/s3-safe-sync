import type { RemoteBlobObject } from "../storage/remote-store";

const DAY_MS = 24 * 60 * 60 * 1_000;
// 上传满这么久（按 S3 LastModified 和 AWS 时间）才可能删除
const MIN_BLOB_AGE_MS = 30 * DAY_MS;
// 两次检查都判定没人用、且相隔至少这么久（AWS 时间）才删除
const MIN_UNREFERENCED_SPAN_MS = DAY_MS;
// 每次最多删这么多个，剩下的下次再删
export const MAX_BLOB_DELETIONS_PER_RUN = 200;

// blobId → 第一次判定它没人用时的 AWS 时间；只存在电脑本地
export type UnreferencedBlobMarks = Record<string, string>;

export interface UnreferencedBlobPlan {
  // 四条判据都满足的数据块，按上传时间从早到晚（未截断到每次上限）
  deletable: RemoteBlobObject[];
  // 前三条满足、但第一次判定没人用还不满 24 小时（或这次才第一次判定）的数据块
  waiting: RemoteBlobObject[];
  // 这次检查之后的第一次判定记录：只含这次仍没人用的数据块
  marks: UnreferencedBlobMarks;
}

export interface BlobMonthSummary {
  bytes: number;
  count: number;
  // 上传月份（UTC），形如 2026-09
  month: string;
}

export interface BlobUsageSummary {
  byMonth: BlobMonthSummary[];
  bytes: number;
  count: number;
}

const byUploadTime = (left: RemoteBlobObject, right: RemoteBlobObject): number =>
  Date.parse(left.lastModified) - Date.parse(right.lastModified) || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);

/**
 * 判定哪些数据块可以删除。四条同时满足才删：
 * (1) 当前记录不引用它；(2) S3 LastModified 比当前 AWS 时间早 30 天以上；
 * (3) S3 LastModified 早于当前 Head 对象的 LastModified（防止某台设备上传完内容后被挂起很久才发布）；
 * (4) 上一次检查已判定它没人用，且两次相隔至少 24 小时（AWS 时间）。
 * 只读入参；时间一律用 AWS 时间，不用设备时间。
 */
export const planUnreferencedBlobDeletion = (input: {
  headLastModified: string;
  marks?: Readonly<UnreferencedBlobMarks>;
  objects: readonly RemoteBlobObject[];
  referenced: ReadonlySet<string>;
  serverDate: string;
}): UnreferencedBlobPlan => {
  const serverTime = Date.parse(input.serverDate);
  const headTime = Date.parse(input.headLastModified);
  if (!Number.isFinite(serverTime) || !Number.isFinite(headTime)) {
    throw new Error("无法读取远端的 AWS 时间，这次不删除数据块。");
  }
  const deletable: RemoteBlobObject[] = [];
  const waiting: RemoteBlobObject[] = [];
  const marks: UnreferencedBlobMarks = {};
  for (const object of input.objects) {
    if (input.referenced.has(object.blobId)) continue;
    const previous = input.marks && Object.prototype.hasOwnProperty.call(input.marks, object.blobId)
      ? Date.parse(input.marks[object.blobId] ?? "") : Number.NaN;
    // 记录丢了、读不懂或在 AWS 时间之后：从这次重新计时
    const firstSeen = Number.isFinite(previous) && previous <= serverTime ? previous : serverTime;
    marks[object.blobId] = new Date(firstSeen).toISOString();
    const uploadedAt = Date.parse(object.lastModified);
    if (!Number.isFinite(uploadedAt) || serverTime - uploadedAt < MIN_BLOB_AGE_MS || uploadedAt >= headTime) continue;
    if (serverTime - firstSeen >= MIN_UNREFERENCED_SPAN_MS) deletable.push(object);
    else waiting.push(object);
  }
  deletable.sort(byUploadTime);
  waiting.sort(byUploadTime);
  return { deletable, marks, waiting };
};

// 预览用：数量和大小，按上传月份汇总
export const summarizeBlobs = (objects: readonly RemoteBlobObject[]): BlobUsageSummary => {
  const months = new Map<string, BlobMonthSummary>();
  let bytes = 0;
  for (const object of objects) {
    const month = new Date(Date.parse(object.lastModified)).toISOString().slice(0, 7);
    const summary = months.get(month) ?? { bytes: 0, count: 0, month };
    summary.bytes += object.size;
    summary.count += 1;
    months.set(month, summary);
    bytes += object.size;
  }
  return {
    byMonth: [...months.values()].sort((left, right) => left.month < right.month ? -1 : 1),
    bytes,
    count: objects.length,
  };
};
