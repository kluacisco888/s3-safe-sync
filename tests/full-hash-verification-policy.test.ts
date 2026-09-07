import { describe, expect, it } from "vitest";

import {
  DEFAULT_FULL_HASH_VERIFICATION_INTERVAL_DAYS,
  DEFAULT_FULL_HASH_VERIFICATION_INTERVAL_MS,
  isFullHashVerificationDue,
  normalizeFullHashVerificationIntervalDays,
} from "../src/sync/full-hash-verification-policy";

describe("isFullHashVerificationDue", () => {
  const now = Date.UTC(2026, 8, 6, 12);

  it("requires verification after seven days and for untrusted local state", () => {
    expect(isFullHashVerificationDue(undefined, true, now)).toBe(true);
    expect(isFullHashVerificationDue(now - 1_000, false, now)).toBe(true);
    expect(isFullHashVerificationDue(Number.NaN, true, now)).toBe(true);
    expect(isFullHashVerificationDue(now + 1, true, now)).toBe(true);
    expect(isFullHashVerificationDue(now - 1_000, true, now, true)).toBe(true);
    expect(
      isFullHashVerificationDue(
        now - DEFAULT_FULL_HASH_VERIFICATION_INTERVAL_MS + 1,
        true,
        now,
      ),
    ).toBe(false);
    expect(
      isFullHashVerificationDue(
        now - DEFAULT_FULL_HASH_VERIFICATION_INTERVAL_MS,
        true,
        now,
      ),
    ).toBe(true);
  });

  it("honors a configured verification interval", () => {
    const fourteenDays = 14 * 24 * 60 * 60 * 1_000;

    expect(
      isFullHashVerificationDue(
        now - fourteenDays + 1,
        true,
        now,
        false,
        fourteenDays,
      ),
    ).toBe(false);
    expect(
      isFullHashVerificationDue(
        now - fourteenDays,
        true,
        now,
        false,
        fourteenDays,
      ),
    ).toBe(true);
  });

  it("normalizes persisted intervals to supported day values", () => {
    expect(normalizeFullHashVerificationIntervalDays(1)).toBe(1);
    expect(normalizeFullHashVerificationIntervalDays(14)).toBe(14);
    expect(normalizeFullHashVerificationIntervalDays(30)).toBe(30);
    expect(normalizeFullHashVerificationIntervalDays(2)).toBe(
      DEFAULT_FULL_HASH_VERIFICATION_INTERVAL_DAYS,
    );
    expect(normalizeFullHashVerificationIntervalDays(undefined)).toBe(
      DEFAULT_FULL_HASH_VERIFICATION_INTERVAL_DAYS,
    );
  });
});
