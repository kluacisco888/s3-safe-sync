import type { CleanupCandidate } from "../sync/sync-service";

// 「已删除，等着从 S3 清掉」里的一项：用户已确认、还在本机队列里
export interface PendingCleanupItem {
  blobId: string;
  // 确认时那次页面读到的 Head serverDate（AWS 时间）
  confirmedAt: string;
  key: string;
  kind: CleanupCandidate["kind"];
  path?: string;
  // 清理提交从记录里去掉它的 AWS 时间；有了就不能再撤销
  recordRemovedAt?: string;
  size: number;
}

export interface CleanupView {
  // 处理的前提暂时不满足时，列表上方说明原因
  blockedReason?: string;
  // 三组可清理的内容（已确认的不在里面）
  candidates: CleanupCandidate[];
  pending: PendingCleanupItem[];
  // 这次列表读到的 Head serverDate（AWS 时间）
  serverDate: string;
}

export interface CleanupController {
  // 电脑上返回可清理的数量（用本机保存的结果，不读 S3）；手机上返回 undefined，没有入口
  getCleanupCount?(): number | undefined;
  loadCleanup?(): Promise<CleanupView>;
  getCleanupView?(): CleanupView | undefined;
  needsCleanupDeviceConfirmation?(): boolean;
  confirmCleanup?(keys: string[], allDevicesUpdated: boolean): Promise<void>;
  undoCleanup?(key: string): Promise<void>;
}
