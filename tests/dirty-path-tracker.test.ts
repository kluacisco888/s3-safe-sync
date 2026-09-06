import { describe, expect, it } from "vitest";

import {
  DirtyPathTracker,
  dirtyPathsForRename,
} from "../src/sync/dirty-path-tracker";

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

  it("marks both sides of every cached path under a renamed folder", () => {
    expect(
      dirtyPathsForRename(
        ["folder/a.md", "folder/nested/b.md", "other.md"],
        "folder",
        "renamed",
      ),
    ).toEqual(
      new Set([
        "folder",
        "renamed",
        "folder/a.md",
        "renamed/a.md",
        "folder/nested/b.md",
        "renamed/nested/b.md",
      ]),
    );
  });
});
