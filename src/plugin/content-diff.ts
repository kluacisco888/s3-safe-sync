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
  return `${names.join(" / ") || "No line endings"} · ${/[\r\n]$/.test(text) ? "final newline" : "no final newline"}${text.startsWith("\uFEFF") ? " · BOM" : ""}`;
};

// This is a two-way comparison, not a claim about which version is newer.
export const compareContent = (local: string, remote: string): ContentDiff => {
  const result: ContentDiff = {summary: "", localFormat: format(local), remoteFormat: format(remote), lines: []};
  const normalize = (text: string): string => text.replace(/\r\n?/g, "\n");
  const a = remote ? normalize(remote).split("\n") : [];
  const b = local ? normalize(local).split("\n") : [];
  if (local === remote || normalize(local) === normalize(remote)) {
    result.summary = local === remote ? "Both text versions are identical." : "Only line-ending format differs; the text is identical.";
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
    result.summary = "Detailed line comparison is too large to display safely.";
    result.warning = "Open the full versions below to compare them. Neither version has been changed.";
    return result;
  }
  const changes = diffIndices(changedA, changedB);
  let remoteOnly = 0;
  let localOnly = 0;
  let cursorA = 0;
  let cursorB = 0;
  const append = (line: DiffLine): void => {
    if (result.lines.length < 400) result.lines.push(line);
    else result.warning = "Showing the first 400 comparison rows. Open the full versions below for the remaining content.";
  };
  const common = (count: number, first: boolean, last: boolean): void => {
    let omitted = 0;
    for (let index = 0; index < count; index++) {
      if ((!first && index < 2) || (!last && index >= count - 2)) {
        if (omitted) { append({kind: "omitted", text: `… ${omitted} unchanged lines …`}); omitted = 0; }
        append({kind: "context", text: a[cursorA + index]!, remoteLine: cursorA + index + 1, localLine: cursorB + index + 1});
      } else omitted++;
    }
    if (omitted) append({kind: "omitted", text: `… ${omitted} unchanged lines …`});
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
  result.summary = `${remoteOnly} remote-only line${remoteOnly === 1 ? "" : "s"} · ${localOnly} local-only line${localOnly === 1 ? "" : "s"}`;
  return result;
};

export const renderContentDiff = (container: HTMLElement, local: string, remote: string): void => {
  const diff = compareContent(local, remote);
  container.createEl("p", {text: diff.summary});
  container.createEl("p", {text: `Local: ${diff.localFormat}. Remote: ${diff.remoteFormat}.`});
  if (diff.warning) container.createEl("p", {text: diff.warning});
  if (!diff.lines.length) return;
  container.createEl("p", {text: "− Remote only · + Local only. These markers do not indicate which version is newer. · marks edge spaces, → tabs, [BOM] a byte-order mark."});
  const rows = container.createDiv({cls: "s3-vault-sync-diff"});
  const heading = rows.createDiv({cls: "s3-vault-sync-diff-row"});
  heading.createSpan({text: "Remote"});
  heading.createSpan({text: "Local"});
  heading.createSpan({text: "Content"});
  for (const line of diff.lines) {
    const row = rows.createDiv({cls: `s3-vault-sync-diff-row s3-vault-sync-diff-${line.kind}`});
    row.createSpan({text: line.remoteLine?.toString() ?? ""});
    row.createSpan({text: line.localLine?.toString() ?? ""});
    const prefix = line.kind === "remote" ? "− " : line.kind === "local" ? "+ " : "  ";
    const visible = line.text.replace(/^ +| +$/g, spaces => "·".repeat(spaces.length)).replace(/\t/g, "→").replace(/\uFEFF/g, "[BOM]");
    row.createEl("code", {text: `${prefix}${visible || "[empty line]"}`});
  }
};
