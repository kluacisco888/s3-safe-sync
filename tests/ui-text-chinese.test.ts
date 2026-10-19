import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 界面相关源码：这些文件里传给界面调用的字符串都会显示给用户
const UI_FILES = [
  "src/main.ts",
  "src/plugin/settings.ts",
  "src/plugin/modals.ts",
  "src/plugin/cleanup-modal.ts",
  "src/plugin/content-review-modal.ts",
  "src/plugin/path-collision-modal.ts",
  "src/plugin/content-diff.ts",
  "src/plugin/modal-actions.ts",
  "src/plugin/sync-progress.ts",
];

// 界面调用的起点：其后的参数（或属性值）会显示给用户
const UI_CALL = new RegExp([
  String.raw`\.(?:setName|setDesc|setText|setButtonText|setPlaceholder|setTooltip|addOption)\(`,
  String.raw`new Notice\(`,
  String.raw`\bactionButton\(`,
  String.raw`\bshowGuidance\(`,
  String.raw`setAttr\("(?:aria-label|title)",`,
  String.raw`"aria-label":`,
  String.raw`\btext:`,
  String.raw`\bname:`,
  String.raw`\bdescription:`,
  String.raw`\blabel:`,
  String.raw`\bsummary =`,
  String.raw`\bwarning =`,
  String.raw`\bpersistenceWarning =`,
].join("|"), "g");

// 允许保留英文的专有名词（按长度从长到短替换，避免短词先吃掉长词的一部分）
const PROPER_NOUNS = [
  "Secret Access Key", "Access Key ID", "S3 Vault Sync", "S3 Safe Sync", "Remotely Save", "SecretStorage",
  "ListObjectsV2", "Content-Range", "If-Match", "Obsidian", "Unicode", "UTF-8", "Wi-Fi", "ETag", "HTTP",
  "Head", "AWS", "VPN", "BOM", "CRLF", "S3",
].sort((a, b) => b.length - a.length);

// 只含小写字母、数字和连字符的单个词是内部取值（如 "local"、"possible-rename"），不是界面文字
const INTERNAL_VALUE = /^[a-z][a-z0-9-]*$/;

/** 从位置 start 起读到参数结束（同层的逗号或闭括号），返回这段表达式源码 */
const readArgument = (source: string, start: number): string => {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\"" || char === "'" || char === "`") {
      index = skipString(source, index);
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) break;
      depth--;
    } else if (char === "," && depth === 0) break;
    else if (char === ";" && depth === 0) break;
    index++;
  }
  return source.slice(start, index);
};

/** 跳过一个字符串字面量（含模板字符串里嵌套的 ${...}），返回其后的位置 */
const skipString = (source: string, start: number): number => {
  const quote = source[start]!;
  let index = start + 1;
  while (index < source.length && source[index] !== quote) {
    if (source[index] === "\\") index += 2;
    else if (quote === "`" && source.startsWith("${", index)) index = skipInterpolation(source, index + 2);
    else index++;
  }
  return index + 1;
};

const skipInterpolation = (source: string, start: number): number => {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\"" || char === "'" || char === "`") { index = skipString(source, index); continue; }
    if (char === "{") depth++;
    else if (char === "}") { if (depth === 0) return index + 1; depth--; }
    index++;
  }
  return index;
};

/** 取出一段表达式里所有字符串字面量的静态文字（模板里的 ${...} 递归处理） */
const literals = (expression: string): string[] => {
  const found: string[] = [];
  let index = 0;
  while (index < expression.length) {
    const char = expression[index]!;
    if (char !== "\"" && char !== "'" && char !== "`") { index++; continue; }
    const end = skipString(expression, index);
    const body = expression.slice(index + 1, end - 1);
    if (char === "`") {
      let text = "";
      let cursor = 0;
      while (cursor < body.length) {
        if (body.startsWith("${", cursor)) {
          const close = skipInterpolation(body, cursor + 2);
          found.push(...literals(body.slice(cursor + 2, close - 1)));
          text += " ";
          cursor = close;
        } else text += body[cursor++];
      }
      found.push(text);
    } else found.push(body);
    index = end;
  }
  return found;
};

const containsEnglish = (text: string): boolean => {
  if (INTERNAL_VALUE.test(text.trim())) return false;
  let rest = text;
  for (const noun of PROPER_NOUNS) rest = rest.split(noun).join(" ");
  return /[A-Za-z]{3,}/.test(rest);
};

/** 列出界面源码里仍含英文的界面文字，返回「文件:行号 文字」 */
const findEnglishUiText = (files = UI_FILES): string[] => {
  const problems: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(UI_CALL)) {
      const start = match.index + match[0].length;
      for (const text of literals(readArgument(source, start))) {
        if (!containsEnglish(text)) continue;
        const line = source.slice(0, match.index).split("\n").length;
        problems.push(`${file}:${line} ${text}`);
      }
    }
  }
  return problems;
};

describe("界面文字全部为中文", () => {
  it("界面相关源码里没有残留的英文界面文字", () => {
    expect(findEnglishUiText()).toEqual([]);
  });

  it("能识别新增的英文界面文字，并放行专有名词和内部取值", () => {
    expect(containsEnglish("Sync now")).toBe(true);
    expect(containsEnglish("Close")).toBe(true);
    expect(containsEnglish("保存两项 AWS 凭证到 SecretStorage")).toBe(false);
    expect(containsEnglish("Access Key ID")).toBe(false);
    expect(containsEnglish("possible-rename")).toBe(false);
    expect(literals('side === "local" ? `本地 ${count} 个` : "Remote only"')).toEqual(["local", "本地   个", "Remote only"]);
  });
});
