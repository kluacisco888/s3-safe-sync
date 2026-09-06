import { describe, expect, it } from "vitest";

import { canonicalVaultPath } from "../src/sync/canonical-path";
import { sha256Content } from "../src/sync/content-hash";

describe("sync primitives", () => {
  it("uses one stable SHA-256 content-hash format for buffers and views", async () => {
    const source = new TextEncoder().encode("xabcx");
    const view = source.subarray(1, 4);
    const expected =
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    await expect(sha256Content(view)).resolves.toBe(expected);
    await expect(sha256Content(view.slice().buffer)).resolves.toBe(expected);
  });

  it("normalizes Unicode and case for cross-platform path identity", () => {
    expect(canonicalVaultPath("Notes/Cafe\u0301.md")).toBe(
      canonicalVaultPath("notes/CAFÉ.md"),
    );
  });
});
