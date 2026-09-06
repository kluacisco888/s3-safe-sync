import { describe, expect, it } from "vitest";

import { decodeDeletedPreview } from "../src/plugin/deleted-preview";

describe("decodeDeletedPreview", () => {
  it("returns UTF-8 note content", () => {
    expect(
      decodeDeletedPreview(new TextEncoder().encode("# Note\n\n正文")),
    ).toBe("# Note\n\n正文");
  });

  it("rejects binary control bytes", () => {
    expect(decodeDeletedPreview(Uint8Array.of(0, 1, 2))).toBeUndefined();
  });

  it("rejects invalid UTF-8", () => {
    expect(decodeDeletedPreview(Uint8Array.of(0xff, 0xfe))).toBeUndefined();
  });
});
