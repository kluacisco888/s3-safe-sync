import { diffIndices } from "node-diff3";

interface DiffLine {
  kind: "local" | "remote" | "context" | "omitted";
  text: string;
  localLine?: number;
  remoteLine?: number;
}

export interface ContentDiff {
  summary: string;
  localFormat: string;
  remoteFormat: string;
  lines: DiffLine[];
  warning?: string;
}

const format = (text: string): string => {
  const endings = new Set(text.match(/\r\n|\r|\n/g) ?? []);
  const names = [...endings].map(ending => ending === "\r\n" ? "CRLF" : ending === "\n" ? "LF" : "CR");
  return `${names.join(" / ") || "无换行符"} · ${/[\r\n]$/.test(text) ? "末尾有换行" : "末尾无换行"}${text.startsWith("\uFEFF") ? " · BOM" : ""}`;
};

// This is a two-way comparison, not a claim about which version is newer.
export const compareContent = (local: string, remote: string): ContentDiff => {
  const result: ContentDiff = {summary: "", localFormat: format(local), remoteFormat: format(remote), lines: []};
  const normalize = (text: string): string => text.replace(/\r\n?/g, "\n");
  const a = remote ? normalize(remote).split("\n") : [];
  const b = local ? normalize(local).split("\n") : [];
  if (local === remote || normalize(local) === normalize(remote)) {
    result.summary = local === remote ? "两个版本的文字完全相同。" : "只有换行符格式不同，文字完全相同。";
    return result;
  }
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const changedA = a.slice(start, endA);
  const changedB = b.slice(start, endB);
  const frequencies = new Map<string, number>();
  for (const line of changedB) frequencies.set(line, (frequencies.get(line) ?? 0) + 1);
  let matchingPairs = 0;
  for (const line of changedA) matchingPairs += frequencies.get(line) ?? 0;
  // Bound the synchronous LCS work, including repeated-line worst cases on mobile.
  if (changedA.length * changedB.length > 1_000_000 || matchingPairs > 40_000) {
    result.summary = "逐行对比内容太多，无法安全显示。";
    result.warning = "请展开下方的完整版本自行对比。两个版本都没有被改动。";
    return result;
  }
  const changes = diffIndices(changedA, changedB);
  let remoteOnly = 0;
  let localOnly = 0;
  let cursorA = 0;
  let cursorB = 0;
  const append = (line: DiffLine): void => {
    if (result.lines.length < 400) result.lines.push(line);
    else result.warning = "只显示前 400 行对比。其余内容请展开下方的完整版本查看。";
  };
  const common = (count: number, first: boolean, last: boolean): void => {
    let omitted = 0;
    for (let index = 0; index < count; index++) {
      if ((!first && index < 2) || (!last && index >= count - 2)) {
        if (omitted) { append({kind: "omitted", text: `… ${omitted} 行未变 …`}); omitted = 0; }
        append({kind: "context", text: a[cursorA + index]!, remoteLine: cursorA + index + 1, localLine: cursorB + index + 1});
      } else omitted++;
    }
    if (omitted) append({kind: "omitted", text: `… ${omitted} 行未变 …`});
    cursorA += count;
    cursorB += count;
  };
  for (const change of changes) {
    const [offsetA, countA] = change.buffer1;
    const [offsetB, countB] = change.buffer2;
    common(start + offsetA - cursorA, cursorA === 0 && cursorB === 0, false);
    for (let index = 0; index < countA; index++) {
      append({kind: "remote", text: a[start + offsetA + index]!, remoteLine: start + offsetA + index + 1});
    }
    for (let index = 0; index < countB; index++) {
      append({kind: "local", text: b[start + offsetB + index]!, localLine: start + offsetB + index + 1});
    }
    remoteOnly += countA;
    localOnly += countB;
    cursorA += countA;
    cursorB += countB;
  }
  common(a.length - cursorA, false, true);
  result.summary = `仅远端有 ${remoteOnly} 行 · 仅本地有 ${localOnly} 行`;
  return result;
};

export const renderContentDiff = (container: HTMLElement, local: string, remote: string): void => {
  const diff = compareContent(local, remote);
  container.createEl("p", {text: diff.summary});
  container.createEl("p", {text: `本地：${diff.localFormat}。远端：${diff.remoteFormat}。`});
  if (diff.warning) container.createEl("p", {text: diff.warning});
  if (!diff.lines.length) return;
  container.createEl("p", {text: "− 仅远端有 · + 仅本地有。这些标记不代表哪个版本更新。· 表示行首行尾的空格，→ 表示制表符，[BOM] 表示字节顺序标记。"});
  const rows = container.createDiv({cls: "s3-vault-sync-diff"});
  const heading = rows.createDiv({cls: "s3-vault-sync-diff-row"});
  heading.createSpan({text: "远端"});
  heading.createSpan({text: "本地"});
  heading.createSpan({text: "内容"});
  for (const line of diff.lines) {
    const row = rows.createDiv({cls: `s3-vault-sync-diff-row s3-vault-sync-diff-${line.kind}`});
    row.createSpan({text: line.remoteLine?.toString() ?? ""});
    row.createSpan({text: line.localLine?.toString() ?? ""});
    const prefix = line.kind === "remote" ? "− " : line.kind === "local" ? "+ " : "  ";
    const visible = line.text.replace(/^ +| +$/g, spaces => "·".repeat(spaces.length)).replace(/\t/g, "→").replace(/\uFEFF/g, "[BOM]");
    row.createEl("code", {text: `${prefix}${visible || "[空行]"}`});
  }
};
