import { describe, expect, it } from "vitest";

import { createCooperativeYield } from "../src/plugin/cooperative-yield";

describe("createCooperativeYield", () => {
  it("defers only after the hashing time budget is exhausted", async () => {
    let now = 0;
    let scheduled = 0;
    const yieldToHost = createCooperativeYield({
      budgetMs: 16,
      now: () => now,
      schedule: () => {
        scheduled += 1;
        return Promise.resolve();
      },
    });

    await yieldToHost();
    now = 15;
    await yieldToHost();
    expect(scheduled).toBe(0);

    now = 16;
    await yieldToHost();
    await yieldToHost();
    expect(scheduled).toBe(1);

    now = 32;
    await yieldToHost();
    expect(scheduled).toBe(2);
  });
});
