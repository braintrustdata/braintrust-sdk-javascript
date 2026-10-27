// Internal bookkeeping for automatic conversions, never serialized or exposed
// to customizers. Explicit user-created Attachments retain their usual behavior.
export const automaticAttachmentOriginals = new WeakMap<object, unknown>();

/** Restore only surviving media leaves, never resurrect customizer-redacted data. */
export function restoreAutomaticAttachments(
  value: unknown,
  references: Map<string, unknown> = new Map(),
  depth = 0,
): unknown {
  if (!value || typeof value !== "object") return value;
  if (depth >= 128) return value;
  if (automaticAttachmentOriginals.has(value))
    return automaticAttachmentOriginals.get(value);
  if (Array.isArray(value))
    return value.map((item) =>
      restoreAutomaticAttachments(item, references, depth + 1),
    );
  const record = value as Record<string, unknown>;
  if (
    record.type === "braintrust_attachment" &&
    typeof record.key === "string" &&
    references.has(record.key)
  )
    return references.get(record.key);
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return value;
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key,
      restoreAutomaticAttachments(item, references, depth + 1),
    ]),
  );
}
