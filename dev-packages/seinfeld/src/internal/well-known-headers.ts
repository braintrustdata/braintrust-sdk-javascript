/**
 * Canonical credential header lists shared by the normalizer and redactor.
 * Keeping them in one place prevents the two subsystems from drifting.
 */

export const TRANSPORT_HEADERS = [
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
];

/** Auth/session headers — stripped during matching and masked during redaction. */
export const AUTH_HEADERS = [
  "authorization",
  "api-key",
  "x-api-key",
  "x-anthropic-api-key",
  "cookie",
  "set-cookie",
  "proxy-authorization",
];

export const RATE_LIMIT_HEADERS = [
  /^x-ratelimit-/i,
  /^x-rate-limit-/i,
  "retry-after",
] as Array<string | RegExp>;

export const FINGERPRINT_HEADERS = ["user-agent"];
