import { beforeEach, describe, expect, it } from "vitest";

import { createObsidianHttpExecutor } from "../src/storage/obsidian-request-adapter";

describe("createObsidianHttpExecutor", () => {
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
