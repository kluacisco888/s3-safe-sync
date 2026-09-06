import { describe, expect, it } from "vitest";

import { PathRenameTracker } from "../src/sync/path-rename-tracker";

describe("PathRenameTracker", () => {
  it("records both sides and stable source mappings for a folder rename", () => {
    const tracker = new PathRenameTracker();

    const dirtyPaths = tracker.record(
      [
        { entryId: "a", path: "folder/a.md" },
        { entryId: "b", path: "folder/nested/b.md" },
        { entryId: "other", path: "other.md" },
      ],
      "folder",
      "renamed",
    );

    expect(dirtyPaths).toEqual(
      new Set([
        "folder",
        "renamed",
        "folder/a.md",
        "renamed/a.md",
        "folder/nested/b.md",
        "renamed/nested/b.md",
      ]),
    );
    expect(tracker.toPathMap(tracker.capture())).toEqual(
      new Map([
        [
          "folder/a.md",
          { entryId: "a", toPath: "renamed/a.md" },
        ],
        [
          "folder/nested/b.md",
          { entryId: "b", toPath: "renamed/nested/b.md" },
        ],
      ]),
    );
  });

  it("chains repeated renames and removes a rename that returns to its source", () => {
    const tracker = new PathRenameTracker();
    tracker.record([{ entryId: "entry-a", path: "a.md" }], "a.md", "b.md");

    tracker.record([{ entryId: "entry-a", path: "a.md" }], "b.md", "c.md");
    expect(tracker.serialize()).toEqual({
      "a.md": { entryId: "entry-a", toPath: "c.md" },
    });

    tracker.record([{ entryId: "entry-a", path: "a.md" }], "c.md", "a.md");
    expect(tracker.serialize()).toEqual({});
  });

  it("persists newer and temporarily unverified rename observations", () => {
    const tracker = new PathRenameTracker({
      "a.md": { entryId: "entry-a", toPath: "b.md" },
    });
    const captured = tracker.capture();
    tracker.record([{ entryId: "entry-a", path: "a.md" }], "b.md", "c.md");

    tracker.acknowledge(captured);
    expect(tracker.serialize()).toEqual({
      "a.md": { entryId: "entry-a", toPath: "c.md" },
    });

    const latest = tracker.capture();
    tracker.acknowledge(latest, new Set(["c.md"]));
    expect(tracker.serialize()).toEqual({
      "a.md": { entryId: "entry-a", toPath: "c.md" },
    });
  });
});
