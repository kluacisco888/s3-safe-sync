import { describe, expect, it } from "vitest";

import {
  AwsS3ObjectStore,
  type HttpRequestInput,
  type HttpResponseOutput,
} from "../src/storage/aws-s3-object-store";
import { ObjectPreconditionError } from "../src/storage/object-store";

describe("AwsS3ObjectStore", () => {
  it("maps an AWS conditional-write rejection to ObjectPreconditionError", async () => {
    let captured: HttpRequestInput | undefined;
    const execute = async (
      request: HttpRequestInput,
    ): Promise<HttpResponseOutput> => {
      captured = request;
      return {
        body: new Uint8Array(),
        headers: {},
        status: 412,
      };
    };
    const store = new AwsS3ObjectStore({
      accessKeyId: "AKIDEXAMPLE",
      bucket: "example-bucket",
      execute,
      region: "us-east-1",
      secretAccessKey: "secret-example",
    });

    await expect(
      store.put("chosen-prefix/v1/head", new TextEncoder().encode("body"), {
        ifMatch: '"old-etag"',
      }),
    ).rejects.toBeInstanceOf(ObjectPreconditionError);

    expect(captured).toMatchObject({
      headers: expect.objectContaining({
        authorization: expect.stringContaining("AWS4-HMAC-SHA256"),
        "if-match": '"old-etag"',
      }),
      method: "PUT",
      url: "https://example-bucket.s3.us-east-1.amazonaws.com/chosen-prefix/v1/head",
    });
  });

  it("uses the aws-cn endpoint suffix for China regions", async () => {
    let captured: HttpRequestInput | undefined;
    const store = new AwsS3ObjectStore({
      accessKeyId: "AKIDEXAMPLE",
      bucket: "china-test-bucket",
      execute: async (request) => {
        captured = request;
        return {
          body: new Uint8Array(),
          headers: { date: "Sat, 05 Sep 2026 00:00:00 GMT", etag: '"etag"' },
          status: 200,
        };
      },
      region: "cn-northwest-1",
      secretAccessKey: "secret-example",
    });

    await store.put("integration/head", new Uint8Array());

    expect(captured?.url).toBe(
      "https://china-test-bucket.s3.cn-northwest-1.amazonaws.com.cn/integration/head",
    );
  });
});
