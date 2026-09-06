export const FULL_HASH_VERIFICATION_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export const isFullHashVerificationDue = (
  lastVerificationAt: number | undefined,
  hasCache: boolean,
  now: number,
): boolean =>
  !hasCache ||
  lastVerificationAt === undefined ||
  !Number.isFinite(lastVerificationAt) ||
  lastVerificationAt > now ||
  now - lastVerificationAt >= FULL_HASH_VERIFICATION_INTERVAL_MS;
