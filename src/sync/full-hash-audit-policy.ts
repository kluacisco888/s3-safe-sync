export const FULL_HASH_AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export const isFullHashAuditDue = (
  lastAuditAt: number | undefined,
  hasCache: boolean,
  now: number,
): boolean =>
  !hasCache ||
  lastAuditAt === undefined ||
  !Number.isFinite(lastAuditAt) ||
  lastAuditAt > now ||
  now - lastAuditAt >= FULL_HASH_AUDIT_INTERVAL_MS;
