import { describe, expect, it, vi } from "vitest";

import {
  SyncRequestQueue,
  type SyncRunOptions,
} from "../src/sync/sync-request-queue";

describe("SyncRequestQueue", () => {
  it("runs another sync when a request arrives during an active sync", async () => {
    let finishFirstSync: (() => void) | undefined;
    const run = vi
      .fn<(options: SyncRunOptions) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirstSync = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const queue = new SyncRequestQueue(run);

    const firstRequest = queue.request();
    await Promise.resolve();
    const secondRequest = queue.request();
    finishFirstSync?.();
    await Promise.all([firstRequest, secondRequest]);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("preserves a queued full hash verification request", async () => {
    let finishFirstSync: (() => void) | undefined;
    const run = vi
      .fn<(options: SyncRunOptions) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirstSync = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const queue = new SyncRequestQueue(run);

    const automaticRequest = queue.request();
    await Promise.resolve();
    const manualRequest = queue.request({ fullHashVerification: true });
    finishFirstSync?.();
    await Promise.all([automaticRequest, manualRequest]);

    expect(run).toHaveBeenNthCalledWith(1, {
      allowBulkDeletion: false,
      fullHashVerification: false,
    });
    expect(run).toHaveBeenNthCalledWith(2, {
      allowBulkDeletion: false,
      fullHashVerification: true,
    });
  });

  it("does not promote an ordinary request queued behind a full check", async () => {
    let finishFirstSync: (() => void) | undefined;
    const run = vi
      .fn<(options: SyncRunOptions) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirstSync = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const queue = new SyncRequestQueue(run);

    const fullCheck = queue.request({ fullHashVerification: true });
    await Promise.resolve();
    const ordinaryRequest = queue.request();
    finishFirstSync?.();
    await Promise.all([fullCheck, ordinaryRequest]);

    expect(run).toHaveBeenNthCalledWith(1, {
      allowBulkDeletion: false,
      fullHashVerification: true,
    });
    expect(run).toHaveBeenNthCalledWith(2, {
      allowBulkDeletion: false,
      fullHashVerification: false,
    });
  });

  it("does not queue a periodic poll while synchronization is already active", async () => {
    let finishSync: (() => void) | undefined;
    const run = vi
      .fn<(options: SyncRunOptions) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishSync = resolve;
          }),
      );
    const queue = new SyncRequestQueue(run);

    const activeSync = queue.request();
    await Promise.resolve();
    const periodicPolls = Array.from({ length: 10 }, () =>
      queue.requestPeriodic(false),
    );
    finishSync?.();
    await Promise.all([activeSync, ...periodicPolls]);

    expect(run).toHaveBeenCalledOnce();
    expect(queue.isRunning).toBe(false);
  });

  it("runs a periodic poll when synchronization is idle", async () => {
    const run = vi.fn(async () => undefined);
    const queue = new SyncRequestQueue(run);

    await queue.requestPeriodic(false);

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith({
      allowBulkDeletion: false,
      fullHashVerification: false,
    });
  });

  it("does not run a periodic poll during Head retry backoff", async () => {
    const run = vi.fn(async () => undefined);
    const queue = new SyncRequestQueue(run);

    await queue.requestPeriodic(true);

    expect(run).not.toHaveBeenCalled();
    expect(queue.isRunning).toBe(false);
  });

  it("serializes direct operations with queued synchronization", async () => {
    const events: string[] = [];
    let releaseDirect = (): void => undefined;
    const directGate = new Promise<void>((resolve) => {
      releaseDirect = resolve;
    });
    let directStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      directStarted = resolve;
    });
    const queue = new SyncRequestQueue(async () => {
      events.push("sync");
    });
    const direct = queue.runExclusive(async () => {
      events.push("direct-start");
      directStarted();
      await directGate;
      events.push("direct-end");
    });
    await started;

    const sync = queue.request();
    await Promise.resolve();
    expect(events).toEqual(["direct-start"]);
    releaseDirect();
    await Promise.all([direct, sync]);

    expect(events).toEqual(["direct-start", "direct-end", "sync"]);
  });

  it("continues after an exclusive operation fails", async () => {
    const run = vi.fn(async () => undefined);
    const queue = new SyncRequestQueue(run);

    await expect(
      queue.runExclusive(() => Promise.reject(new Error("direct failure"))),
    ).rejects.toThrow("direct failure");
    await queue.request();

    expect(run).toHaveBeenCalledOnce();
  });

  it("does not lose a request at the runner completion boundary", async () => {
    let finishFirstSync: (() => void) | undefined;
    const firstSync = new Promise<void>((resolve) => {
      finishFirstSync = resolve;
    });
    const run = vi
      .fn<(options: SyncRunOptions) => Promise<void>>()
      .mockImplementationOnce(() => firstSync)
      .mockResolvedValue(undefined);
    const queue = new SyncRequestQueue(run);

    const firstRequest = queue.request();
    let boundaryRequest: Promise<void> | undefined;
    void firstSync.then(() => {
      boundaryRequest = queue.request();
    });
    finishFirstSync?.();
    await firstRequest;
    await Promise.resolve();
    await boundaryRequest;

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not start a second runner when the run callback requests sync", async () => {
    let activeRuns = 0;
    let maxActiveRuns = 0;
    let runCount = 0;
    let queue: SyncRequestQueue;
    const run = vi.fn(async () => {
      activeRuns += 1;
      maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
      runCount += 1;
      if (runCount === 1) {
        void queue.request();
      }
      await Promise.resolve();
      activeRuns -= 1;
    });
    queue = new SyncRequestQueue(run);

    await queue.request();

    expect(run).toHaveBeenCalledTimes(2);
    expect(maxActiveRuns).toBe(1);
  });
});
