export const DEFAULT_FULL_HASH_VERIFICATION_INTERVAL_DAYS = 7;
export const SUPPORTED_FULL_HASH_VERIFICATION_INTERVAL_DAYS = [
  1,
  7,
  14,
  30,
] as const;

export const DEFAULT_FULL_HASH_VERIFICATION_INTERVAL_MS =
  DEFAULT_FULL_HASH_VERIFICATION_INTERVAL_DAYS * 24 * 60 * 60 * 1_000;

export const normalizeFullHashVerificationIntervalDays = (
  value: number | undefined,
): number =>
  SUPPORTED_FULL_HASH_VERIFICATION_INTERVAL_DAYS.some(
    (candidate) => candidate === value,
  )
    ? (value ?? DEFAULT_FULL_HASH_VERIFICATION_INTERVAL_DAYS)
    : DEFAULT_FULL_HASH_VERIFICATION_INTERVAL_DAYS;

export const isFullHashVerificationDue = (
  lastVerificationAt: number | undefined,
  hasCache: boolean,
  now: number,
  verificationRequired = false,
  intervalMs = DEFAULT_FULL_HASH_VERIFICATION_INTERVAL_MS,
): boolean =>
  verificationRequired ||
  !hasCache ||
  lastVerificationAt === undefined ||
  !Number.isFinite(lastVerificationAt) ||
  lastVerificationAt > now ||
  now - lastVerificationAt >= intervalMs;
