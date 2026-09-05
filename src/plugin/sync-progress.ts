import type { SyncProgress } from "../sync/sync-service";

const phaseLabels: Record<SyncProgress["phase"], string> = {
  downloading: "Downloading",
  publishing: "Publishing encrypted snapshot",
  scanning: "Scanning",
  uploading: "Uploading",
};

const formatBytes = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB"] as const;
  let unitIndex = 0;
  let value = bytes;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
};

export const formatSyncProgress = (
  progress: SyncProgress,
): { detail: string; label: string } => {
  const phase = phaseLabels[progress.phase];
  const percentage =
    progress.total === 0
      ? 0
      : Math.round((progress.completed / progress.total) * 100);
  const label =
    progress.phase === "publishing"
      ? phase
      : `${phase} ${progress.completed.toLocaleString("en-US")}/${progress.total.toLocaleString("en-US")} (${percentage}%)`;
  const bytes =
    progress.totalBytes > 0
      ? ` · ${formatBytes(progress.transferredBytes)} / ${formatBytes(progress.totalBytes)}`
      : "";
  const currentPath = progress.currentPath ? ` · ${progress.currentPath}` : "";
  return { detail: `${label}${bytes}${currentPath}`, label };
};
