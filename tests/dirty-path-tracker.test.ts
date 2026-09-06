import { describe, expect, it } from "vitest";

import { DirtyPathTracker } from "../src/sync/dirty-path-tracker";

describe("DirtyPathTracker", () => {
  it("does not acknowledge edits that arrive after a sync captures its paths", () => {
    const tracker = new DirtyPathTracker();
    tracker.mark("notes/draft.md");
    const captured = tracker.capture();

    tracker.mark("notes/draft.md");
    tracker.mark("notes/new.md");
    tracker.acknowledge(captured);

    const remaining = tracker.capture();
    expect([...remaining.keys()]).toEqual([
      "notes/draft.md",
      "notes/new.md",
    ]);

    tracker.acknowledge(remaining);
    expect(tracker.capture().size).toBe(0);
  });

  it("retains a captured path that the device could not verify", () => {
    const tracker = new DirtyPathTracker();
    tracker.mark("attachments/large.bin");
    tracker.mark("notes/verified.md");
    const captured = tracker.capture();

    tracker.acknowledge(captured, new Set(["attachments/large.bin"]));

    expect([...tracker.capture().keys()]).toEqual([
      "attachments/large.bin",
    ]);
  });

  it("identifies the first path changed after a synchronization snapshot", () => {
    const tracker = new DirtyPathTracker();
    tracker.mark("notes/existing.md");
    const captured = tracker.capture();
    expect(tracker.changedPathSince(captured)).toBeUndefined();

    tracker.mark("notes/renamed.md");

    expect(tracker.changedPathSince(captured)).toBe("notes/renamed.md");
  });
});
