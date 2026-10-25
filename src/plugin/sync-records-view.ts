import type { SyncActivityFile, SyncActivityRecord, SyncActivitySnapshot } from "./sync-activity";
import { formatLocalClock } from "./local-time";
import { PHASES, RETENTION_MS as DIAGNOSTICS_RETENTION_MS, type SyncRunRecord } from "./sync-diagnostics";
import { errorCategoryLabels, fileKindLabels, outcomeLabels, phaseLabels, triggerLabels } from "./sync-labels";

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

/** 不到 1 秒写毫秒，否则写一位小数的秒 */
const duration = (ms: number): string => ms < 1_000 ? `${Math.round(ms)} 毫秒` : `${(ms / 1_000).toFixed(1)} 秒`;

/** 字节数写成 KB，满 1 MB 写 MB，都保留一位小数 */
const size = (bytes: number): string => bytes === 0 ? "0 KB"
  : bytes < 1_024 * 1_024 ? `${(bytes / 1_024).toFixed(1)} KB` : `${(bytes / 1_024 / 1_024).toFixed(1)} MB`;

const renderFiles = (container: HTMLElement, title: string, files: readonly SyncActivityFile[], more: number): void => {
  if (files.length + more === 0) return;
  const group = container.createDiv({cls: "s3-vault-sync-record-group"});
  group.createDiv({cls: "s3-vault-sync-record-group-title", text: `${title}（${files.length + more} 个）`});
  const list = group.createEl("ul", {cls: "s3-vault-sync-record-files"});
  for (const file of files) {
    const item = list.createEl("li");
    item.createSpan({cls: `s3-vault-sync-record-file-kind mod-${file.kind}`, text: fileKindLabels[file.kind]});
    item.createSpan({cls: "s3-vault-sync-record-path", text: file.fromPath ? `${file.fromPath} → ${file.path}` : file.path});
  }
  if (more > 0) group.createEl("p", {cls: "s3-vault-sync-muted", text: `只记录了前 200 个文件名，另有 ${more} 个没有列出。`});
};

/** 详情最上面的一句说明：出错和重试时说发生了什么；只有下载时说明看不出是哪台设备改的 */
const explanation = (record: SyncActivityRecord): string => {
  if (record.kind === "manual") return "";
  const category = record.errorCategory;
  const problem = category === "local-change" ? "同步时文件还在被修改，插件先停下，等编辑停下几秒后重新同步。这不算出错，没有丢任何改动。"
    : category === "network" || category === "timeout" ? `${errorCategoryLabels[category]}，连不上 S3。`
    : category ? `${errorCategoryLabels[category]}。` : "";
  const retry = record.outcome === "retrying" && category !== "local-change" ? "稍后会自动重试。" : "";
  const downloadsOnly = record.uploads.length === 0 && record.downloads.length > 0
    ? "下载的文件是别的设备改的。本机只知道从 S3 下载了，看不出是哪台设备改的。" : "";
  return `${problem}${retry}${downloadsOnly}`;
};

const renderDetails = (body: HTMLElement, record: SyncActivityRecord): void => {
  const note = explanation(record);
  if (note) body.createEl("p", {cls: "s3-vault-sync-record-explain", text: note});
  const more = unlisted(record);
  if (record.kind === "manual") {
    renderFiles(body, "涉及的文件", record.files ?? [], more.files);
    return;
  }
  renderFiles(body, "上传到 S3", record.uploads, more.uploads);
  renderFiles(body, "从 S3 下载", record.downloads, more.downloads);
  body.createDiv({cls: "s3-vault-sync-record-tech", text: `开始 ${formatLocalClock(record.startedAt)} · 用时 ${duration(Math.max(0, record.finishedAt - record.startedAt))}`
    + ` · ${record.requests ?? 0} 次请求 · 发送 ${size(record.sentBytes ?? 0)} / 接收 ${size(record.receivedBytes ?? 0)}`});
  const phases = PHASES.flatMap(phase => {
    const spent = record.phaseDurations?.[phase];
    return spent === undefined ? [] : [`${phaseLabels[phase]} ${duration(spent)}`];
  });
  if (phases.length > 0) body.createDiv({cls: "s3-vault-sync-record-tech", text: `各阶段：${phases.join("、")}`});
};

/**
 * 点一下或聚焦后按回车 / 空格展开，再按一次收起。展开时才画详情（一条记录最多 200 个文件名）。
 * 展开状态按 key 记在 openRows 里，状态刷新重画后照样展开
 */
const expandable = (item: HTMLElement, target: HTMLElement, body: HTMLElement, key: string, openRows: Set<string>, fill: () => void): void => {
  target.setAttr("role", "button");
  target.setAttr("tabindex", "0");
  const show = (): void => {
    const open = openRows.has(key);
    item.toggleClass("is-open", open);
    target.setAttr("aria-expanded", String(open));
    body.empty();
    if (open) fill();
  };
  const flip = (): void => {
    if (openRows.has(key)) openRows.delete(key);
    else openRows.add(key);
    show();
  };
  target.addEventListener("click", flip);
  target.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      flip();
    }
  });
  show();
};

const renderRecord = (container: HTMLElement, record: SyncActivityRecord, openRows: Set<string>): void => {
  const item = container.createDiv({cls: "s3-vault-sync-record"});
  const line = item.createDiv({cls: "s3-vault-sync-record-line"});
  line.createSpan({cls: "s3-vault-sync-record-time", text: formatLocalClock(record.startedAt)});
  line.createSpan({cls: "s3-vault-sync-record-trigger", text: triggerText(record)});
  line.createSpan({cls: "s3-vault-sync-record-summary", text: recordSummary(record)});
  const state = record.kind === "manual" ? "manual" : record.outcome;
  line.createSpan({cls: `s3-vault-sync-record-state mod-${state}`, text: record.kind === "manual" ? "手动操作" : outcomeLabels[record.outcome]});
  line.createSpan({cls: "s3-vault-sync-record-arrow", text: "›"});
  const body = item.createDiv({cls: "s3-vault-sync-record-body"});
  expandable(item, line, body, `record:${record.id}`, openRows, () => renderDetails(body, record));
};

/**
 * 每天最后一行：诊断日志里这一天结果是 complete、没有改动文件的运行次数，点开按触发原因分类。
 * 诊断日志只留 7 天，整天都在 7 天以前的写「已经不保留」
 */
const renderQuietChecks = (day: HTMLElement, start: number, quietRuns: readonly SyncRunRecord[], openRows: Set<string>, now: number): void => {
  if (dayStart(start, 1) <= now - DIAGNOSTICS_RETENTION_MS) {
    day.createDiv({cls: "s3-vault-sync-records-older s3-vault-sync-muted", text: "超过 7 天，没有改动的检查已经不保留。"});
    return;
  }
  const runs = quietRuns.filter(run => dayStart(run.startedAt) === start);
  if (runs.length === 0) return;
  const byTrigger = new Map<string, number>();
  for (const run of runs) {
    const label = run.triggers[0] ? triggerLabels[run.triggers[0]] : "其他";
    byTrigger.set(label, (byTrigger.get(label) ?? 0) + 1);
  }
  const item = day.createDiv({cls: "s3-vault-sync-records-quiet"});
  const line = item.createDiv({cls: "s3-vault-sync-records-quiet-line"});
  line.createSpan({text: `另有 ${runs.length} 次检查，没有改动任何文件`});
  line.createSpan({cls: "s3-vault-sync-record-arrow", text: "›"});
  const body = item.createDiv({cls: "s3-vault-sync-records-quiet-body"});
  expandable(item, line, body, `quiet:${start}`, openRows, () => body.createSpan({
    text: `${[...byTrigger].sort((left, right) => right[1] - left[1]).map(([label, count]) => `${label} ${count} 次`).join(" · ")}。每次都成功完成。`,
  }));
};

/**
 * 画进已经建好的折叠区块里。runs 是诊断日志里的运行（只用来数没有改动的检查），
 * openRows 是用户展开的行，由窗口保管
 */
export const renderSyncRecords = (section: HTMLElement, activity: SyncActivitySnapshot, runs: readonly SyncRunRecord[],
  openRows: Set<string>, now = Date.now()): void => {
  section.createEl("p", {cls: "s3-vault-sync-muted", text: HINT});
  if (activity.persistenceWarning) section.createEl("p", {cls: "s3-vault-sync-error", text: activity.persistenceWarning});
  if (activity.records.length === 0) {
    section.createEl("p", {cls: "s3-vault-sync-muted", text: "最近 30 天还没有改动过文件的同步。"});
    return;
  }
  // 进了同步记录的运行都动过文件或出了问题；旧版本留下的运行再按结果里的数量排除一次
  const recorded = new Set(activity.records.map(record => record.id));
  const quietRuns = runs.filter(run => run.outcome === "complete" && !recorded.has(run.id) &&
    (run.counts?.uploaded ?? 0) + (run.counts?.downloaded ?? 0) + (run.counts?.deleted ?? 0) === 0);
  const days = new Map<number, SyncActivityRecord[]>();
  for (const record of [...activity.records].sort((left, right) => right.startedAt - left.startedAt)) {
    const start = dayStart(record.startedAt);
    days.set(start, [...(days.get(start) ?? []), record]);
  }
  for (const [start, records] of days) {
    const day = section.createDiv({cls: "s3-vault-sync-records-day"});
    day.createDiv({cls: "s3-vault-sync-records-day-title", text: dayLabel(start, now)});
    for (const record of records) renderRecord(day, record, openRows);
    renderQuietChecks(day, start, quietRuns, openRows, now);
  }
};
