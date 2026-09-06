import { describe, expect, it, vi } from "vitest";

import { HeadChangedError } from "../src/storage/remote-store";
import { retryHeadChanges } from "../src/sync/head-change-retry";

describe("retryHeadChanges", () => {
  it("uses backoff and succeeds after repeated Head changes", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new HeadChangedError())
      .mockRejectedValueOnce(new HeadChangedError())
      .mockRejectedValueOnce(new HeadChangedError())
      .mockResolvedValue("complete");
    const sleep = vi.fn(async () => undefined);

    await expect(
      retryHeadChanges(operation, {
        baseDelaysMs: [100, 200, 400, 800],
        random: () => 0,
        sleep,
      }),
    ).resolves.toBe("complete");

    expect(operation).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[100], [200], [400]]);
  });

  it("does not retry unrelated failures", async () => {
    const failure = new Error("Network unavailable");
    const operation = vi.fn(async () => {
      throw failure;
    });
    const sleep = vi.fn(async () => undefined);

    await expect(retryHeadChanges(operation, { sleep })).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops after the configured number of Head-change retries", async () => {
    const failure = new HeadChangedError();
    const operation = vi.fn(async () => {
      throw failure;
    });
    const sleep = vi.fn(async () => undefined);

    await expect(
      retryHeadChanges(operation, {
        baseDelaysMs: [100, 200],
        random: () => 0,
        sleep,
      }),
    ).rejects.toBe(failure);

    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[100], [200]]);
  });
});
