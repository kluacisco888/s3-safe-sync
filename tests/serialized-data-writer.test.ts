import { describe, expect, it } from "vitest";

import { SerializedDataWriter } from "../src/plugin/serialized-data-writer";

describe("SerializedDataWriter", () => {
  it("writes in order and snapshots queued saves only when they start", async () => {
    let state = { value: 1 };
    let releaseFirst = (): void => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: number[] = [];
    const completed: number[] = [];
    let active = 0;
    let maxActive = 0;
    const writer = new SerializedDataWriter(
      () => state,
      async (snapshot) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        started.push(snapshot.value);
        if (snapshot.value === 1) {
          await firstGate;
        }
        completed.push(snapshot.value);
        active -= 1;
      },
    );

    const first = writer.save();
    await Promise.resolve();
    state = { value: 2 };
    const second = writer.save();
    state = { value: 3 };
    releaseFirst();
    await Promise.all([first, second]);

    expect(started).toEqual([1, 3]);
    expect(completed).toEqual([1, 3]);
    expect(maxActive).toBe(1);
  });

  it("continues with the latest state after an earlier write fails", async () => {
    let state = { value: 1 };
    const written: number[] = [];
    const writer = new SerializedDataWriter(
      () => state,
      async (snapshot) => {
        if (snapshot.value === 1) {
          throw new Error("disk unavailable");
        }
        written.push(snapshot.value);
      },
    );

    await expect(writer.save()).rejects.toThrow("disk unavailable");
    state = { value: 2 };
    await writer.save();

    expect(written).toEqual([2]);
  });
});
