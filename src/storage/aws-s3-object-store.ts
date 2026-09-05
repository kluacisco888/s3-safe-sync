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
  execute: HttpExecutor;
  region: string;
  secretAccessKey: string;
  sessionToken?: string;
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

export class AwsS3ObjectStore implements ObjectStore {
  private readonly execute: HttpExecutor;
  private readonly hostname: string;
  private readonly signer: SignatureV4;

  constructor(options: AwsS3ObjectStoreOptions) {
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
    const response = await this.request("GET", encodeKeyPath(key));
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
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
    };
    if (options.ifMatch !== undefined) {
      headers["if-match"] = options.ifMatch;
    }
    if (options.ifNoneMatch) {
      headers["if-none-match"] = "*";
    }
    const response = await this.request(
      "PUT",
      encodeKeyPath(key),
      body,
      headers,
    );
    if (response.status === 409 || response.status === 412) {
      throw new ObjectPreconditionError();
    }
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
