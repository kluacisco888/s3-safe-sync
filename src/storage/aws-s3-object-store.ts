import { Sha256 } from "@aws-crypto/sha256-browser";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { XMLParser } from "fast-xml-parser";

import {
  ObjectPreconditionError,
  type ObjectPutOptions,
  type ObjectStore,
  type StoredObject,
} from "./object-store";

export interface HttpRequestInput {
  body?: Uint8Array;
  headers: Record<string, string>;
  method: string;
  url: string;
}

export interface HttpResponseOutput {
  body: Uint8Array;
  headers: Record<string, string>;
  status: number;
}

export type HttpExecutor = (
  request: HttpRequestInput,
) => Promise<HttpResponseOutput>;

export interface AwsS3ObjectStoreOptions {
  accessKeyId: string;
  bucket: string;
  downloadChunkBytes?: number;
  execute: HttpExecutor;
  region: string;
  secretAccessKey: string;
  sessionToken?: string;
  uploadChunkBytes?: number;
}

export class S3RequestError extends Error {
  readonly code = "S3_REQUEST_FAILED" as const;

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "S3RequestError";
  }
}

const encodePathSegment = (segment: string): string =>
  encodeURIComponent(segment).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const encodeKeyPath = (key: string): string =>
  `/${key.split("/").map(encodePathSegment).join("/")}`;

const lowerCaseHeaders = (
  headers: Record<string, string>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );

const requiredHeader = (
  headers: Record<string, string>,
  name: string,
): string => {
  const value = lowerCaseHeaders(headers)[name.toLowerCase()];
  if (value === undefined) {
    throw new Error(`AWS S3 response omitted ${name}`);
  }
  return value;
};

const parseContentRange = (
  value: string,
): { end: number; start: number; total: number } => {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`AWS S3 returned an invalid Content-Range: ${value}`);
  }
  return {
    end: Number(match[2]),
    start: Number(match[1]),
    total: Number(match[3]),
  };
};

const readXmlElement = (
  body: Uint8Array,
  rootName: string,
  elementName: string,
): string => {
  const parsed = new XMLParser().parse(new TextDecoder().decode(body)) as unknown;
  if (typeof parsed !== "object" || parsed === null || !(rootName in parsed)) {
    throw new Error(`AWS S3 returned an invalid ${rootName} document`);
  }
  const root = (parsed as Record<string, unknown>)[rootName];
  if (typeof root !== "object" || root === null) {
    throw new Error(`AWS S3 returned an invalid ${rootName} result`);
  }
  const value = (root as Record<string, unknown>)[elementName];
  if (typeof value !== "string") {
    throw new Error(`AWS S3 omitted ${elementName} from ${rootName}`);
  }
  return value;
};

const escapeXml = (value: string): string =>
  value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");

const conditionalWriteHeaders = (
  contentType: string,
  options: ObjectPutOptions,
): Record<string, string> => ({
  "content-type": contentType,
  ...(options.ifMatch !== undefined ? { "if-match": options.ifMatch } : {}),
  ...(options.ifNoneMatch ? { "if-none-match": "*" } : {}),
});

const throwIfPreconditionFailed = (response: HttpResponseOutput): void => {
  if (response.status === 409 || response.status === 412) {
    throw new ObjectPreconditionError();
  }
};

export class AwsS3ObjectStore implements ObjectStore {
  private readonly downloadChunkBytes: number | undefined;
  private readonly execute: HttpExecutor;
  private readonly hostname: string;
  private readonly signer: SignatureV4;
  private readonly uploadChunkBytes: number | undefined;

  constructor(options: AwsS3ObjectStoreOptions) {
    if (
      options.downloadChunkBytes !== undefined &&
      (!Number.isInteger(options.downloadChunkBytes) ||
        options.downloadChunkBytes < 1)
    ) {
      throw new Error("S3 download chunk size must be a positive integer");
    }
    this.downloadChunkBytes = options.downloadChunkBytes;
    if (
      options.uploadChunkBytes !== undefined &&
      (!Number.isInteger(options.uploadChunkBytes) ||
        options.uploadChunkBytes < 5 * 1024 * 1024)
    ) {
      throw new Error("S3 upload chunk size must be at least 5 MiB");
    }
    this.uploadChunkBytes = options.uploadChunkBytes;
    this.execute = options.execute;
    const dnsSuffix = options.region.startsWith("cn-")
      ? "amazonaws.com.cn"
      : "amazonaws.com";
    this.hostname = `${options.bucket}.s3.${options.region}.${dnsSuffix}`;
    this.signer = new SignatureV4({
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        sessionToken: options.sessionToken,
      },
      region: options.region,
      service: "s3",
      sha256: Sha256,
      uriEscapePath: false,
    });
  }

  async delete(key: string): Promise<void> {
    const response = await this.request("DELETE", encodeKeyPath(key));
    if (![200, 204, 404].includes(response.status)) {
      this.throwResponseError(response, `delete ${key}`);
    }
  }

  async get(key: string): Promise<StoredObject | undefined> {
    const path = encodeKeyPath(key);
    if (this.downloadChunkBytes === undefined) {
      const response = await this.request("GET", path);
      if (response.status === 404) {
        return undefined;
      }
      if (response.status !== 200) {
        this.throwResponseError(response, `read ${key}`);
      }
      return {
        body: response.body,
        etag: requiredHeader(response.headers, "etag"),
        lastModified: requiredHeader(response.headers, "last-modified"),
        serverDate: requiredHeader(response.headers, "date"),
      };
    }
    const first = await this.request("GET", path, undefined, {
      range: `bytes=0-${this.downloadChunkBytes - 1}`,
    });
    if (first.status === 404) {
      return undefined;
    }
    if (first.status === 200) {
      return {
        body: first.body,
        etag: requiredHeader(first.headers, "etag"),
        lastModified: requiredHeader(first.headers, "last-modified"),
        serverDate: requiredHeader(first.headers, "date"),
      };
    }
    if (first.status !== 206) {
      this.throwResponseError(first, `read ${key}`);
    }
    const firstRange = parseContentRange(
      requiredHeader(first.headers, "content-range"),
    );
    if (
      firstRange.start !== 0 ||
      firstRange.end + 1 !== first.body.byteLength
    ) {
      throw new Error(`AWS S3 returned an unexpected first byte range for ${key}`);
    }
    const etag = requiredHeader(first.headers, "etag");
    const body = new Uint8Array(firstRange.total);
    body.set(first.body, 0);
    let offset = firstRange.end + 1;
    while (offset < firstRange.total) {
      const end = Math.min(
        offset + this.downloadChunkBytes - 1,
        firstRange.total - 1,
      );
      const response = await this.request("GET", path, undefined, {
        "if-match": etag,
        range: `bytes=${offset}-${end}`,
      });
      if (response.status !== 206) {
        this.throwResponseError(response, `read byte range ${offset}-${end} of ${key}`);
      }
      const received = parseContentRange(
        requiredHeader(response.headers, "content-range"),
      );
      if (
        received.start !== offset ||
        received.end !== end ||
        received.total !== firstRange.total ||
        response.body.byteLength !== end - offset + 1 ||
        requiredHeader(response.headers, "etag") !== etag
      ) {
        throw new Error(`AWS S3 returned an inconsistent byte range for ${key}`);
      }
      body.set(response.body, offset);
      offset = end + 1;
    }
    return {
      body,
      etag,
      lastModified: requiredHeader(first.headers, "last-modified"),
      serverDate: requiredHeader(first.headers, "date"),
    };
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const query: Record<string, string> = {
        "list-type": "2",
        prefix,
      };
      if (continuationToken) {
        query["continuation-token"] = continuationToken;
      }
      const response = await this.request("GET", "/", undefined, {}, query);
      if (response.status !== 200) {
        this.throwResponseError(response, `list ${prefix}`);
      }
      const parsed = new XMLParser().parse(
        new TextDecoder().decode(response.body),
      ) as unknown;
      const result = this.readListResult(parsed);
      keys.push(...result.keys);
      continuationToken = result.nextContinuationToken;
    } while (continuationToken);
    return keys;
  }

  async put(
    key: string,
    body: Uint8Array,
    options: ObjectPutOptions = {},
  ): Promise<StoredObject> {
    if (
      this.uploadChunkBytes !== undefined &&
      body.byteLength > this.uploadChunkBytes
    ) {
      return this.putMultipart(key, body, options);
    }
    const headers = conditionalWriteHeaders("application/octet-stream", options);
    const response = await this.request(
      "PUT",
      encodeKeyPath(key),
      body,
      headers,
    );
    throwIfPreconditionFailed(response);
    if (response.status !== 200) {
      this.throwResponseError(response, `write ${key}`);
    }
    return {
      body: new Uint8Array(),
      etag: requiredHeader(response.headers, "etag"),
      lastModified: requiredHeader(response.headers, "date"),
      serverDate: requiredHeader(response.headers, "date"),
    };
  }

  private async putMultipart(
    key: string,
    body: Uint8Array,
    options: ObjectPutOptions,
  ): Promise<StoredObject> {
    if (this.uploadChunkBytes === undefined) {
      throw new Error("Multipart upload requires a configured chunk size");
    }
    const path = encodeKeyPath(key);
    const initiated = await this.request(
      "POST",
      path,
      undefined,
      { "content-type": "application/octet-stream" },
      { uploads: "" },
    );
    if (initiated.status !== 200) {
      this.throwResponseError(initiated, `start multipart upload for ${key}`);
    }
    const uploadId = readXmlElement(
      initiated.body,
      "InitiateMultipartUploadResult",
      "UploadId",
    );
    try {
      const parts: Array<{ etag: string; partNumber: number }> = [];
      let partNumber = 1;
      for (let offset = 0; offset < body.byteLength; offset += this.uploadChunkBytes) {
        const end = Math.min(offset + this.uploadChunkBytes, body.byteLength);
        const uploaded = await this.request(
          "PUT",
          path,
          body.subarray(offset, end),
          { "content-type": "application/octet-stream" },
          { partNumber: String(partNumber), uploadId },
        );
        if (uploaded.status !== 200) {
          this.throwResponseError(uploaded, `upload part ${partNumber} of ${key}`);
        }
        parts.push({
          etag: requiredHeader(uploaded.headers, "etag"),
          partNumber,
        });
        partNumber += 1;
      }
      const completionDocument = new TextEncoder().encode(
        `<CompleteMultipartUpload>${parts
          .map(
            (part) =>
              `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`,
          )
          .join("")}</CompleteMultipartUpload>`,
      );
      const headers = conditionalWriteHeaders("application/xml", options);
      const completed = await this.request(
        "POST",
        path,
        completionDocument,
        headers,
        { uploadId },
      );
      throwIfPreconditionFailed(completed);
      if (completed.status !== 200) {
        this.throwResponseError(completed, `complete multipart upload for ${key}`);
      }
      return {
        body: new Uint8Array(),
        etag: readXmlElement(
          completed.body,
          "CompleteMultipartUploadResult",
          "ETag",
        ),
        lastModified: requiredHeader(completed.headers, "date"),
        serverDate: requiredHeader(completed.headers, "date"),
      };
    } catch (error) {
      try {
        await this.request("DELETE", path, undefined, {}, { uploadId });
      } catch {
        // The original upload failure is more useful than a cleanup failure.
      }
      throw error;
    }
  }

  private buildUrl(request: {
    hostname: string;
    path: string;
    query?: Record<string, string | string[] | null>;
  }): string {
    const url = new URL(`https://${request.hostname}${request.path}`);
    for (const [name, rawValue] of Object.entries(request.query ?? {})) {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      for (const value of values) {
        if (value === null) {
          url.searchParams.append(name, "");
        } else {
          url.searchParams.append(name, value);
        }
      }
    }
    return url.toString();
  }

  private readListResult(value: unknown): {
    keys: string[];
    nextContinuationToken?: string;
  } {
    if (typeof value !== "object" || value === null || !("ListBucketResult" in value)) {
      throw new Error("AWS S3 returned an invalid ListObjectsV2 document");
    }
    const document = value as Record<string, unknown>;
    const rootValue = document["ListBucketResult"];
    if (typeof rootValue !== "object" || rootValue === null) {
      throw new Error("AWS S3 returned an invalid ListObjectsV2 result");
    }
    const root = rootValue as Record<string, unknown>;
    const contents = root["Contents"] ?? [];
    const items = Array.isArray(contents) ? contents : [contents];
    const keys: string[] = items.flatMap((item): string[] => {
      if (typeof item === "object" && item !== null) {
        const key = (item as Record<string, unknown>)["Key"];
        if (typeof key === "string") {
          return [key];
        }
      }
      return [];
    });
    const rawNextToken = root["NextContinuationToken"];
    const nextContinuationToken =
      typeof rawNextToken === "string"
        ? rawNextToken
        : undefined;
    return { keys, nextContinuationToken };
  }

  private async request(
    method: string,
    path: string,
    body?: Uint8Array,
    headers: Record<string, string> = {},
    query: Record<string, string> = {},
  ): Promise<HttpResponseOutput> {
    const signed = await this.signer.sign(
      new HttpRequest({
        body,
        headers: { host: this.hostname, ...headers },
        hostname: this.hostname,
        method,
        path,
        protocol: "https:",
        query,
      }),
    );
    return this.execute({
      body,
      headers: lowerCaseHeaders(signed.headers),
      method,
      url: this.buildUrl(signed),
    });
  }

  private throwResponseError(
    response: HttpResponseOutput,
    operation: string,
  ): never {
    throw new S3RequestError(
      response.status,
      `AWS S3 could not ${operation} (HTTP ${response.status})`,
    );
  }
}
