import { describe, expect, it } from "vitest";

import { automaticMobileFileLimit } from "../src/plugin/mobile-file-limit";

const MiB = 1024 * 1024;

describe("automaticMobileFileLimit", () => {
  it("does not limit desktop files", () => {
    expect(automaticMobileFileLimit("attachments/photo.jpg", false)).toBeUndefined();
  });

  it("allows every mobile file up to 50 MiB on Wi-Fi", () => {
    expect(automaticMobileFileLimit("notes/article.md", true, "wifi")).toBe(
      50 * MiB,
    );
    expect(automaticMobileFileLimit("attachments/photo.jpg", true, "wifi")).toBe(
      50 * MiB,
    );
  });

  it("keeps notes at 50 MiB away from Wi-Fi", () => {
    expect(automaticMobileFileLimit("notes/article.md", true, "cellular")).toBe(
      50 * MiB,
    );
    expect(automaticMobileFileLimit("boards/plan.canvas", true)).toBe(50 * MiB);
    expect(automaticMobileFileLimit("tables/data.base", true)).toBe(50 * MiB);
  });

  it("delays attachments above 10 MiB away from Wi-Fi", () => {
    expect(automaticMobileFileLimit("attachments/photo.jpg", true, "cellular")).toBe(
      10 * MiB,
    );
    expect(automaticMobileFileLimit("attachments/archive", true)).toBe(10 * MiB);
  });
});
