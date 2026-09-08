import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createObsidianHttpExecutor } from "../src/storage/obsidian-request-adapter";

describe("createObsidianHttpExecutor", () => {
  afterEach(() => vi.useRealTimers());

  it("cancels a waiting request and ignores its late response", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let finish!: (value: { arrayBuffer: ArrayBuffer; headers: Record<string, string>; status: number }) => void;
    const requestUrl = vi.fn(() => new Promise<{ arrayBuffer: ArrayBuffer; headers: Record<string, string>; status: number }>(resolve => { finish = resolve; }));
    const execute = createObsidianHttpExecutor(requestUrl, controller.signal);
    const request = { url: "https://example.invalid/head", method: "GET", headers: {} };
    const error = new Error("instance stopped");
    const pending = execute(request);
    controller.abort(error);
    await expect(pending).rejects.toBe(error);
    finish({ arrayBuffer: new ArrayBuffer(0), headers: {}, status: 200 });
    await expect(execute(request)).rejects.toBe(error);
    expect(requestUrl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a hung request after two minutes and permits a later request", async () => {
    vi.useFakeTimers();
    const requestUrl = vi.fn().mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue({ arrayBuffer: new ArrayBuffer(0), headers: {}, status: 200 });
    const execute = createObsidianHttpExecutor(requestUrl);
    const request = { url: "https://example.invalid/head", method: "GET", headers: {} };
    const result = execute(request).then(() => "success", error => String(error));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await Promise.race([result, Promise.resolve("still pending")])).toContain("timed out");
    await expect(execute(request)).resolves.toMatchObject({ status: 200 });
    expect(vi.getTimerCount()).toBe(0);
  });

  const requests: Array<{ headers?: Record<string, string> }> = [];
  const requestUrl = async (request: {
    headers?: Record<string, string>;
  }) => {
    requests.push(request);
    const headerNames = Object.keys(request.headers ?? {}).map((name) =>
      name.toLowerCase(),
    );
    if (headerNames.includes("host") || headerNames.includes("content-length")) {
      throw new Error("net::ERR_INVALID_ARGUMENT");
    }
    return {
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
      status: 200,
    };
  };
  const executeObsidianHttpRequest = createObsidianHttpExecutor(requestUrl);

  beforeEach(() => requests.splice(0));

  it("keeps signed headers but omits headers Chromium controls", async () => {
    await expect(
      executeObsidianHttpRequest({
        body: new TextEncoder().encode("body"),
        headers: {
          authorization: "signed",
          "Content-Length": "4",
          Host: "bucket.s3.cn-northwest-1.amazonaws.com.cn",
          "if-match": "etag",
        },
        method: "PUT",
        url: "https://bucket.s3.cn-northwest-1.amazonaws.com.cn/object",
      }),
    ).resolves.toMatchObject({ status: 200 });

    expect(requests).toContainEqual(
      expect.objectContaining({
        headers: {
          authorization: "signed",
          "if-match": "etag",
        },
      }),
    );
  });
});
