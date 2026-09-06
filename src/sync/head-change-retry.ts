import { HeadChangedError } from "../storage/remote-store";

export interface HeadChangeRetryOptions {
  baseDelaysMs?: readonly number[];
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_BASE_DELAYS_MS = [250, 500, 1_000, 2_000] as const;

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));

export const retryHeadChanges = async <Result>(
  operation: (attempt: number, totalAttempts: number) => Promise<Result>,
  options: HeadChangeRetryOptions = {},
): Promise<Result> => {
  const baseDelaysMs = options.baseDelaysMs ?? DEFAULT_BASE_DELAYS_MS;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? wait;
  const totalAttempts = baseDelaysMs.length + 1;
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      return await operation(attempt, totalAttempts);
    } catch (error) {
      const baseDelay = baseDelaysMs[attempt - 1];
      if (!(error instanceof HeadChangedError) || baseDelay === undefined) {
        throw error;
      }
      const jitter = Math.max(0, Math.min(1, random()));
      await sleep(baseDelay + Math.floor(baseDelay * jitter));
    }
  }
  throw new Error("Head retry loop ended unexpectedly");
};
