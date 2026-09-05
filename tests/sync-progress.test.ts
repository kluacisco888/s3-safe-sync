import { describe, expect, it } from "vitest";

import { formatSyncProgress } from "../src/plugin/sync-progress";

describe("formatSyncProgress", () => {
  it("formats a compact label and a detailed current-file message", () => {
    expect(
      formatSyncProgress({
        completed: 954,
        currentPath: "notes/current.md",
        phase: "uploading",
        total: 1559,
        totalBytes: 1_084_013_283,
        transferredBytes: 650_000_000,
      }),
    ).toEqual({
      detail:
        "Uploading 954/1,559 (61%) · 620 MB / 1.01 GB · notes/current.md",
      label: "Uploading 954/1,559 (61%)",
    });
  });

  it("shows publication as a finalization step", () => {
    expect(
      formatSyncProgress({
        completed: 1559,
        phase: "publishing",
        total: 1559,
        totalBytes: 1_084_013_283,
        transferredBytes: 1_084_013_283,
      }),
    ).toEqual({
      detail: "Publishing encrypted snapshot · 1.01 GB / 1.01 GB",
      label: "Publishing encrypted snapshot",
    });
  });
});
