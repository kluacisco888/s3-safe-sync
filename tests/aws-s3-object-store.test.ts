import { describe, expect, it } from "vitest";

import {
  AwsS3ObjectStore,
  type HttpRequestInput,
  type HttpResponseOutput,
} from "../src/storage/aws-s3-object-store";
import { ObjectPreconditionError } from "../src/storage/object-store";

describe("AwsS3ObjectStore", () => {
  it("revalidates mutable listings before trusting that commit history is absent", async () => {
    const store = new AwsS3ObjectStore({
      accessKeyId: "test", secretAccessKey: "test", bucket: "example-bucket", region: "us-east-1",
      execute: async request => ({
        status: 200,
        headers: {},
        body: new TextEncoder().encode(request.headers["cache-control"] === "no-cache"
          ? "<ListBucketResult><Contents><Key>prefix/v1/commits/accepted</Key></Contents></ListBucketResult>"
          : "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>"),
      }),
    });
    await expect(store.list("prefix/v1/commits/")).resolves.toEqual(["prefix/v1/commits/accepted"]);
  });

  it("bypasses a cached Head read and normalizes its ETag before a conditional write", async () => {
    const store = new AwsS3ObjectStore({
      accessKeyId: "AKIDEXAMPLE",
      bucket: "example-bucket",
      execute: async (request): Promise<HttpResponseOutput> => {
        if (request.method === "GET") {
          const fresh =
            request.headers["cache-control"] === "no-cache" &&
            new URL(request.url).searchParams.get("response-cache-control") ===
              "no-store";
          return {
            body: new TextEncoder().encode(fresh ? "current" : "stale"),
            headers: {
              date: "Sat, 05 Sep 2026 00:00:00 GMT",
              etag: fresh ? "current-etag" : "stale-etag",
              "last-modified": "Sat, 05 Sep 2026 00:00:00 GMT",
            },
            status: 200,
          };
        }
        if (request.method === "PUT") {
          return {
            body: new Uint8Array(),
            headers: {
              date: "Sat, 05 Sep 2026 00:00:01 GMT",
              etag: "next-etag",
            },
            status:
              request.headers["if-match"] === '"current-etag"' ? 200 : 412,
          };
        }
        throw new Error(`Unexpected request: ${request.method}`);
      },
      region: "us-east-1",
      secretAccessKey: "secret-example",
    });

    const current = await store.get("chosen-prefix/v1/head", {
      revalidate: true,
    });
    expect(new TextDecoder().decode(current?.body)).toBe("current");
    expect(current?.etag).toBe('"current-etag"');

    await expect(
      store.put("chosen-prefix/v1/head", new TextEncoder().encode("next"), {
        ifMatch: current?.etag,
      }),
    ).resolves.toMatchObject({ etag: '"next-etag"' });
  });

  it.each([
    'W/"weak-etag"',
    '"contains space"',
    '"one", "two"',
    '"line\nbreak"',
  ])("rejects an unusable ETag: %s", async (etag) => {
    const store = new AwsS3ObjectStore({
      accessKeyId: "AKIDEXAMPLE",
      bucket: "example-bucket",
      execute: async () => ({
        body: new TextEncoder().encode("head"),
        headers: {
          date: "Sat, 05 Sep 2026 00:00:00 GMT",
          etag,
          "last-modified": "Sat, 05 Sep 2026 00:00:00 GMT",
        },
        status: 200,
      }),
      region: "us-east-1",
      secretAccessKey: "secret-example",
    });

    await expect(
      store.get("chosen-prefix/v1/head", { revalidate: true }),
    ).rejects.toThrow("strong ETag");
  });

  it("uploads a large S3 object through bounded multipart requests", async () => {
    const partBytes = 5 * 1024 * 1024;
    const source = new Uint8Array(partBytes * 2 + 3);
    const uploadedPartSizes: number[] = [];
    let completedBody = "";
    let completeIfNoneMatch: string | undefined;
    const store = new AwsS3ObjectStore({
      accessKeyId: "AKIDEXAMPLE",
      bucket: "example-bucket",
      execute: async (request): Promise<HttpResponseOutput> => {
        const url = new URL(request.url);
        if (request.method === "POST" && url.searchParams.has("uploads")) {
          return {
            body: new TextEncoder().encode(
              "<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>",
            ),
            headers: { date: "Sat, 05 Sep 2026 00:00:00 GMT" },
            status: 200,
          };
        }
        if (request.method === "PUT" && url.searchParams.has("partNumber")) {
          uploadedPartSizes.push(request.body?.byteLength ?? 0);
          return {
            body: new Uint8Array(),
            headers: {
              date: "Sat, 05 Sep 2026 00:00:00 GMT",
              etag: `"part-${url.searchParams.get("partNumber")}"`,
            },
            status: 200,
          };
        }
        if (request.method === "POST" && url.searchParams.has("uploadId")) {
          completedBody = new TextDecoder().decode(request.body);
          completeIfNoneMatch = request.headers["if-none-match"];
          return {
            body: new TextEncoder().encode(
              "<CompleteMultipartUploadResult><ETag>complete-etag</ETag></CompleteMultipartUploadResult>",
            ),
            headers: { date: "Sat, 05 Sep 2026 00:00:00 GMT" },
            status: 200,
          };
        }
        throw new Error(`Unexpected multipart request: ${request.method} ${request.url}`);
      },
      region: "us-east-1",
      secretAccessKey: "secret-example",
      uploadChunkBytes: partBytes,
    });

    const uploaded = await store.put(
      "chosen-prefix/v1/blobs/blob-1",
      source,
      { ifNoneMatch: true },
    );

    expect(uploaded.etag).toBe('"complete-etag"');
    expect(uploadedPartSizes).toEqual([partBytes, partBytes, 3]);
    expect(completeIfNoneMatch).toBe("*");
    expect(completedBody).toContain(
      "<PartNumber>1</PartNumber><ETag>&quot;part-1&quot;</ETag>",
    );
    expect(completedBody).toContain(
      "<PartNumber>3</PartNumber><ETag>&quot;part-3&quot;</ETag>",
    );
  });

  it("downloads one S3 object through bounded byte ranges", async () => {
    const source = new TextEncoder().encode("0123456789");
    const ranges: string[] = [];
    const store = new AwsS3ObjectStore({
      accessKeyId: "AKIDEXAMPLE",
      bucket: "example-bucket",
      downloadChunkBytes: 4,
      execute: async (request) => {
        const range = request.headers["range"];
        if (!range) {
          throw new Error("Expected a signed Range header");
        }
        ranges.push(range);
        const match = /^bytes=(\d+)-(\d+)$/u.exec(range);
        if (!match?.[1] || !match[2]) {
          throw new Error(`Invalid test Range: ${range}`);
        }
        const start = Number(match[1]);
        const end = Math.min(Number(match[2]), source.byteLength - 1);
        return {
          body: source.slice(start, end + 1),
          headers: {
            "content-range": `bytes ${start}-${end}/${source.byteLength}`,
            date: "Sat, 05 Sep 2026 00:00:00 GMT",
            etag: '"stable-etag"',
            "last-modified": "Sat, 05 Sep 2026 00:00:00 GMT",
          },
          status: 206,
        };
      },
      region: "us-east-1",
      secretAccessKey: "secret-example",
    });

    const downloaded = await store.get("chosen-prefix/v1/blobs/blob-1");

    expect(downloaded?.body).toEqual(source);
    expect(ranges).toEqual(["bytes=0-3", "bytes=4-7", "bytes=8-9"]);
  });

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
