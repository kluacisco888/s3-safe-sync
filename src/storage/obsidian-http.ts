import { requestUrl } from "obsidian";

import { createObsidianHttpExecutor } from "./obsidian-request-adapter";

export const executeObsidianHttpRequest =
  createObsidianHttpExecutor(requestUrl);
