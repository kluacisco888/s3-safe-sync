import { describe, expect, it } from "vitest";

import { compareContent } from "../src/plugin/content-diff";

describe("content comparison", () => {
  it("compares an empty file without inventing a remote-only line", () => {
    const diff = compareContent("new text", "");
    expect(diff.summary).toBe("0 remote-only lines · 1 local-only line");
    expect(diff.lines).toEqual([{kind: "local", text: "new text", localLine: 1}]);
  });

  it("reports identical and line-ending-only differences separately", () => {
    expect(compareContent("same", "same").summary).toBe("Both text versions are identical.");
    const diff = compareContent("first\r\nsecond\r\n", "first\nsecond\n");
    expect(diff.summary).toBe("Only line-ending format differs; the text is identical.");
    expect(diff.lines).toEqual([]);
    expect(diff.localFormat).toBe("CRLF · final newline");
    expect(diff.remoteFormat).toBe("LF · final newline");
  });

  it("keeps line numbers aligned across an insertion and a later deletion", () => {
    const diff = compareContent("a\nadded\nb\nc\ne", "a\nb\nc\ndeleted\ne");
    expect(diff.summary).toBe("1 remote-only line · 1 local-only line");
    expect(diff.lines).toEqual([
      {kind: "context", text: "a", localLine: 1, remoteLine: 1},
      {kind: "local", text: "added", localLine: 2},
      {kind: "context", text: "b", localLine: 3, remoteLine: 2},
      {kind: "context", text: "c", localLine: 4, remoteLine: 3},
      {kind: "remote", text: "deleted", remoteLine: 4},
      {kind: "context", text: "e", localLine: 5, remoteLine: 5},
    ]);
  });

  it("does not silently ignore trailing whitespace, Unicode markers or a final newline", () => {
    const whitespace = compareContent("正文  ", "正文\t");
    expect(whitespace.lines.filter(line => line.kind !== "context").map(line => line.text)).toEqual(["正文\t", "正文  "]);
    const bom = compareContent("\uFEFF正文", "正文");
    expect(bom.localFormat).toContain("BOM");
    expect(bom.summary).toBe("1 remote-only line · 1 local-only line");
    const newline = compareContent("正文\n", "正文");
    expect(newline.summary).toBe("0 remote-only lines · 1 local-only line");
    expect(newline.remoteFormat).toBe("No line endings · no final newline");
    expect(newline.lines.at(-1)).toEqual({kind: "local", text: "", localLine: 2});
  });

  it("collapses unchanged paragraphs and compares a small edit in a long document", () => {
    const lines = Array.from({length: 5_000}, (_, index) => `paragraph ${index}`);
    const local = [...lines];
    local[2500] = "changed paragraph";
    const diff = compareContent(local.join("\n"), lines.join("\n"));
    expect(diff.summary).toBe("1 remote-only line · 1 local-only line");
    expect(diff.warning).toBeUndefined();
    expect(diff.lines).toHaveLength(8);
    expect(diff.lines[0]).toEqual({kind: "omitted", text: "… 2498 unchanged lines …"});
    expect(diff.lines.find(line => line.kind === "local")).toEqual({kind: "local", text: "changed paragraph", localLine: 2501});
  });

  it("bounds expensive comparisons and rendered rows without claiming the rest is identical", () => {
    const diff = compareContent("local\n".repeat(1_100), "remote\n".repeat(1_100));
    expect(diff.summary).toContain("too large");
    expect(diff.warning).toContain("full versions");
    expect(diff.lines).toEqual([]);
    const many = compareContent("new\n".repeat(600), "");
    expect(many.lines).toHaveLength(400);
    expect(many.warning).toContain("first 400");
    expect(many.summary).toBe("0 remote-only lines · 601 local-only lines");
  });

  it("bounds repeated-line matching even when the document fits the general work limit", () => {
    const repeated = Array.from({length: 998}, () => "repeated").join("\n");
    const diff = compareContent(`local start\n${repeated}\nlocal end`, `remote start\n${repeated}\nremote end`);
    expect(diff.summary).toContain("too large");
    expect(diff.warning).toContain("full versions");
    expect(diff.lines).toEqual([]);
  });
});
