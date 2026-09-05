import { requestUrl } from "obsidian";

import type {
  HttpExecutor,
  HttpRequestInput,
} from "./aws-s3-object-store";

const toArrayBuffer = (body: Uint8Array): ArrayBuffer =>
  body.byteOffset === 0 &&
  body.buffer instanceof ArrayBuffer &&
  body.byteLength === body.buffer.byteLength
    ? body.buffer
    : body.slice().buffer;

export const executeObsidianHttpRequest: HttpExecutor = async (
  request: HttpRequestInput,
) => {
  const response = await requestUrl({
    body: request.body ? toArrayBuffer(request.body) : undefined,
    headers: request.headers,
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
