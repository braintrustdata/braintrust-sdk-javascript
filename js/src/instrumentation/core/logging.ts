export function toLoggedError(error: unknown): unknown {
  return error instanceof Error ? error.message : error;
}
