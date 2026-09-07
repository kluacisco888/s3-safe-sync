export interface CooperativeYieldOptions {
  budgetMs?: number;
  now?: () => number;
  schedule?: () => Promise<void>;
}

const scheduleMacrotask = (): Promise<void> =>
  document.visibilityState === "visible"
    ? new Promise((resolve) => window.setTimeout(resolve, 0))
    : Promise.resolve();

export const createCooperativeYield = (
  options: CooperativeYieldOptions = {},
): (() => Promise<void>) => {
  const budgetMs = options.budgetMs ?? 16;
  const now = options.now ?? (() => performance.now());
  const schedule = options.schedule ?? scheduleMacrotask;
  let lastYieldAt = now();

  return async (): Promise<void> => {
    if (now() - lastYieldAt < budgetMs) {
      return;
    }
    await schedule();
    lastYieldAt = now();
  };
};
