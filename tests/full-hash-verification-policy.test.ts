import { describe, expect, it } from "vitest";

import {
  FULL_HASH_VERIFICATION_INTERVAL_MS,
  isFullHashVerificationDue,
} from "../src/sync/full-hash-verification-policy";

describe("isFullHashVerificationDue", () => {
  const now = Date.UTC(2026, 8, 6, 12);

  it("requires verification after 24 hours and for untrusted local state", () => {
    expect(isFullHashVerificationDue(undefined, true, now)).toBe(true);
    expect(isFullHashVerificationDue(now - 1_000, false, now)).toBe(true);
    expect(isFullHashVerificationDue(Number.NaN, true, now)).toBe(true);
    expect(isFullHashVerificationDue(now + 1, true, now)).toBe(true);
    expect(
      isFullHashVerificationDue(
        now - FULL_HASH_VERIFICATION_INTERVAL_MS + 1,
        true,
        now,
      ),
    ).toBe(false);
    expect(
      isFullHashVerificationDue(
        now - FULL_HASH_VERIFICATION_INTERVAL_MS,
        true,
        now,
      ),
    ).toBe(true);
  });
});
