import type {
  HttpExecutor,
  HttpRequestInput,
} from "./aws-s3-object-store";

interface ObsidianRequestInput {
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  method?: string;
  throw?: boolean;
  url: string;
}

interface ObsidianResponseOutput {
  arrayBuffer: ArrayBuffer;
  headers: Record<string, string>;
  status: number;
}

export type ObsidianRequestExecutor = (
  request: ObsidianRequestInput,
) => Promise<ObsidianResponseOutput>;

const forbiddenRequestHeaders = new Set(["content-length", "host"]);

const toArrayBuffer = (body: Uint8Array): ArrayBuffer =>
  body.byteOffset === 0 &&
  body.buffer instanceof ArrayBuffer &&
  body.byteLength === body.buffer.byteLength
    ? body.buffer
    : body.slice().buffer;

const transferHeaders = (
  headers: Record<string, string>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !forbiddenRequestHeaders.has(name.toLowerCase()),
    ),
  );

export const createObsidianHttpExecutor = (
  execute: ObsidianRequestExecutor,
): HttpExecutor =>
  async (request: HttpRequestInput) => {
    const method = request.method.toUpperCase();
    const response = await execute({
      body:
        request.body && method !== "GET" && method !== "HEAD"
          ? toArrayBuffer(request.body)
          : undefined,
      headers: transferHeaders(request.headers),
      method: request.method,
      throw: false,
      url: request.url,
    });
    return {
      body: new Uint8Array(response.arrayBuffer),
      headers: response.headers,
      status: response.status,
    };
  };
