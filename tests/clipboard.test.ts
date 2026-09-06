import { describe, expect, it, vi } from "vitest";

import { copyText } from "../src/plugin/clipboard";

describe("copyText", () => {
  it("copies text when the Clipboard API is available", async () => {
    const writeText = vi.fn(async () => undefined);

    await expect(copyText("notes/example.md", { writeText })).resolves.toBe(
      true,
    );
    expect(writeText).toHaveBeenCalledWith("notes/example.md");
  });

  it("returns false when the Clipboard API is unavailable", async () => {
    await expect(copyText("notes/example.md", undefined)).resolves.toBe(false);
  });

  it("returns false when the platform rejects clipboard access", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("Clipboard denied");
    });

    await expect(copyText("notes/example.md", { writeText })).resolves.toBe(
      false,
    );
  });
});
