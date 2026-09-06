import { describe, expect, it } from "vitest";

import {
  FULL_HASH_AUDIT_INTERVAL_MS,
  isFullHashAuditDue,
} from "../src/sync/full-hash-audit-policy";

describe("isFullHashAuditDue", () => {
  const now = Date.UTC(2026, 8, 6, 12);

  it("requires an audit after 24 hours and for untrusted local state", () => {
    expect(isFullHashAuditDue(undefined, true, now)).toBe(true);
    expect(isFullHashAuditDue(now - 1_000, false, now)).toBe(true);
    expect(isFullHashAuditDue(Number.NaN, true, now)).toBe(true);
    expect(isFullHashAuditDue(now + 1, true, now)).toBe(true);
    expect(
      isFullHashAuditDue(now - FULL_HASH_AUDIT_INTERVAL_MS + 1, true, now),
    ).toBe(false);
    expect(
      isFullHashAuditDue(now - FULL_HASH_AUDIT_INTERVAL_MS, true, now),
    ).toBe(true);
  });
});
