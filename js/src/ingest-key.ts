/** Ingest key URLs are configuration, never HTTP request URLs. */
export function parseIngestKey(
  value: string,
): { endpoint: string; token: string } | undefined {
  const credential = value.trim();
  if (!credential.includes("://") && !credential.startsWith("bt-ik-")) {
    return undefined;
  }
  const invalid =
    "Invalid ingest key. Use the complete ingest key URL from Braintrust.";
  let url: URL;
  try {
    url = new URL(credential);
  } catch {
    throw new Error(invalid);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback)) ||
    !/^bt-ik-[A-Za-z0-9_-]+$/.test(url.username) ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === "/"
  ) {
    throw new Error(invalid);
  }
  const token = url.username;
  url.username = "";
  return { endpoint: url.toString(), token };
}

export const INGEST_KEY_ATTACHMENT_BLOCKED =
  "[Attachment blocked by ingest key policy]";

/** Runs after masking, on JSON records whose Attachment objects were extracted. */
export function blockIngestKeyAttachments(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(blockIngestKeyAttachments);
  if (
    "type" in value &&
    (value.type === "braintrust_attachment" ||
      value.type === "external_attachment" ||
      value.type === "inline_attachment")
  ) {
    return INGEST_KEY_ATTACHMENT_BLOCKED;
  }
  // Masking/customizers may return Dates or other objects with toJSON methods.
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      blockIngestKeyAttachments(child),
    ]),
  );
}
