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

export class S3TransportError extends Error {
  constructor(readonly kind: "network" | "timeout", readonly writeMayHaveSucceeded: boolean) {
    super(kind === "timeout" ? "S3 request timed out after 120 seconds. Check the connection and retry sync."
      : "S3 network request failed. Check the connection and retry sync.");
    this.name = "S3TransportError";
  }
}

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
  signal?: AbortSignal,
): HttpExecutor =>
  async (request: HttpRequestInput) => {
    const method = request.method.toUpperCase();
    const writeMayHaveSucceeded = method !== "GET" && method !== "HEAD";
    const abortError = (): Error => signal?.reason instanceof Error
      ? signal.reason
      : new Error("S3 request was cancelled");
    if (signal?.aborted) throw abortError();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new S3TransportError("timeout", writeMayHaveSucceeded)), 120_000);
      onAbort = () => reject(abortError());
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const delivered = (async () => { try { return await execute({
        body:
          request.body && method !== "GET" && method !== "HEAD"
            ? toArrayBuffer(request.body)
            : undefined,
        headers: transferHeaders(request.headers),
        method: request.method,
        throw: false,
        url: request.url,
      }); } catch {
        if (signal?.aborted) throw abortError();
        throw new S3TransportError("network", writeMayHaveSucceeded);
      } })();
      const response = await Promise.race([delivered, interrupted]);
      return {
        body: new Uint8Array(response.arrayBuffer),
        headers: response.headers,
        status: response.status,
      };
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  };
