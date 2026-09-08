import { requestUrl } from "obsidian";

import { createObsidianHttpExecutor } from "./obsidian-request-adapter";
import type { HttpRequestInput } from "./aws-s3-object-store";

export const executeObsidianHttpRequest = (request: HttpRequestInput, signal?: AbortSignal) =>
  createObsidianHttpExecutor(requestUrl, signal)(request);
