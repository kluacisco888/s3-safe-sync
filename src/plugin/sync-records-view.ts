import type { SyncActivityFile, SyncActivityRecord, SyncActivitySnapshot } from "./sync-activity";
import { formatLocalClock } from "./local-time";
import { errorCategoryLabels, fileKindLabels, outcomeLabels, triggerLabels } from "./sync-labels";

// 同步状态窗口里的「同步记录（最近 30 天）」：按本机时区的天分组，点一行展开这次同步的详情

const HINT = "只列出动过文件、出错、需要重试的同步，以及你的手动操作。点一行查看这次同步的详情，再点一次收起。没有改动任何文件的检查，每天合成一行，只保留 7 天。";
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 本机时区里这一天 0 点的时间 */
const dayStart = (time: number, shift = 0): number => {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + shift).getTime();
};

/** 「今天 · 10月25日 周日」「昨天 · ……」「10月21日 周三」 */
const dayLabel = (start: number, now: number): string => {
  const date = new Date(start);
  const name = `${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]}`;
  if (start === dayStart(now)) return `今天 · ${name}`;
  if (start === dayStart(now, -1)) return `昨天 · ${name}`;
  return name;
};

/**
 * 超出 200 个的文件只存一个合计数量。记录时上传先占名额，
 * 所以下载一个都没记下名字时多出来的算上传，否则算下载；手动操作只有一组文件
 */
const unlisted = (record: SyncActivityRecord): {uploads: number; downloads: number; files: number} => {
  const more = record.moreFiles ?? 0;
  if (record.kind === "manual") return {uploads: 0, downloads: 0, files: more};
  return record.downloads.length === 0 ? {uploads: more, downloads: 0, files: 0} : {uploads: 0, downloads: more, files: 0};
};

const fileName = (file: SyncActivityFile): string => file.path.split("/").pop() || file.path;

const triggerText = (record: SyncActivityRecord): string => record.kind === "manual" ? "手动操作"
  : record.triggers.map(trigger => triggerLabels[trigger]).join("、") || "同步";

/** 行里「改了什么」：上传 N 个 · 下载 M 个，后面跟第一个文件的名字；没有文件时写错误说明 */
const recordSummary = (record: SyncActivityRecord): string => {
  if (record.kind === "manual") return record.summary ?? "手动操作";
  const more = unlisted(record);
  const uploads = record.uploads.length + more.uploads;
  const downloads = record.downloads.length + more.downloads;
  const first = record.uploads[0] ?? record.downloads[0];
  if (first) {
    const counts = [...(uploads ? [`上传 ${uploads} 个`] : []), ...(downloads ? [`下载 ${downloads} 个`] : [])].join(" · ");
    return `${counts}：${uploads + downloads === 1 ? `${fileKindLabels[first.kind]} ${fileName(first)}` : `${fileName(first)} 等`}`;
  }
  if (record.errorCategory) return `${errorCategoryLabels[record.errorCategory]}${record.outcome === "retrying" ? "，稍后重试" : ""}`;
  return "没有改动文件";
};

const renderRecord = (container: HTMLElement, record: SyncActivityRecord): void => {
  const item = container.createDiv({cls: "s3-vault-sync-record"});
  const line = item.createDiv({cls: "s3-vault-sync-record-line"});
  line.createSpan({cls: "s3-vault-sync-record-time", text: formatLocalClock(record.startedAt)});
  line.createSpan({cls: "s3-vault-sync-record-trigger", text: triggerText(record)});
  line.createSpan({cls: "s3-vault-sync-record-summary", text: recordSummary(record)});
  const state = record.kind === "manual" ? "manual" : record.outcome;
  line.createSpan({cls: `s3-vault-sync-record-state mod-${state}`, text: record.kind === "manual" ? "手动操作" : outcomeLabels[record.outcome]});
  line.createSpan({cls: "s3-vault-sync-record-arrow", text: "›"});
};

/** 画进已经建好的折叠区块里 */
export const renderSyncRecords = (section: HTMLElement, activity: SyncActivitySnapshot, now = Date.now()): void => {
  section.createEl("p", {cls: "s3-vault-sync-muted", text: HINT});
  const days = new Map<number, SyncActivityRecord[]>();
  for (const record of [...activity.records].sort((left, right) => right.startedAt - left.startedAt)) {
    const start = dayStart(record.startedAt);
    days.set(start, [...(days.get(start) ?? []), record]);
  }
  for (const [start, records] of days) {
    const day = section.createDiv({cls: "s3-vault-sync-records-day"});
    day.createDiv({cls: "s3-vault-sync-records-day-title", text: dayLabel(start, now)});
    for (const record of records) renderRecord(day, record);
  }
};
