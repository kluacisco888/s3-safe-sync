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
});
