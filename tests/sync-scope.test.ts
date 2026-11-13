import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  FileSystemAdapter: class {},
  TFile: class {},
  Platform: { isDesktopApp: false, isAndroidApp: false },
  normalizePath: (path: string) => path,
}));

import { isInSyncScope } from "../src/plugin/obsidian-vault-port";

describe("macOS 文件夹图标文件 Icon\\r", () => {
  it.each(["Icon\r", "a/b/Icon\r"])("不在同步范围内：%j", (path) => {
    expect(isInSyncScope(path)).toBe(false);
  });

  it.each(["Icon", "Icon.md", "Icon\r.md", "MyIcon\r", "a/Icon/note.md"])(
    "名字只是相近的照旧同步：%j",
    (path) => {
      expect(isInSyncScope(path)).toBe(true);
    },
  );
});
