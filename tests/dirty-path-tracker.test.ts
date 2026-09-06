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
});
