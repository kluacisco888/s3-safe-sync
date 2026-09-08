import { describe, expect, it } from "vitest";

import {
  formatStatusBarText,
  formatSyncProgress,
} from "../src/plugin/sync-progress";

describe("formatSyncProgress", () => {
  it("keeps the current synchronization detail visible in the status bar", () => {
    expect(
      formatStatusBarText(
        "Another device published first. Retrying automatically in 39 seconds.",
      ),
    ).toBe(
      "S3 Sync: Another device published first. Retrying automatically in 39 seconds.",
    );
  });

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

  it("distinguishes metadata checks from content hashing", () => {
    expect(
      formatSyncProgress({
        completed: 1_517,
        phase: "scanning",
        total: 1_517,
        totalBytes: 0,
        transferredBytes: 0,
      }),
    ).toEqual({
      detail: "Checking metadata 1,517/1,517 (100%)",
      label: "Checking metadata 1,517/1,517 (100%)",
    });
    expect(
      formatSyncProgress({
        completed: 0,
        currentPath: "attachments/large.bin",
        phase: "hashing",
        total: 1,
        totalBytes: 2_048,
        transferredBytes: 0,
      }),
    ).toEqual({
      detail:
        "Hashing content 0/1 (0%) · 0 B / 2.00 KB · attachments/large.bin",
      label: "Hashing content 0/1 (0%)",
    });
  });
});
