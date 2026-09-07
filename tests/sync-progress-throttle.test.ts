import { describe, expect, it } from "vitest";

import { SyncProgressThrottle } from "../src/plugin/sync-progress-throttle";
import type { SyncProgress } from "../src/sync/sync-service";

const progress = (
  overrides: Partial<SyncProgress> = {},
): SyncProgress => ({
  completed: 0,
  phase: "hashing",
  total: 10,
  totalBytes: 1_000,
  transferredBytes: 0,
  ...overrides,
});

describe("SyncProgressThrottle", () => {
  it("renders important boundaries and throttles intermediate updates", () => {
    const throttle = new SyncProgressThrottle(100);

    expect(throttle.shouldRender(progress({ phase: "scanning" }), 0)).toBe(true);
    expect(throttle.shouldRender(progress({ phase: "scanning" }), 1)).toBe(false);
    expect(throttle.shouldRender(progress(), 2)).toBe(true);
    expect(
      throttle.shouldRender(progress({ currentPath: "notes/one.md" }), 3),
    ).toBe(true);
    expect(
      throttle.shouldRender(progress({ currentPath: "notes/two.md" }), 4),
    ).toBe(false);
    expect(
      throttle.shouldRender(progress({ currentPath: "notes/two.md" }), 103),
    ).toBe(true);
    expect(
      throttle.shouldRender(
        progress({ completed: 10, transferredBytes: 1_000 }),
        104,
      ),
    ).toBe(true);

    throttle.reset();
    expect(throttle.shouldRender(progress(), 105)).toBe(true);
  });
});
