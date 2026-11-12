/** Cost attribution fields are independent; a requested policy is not a served tier. */
export function serviceTierMetadata(values: {
  requested?: unknown;
  served?: unknown;
}): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [source, field] of [
    [values.requested, "requested_service_tier"],
    [values.served, "served_service_tier"],
  ] as const) {
    if (typeof source !== "string") continue;
    const tier = source
      .trim()
      .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
    if (tier) metadata[field] = tier;
  }
  return metadata;
}
